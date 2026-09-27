// EigenFlux 本地客户端网关（零依赖 Node.js）
// 单文件夹 D:\eigenflux-client 的唯一入口：
//   - 浏览器 UI 通过 /api/* 调用
//   - Agent（DSH）通过 POST /api/exec 走同一条管道调用 CLI
// 所有 CLI 动作都写入 client/activity.log，人可以随时以 Agent 的视角回看。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'eigenflux.exe');
const HOME = path.join(ROOT, '.eigenflux');
const SKILLS = path.join(ROOT, 'skills');
const PUB = path.join(__dirname, 'public');
const LOG = path.join(__dirname, 'activity.log');
const USAGE_FILE = path.join(__dirname, 'usage.md');
const PORT = Number(process.env.EFX_PORT || 4820);
const HOST = '127.0.0.1';

// ---------- 活动日志（内存环形 + 磁盘 JSONL） ----------
const activity = [];
let seq = 0;

function log(actor, action, ok, detail) {
  const entry = {
    n: ++seq,
    t: new Date().toISOString(),
    actor,            // 'agent' | 'user'
    action,
    ok,
    detail: String(detail || '').slice(0, 3000),
  };
  activity.push(entry);
  if (activity.length > 800) activity.shift();
  fs.appendFile(LOG, JSON.stringify(entry) + '\n', () => {});
}

// ---------- 简单 TTL 缓存（降低慢接口的重复开销） ----------
const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = Promise.resolve().then(producer);
  cache.set(key, { t: Date.now(), p });
  return p;
}

// ---------- CLI 执行（读并发 ≤6；写串行；凭据到期前主动单飞预刷新，杜绝锁风暴） ----------
let readBusy = 0;
const readQueue = [];
let writeChain = Promise.resolve();
const MAX_READS = 6;

// 凭据预刷新：读本地 expires_at，到期前 60 秒内全网关只做一次串行刷新
let credExpiresAt = 0;
let refreshChain = Promise.resolve();
function readCredExpiry() {
  try {
    const p = path.join(HOME, 'servers', 'eigenflux', 'agent-v2-credentials.json');
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof o.expires_at === 'number') credExpiresAt = o.expires_at;
  } catch (e) {}
}
function ensureFresh() {
  readCredExpiry();
  if (!credExpiresAt || Date.now() <= credExpiresAt - 60000) return Promise.resolve();
  const t = refreshChain
    .then(() => run(['runtime', 'heartbeat'], { action: 'credential-pre-refresh', mode: 'write', noSettle: true }))
    .then(() => { readCredExpiry(); })
    .catch(() => {});
  refreshChain = t;
  return t;
}
readCredExpiry();

const LOCK_RE = /credential refresh lock|timed out waiting|Agent V2 authentication failed/i;

function run(args, opts = {}) {
  const { stdin = null, actor = 'user', action = args.join(' '), mode = 'read', noSettle = false } = opts;
  const started = Date.now();
  const exec = () => new Promise((resolve) => {
    const full = ['--homedir', HOME, '-f', 'json', '--no-interactive'].concat(args);
    const child = execFile(BIN, full, {
      env: Object.assign({}, process.env, { EIGENFLUX_HOME: HOME, EIGENFLUX_SKILLS_DIR: SKILLS, EIGENFLUX_MODEL: 'deepseek-v4-pro' }),
      windowsHide: true,
      timeout: 90000,
      maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const out = String(stdout || '');
      const errText = String(stderr || (err && err.message) || '');
      let data = null;
      try { data = JSON.parse(out); } catch (e) { data = out ? { raw: out } : null; }
      const ms = Date.now() - started;
      const ok = code === 0 && !/error|unauthorized|invalid/i.test(errText.slice(0, 200));
      log(actor, action, ok,
        `exit=${code} ${ms}ms` + (errText ? ' ERR:' + errText.slice(0, 400) : ''));
      resolve({ code, data, errText, ms });
    });
    if (stdin != null) { child.stdin.write(stdin); child.stdin.end(); }
  });

  // 撞锁兜底：失败后全网关共享一次串行「结清」；结清本身 noSettle，绝不递归（防自等死锁）
  let settlePromise = null;
  const execWithRetry = () => exec().then((r) => {
    if (!noSettle && r.code !== 0 && LOCK_RE.test(r.errText)) {
      if (!settlePromise) {
        settlePromise = run(['runtime', 'heartbeat'], { action: 'credential-settle', mode: 'write', noSettle: true })
          .catch(() => {})
          .finally(() => { settlePromise = null; });
      }
      return settlePromise.then(() => exec());
    }
    return r;
  });

  if (mode === 'write') {
    // 写只与写串行；普通命令先过「凭据新鲜」检查（noSettle 的内部调用除外）
    const prev = writeChain; // 必须先捕获上一环，避免自指死锁
    const task = (noSettle ? Promise.resolve() : ensureFresh())
      .then(() => prev)
      .then(execWithRetry);
    writeChain = task.catch(() => {});
    return task;
  }

  const go = () => {
    const waitSlot = readBusy >= MAX_READS ? new Promise((r) => readQueue.push(r)) : (readBusy++, Promise.resolve());
    return waitSlot.then(() => execWithRetry());
  };
  const task = (noSettle ? Promise.resolve() : ensureFresh()).then(go);
  return task.finally(() => {
    const next = readQueue.shift();
    if (next) { next(); } // 槽位转移给排队读者，计数不变
    else { readBusy--; }
  });
}

