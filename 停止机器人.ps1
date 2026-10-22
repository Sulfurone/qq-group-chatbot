$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'data/service.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Host '未找到本工具启动的后台进程。'; exit 0 }
$taskServiceId = [int](Get-Content -LiteralPath $taskPidFile -Raw)
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServiceId" -ErrorAction SilentlyContinue
$taskServerFile = Join-Path $PSScriptRoot 'server.mjs'
if ($taskProcess -and $taskProcess.Name -eq 'node.exe' -and $taskProcess.CommandLine.Contains($taskServerFile)) {
  # PID 文件仅针对本工具的 Node 服务；同时核对监听端口所属进程。
  $taskPort = if ($env:PORT) { [int]$env:PORT } else { 3210 }
  $listener = Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $taskServiceId }
  if ($listener) { Stop-Process -Id $taskServiceId; Write-Host '答疑服务已停止。' }
  else { Write-Host '记录的进程不再是答疑服务，未结束任何进程。' }
} else { Write-Host '答疑服务已经停止。' }
Remove-Item -LiteralPath $taskPidFile -ErrorAction SilentlyContinue
