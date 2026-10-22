$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw '未找到 Node.js，请先安装 Node.js 22 或更新版本：https://nodejs.org/' }
$taskPort = if ($env:PORT) { [int]$env:PORT } else { 3210 }
$taskURL = "http://127.0.0.1:$taskPort"
try {
  $existing = Invoke-WebRequest -Uri $taskURL -UseBasicParsing -TimeoutSec 2
  if ($existing.Content -match 'id="settings-form"') { Start-Process $taskURL; Write-Host "机器人已经启动：$taskURL"; exit 0 }
  throw "端口 $taskPort 已被其他服务占用"
} catch {
  if ($_.Exception.Message -match '已被其他服务占用') { throw }
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/ws')) -or -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/@tencent-ai/codebuddy-code/bin/codebuddy'))) {
  $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpmCommand) { & $pnpmCommand.Source install --frozen-lockfile }
  else {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCommand) { throw '缺少依赖，请安装 Node.js（含 npm）后重新运行。' }
    & $npmCommand.Source install
  }
  if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请检查网络连接。' }
}
$taskOutput = Join-Path $PSScriptRoot 'data/service.stdout.log'
$taskError = Join-Path $PSScriptRoot 'data/service.stderr.log'
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data') | Out-Null
$taskServerFile = Join-Path $PSScriptRoot 'server.mjs'
$taskProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $taskServerFile + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $taskOutput -RedirectStandardError $taskError -PassThru
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data/service.pid') -Value $taskProcess.Id -Encoding ascii
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 300
  if ($taskProcess.HasExited) { throw "启动失败，请查看 $taskError" }
  try { $ready = Invoke-WebRequest -Uri $taskURL -UseBasicParsing -TimeoutSec 1; if ($ready.StatusCode -eq 200) { break } } catch {}
}
Start-Process $taskURL
Write-Host "机器人已在后台启动：$taskURL"
Write-Host '停止服务请双击「停止答疑机器人.bat」。'
