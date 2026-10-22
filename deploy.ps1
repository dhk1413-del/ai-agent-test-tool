<#
  AI 机器人问答测试平台 —— 一键部署/启动脚本
  ------------------------------------------------------------------
  为什么需要这个脚本：
  本程序的自动化引擎需要启动一个「受控 Chrome」。Chrome 的多进程 IPC
  依赖 Windows 命名管道，在受限沙箱（如 DSH 的 workspace-write 模式）中
  会被拒绝，表现为「浏览器已启动但调试端口未就绪」。
  因此必须在【普通用户会话】中启动本服务。双击本脚本（或它的桌面快捷方式）
  即可在普通会话中常驻运行。

  用法：
    powershell -ExecutionPolicy Bypass -File deploy.ps1
    powershell -ExecutionPolicy Bypass -File deploy.ps1 -InstallOnly
    powershell -ExecutionPolicy Bypass -File deploy.ps1 -Headless
#>
[CmdletBinding()]
param(
  # 只安装依赖、做环境自检，不启动服务
  [switch]$InstallOnly,
  # 无头运行受控浏览器（看不到浏览器窗口）
  [switch]$Headless,
  # 自定义端口
  [int]$Port = 3789
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  [ERROR] $msg" -ForegroundColor Red }

Write-Host ''
Write-Host '  ============================================' -ForegroundColor White
Write-Host '     AI 机器人问答测试平台 —— 部署 / 启动'      -ForegroundColor White
Write-Host '  ============================================' -ForegroundColor White
Write-Host ''

# ---------- 1. 检查 Node.js ----------
Write-Step '检查 Node.js ...'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Err '未找到 Node.js。请先安装 Node.js 18+ ： https://nodejs.org/'
  exit 1
}
$nodeVer = (& node -v).TrimStart('v')
$major = [int]($nodeVer.Split('.')[0])
Write-Ok "Node.js v$nodeVer  ($($node.Source))"
if ($major -lt 18) {
  Write-Err "Node.js 版本过低（需要 18+，当前 v$nodeVer）。"
  exit 1
}

# ---------- 2. 安装依赖 ----------
Write-Step '检查运行依赖 ...'
if (-not (Test-Path (Join-Path $Root 'node_modules\puppeteer-core'))) {
  Write-Step '首次运行，正在安装依赖（npm install）...'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Err 'npm install 失败。'; exit 1 }
  Write-Ok '依赖安装完成。'
} else {
  Write-Ok '依赖已就绪。'
}

# ---------- 3. 准备数据目录 ----------
foreach ($d in 'data', 'data\runs', 'data\shots', 'chrome-profile') {
  $p = Join-Path $Root $d
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
}
Write-Ok '数据目录已就绪。'

# ---------- 4. 检查受控浏览器 ----------
Write-Step '检查受控浏览器 ...'
$chrome = $env:AI_TESTER_CHROME
if (-not $chrome) {
  $cands = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
  )
  $chrome = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if ($chrome) {
  $ver = (Get-Item $chrome).VersionInfo.ProductVersion
  Write-Ok "找到浏览器：$chrome  (v$ver)"
} else {
  Write-Warn2 '未找到 Chrome / Edge。测试引擎需要浏览器，请安装 Google Chrome。'
}

# ---------- 5. 端口占用 / 服务复用检查 ----------
$env:PORT = "$Port"
$url = "http://127.0.0.1:$Port"

# 5a. 该端口上是否已经是「本程序」在运行？是则直接复用，绝不误杀
$alreadyOurs = $false
try {
  $probe = Invoke-RestMethod "$url/api/health" -TimeoutSec 3
  if ($probe.ok -and $probe.version) { $alreadyOurs = $true }
} catch { }

