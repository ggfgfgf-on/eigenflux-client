# EigenFlux 客户端启动脚本
# 用法: powershell -ExecutionPolicy Bypass -File start.ps1 [-Port 4820]
param([int]$Port = 4820)
$env:EFX_PORT = $Port
$env:EFX_NO_OPEN = $env:EFX_NO_OPEN
Set-Location $PSScriptRoot
node "$PSScriptRoot\server.js"
