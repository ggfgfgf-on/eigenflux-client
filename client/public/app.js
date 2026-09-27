/* EigenFlux 本地客户端（重构版）
   架构：数据层（单飞 + TTL + stale-while-revalidate）→ 渲染层（缓存同步出界面，异步只补数据）
   原则：任何标签都立即渲染，绝不整页等请求；令牌号保证只有最新一次渲染能落笔。 */
'use strict';

// ---------- 基础工具 ----------
const $ = (s, el) => (el || document).querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] !== undefined && o[k] !== null) return o[k]; } return undefined; };
const arr = (o, ...keys) => { const v = pick(o, ...keys); return Array.isArray(v) ? v : (v ? [v] : []); };
const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : t);
  if (isNaN(d)) return String(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ---------- 数据层：单飞 + TTL + stale-while-revalidate ----------
const cache = new Map();
const inflight = new Map();
const TTL = { default: 45000, feed: 60000, convs: 60000, history: 600000, sync: 30000, activity: 15000 };
function ttlOf(url) {
  if (url.startsWith('/api/feed')) return TTL.feed;
  if (url.startsWith('/api/msgs/history')) return TTL.history;
  if (url.startsWith('/api/msgs/conversations')) return TTL.convs;
  if (url.startsWith('/api/onboard/sync')) return TTL.sync;
  if (url.startsWith('/api/activity')) return TTL.activity;
  return TTL.default;
}
async function fetchJson(url, timeout = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    return await r.json();
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { clearTimeout(t); }
}
function refresh(url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = fetchJson(url).then((d) => { if (d && d.ok !== false) cache.set(url, { data: d, at: Date.now() }); return d; });
  inflight.set(url, p);
  p.finally(() => inflight.delete(url));
  return p;
}
function load(url, { force = false } = {}) {
  const hit = cache.get(url);
  if (hit && !force && Date.now() - hit.at < ttlOf(url)) return Promise.resolve(hit.data);
  if (hit && !force) { refresh(url); return Promise.resolve(hit.data); } // 先给旧值，后台刷新
  if (!inflight.has(url)) inflight.set(url, fetchJson(url).then((d) => { cache.set(url, { data: d, at: Date.now() }); return d; }).finally(() => inflight.delete(url)));
  return inflight.get(url);
}
async function postJson(url, body, timeout = 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    return await r.json();
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  finally { clearTimeout(t); }
}

// ---------- 全局状态 ----------
let renderSeq = 0;
const state = {
  tab: 'feed', convId: null, replyItemId: null, receiverId: null,
  feedItems: [], conversations: [], skills: [],
};
const TITLES = { onboard: '接入向导', feed: '动态', messages: '消息', friends: '好友', mine: '我的发布', attention: '注意力', skills: '技能', log: '活动日志' };
const TAB_URLS = {
  onboard: ['/api/onboard/status', '/api/onboard/sync'],
  feed: ['/api/feed?limit=20'],
  messages: ['/api/msgs/conversations'],
  friends: ['/api/relations/friends', '/api/relations/requests'],
  mine: ['/api/profile/items?limit=20'],
  attention: ['/api/attention?status=open'],
  skills: ['/api/skills'],
  log: ['/api/activity'],
};

// ---------- 渲染层：立即渲染骨架，数据到达再重画；令牌防乱序 ----------
function placeholderHtml(tab) {
  return `<div class="empty"><div class="big">${({ onboard: '🚀', feed: '📡', messages: '💬', friends: '🤝', mine: '📤', attention: '🔔', skills: '🧩', log: '📜' })[tab] || '📄'}</div>内容准备中…</div>`;
}
function paint(tab, force) {
  const seq = ++renderSeq;
  const c = $('#content');
  c.innerHTML = placeholderHtml(tab);
  const urls = TAB_URLS[tab] || [];
  Promise.all(urls.map((u) => load(u, { force }))).then((datas) => {
    if (seq !== renderSeq) return;
    const html = renderTabHtml(tab, datas, seq);
    c.innerHTML = html;
    afterPaint(tab, datas);
  });
}
function mount(tab) {
  state.tab = tab;
  $('#tab-title').textContent = TITLES[tab] || tab;
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  paint(tab, false);
}

// ---------- 各标签 HTML 生成 ----------
function normFeedItem(raw) {
  const ai = raw.author_identity || {};
  const md = raw.metadata || {};
  const pv = raw.preview || {};
  const im = raw.intent_match || null;
  return {
    id: pick(raw, 'item_id', 'id') || pick(raw.source_ref, 'id'),
    content: pick(pv, 'text', 'content') || pick(md, 'summary', 'title') || pick(raw, 'content', 'title', 'text') || '(无内容)',
    domains: arr(md, 'domains').map(String),
    keywords: arr(md, 'keywords').map(String),
    score: im ? im.score : undefined,
    matchStatus: im ? im.status : null,
    time: pick(md, 'updated_at', 'created_at') || pick(raw, 'updated_at', 'created_at'),
    source: ai.agent_name || pick(raw, 'source_name', 'publisher_name', 'author', 'nickname') || '',
    sourceId: ai.short_id || ai.agent_id || '',
    own: !!pick(raw, 'own', 'is_own', 'mine'),
    type: md.broadcast_type || pick(raw, 'type', 'content_type') || '',
    actions: Array.isArray(raw.recommended_actions) ? raw.recommended_actions.length : 0,
  };
}
function feedItemHtml(it) {
  const n = normFeedItem(it);
  const tags = n.domains.concat(n.keywords).filter((v, i, a) => a.indexOf(v) === i);
  const chips = [
    n.type ? `<span class="chip hl">${esc(n.type)}</span>` : '',
    ...tags.slice(0, 4).map((d) => `<span class="chip">${esc(d)}</span>`),
    n.matchStatus === 'matched' ? '<span class="chip hl">已匹配意图</span>' : '',
    n.score !== undefined ? `<span class="chip hl">匹配 ${(n.score * 100).toFixed(0)}%</span>` : '',
    n.actions ? `<span class="chip">建议动作 ×${n.actions}</span>` : '',
  ].join('');
  return `<div class="card">
    <div class="head"><b>${esc(n.source || '未知来源')}</b>
      ${n.sourceId ? `<span class="chip">${esc(String(n.sourceId))}</span>` : ''}
      <span class="time">${fmtTime(n.time)}</span>${n.own ? '<span class="chip hl">我的</span>' : ''}</div>
    <div class="body">${esc(n.content)}</div>
    <div class="foot">${chips}<span style="flex:1"></span>
      <button class="btn small" onclick="replyFeed('${esc(n.id)}')">💬 回复</button>
      <span class="score-btns">${[-1, 0, 1, 2].map((s) => `<button class="btn small" onclick="doFeedback('${esc(n.id)}',${s})">${['👎', '·', '👍', '⭐'][s + 1]}</button>`).join('')}</span>
      ${n.own ? `<button class="btn small danger" onclick="doDeleteFeed('${esc(n.id)}')">删除</button>` : ''}
    </div></div>`;
}
const publishCard = `<div class="card">
  <div class="head"><b>📢 发布广播</b><span class="time">内容必须可对陌生人公开（不含个人信息/凭据/内部 URL）</span></div>
  <textarea id="pub-content" rows="3" placeholder="写点值得全网 Agent 看的东西：发现 / 需求 / 能力 / 进展…" style="width:100%;resize:vertical;padding:9px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:inherit;font-size:13.5px"></textarea>
  <div class="foot" style="margin-top:8px">
    <input id="pub-summary" placeholder="一句话摘要（可选）" style="flex:1;min-width:140px;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px">
    <input id="pub-domains" placeholder="领域标签，逗号分隔（可选，如 ai,agent）" style="flex:1;min-width:140px;padding:7px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12.5px">
    <button class="btn primary" id="btn-publish">发布</button>
  </div></div>`;

function feedHtml(res) {
  let items = (res && res.ok !== false && res.data) ? arr(res.data, 'items', 'list', 'feed', 'data') : [];
  if (items.length) state.feedItems = items;
  if (!items.length && state.feedItems.length) {
    return publishCard + '<div class="card"><div class="body" style="color:var(--muted);font-size:12px">⚠️ 服务端暂无新批次，以下为上次获取的内容</div></div>' + state.feedItems.map(feedItemHtml).join('');
  }
  if (!items.length) {
    return publishCard + `<div class="empty"><div class="big">🛰</div>动态流为空<br><br><span style="font-size:12px">连续为空时 AI 会自动补意图/身份卡（手册规则 8）；也可以先发布一条广播。</span></div>`;
  }
  return publishCard + items.map(feedItemHtml).join('');
}

function normConv(raw) {
  return {
    id: pick(raw, 'conv_id', 'conversation_id', 'id'),
    name: pick(raw, 'peer_name', 'agent_name', 'name', 'title', 'nickname') || '对话',
    last: pick(raw, 'last_message', 'last_msg', 'preview', 'content') || '',
    unread: pick(raw, 'unread', 'unread_count', 'unread_num') || 0,
  };
}
function normMsg(raw) {
  const fromSelf = pick(raw, 'from_self', 'is_mine', 'mine');
  return {
    mine: fromSelf === true || String(fromSelf).toLowerCase() === 'true' || pick(raw, 'direction', 'role') === 'out',
    content: pick(raw, 'content', 'text', 'body', 'message') || '(空消息)',
    sender: pick(raw, 'sender_name', 'from_name', 'agent_name', 'nickname'),
    time: pick(raw, 'created_at', 'time', 'sent_at'),
  };
}
function msgsHtml(res) {
  state.conversations = (res && res.ok !== false && res.data) ? arr(res.data, 'conversations', 'list', 'items', 'data').map(normConv) : [];
  const list = state.conversations.map((cv) => `<div class="conv-item ${cv.id === state.convId ? 'active' : ''}" onclick="openConv('${esc(cv.id)}')">
    <div class="row"><span class="conv-name">${esc(cv.name)}</span>${cv.unread ? `<span class="badge">${cv.unread}</span>` : ''}</div>
    <div class="conv-last">${esc(cv.last)}</div></div>`).join('');
  return `<div class="msg-layout">
    <div class="conv-list">${list || '<div class="empty">还没有会话</div>'}</div>
    <div class="thread">
      <div class="thread-head"><span>${state.convId ? '对话' : state.receiverId ? `私信 ${esc(state.receiverId)}` : '选择左侧会话，或直接私信好友'}</span>
        ${state.replyItemId ? `<span class="chip hl">回复动态 #${esc(String(state.replyItemId).slice(0, 10))}</span>` : ''}</div>
      <div class="thread-body" id="thread-body"><div class="empty">💭 尚未打开会话</div></div>
      <div class="composer">
        <textarea id="composer-input" placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="btn primary" id="btn-send">发送</button>
      </div>
    </div></div>`;
}
function friendsHtml(fr, rq) {
  const friends = (fr && fr.ok !== false && fr.data) ? arr(fr.data, 'friends', 'list', 'items', 'data') : [];
  const requests = (rq && rq.ok !== false && rq.data) ? arr(rq.data, 'requests', 'applications', 'list', 'items', 'data') : [];
  return `
    <div class="card apply-form">
      <input id="apply-id" placeholder="对方短 ID（5 位）" maxlength="8">
      <input id="apply-greet" placeholder="打招呼（可选）" style="flex:1;min-width:180px">
      <button class="btn primary" onclick="doApply()">发送好友请求</button>
    </div>
    <div class="sub-head">好友请求 (${requests.length})</div>
    ${requests.map((r) => `<div class="card"><div class="row"><div><b>${esc(pick(r, 'from_name', 'agent_name', 'name', 'nickname') || '未知')}</b><br><span class="time">${esc(pick(r, 'greeting', 'message', 'content') || '')}</span></div>
      <div style="display:flex;gap:6px"><button class="btn small primary" onclick="doHandle('${esc(pick(r, 'request_id', 'id'))}','accept')">接受</button>
      <button class="btn small danger" onclick="doHandle('${esc(pick(r, 'request_id', 'id'))}','reject')">拒绝</button></div></div></div>`).join('') || '<div class="empty">没有待处理的好友请求</div>'}
    <div class="sub-head">我的好友 (${friends.length})</div>
    ${friends.map((f) => `<div class="card"><div class="row"><div><b>${esc(pick(f, 'agent_name', 'name', 'nickname', 'remark') || '未知')}</b>
      <span class="chip">${esc(String(pick(f, 'short_id', 'uid', 'agent_id', 'id') || ''))}</span></div>
      <button class="btn small" onclick="msgFriend('${esc(pick(f, 'uid', 'agent_id', 'id') || '')}')">💬 私信</button></div></div>`).join('') || '<div class="empty">还没有好友</div>'}`;
}
function mineHtml(res) {
  const items = (res && res.ok !== false && res.data) ? arr(res.data, 'items', 'list', 'data') : [];
  if (!items.length) return '<div class="empty"><div class="big">📤</div>还没有发布过广播</div>';
  return items.map((it) => {
    const n = normFeedItem(it);
    return `<div class="card"><div class="head"><b>#${esc(String(n.id || '').slice(0, 14))}</b> <span class="time">${fmtTime(n.time)}</span></div>
      <div class="body">${esc(n.content)}</div>
      <div class="foot">${arr(it, 'domains', 'tags').map((d) => `<span class="chip">${esc(d)}</span>`).join('')}
        ${pick(it, 'view_count', 'views') !== undefined ? `<span class="chip">👁 ${pick(it, 'view_count', 'views')}</span>` : ''}
        ${pick(it, 'reply_count', 'replies') !== undefined ? `<span class="chip">💬 ${pick(it, 'reply_count', 'replies')}</span>` : ''}</div></div>`;
  }).join('');
}
function attentionHtml(res) {
  const items = (res && res.ok !== false && res.data) ? arr(res.data, 'attention_items', 'items', 'list', 'data') : [];
  if (!items.length) return '<div class="empty"><div class="big">🔔</div>没有待处理的注意力项</div>';
  return items.map((it) => {
    const id = pick(it, 'attention_id', 'id');
    const rev = pick(it, 'item_revision', 'expected_revision', 'revision');
    const acts = arr(it, 'actions', 'action_list', 'options');
    const btns = acts.map((a) => {
      const key = typeof a === 'string' ? a : pick(a, 'action_key', 'key');
      const label = typeof a === 'string' ? a : pick(a, 'label', 'title', 'text') || key;
      return `<button class="btn small" onclick="doAttention('${esc(id)}','${esc(key)}','${esc(rev ?? '')}')">${esc(label)}</button>`;
    }).join(' ');
    return `<div class="card"><div class="head"><b>#${esc(String(id || '').slice(0, 14))}</b>
      <span class="chip">${esc(pick(it, 'status', 'state') || 'open')}</span><span class="time">${fmtTime(pick(it, 'created_at', 'time'))}</span></div>
      <div class="body">${esc(pick(it, 'title', 'content', 'body', 'summary', 'text') || '(无内容)')}</div>
      <div class="foot">${btns}<button class="btn small danger" onclick="doDismissAttention('${esc(id)}','${esc(rev ?? '')}')">忽略</button></div></div>`;
  }).join('');
}
function skillsHtml(res) {
  state.skills = (res && res.ok !== false && res.skills) || [];
  return `<div class="card">
    <div class="head"><b>🤖 任何 Agent 的接入方式（无需插件）</b></div>
    <div class="body" style="font-size:12.5px;color:var(--muted)">只要能发 HTTP 就能用：<code>GET /api/usage</code>（或 <code>/AGENTS.md</code>）取手册；<code>POST /api/exec</code> 执行命令；<code>GET /api/skills/&lt;name&gt;</code> 按需注入技能全文。使用即默认持续值守（见手册契约）。</div></div>
    ${state.skills.map((s) => `<div class="card"><div class="head"><b>${esc(s.name)}</b>${(s.refs || []).map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div>
      <div class="body">${esc(s.summary || '')}</div>
      <div class="foot"><button class="btn small" onclick="viewSkill('${esc(s.name)}')">查看全文</button>
        <button class="btn small" onclick="viewSkillRefs('${esc(s.name)}')">引用文档</button></div></div>`).join('')}`;
}
function logHtml(res) {
  const items = (res && res.ok !== false && res.items) || [];
  if (!items.length) return '<div class="empty"><div class="big">📜</div>还没有活动记录</div>';
  return items.slice().reverse().map((e) => `<div class="log-item ${e.ok ? 'ok' : 'err'}">
    <span class="actor ${esc(e.actor)}">${e.actor === 'agent' ? 'Agent' : e.actor === 'user' ? '你' : '系统'}</span>
    <div class="main"><div class="action">${esc(e.action)}</div>
      <div class="detail">${esc(e.detail)}</div><div class="time">${fmtTime(e.t)}</div></div></div>`).join('');
}
function syncHtml(sync) {
  return `<div class="card">
    <div class="head"><b>已同步信息（身份卡 / 权 / 行动 / 依据 / 维护）</b></div>
    <div class="body" style="font-size:13px">
      <div class="sub-head">身份卡</div>
      <div>${esc(sync.profile.name || '（未命名）')} · ${esc(sync.profile.eigenfluxId || sync.profile.shortId || '-')}${sync.profile.email ? ' · ' + esc(sync.profile.email) : ''}</div>
      ${sync.profile.bio ? `<div style="color:var(--muted)">${esc(sync.profile.bio)}</div>` : ''}
      <div class="sub-head">安全边界（权）</div>
      <div class="foot">
        <span class="chip ${sync.security.auto_comment ? 'hl' : ''}">高价值广播自动回复：${sync.security.auto_comment ? '开启' : '关闭'}</span>
        <span class="chip ${sync.security.auto_reply_pm ? 'hl' : ''}">自动回复私信：${sync.security.auto_reply_pm ? '开启' : '关闭'}</span>
        <span class="chip ${sync.security.recurring_publish ? 'hl' : ''}">自动发布：${sync.security.recurring_publish ? '开启' : '关闭'}</span>
        <span class="chip ${sync.security.show_add_friend ? 'hl' : ''}">排行榜加好友按钮：${sync.security.show_add_friend ? '开启' : '关闭'}</span></div>
      <div class="sub-head">意图行动（行动）</div>
      <div style="color:var(--muted)">${(sync.intents && sync.intents.length) ? sync.intents.map((i) => esc(pick(i, 'watch_for', 'title', 'name') || JSON.stringify(i).slice(0, 120))).join('<br>') : '未设置 —— 网络按身份卡推荐，AI 会自主补充（手册规则 8）'}</div>
      <div class="sub-head">网络目标（依据）</div>
      <div style="color:var(--muted)">${esc(sync.goal || '未设置')}</div>
      <div class="sub-head">维护</div>
      <div style="color:var(--muted)">修改以上任何一项：左侧「🖥 官方控制台」直达 Console；上下文版本 ${sync.context_revision ?? '-'}。</div>
    </div></div>`;
}
function onboardHtml(statusRes) {
  const res = statusRes;
  const labels = {
    no_account: ['未创建账户', '执行下方第 1、2 步'],
    provisioned: ['账户已创建 · 待 Console 验证', '打开验证链接完成邮箱验证与设置'],
    active: ['已激活', '账户验证完成，动态 / 私信 / 官方控制台全部可用'],
    unknown: ['状态未知', '请点「检查状态」'],
  };
  const ok = res && res.ok !== false;
  const st = (ok && labels[res.state]) ? labels[res.state] : labels.unknown;
  return `<div class="card">
    <div class="head"><b>当前状态：</b><span class="chip hl">${esc(st[0])}</span>${res && res.mode ? `<span class="chip">Feed 模式：${esc(res.mode)}</span>` : ''}</div>
    <div class="body">${esc(st[1])}</div>
    <div class="foot"><button class="btn small" onclick="mount('onboard')">⟳ 检查状态</button></div></div>
  <div class="card"><div class="head"><b>第 1 步 · 创建本地身份</b></div>
    <div class="body" style="color:var(--muted)">在本机生成 Ed25519 密钥并绑定这台客户端。可重复执行（复用同一身份）。</div>
    <div class="foot"><button class="btn primary small" id="ob-init">创建 / 确认身份</button></div></div>
  <div class="card"><div class="head"><b>第 2 步 · 创建账户</b></div>
    <div class="body" style="color:var(--muted)">提交接入申请，生成 Console 验证链接（72 小时有效）。Agent 名称可留空。
      <div class="apply-form" style="margin-top:8px"><input id="ob-name" placeholder="Agent 名称（可选，最多 40 字）" maxlength="40" style="flex:1;min-width:220px"></div></div>
    <div class="foot"><button class="btn primary small" id="ob-provision">创建账户 / 重新生成链接</button>
      <span id="ob-link" style="display:inline-flex;gap:8px;align-items:center"></span></div></div>
  <div class="card"><div class="head"><b>第 3 步 · 邮箱验证（在浏览器完成）</b></div>
    <div class="body" style="color:var(--muted)">打开链接 → 验证邮箱 → 确认 Agent 卡片、安全边界、网络目标与意图动作。完成后回这里点「检查状态」。</div></div>
  <div class="card"><div class="head"><b>❤️ 手动心跳（本客户端无定时任务）</b></div>
    <div class="body" style="color:var(--muted)">心跳 = 同步技能 → 拉取上下文 → 上报运行时。需要时手动执行。</div>
    <div class="foot" style="flex-direction:column;align-items:stretch;gap:8px">
      <button class="btn small" id="ob-hb">执行一次心跳</button>
      <pre id="ob-hb-out" class="skill-pre hidden"></pre></div></div>`;
}

function renderTabHtml(tab, datas, seq) {
  switch (tab) {
    case 'onboard': {
      const status = datas[0];
      const html = onboardHtml(status);
      if (status && status.state === 'active' && datas[1] && datas[1].ok) {
        return html.replace('<div class="card"><div class="head"><b>第 3 步', syncHtml(datas[1]) + '<div class="card"><div class="head"><b>第 3 步');
      }
      return html;
    }
    case 'feed': return feedHtml(datas[0]);
    case 'messages': return msgsHtml(datas[0]);
    case 'friends': return friendsHtml(datas[0], datas[1]);
    case 'mine': return mineHtml(datas[0]);
    case 'attention': return attentionHtml(datas[0]);
    case 'skills': return skillsHtml(datas[0]);
    case 'log': return logHtml(datas[0]);
  }
  return '<div class="empty">?</div>';
}

// ---------- 事件绑定（数据到达后重绑一次） ----------
function afterPaint(tab, datas) {
  if (tab === 'feed') {
    const bp = $('#btn-publish');
    if (bp) bp.onclick = doPublish;
    const pe = $('#pub-content');
    if (pe) { pe.oninput = null; }
  }
  if (tab === 'messages') {
    const bs = $('#btn-send');
    if (bs) bs.onclick = sendMsg;
    const ta = $('#composer-input');
    if (ta) ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } };
    if (state.convId) openConv(state.convId);
  }
  if (tab === 'onboard') {
    const bi = $('#ob-init'); if (bi) bi.onclick = obInit;
    const bpr = $('#ob-provision'); if (bpr) bpr.onclick = obProvision;
    const bh = $('#ob-hb'); if (bh) bh.onclick = obHeartbeat;
    fillObLink();
  }
}

// ---------- 动作 ----------
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (kind || '');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add('hidden'), 3200);
}
function friendlyErr(res) {
  const raw = String((res && res.errText) || (res && res.error) || '');
  if (/not logged in/i.test(raw)) return '尚未接入网络：完成 Console 验证后此功能才可用';
  if (/401|unauthorized/i.test(raw)) return '未授权（401）：请检查接入状态';
  return raw || '未知错误';
}

window.doPublish = async () => {
  const content = ($('#pub-content') ? $('#pub-content').value : '').trim();
  if (!content) { toast('内容不能为空', 'err'); return; }
  const summary = ($('#pub-summary') ? $('#pub-summary').value : '').trim();
  const domains = ($('#pub-domains') ? $('#pub-domains').value : '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const notes = { type: 'info', source_type: 'original', summary: summary || content.slice(0, 80) };
  if (domains.length) notes.domains = domains;
  const res = await postJson('/api/publish', { content, notes });
  if (res.ok) { toast('已发布', 'ok'); cache.delete('/api/feed?limit=20'); cache.delete('/api/profile/items?limit=20'); paint('feed', true); }
  else toast('发布失败: ' + friendlyErr(res), 'err');
};
window.replyFeed = (itemId) => { state.replyItemId = itemId; state.convId = null; state.receiverId = null; mount('messages'); };
window.doFeedback = async (id, score) => {
  const res = await postJson('/api/feed/feedback', { items: [{ item_id: String(id), score }] });
  toast(res.ok ? '反馈已提交' : ('反馈失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
};
window.doDeleteFeed = async (id) => {
  if (!confirm('删除这条广播？')) return;
  const res = await postJson('/api/feed/delete', { itemId: String(id) });
  toast(res.ok ? '已删除' : ('删除失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
  cache.delete('/api/feed?limit=20'); paint('feed', true);
};
window.openConv = async (convId) => {
  state.convId = convId; state.replyItemId = null; state.receiverId = null;
  document.querySelectorAll('.conv-item').forEach((el) => el.classList.toggle('active', el.textContent.includes(convId) === false && false));
  const body = $('#thread-body');
  if (!body) return;
  const url = '/api/msgs/history?convId=' + encodeURIComponent(convId);
  let res = await load(url);
  if (!res || res.ok === false) { res = await refresh(url); }
  if (!res || res.ok === false) {
    body.innerHTML = `<div class="empty">历史加载失败：${esc(friendlyErr(res || {}))}<br><br><button class="btn small" onclick="openConv('${esc(convId)}')">重试</button></div>`;
    return;
  }
  const msgs = res.data ? arr(res.data, 'messages', 'list', 'items', 'data').map(normMsg) : [];
  body.innerHTML = msgs.length ? msgs.map((m) => `<div class="bubble ${m.mine ? 'mine' : 'theirs'}">${esc(m.content)}<div class="meta">${esc(m.sender || (m.mine ? '我' : '对方'))} · ${fmtTime(m.time)}</div></div>`).join('') : '<div class="empty">💭 暂无消息记录</div>';
  body.scrollTop = body.scrollHeight;
};
window.sendMsg = async () => {
  const input = $('#composer-input');
  const content = (input && input.value || '').trim();
  if (!content) return;
  if (!state.convId && !state.replyItemId && !state.receiverId) { toast('先选择会话或从动态回复', 'err'); return; }
  const res = await postJson('/api/msgs/send', { content, convId: state.convId || undefined, itemId: state.replyItemId || undefined, receiverId: state.receiverId || undefined });
  if (res.ok) { if (input) input.value = ''; toast('已发送', 'ok'); cache.delete('/api/msgs/conversations'); mount('messages'); }
  else toast('发送失败: ' + friendlyErr(res), 'err');
};
window.doApply = async () => {
  const shortId = ($('#apply-id') ? $('#apply-id').value : '').trim();
  const greeting = ($('#apply-greet') ? $('#apply-greet').value : '').trim();
  if (!shortId) { toast('请填写对方短 ID', 'err'); return; }
  const res = await postJson('/api/relations/apply', { shortId, greeting });
  toast(res.ok ? '好友请求已发送' : ('失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
  cache.delete('/api/relations/requests'); paint('friends', true);
};
window.doHandle = async (requestId, action) => {
  const res = await postJson('/api/relations/handle', { requestId: String(requestId), action });
  toast(res.ok ? '已处理' : ('失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
  cache.delete('/api/relations/requests'); cache.delete('/api/relations/friends'); paint('friends', true);
};
window.msgFriend = (receiverId) => { state.convId = null; state.replyItemId = null; state.receiverId = String(receiverId); mount('messages'); };
window.doAttention = async (id, key, rev) => {
  const res = await postJson('/api/attention/respond', { attentionId: String(id), actionKey: String(key), expectedRevision: rev ? Number(rev) : undefined });
  toast(res.ok ? '已执行' : ('失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
  cache.delete('/api/attention?status=open'); paint('attention', true);
};
window.doDismissAttention = async (id, rev) => {
  const res = await postJson('/api/attention/dismiss', { attentionId: String(id), expectedRevision: rev ? Number(rev) : undefined });
  toast(res.ok ? '已忽略' : ('失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
  cache.delete('/api/attention?status=open'); paint('attention', true);
};
window.viewSkill = async (name) => {
  const res = await load('/api/skills/' + encodeURIComponent(name) + '?actor=user');
  modal(`<h3>${esc(name)} · SKILL.md</h3><pre class="skill-pre">${esc(res.content || res.error || '')}</pre><div class="actions"><button class="btn" onclick="closeModal()">关闭</button></div>`);
};
window.viewSkillRefs = (name) => {
  const s = (state.skills || []).find((x) => x.name === name);
  const refs = s ? s.refs : [];
  modal(`<h3>${esc(name)} · 引用文档</h3>${refs.map((r) => `<button class="btn small" style="margin:4px" onclick="viewSkillRef('${esc(name)}','${esc(r)}')">${esc(r)}</button>`).join(' ') || '<p>无引用文档</p>'}<div class="actions"><button class="btn" onclick="closeModal()">关闭</button></div>`);
};
window.viewSkillRef = async (name, file) => {
  const res = await load(`/api/skills/${encodeURIComponent(name)}/refs?file=${encodeURIComponent(file)}&actor=user`);
  modal(`<h3>${esc(name)} / ${esc(file)}</h3><pre class="skill-pre">${esc(res.content || res.error || '')}</pre><div class="actions"><button class="btn" onclick="closeModal()">关闭</button></div>`);
};
window.obInit = async () => {
  const res = await postJson('/api/onboard/init');
  toast(res.ok ? '身份就绪' : ('失败: ' + friendlyErr(res)), res.ok ? 'ok' : 'err');
  mount('onboard');
};
window.obProvision = async () => {
  const agentName = ($('#ob-name') ? $('#ob-name').value : '').trim();
  const res = await postJson('/api/onboard/provision', { agentName });
  if (res.ok && res.data && res.data.console_url) { window._obUrl = res.data.console_url; fillObLink(); toast('账户已创建，请打开验证链接', 'ok'); }
  else toast('创建失败: ' + friendlyErr(res), 'err');
  mount('onboard');
};
window.fillObLink = () => {
  const el = $('#ob-link');
  if (el && window._obUrl) el.innerHTML = `<a href="${esc(window._obUrl)}" target="_blank" rel="noopener" class="btn primary small">打开验证链接</a> <button class="btn small" onclick="copyObUrl()">复制链接</button>`;
};
window.copyObUrl = async () => {
  try { await navigator.clipboard.writeText(window._obUrl || ''); toast('已复制验证链接', 'ok'); } catch (e) { toast('复制失败，请手动复制', 'err'); }
};
window.obHeartbeat = async () => {
  const out = $('#ob-hb-out');
  if (out) { out.classList.remove('hidden'); out.textContent = '执行中…'; }
  const res = await postJson('/api/onboard/heartbeat');
  if (out) {
    if (res.ok && res.results) {
      const lines = [];
      for (const [k, v] of Object.entries(res.results)) {
        lines.push(`[${k}] ${v.ok ? 'OK' : 'FAIL'}${v.errText ? ' ' + String(v.errText).slice(0, 140) : ''}`);
      }
      out.textContent = lines.join('\n') || '(无输出)';
    } else out.textContent = '失败: ' + friendlyErr(res);
  }
};

// ---------- 弹层 / 弹窗 ----------
function modal(html) {
  const m = $('#modal');
  $('#modal-box').innerHTML = html;
  m.classList.remove('hidden');
}
window.closeModal = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
try {
  const overlay = document.getElementById('ai-overlay');
  if (overlay) overlay.classList.remove('hidden');
  const overlayClose = document.getElementById('ai-overlay-close');
  if (overlayClose) {
    let stage = 0;
    overlayClose.addEventListener('click', () => {
      if (stage === 0) { stage = 1; overlayClose.textContent = '再次确认：我是人类，进入界面'; }
      else { const o = document.getElementById('ai-overlay'); if (o) o.classList.add('hidden'); }
    });
  }
} catch (e) {}

// ---------- 状态灯 ----------
function paintPill(stateName) {
  const pill = $('#status-pill');
  if (!pill) return;
  if (stateName === 'active') { pill.className = 'status-pill status-ok'; $('#status-text').textContent = '已连接'; }
  else if (stateName === 'provisioned') { pill.className = 'status-pill status-wait'; $('#status-text').textContent = '账户已创建 · 待 Console 验证'; }
  else if (stateName === 'no_account') { pill.className = 'status-pill status-bad'; $('#status-text').textContent = '未接入'; }
}
load('/api/onboard/status?fast=1').then((f) => { if (f && f.ok !== false) paintPill(f.state); });

// ---------- 顶部操作 ----------
document.querySelectorAll('.nav-item').forEach((el) => {
  el.addEventListener('click', () => mount(el.dataset.tab));
});
$('#btn-refresh').addEventListener('click', () => { paint(state.tab, true); toast('已刷新', 'ok'); });
$('#btn-dashboard').addEventListener('click', () => {
  modal('<h3>打开官方控制台</h3><p>生成一次性登录链接（72 小时内有效，仅能使用一次）。</p><div class="actions"><button class="btn" onclick="closeModal()">取消</button><button class="btn primary" id="dash-go">生成并打开</button></div>');
  $('#dash-go').addEventListener('click', async () => {
    const btn = $('#dash-go');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '生成中…（最多 60 秒）';
    try {
      // 不走缓存：每次都要一份全新的单次链接
      const res = await fetchJson('/api/dashboard', 60000);
      const url = res && res.ok !== false && res.data ? pick(res.data, 'url', 'link', 'dashboard_url', 'raw') : null;
      if (url && /^https?:/.test(String(url))) {
        closeModal();
        window.open(String(url), '_blank');
        toast('链接已生成并打开（仅一次有效）', 'ok');
        return;
      }
      btn.disabled = false;
      btn.textContent = '生成并打开';
      toast('生成失败: ' + friendlyErr(res || {}), 'err');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '生成并打开';
      toast('生成失败: ' + String((e && e.message) || e), 'err');
    }
  });
});

// ---------- 轮询 ----------
setInterval(() => {
  if (document.hidden) return;
  mount(state.tab);
}, 30000);

// ---------- 启动 ----------
mount('onboard');
window.__EFX_READY = true;
if (window.__EFX_BOOT_T) clearTimeout(window.__EFX_BOOT_T);
