$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPort = if ($env:PORT) { [int]$env:PORT } else { 3210 }
$taskURL = "http://127.0.0.1:$taskPort"
try { $taskHome = Invoke-WebRequest -Uri $taskURL -SessionVariable taskSession -UseBasicParsing -TimeoutSec 2 }
catch {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '启动机器人.ps1')
  if ($LASTEXITCODE -ne 0) { throw '请先启动答疑管理服务。' }
  $taskHome = Invoke-WebRequest -Uri $taskURL -SessionVariable taskSession -UseBasicParsing -TimeoutSec 5
}
$taskState = Invoke-RestMethod -Uri "$taskURL/api/state" -WebSession $taskSession
if (-not $taskState.napcat.installed) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '安装或启动QQ连接.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'QQ 组件安装没有完成。' }
}
Invoke-RestMethod -Uri "$taskURL/api/qq/start" -Method Post -WebSession $taskSession -Headers @{ 'X-Local-Request'='1' } -ContentType 'application/json' -Body '{}' | Out-Null
for ($taskTry = 0; $taskTry -lt 60; $taskTry++) {
  $taskState = Invoke-RestMethod -Uri "$taskURL/api/state" -WebSession $taskSession
  if ($taskState.napcat.ready) { Start-Process "$taskURL/#qq"; Write-Host 'QQ 登录服务已就绪，在管理页点击账号管理或扫码登录即可。'; exit 0 }
  if ($taskState.napcat.error) { throw $taskState.napcat.error }
  Start-Sleep -Seconds 1
}
throw 'QQ 服务启动超时，请查看 data/napcat.stderr.log。'
