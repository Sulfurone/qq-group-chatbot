$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$installDir = Join-Path $PSScriptRoot 'runtime/napcat'
$launcher = Get-ChildItem -LiteralPath $installDir -Recurse -Filter 'napcat.bat' -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '[\\/]bootmain[\\/]' } | Select-Object -First 1
if ($launcher) {
  Write-Host '即将启动 NapCat。请在当前窗口查看二维码、管理地址和管理 Token。'
  Set-Location -LiteralPath $launcher.DirectoryName
  & $launcher.FullName
  exit $LASTEXITCODE
}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$archive = Join-Path $PSScriptRoot 'runtime/NapCat.Shell.Windows.OneKey.zip'
$expected = '46c3ec155aa61f12e89bbf97013a21243d00b0019b5565992a88852d7627f39c'
if (-not (Test-Path -LiteralPath $archive)) {
  Write-Host '正在从 NapCat 官方 GitHub 下载 v4.18.38 安装器……'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.38/NapCat.Shell.Windows.OneKey.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw '安装包 SHA256 校验失败，请删除 runtime 中的 zip 后重试。' }
Expand-Archive -LiteralPath $archive -DestinationPath $installDir -Force
Write-Host '已核对官方安装包 SHA256。即将运行交互式安装器，按提示下载 QQ 与 NapCat 组件。'
Write-Host '安装后运行生成的 napcat.bat；在 NapCat 管理页扫码登录。'
Write-Host '然后在答疑管理页复制连接地址和 Token，填写到 NapCat 的 WebSocket 客户端。'
Set-Location -LiteralPath $installDir
& (Join-Path $installDir 'NapCatInstaller.exe')
