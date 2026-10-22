<#
  后台常驻启动器（供 Windows 计划任务调用）
  ------------------------------------------------------------------
  与 deploy.ps1 的区别：
    - 不做交互、不弹窗、不自动打开浏览器
    - 直接以前台阻塞方式运行 server.js，进程生命周期由计划任务托管
    - 标准输出/错误写入 data\logs\
  用法： powershell -NoProfile -ExecutionPolicy Bypass -File run-server.ps1
#>
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$logDir = Join-Path $Root 'data\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# 清理上一次的日志，避免无限增长
$outLog = Join-Path $logDir 'server.out.log'
$errLog = Join-Path $logDir 'server.err.log'
foreach ($f in $outLog, $errLog) {
  if (Test-Path $f) {
    try { Remove-Item $f -Force -ErrorAction Stop } catch { }
  }
}

$nodeExe = (Get-Command node).Source
& $nodeExe 'server.js' 1>> $outLog 2>> $errLog
