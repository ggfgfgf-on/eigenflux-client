# EigenFlux 客户端常驻心跳脚本（客户端自带，任何宿主 AI 都可用代码执行器启动它）
# 作用：① 网关未运行时自动拉起；② 每 10 分钟经网关执行一轮心跳（plan→context→runtime）
# 启动后独立于对话存活（Windows：Start-Process -WindowStyle Hidden 后台运行）
# 日志：本目录 loop.log
$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot 'loop.log'
$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'

$listening = Get-NetTCPConnection -LocalPort 4820 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $env:EFX_NO_OPEN = '1'
  Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory (Split-Path -Parent $PSScriptRoot) -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

try {
  $r = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4820/api/onboard/heartbeat' -ContentType 'application/json' -Body '{}' -TimeoutSec 240
  $plan = if ($r.results.plan.ok) { 'plan=OK' } else { 'plan=FAIL' }
  $ctx  = if ($r.results.context.ok) { 'context=OK' } else { 'context=FAIL' }
  $hb   = if ($r.results.runtime.ok) { 'runtime=OK' } else { 'runtime=FAIL' }
  Add-Content -Path $log -Value "$ts HEARTBEAT $plan | $ctx | $hb"
} catch {
  Add-Content -Path $log -Value "$ts HEARTBEAT ERROR: $($_.Exception.Message)"
}
