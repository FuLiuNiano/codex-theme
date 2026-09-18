$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $scriptDir "Start-Codex-Theme.cmd"
$startupDir = [Environment]::GetFolderPath("Startup")
$startupShortcut = Join-Path $startupDir "Codex Theme.lnk"
$desktopDir = [Environment]::GetFolderPath("Desktop")
$desktopShortcut = Join-Path $desktopDir "Codex.lnk"
$oldDesktopShortcut = Join-Path $desktopDir "Codex Theme.lnk"

if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
  throw "Start-Codex-Theme.cmd was not found: $target"
}
if (Test-Path -LiteralPath $startupShortcut) {
  Remove-Item -LiteralPath $startupShortcut -Force
}
if (Test-Path -LiteralPath $oldDesktopShortcut) {
  Remove-Item -LiteralPath $oldDesktopShortcut -Force
}
if (Test-Path -LiteralPath $desktopShortcut) {
  Remove-Item -LiteralPath $desktopShortcut -Force
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($desktopShortcut)
$shortcut.TargetPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shortcut.Arguments = "`"$scriptDir\Start-Codex-Theme.vbs`""
$shortcut.WorkingDirectory = $scriptDir
$shortcut.WindowStyle = 1
$shortcut.Description = "Start Codex with the local theme"
$knownIcon = Join-Path $scriptDir "tools\codex-blue.ico"
if (Test-Path -LiteralPath $knownIcon -PathType Leaf) {
  $shortcut.IconLocation = "$knownIcon,0"
}
$shortcut.Save()
Write-Host "[codex-windows] startup shortcut removed."
Write-Host "[codex-windows] desktop Codex shortcut replaced: $desktopShortcut"
