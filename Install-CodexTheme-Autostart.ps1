param([switch]$Remove)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $scriptDir "Start-Codex-Theme.cmd"
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "Codex Theme.lnk"

if ($Remove) {
  if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
  Write-Host "[codex-windows] automatic startup removed."
  exit 0
}

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "Start-Codex-Theme.cmd was not found: $target"
}
if (-not (Test-Path -LiteralPath $startupDir -PathType Container)) {
  New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $scriptDir
$shortcut.WindowStyle = 1
$shortcut.Description = "Start Codex with the local theme"
$shortcut.Save()
Write-Host "[codex-windows] automatic startup installed: $shortcutPath"
