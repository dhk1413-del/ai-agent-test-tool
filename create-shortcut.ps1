<#
  在桌面创建「AI 测试平台」快捷方式，双击即可在普通用户会话中启动服务。
  用法： powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
#>
$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$target  = Join-Path $Root 'deploy.ps1'

# 定位真实桌面：可能存在 OneDrive 重定向
$candidates = @()
try { $candidates += [Environment]::GetFolderPath('Desktop') } catch { }
$candidates += (Join-Path $env:USERPROFILE 'Desktop')
$candidates += (Join-Path $env:USERPROFILE 'OneDrive\Desktop')
if ($env:OneDrive) { $candidates += (Join-Path $env:OneDrive 'Desktop') }
$desktop = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $desktop) {
  Write-Host '  [ERROR] 未能定位桌面目录。' -ForegroundColor Red
  exit 1
}

$lnkPath = Join-Path $desktop 'AI 测试平台.lnk'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath       = 'powershell.exe'
$lnk.Arguments        = "-NoProfile -ExecutionPolicy Bypass -File `"$target`""
$lnk.WorkingDirectory = $Root
$lnk.Description      = 'AI 机器人问答测试平台（启动本地服务并打开浏览器）'
$lnk.IconLocation     = "$env:SystemRoot\System32\shell32.dll,13"
$lnk.WindowStyle      = 7   # 最小化启动，避免弹出黑色命令行窗口
$lnk.Save()

Write-Host "  [OK] 桌面快捷方式已创建：$lnkPath" -ForegroundColor Green