if ($alreadyOurs) {
  Write-Ok "服务已在运行（端口 $Port），无需重新启动。"
  if ($probe.chrome -eq 'ready') {
    Write-Ok "受控浏览器已就绪（$($probe.chromeVersion)）"
  } else {
    Write-Step '正在启动受控浏览器 ...'
    for ($i = 0; $i -lt 40; $i++) {
      try {
        $probe = Invoke-RestMethod "$url/api/chrome/restart" -Method POST -TimeoutSec 60
        if ($probe.chrome -eq 'ready') { break }
      } catch { }
      Start-Sleep -Milliseconds 700
    }
    if ($probe.chrome -eq 'ready') { Write-Ok '受控浏览器已就绪。' }
    else { Write-Warn2 '受控浏览器未就绪，请关闭其它 Chrome 窗口后在界面点「重启浏览器」。' }
  }
  Start-Process $url | Out-Null
  Write-Host ''
  Write-Ok '已为你打开界面，无需重复启动。'
  exit 0
}

# 5b. 端口被其它程序占用
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $ownerPid = $existing[0].OwningProcess
  $ownerName = try { (Get-Process -Id $ownerPid -ErrorAction Stop).ProcessName } catch { '未知' }
  Write-Warn2 "端口 $Port 被其它程序占用（$ownerName, PID $ownerPid），它不是本程序。"
  if ($InstallOnly) { exit 0 }
  $ans = Read-Host '  是否结束该进程并改用本程序启动？(y/N)'
  if ($ans -notmatch '^[Yy]') {
    Write-Err "已取消。请关闭占用端口的程序，或改用其它端口： -Port 3790"
    exit 1
  }
  try { Stop-Process -Id $ownerPid -Force; Start-Sleep 2 } catch {
    Write-Err "无法结束进程：$($_.Exception.Message)"; exit 1
  }
}

if ($InstallOnly) {
  Write-Host ''
  Write-Ok '环境自检通过（未启动服务）。'
  exit 0
}

# ---------- 6. 启动服务 ----------
Write-Host ''
Write-Step "正在启动服务（端口 $Port）..."
if ($Headless) { $env:AI_TESTER_HEADLESS = '1' }

$nodeExe = (Get-Command node).Source
$logDir  = Join-Path $Root 'data\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$outLog = Join-Path $logDir 'server.out.log'
$errLog = Join-Path $logDir 'server.err.log'

$proc = Start-Process -FilePath $nodeExe -ArgumentList 'server.js' -WorkingDirectory $Root `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

# ---------- 7. 等待服务就绪 ----------
$ok   = $false
$health = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if ($proc.HasExited) { break }
  try {
    $health = Invoke-RestMethod "$url/api/health" -TimeoutSec 3
    $ok = $true
    break
  } catch { }
}

if (-not $ok) {
  Write-Err '服务启动失败。最近日志：'
  if (Test-Path $errLog) { Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host "    $_" } }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 20 | ForEach-Object { Write-Host "    $_" } }
  exit 1
}
Write-Ok "网页服务已就绪：$url  (PID $($proc.Id))"

# ---------- 8. 验证受控浏览器 ----------
Write-Step '正在启动受控浏览器（首次约需 5-15 秒）...'
$chromeState = 'unknown'
for ($i = 0; $i -lt 40; $i++) {
  try {
    $health = Invoke-RestMethod "$url/api/health" -TimeoutSec 3
    if ($health.chrome -eq 'ready') { $chromeState = 'ready'; break }
    if ($health.chrome -eq 'down' -and $i -gt 26) { $chromeState = 'down'; break }
  } catch { }
  Start-Sleep -Milliseconds 700
}

if ($chromeState -eq 'ready') {
  Write-Ok "受控浏览器已就绪（$($health.chromeVersion)）"
} else {
  Write-Warn2 '受控浏览器尚未就绪。请点界面里的「重启浏览器」，或关闭其它 Chrome 窗口后重试。'
}

# ---------- 9. 打开浏览器页面 ----------
Start-Process $url | Out-Null
Write-Host ''
Write-Host '  ============================================' -ForegroundColor Green
Write-Host '     部署完成，服务已在后台运行'                 -ForegroundColor Green
Write-Host '  ============================================' -ForegroundColor Green
Write-Host ''
Write-Host "    访问地址 : $url"
Write-Host "    进程 PID : $($proc.Id)"
Write-Host "    日志目录 : $logDir"
Write-Host ''
Write-Host "    停止服务 : Stop-Process -Id $($proc.Id)" -ForegroundColor DarkGray
Write-Host ''