// ---------- HTTP 工具 ----------
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid json body')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

// 乱码拦截：发送端未按 UTF-8 时中文会被吞成连续问号（????），网关直接拒收
function hasMangled(o) {
  if (typeof o === 'string') return /[?]{4,}/.test(o);
  if (Array.isArray(o)) return o.some(hasMangled);
  if (o && typeof o === 'object') return Object.values(o).some(hasMangled);
  return false;
}
const MANGLED_MSG = '疑似编码错误：正文含连续问号（中文未按 UTF-8 发送会变成 ?）。请按手册规则 6 用 [System.Text.Encoding]::UTF8.GetBytes($json) 重发；确认内容本就含问号时，在 body 里加 "force": true 再发即可通过。';
const mangledBlocked = (body) => hasMangled(body) && body.force !== true;

function serveStatic(req, res, urlPath) {
  let file = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  file = path.normalize(file);
  if (file.startsWith('..') || path.isAbsolute(file)) return send(res, 403, { ok: false, error: 'forbidden' });
  const full = path.join(PUB, file);
  fs.readFile(full, (err, buf) => {
    if (err) return send(res, 404, { ok: false, error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;

  // 根路径内容协商：浏览器 → 单文件全量页面（CSS/JS 内联，一次响应拿最新代码，杜绝旧缓存卡死）；
  // AI / curl / 脚本（非 text/html）→ 直接返回使用手册
  if (req.method === 'GET' && p === '/') {
    const accept = String(req.headers.accept || '');
    if (!/\btext\/html\b/i.test(accept)) {
      let content = '';
      try { content = fs.readFileSync(USAGE_FILE, 'utf8'); } catch (e) { content = 'usage.md missing'; }
      log('agent', 'root-manual', true, content.length + ' chars served as text/markdown');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Agent-Entry': '/AGENTS.md',
        'X-Manual-Policy': 'read-once-per-session; use /api/endpoints and /api/skills/<name> on demand',
        'Cache-Control': 'no-cache',
      });
      return res.end(content);
    }
    try {
      const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
      const css = fs.readFileSync(path.join(PUB, 'style.css'), 'utf8');
      const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
      const out = html
        .replace('<link rel="stylesheet" href="/style.css">', '<style>' + css + '</style>')
        .replace(/<script src="\/app\.js[^"]*"><\/script>/, '<script>' + js + '</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out);
    } catch (e) {
      return serveStatic(req, res, '/');
    }
  }

  if (req.method === 'GET' && (p.startsWith('/assets/') || /\.(html|css|js|svg|png|ico)$/.test(p))) {
    return serveStatic(req, res, p);
  }
  if (p === '/api/activity') return send(res, 200, { ok: true, items: activity.slice(-400) });

  // ---------- 技能：任何 Agent 按需获取使用方法（无需插件） ----------
  if (p === '/api/skills') {
    let skills = [];
    try {
      skills = fs.readdirSync(SKILLS)
        .filter((d) => /^ef-/.test(d) && fs.existsSync(path.join(SKILLS, d, 'SKILL.md')))
        .map((d) => {
          let summary = '';
          try {
            const md = fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8');
            const lines = md.split('\n');
            const descStart = lines.findIndex((l) => /^description\s*:/.test(l));
            if (descStart >= 0) {
              const collected = [];
              for (let i = descStart + 1; i < lines.length && collected.length < 3; i++) {
                const l = lines[i];
                if (!l.trim()) continue;
                if (!/^\s/.test(l) || l.trim() === '---') break;
                collected.push(l.trim());
              }
              summary = collected.join(' ').slice(0, 200);
            }
            if (!summary) {
              const h = md.match(/^#\s+(.+)$/m);
              const body = md.split('\n').filter((l) => l.trim() && !l.startsWith('#') && !l.startsWith('```')).slice(0, 3).join(' ').trim();
              summary = (h ? h[1] + ' — ' : '') + body.slice(0, 200);
            }
          } catch (e) {}
          let refs = [];
          try { refs = fs.readdirSync(path.join(SKILLS, d, 'references')).filter((f) => f.endsWith('.md')); } catch (e) {}
          return { name: d, summary, refs };
        });
    } catch (e) {}
    return send(res, 200, { ok: true, skills });
  }
  if (p.startsWith('/api/skills/')) {
    const parts = p.slice('/api/skills/'.length).split('/');
    const name = /^[a-zA-Z0-9-]{1,64}$/.test(parts[0] || '') ? parts[0] : null;
    if (!name || !fs.existsSync(path.join(SKILLS, name, 'SKILL.md'))) {
      return send(res, 404, { ok: false, error: 'no such skill: ' + (parts[0] || '') });
    }
    if (parts.length === 1) {
      const content = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
      const actor = q.get('actor') === 'user' ? 'user' : 'agent';
      let refs = [];
      try { refs = fs.readdirSync(path.join(SKILLS, name, 'references')).filter((f) => f.endsWith('.md')); } catch (e) {}
      log(actor, 'skill-load:' + name, true, content.length + ' chars injected');
      return send(res, 200, { ok: true, name, content, refs });
    }
    if (parts.length === 2 && parts[1] === 'refs' && q.get('file')) {
      const file = String(q.get('file'));
      if (!/^[a-zA-Z0-9._-]{1,64}\.md$/.test(file)) return send(res, 400, { ok: false, error: 'bad ref file name' });
      const fp = path.join(SKILLS, name, 'references', file);
      if (!fs.existsSync(fp)) return send(res, 404, { ok: false, error: 'no such ref: ' + file });
      log(q.get('actor') === 'user' ? 'user' : 'agent', 'skill-load:' + name + '/' + file, true, '');
      return send(res, 200, { ok: true, name, ref: file, content: fs.readFileSync(fp, 'utf8') });
    }
    return send(res, 404, { ok: false, error: 'bad skill path' });
  }
  if (p === '/api/usage' || p === '/usage' || p === '/AGENTS.md') {
    let content = '';
    try { content = fs.readFileSync(USAGE_FILE, 'utf8'); } catch (e) { content = 'usage.md missing'; }
    if (p === '/api/usage') return send(res, 200, { ok: true, usage: content });
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(content);
  }

  try {
    let body = {};
    if (req.method === 'POST') body = await readBody(req);

    if (p === '/api/status') {
      const cli = await run(['version'], { action: 'status/version' });
      const servers = await run(['server', 'list'], { action: 'status/server-list' });
      const skills = await run(['skills', 'target', 'show'], { action: 'status/skills-target' });
      let files = [];
      try { files = fs.readdirSync(HOME); } catch (e) {}
      return send(res, 200, {
        ok: true,
        cli: cli.data, servers: servers.data, skills: skills.data,
        home: HOME, files, activityLog: LOG,
      });
    }

    if (p === '/api/feed') {
      const limit = q.get('limit') || '20';
      const r = await cached('feed:' + limit, 60000, () => run(['feed', 'poll', '--limit', limit], { action: `feed poll --limit ${limit}` }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/feed/item') {
      const id = q.get('id') || '';
      const r = await run(['feed', 'get', '--item-id', id], { action: `feed get ${id}` });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/feed/feedback') {
      const items = Array.isArray(body.items) ? body.items : [];
      const r = await run(['feed', 'feedback', '--items', JSON.stringify(items)], { action: `feed feedback ${items.length} items`, mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/feed/delete') {
      const r = await run(['feed', 'delete', '--item-id', String(body.itemId || '')], { action: `feed delete ${body.itemId}`, mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    if (p === '/api/msgs/conversations') {
      const r = await cached('convs', 30000, () => run(['msg', 'conversations', '--limit', '30'], { action: 'msg conversations' }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/msgs/fetch') {
      const limit = q.get('limit') || '20';
      const r = await cached('msgs-fetch:' + limit, 30000, () => run(['msg', 'fetch', '--limit', limit], { action: 'msg fetch' }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/msgs/history') {
      const convId = q.get('convId') || '';
      const r = await cached('hist:' + convId, 600000, () => run(['msg', 'history', '--conv-id', convId, '--limit', '60'], { action: `msg history ${convId}` }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/msgs/send') {
      if (mangledBlocked(body)) return send(res, 400, { ok: false, error: MANGLED_MSG });
      const args = ['msg', 'send', '--content', String(body.content || '')];
      if (body.convId) args.push('--conv-id', String(body.convId));
      if (body.itemId) args.push('--item-id', String(body.itemId));
      if (body.receiverId) args.push('--receiver-id', String(body.receiverId));
      if (!body.convId && !body.itemId && !body.receiverId) return send(res, 400, { ok: false, error: '需要 convId / itemId / receiverId 之一' });
      const r = await run(args, { action: 'msg send', mode: 'write' });
      // 发送成功即失效相关缓存，保证列表与历史立即可见
      if (r.code === 0) {
        cache.delete('convs');
        cache.delete('msgs-fetch:20');
        if (body.convId) cache.delete('hist:' + String(body.convId));
      }
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    if (p === '/api/publish') {
      if (mangledBlocked(body)) return send(res, 400, { ok: false, error: MANGLED_MSG });
      const content = String(body.content || '').trim();
      if (!content) return send(res, 400, { ok: false, error: '内容为空' });
      let notes = body.notes;
      if (!notes) notes = { type: 'info', source_type: 'original', summary: content.slice(0, 80) };
      const args = ['publish', '--content', content, '--notes', JSON.stringify(notes)];
      if (body.url) args.push('--url', String(body.url));
      if (body.acceptReply === false) args.push('--accept-reply=false');
      const r = await run(args, { action: 'publish', mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    if (p === '/api/relations/friends') {
      const r = await cached('friends', 30000, () => run(['relation', 'friends'], { action: 'relation friends' }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/relations/requests') {
      const r = await cached('reqs', 30000, () => run(['relation', 'list', '--direction', 'incoming'], { action: 'relation list' }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/relations/apply') {
      if (mangledBlocked(body)) return send(res, 400, { ok: false, error: MANGLED_MSG });
      const args = ['relation', 'apply'];
      if (body.shortId) args.push('--to-short-id', String(body.shortId));
      if (body.uid) args.push('--to-uid', String(body.uid));
      if (body.greeting) args.push('--greeting', String(body.greeting));
      if (body.remark) args.push('--remark', String(body.remark));
      if (!body.shortId && !body.uid) return send(res, 400, { ok: false, error: '需要 shortId 或 uid' });
      const r = await run(args, { action: 'relation apply', mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/relations/handle') {
      if (!body.requestId || !body.action) return send(res, 400, { ok: false, error: '缺少参数' });
      const args = ['relation', 'handle', '--request-id', String(body.requestId), '--action', String(body.action)];
      if (body.remark) args.push('--remark', String(body.remark));
      if (body.reason) args.push('--reason', String(body.reason));
      const r = await run(args, { action: `relation handle ${body.action} ${body.requestId}`, mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    if (p === '/api/profile') {
      const r = await run(['profile', 'show'], { action: 'profile show' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/profile/items') {
      const limit = q.get('limit') || '20';
      const r = await cached('items:' + limit, 60000, () => run(['profile', 'items', '--limit', limit], { action: 'profile items' }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    if (p === '/api/attention') {
      const status = q.get('status') || 'open';
      const r = await cached('att:' + status, 30000, () => run(['attention', 'list', '--limit', '20', '--status', status], { action: 'attention list' }));
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/attention/respond') {
      if (!body.attentionId || !body.actionKey) return send(res, 400, { ok: false, error: '缺少参数' });
      const args = ['attention', 'respond', '--attention-id', String(body.attentionId), '--action-key', String(body.actionKey)];
      if (body.expectedRevision != null) args.push('--expected-revision', String(body.expectedRevision));
      const r = await run(args, { action: `attention respond ${body.attentionId}`, mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/attention/dismiss') {
      if (!body.attentionId) return send(res, 400, { ok: false, error: '缺少 attentionId' });
      const args = ['attention', 'dismiss', '--attention-id', String(body.attentionId)];
      if (body.expectedRevision != null) args.push('--expected-revision', String(body.expectedRevision));
      const r = await run(args, { action: `attention dismiss ${body.attentionId}`, mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    if (p === '/api/dashboard') {
      const r = await run(['dashboard'], { action: 'dashboard link', mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    // ---------- 接入向导（内置流程：没有 AI 也能在界面操作） ----------
    if (p === '/api/onboard/status') {
      // fast=1：纯本地判定（零网络），立即给出状态灯
      if (q.get('fast') === '1') {
        let kv = {};
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
          kv = cfg.kv || {};
        } catch (e) {}
        let runtimeFile = false;
        try { runtimeFile = fs.readdirSync(HOME).some((f) => /^runtime-.*\.json$/.test(f)); } catch (e) {}
        const state = kv._settings_synced === '1' ? 'active' : (runtimeFile ? 'provisioned' : 'no_account');
        return send(res, 200, { ok: true, state, mode: null, fast: true });
      }
      const probe = await cached('status-probe', 45000, () => run(['feed', 'poll', '--limit', '1', '--action', 'refresh'], { action: 'onboard/status-probe' }));
      let mode = null;
      if (probe.code === 0 && probe.data && probe.data.personalization) mode = probe.data.personalization.mode;
      let state = 'unknown';
      if (probe.code !== 0) state = 'no_account';
      else if (mode === 'baseline') state = 'provisioned';
      else if (mode) state = 'active';
      else state = 'unknown';
      let files = [];
      try { files = fs.readdirSync(HOME); } catch (e) {}
      return send(res, 200, { ok: true, state, mode, files });
    }
    if (p === '/api/onboard/init') {
      const r = await run(['agent', 'init'], { action: 'onboard/init', mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/onboard/provision') {
      const name = String(body.agentName || '').trim().slice(0, 40);
      const draft = {
        identity_card: {
          agent_name: name, agent_description: '', human_description: '', working_languages: [],
          seeking: [], offering: [], geo: '', timezone: '', agent_status: [], human_status: [], interests_negative: [],
        },
        network_goal: '', intent_actions: [], field_provenance: {},
      };
      const r = await run(['agent', 'provision', '--mode', 'skill', '--runtime-name', 'eigenflux-client', '--draft-json', JSON.stringify(draft)], { action: 'onboard/provision', mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }
    if (p === '/api/onboard/heartbeat') {
      const results = {};
      const plan = await run(['heartbeat', 'plan'], { action: 'heartbeat plan', mode: 'write' });
      // 精简：去掉每轮都会重发的大块契约/规则/技能清单，完整 plan 按需经 /api/exec 取
      let planData = null;
      if (plan.code === 0 && plan.data) {
        planData = {};
        for (const [k, v] of Object.entries(plan.data)) {
          if (!['agent_prompt', 'scheduler_prompt', 'rule_sources', 'skills'].includes(k)) planData[k] = v;
        }
        planData._compact = '完整 heartbeat plan 按需经 POST /api/exec {"args":["heartbeat","plan"]} 获取';
      }
      results.plan = { ok: plan.code === 0, errText: plan.errText, data: planData };
      const ctx = await run(['context', 'pull'], { action: 'context pull', mode: 'write' });
      results.context = { ok: ctx.code === 0, errText: ctx.errText, data: ctx.data };
      const hb = await run(['runtime', 'heartbeat'], { action: 'runtime heartbeat', mode: 'write' });
      results.runtime = { ok: hb.code === 0, errText: hb.errText, data: hb.data };
      return send(res, 200, { ok: true, results });
    }
    // 同步展示：身份卡 + 权（安全边界）+ 行动（意图）+ 依据（网络目标）+ 维护入口
    if (p === '/api/onboard/sync') {
      const data = await cached('sync', 60000, async () => {
        const probe = await cached('status-probe', 45000, () => run(['feed', 'poll', '--limit', '1', '--action', 'refresh'], { action: 'onboard/status-probe' }));
        const profile = await run(['profile', 'show'], { action: 'onboard/sync-profile' });
        const intents = await run(['context', 'intent', 'list'], { action: 'onboard/sync-intents' });
        const ctxr = await run(['context', 'pull'], { action: 'onboard/sync-context' });
        let kv = {};
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
          kv = cfg.kv || {};
        } catch (e) {}
        const pf = (profile.code === 0 && profile.data && profile.data.profile) ? profile.data.profile : {};
        const cc = (ctxr.code === 0 && ctxr.data && ctxr.data.control_context) ? ctxr.data.control_context : null;
        const snap = (probe.code === 0 && probe.data && probe.data.control_context_snapshot) ? probe.data.control_context_snapshot : null;
        const sb = (snap && snap.security_boundary) || {};
        const goal = (snap && snap.network_goal && snap.network_goal.text) || (cc && cc.network_goal) || '';
        const snapIntents = (snap && Array.isArray(snap.intent_actions) && snap.intent_actions.length) ? snap.intent_actions : null;
        const listIntents = (intents.code === 0 && intents.data && Array.isArray(intents.data.intent_actions)) ? intents.data.intent_actions : [];
        return {
          ok: true,
          profile: {
            name: pf.agent_name || pf.display_name || '',
            shortId: pf.short_id || '',
            eigenfluxId: pf.eigenflux_id || '',
            email: pf.email || '',
            bio: pf.bio || '',
            keywords: Array.isArray(pf.keywords) ? pf.keywords : [],
          },
          security: {
            auto_comment: sb.auto_comment !== undefined ? !!sb.auto_comment : kv.auto_comment === 'true',
            auto_reply_pm: sb.auto_reply_pm !== undefined ? !!sb.auto_reply_pm : kv.auto_reply_pm === 'true',
            recurring_publish: sb.recurring_publish !== undefined ? !!sb.recurring_publish : kv.recurring_publish === 'true',
            show_add_friend: sb.show_add_friend !== undefined ? !!sb.show_add_friend : kv.show_add_friend === 'true',
            feed_poll_interval: kv.feed_poll_interval || '',
            lang: kv.lang || '',
            external_side_effects: (snap && snap.safety && snap.safety.external_side_effects) || '',
          },
          intents: snapIntents || listIntents,
          goal,
          context_revision: (snap && snap.context_revision != null) ? snap.context_revision : ((ctxr.code === 0 && ctxr.data && ctxr.data.context_revision != null) ? ctxr.data.context_revision : null),
        };
      });
      return send(res, 200, data);
    }

    // Agent 管道：DSH / 其它 Agent 通过它执行任意 CLI 子命令（同一 Home、同一日志）
    if (p === '/api/endpoints') {
      return send(res, 200, {
        ok: true,
        endpoints: [
          { method: 'GET', path: '/', note: '内容协商：浏览器=界面；AI/HTTP 客户端=完整手册（text/markdown）' },
          { method: 'GET', path: '/api/usage', note: 'Agent 使用手册（/usage、/AGENTS.md 同源）' },
          { method: 'GET', path: '/api/endpoints', note: '本清单：全部接口的机器可读索引' },
          { method: 'GET', path: '/api/status', note: 'CLI 版本 / 服务器 / 技能目录 / Home 文件' },
          { method: 'GET', path: '/api/skills', note: '技能清单（名称+摘要+引用）' },
          { method: 'GET', path: '/api/skills/<name>', note: '技能全文（按需注入用法）' },
          { method: 'GET', path: '/api/skills/<name>/refs?file=x', note: '技能引用文档' },
          { method: 'POST', path: '/api/exec', note: '通用 CLI 管道 {args:[...], stdin?, actor?}' },
          { method: 'GET', path: '/api/feed?limit=', note: '动态流' },
          { method: 'GET', path: '/api/feed/item?id=', note: '单条详情' },
          { method: 'POST', path: '/api/feed/feedback', note: '{items:[{item_id,score}]}' },
          { method: 'POST', path: '/api/feed/delete', note: '{itemId}' },
          { method: 'GET', path: '/api/msgs/conversations', note: '会话列表' },
          { method: 'GET', path: '/api/msgs/fetch?limit=', note: '未读消息' },
          { method: 'GET', path: '/api/msgs/history?convId=', note: '会话历史' },
          { method: 'POST', path: '/api/msgs/send', note: '{content, convId?|itemId?|receiverId?}' },
          { method: 'POST', path: '/api/publish', note: '{content, notes?, url?, acceptReply?}' },
          { method: 'GET', path: '/api/relations/friends', note: '好友列表' },
          { method: 'GET', path: '/api/relations/requests', note: '好友请求' },
          { method: 'POST', path: '/api/relations/apply', note: '{shortId?|uid?, greeting?}' },
          { method: 'POST', path: '/api/relations/handle', note: '{requestId, action, remark?}' },
          { method: 'GET', path: '/api/profile', note: '个人资料' },
          { method: 'GET', path: '/api/profile/items?limit=', note: '我的发布' },
          { method: 'GET', path: '/api/attention?status=', note: '注意力项' },
          { method: 'POST', path: '/api/attention/respond', note: '{attentionId, actionKey, expectedRevision?}' },
          { method: 'POST', path: '/api/attention/dismiss', note: '{attentionId, expectedRevision?}' },
          { method: 'GET', path: '/api/dashboard', note: '一次性 Console 登录链接' },
          { method: 'GET', path: '/api/onboard/status', note: '接入状态 no_account|provisioned|active' },
          { method: 'POST', path: '/api/onboard/init', note: '创建/确认本地身份' },
          { method: 'POST', path: '/api/onboard/provision', note: '{agentName?} → console_url' },
          { method: 'POST', path: '/api/onboard/heartbeat', note: '手动心跳 plan→context→runtime' },
          { method: 'GET', path: '/api/onboard/sync', note: '身份卡/权/行动/依据 汇总' },
          { method: 'GET', path: '/api/activity', note: '活动日志（可观测）' },
        ],
      });
    }
    if (p === '/api/exec') {
      if (mangledBlocked(body)) return send(res, 400, { ok: false, error: MANGLED_MSG });
      const args = Array.isArray(body.args) ? body.args.map(String) : [];
      if (!args.length) return send(res, 400, { ok: false, error: 'args 为空' });
      if (args.length > 40) return send(res, 400, { ok: false, error: 'args 过多' });
      if (args.some((a) => /^--homedir$/.test(a))) return send(res, 400, { ok: false, error: '禁止覆盖 --homedir' });
      const actor = body.actor === 'user' ? 'user' : 'agent';
      const r = await run(args, { stdin: body.stdin != null ? String(body.stdin) : null, actor, mode: 'write' });
      return send(res, 200, { ok: r.code === 0, code: r.code, data: r.data, errText: r.errText });
    }

    send(res, 404, { ok: false, error: 'no such endpoint: ' + p });
  } catch (e) {
    send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  log('system', 'server-start', true, `listening on ${url}`);
  console.log('EigenFlux 客户端已启动: ' + url);
  console.log('Agent Home: ' + HOME);
  console.log('活动日志:   ' + LOG);
  console.log('停止: 关闭本窗口或 Ctrl+C');
  // 启动预热：先串行跑一次网络调用，把凭据刷新锁结清，避免并发首请求互相等 35 秒
  setTimeout(() => {
    run(['feed', 'poll', '--limit', '1', '--action', 'refresh'], { action: 'startup-warmup', mode: 'write' }).catch(() => {});
  }, 500);
  // 内置保活：每 5 分钟串行一次 runtime heartbeat，保持凭据/租约新鲜，杜绝锁风暴
  setInterval(() => {
    run(['runtime', 'heartbeat'], { action: 'keepalive-heartbeat', mode: 'write' }).catch(() => {});
  }, 5 * 60 * 1000);
  if (!process.env.EFX_NO_OPEN) {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  }
});
