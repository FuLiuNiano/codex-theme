param(
  [ValidateSet("Start", "Stop", "Watchdog")]
  [string]$Action = "Start",
  [string]$CodexExe = "",
  [int]$Port = 9222,
  [int]$ParentPid = 0,
  [int]$CodexPid = 0,
  [int]$AdapterPid = 0
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = $MyInvocation.MyCommand.Path
$themeScript = Join-Path $scriptDir "codex-video-theme.mjs"
$themeDir = Join-Path $scriptDir "tools\theme"
$statePath = Join-Path $scriptDir ".codex-theme-session.json"

function Get-SafeProcess {
  param([int]$Id)
  if ($Id -le 0) { return $null }
  try { return Get-Process -Id $Id -ErrorAction Stop } catch { return $null }
}

function Stop-OwnedProcess {
  param(
    [int]$Id,
    [string[]]$ExpectedNames
  )
  $process = Get-SafeProcess -Id $Id
  if (-not $process) { return }
  if ($ExpectedNames -and ($ExpectedNames -notcontains $process.ProcessName)) { return }
  try { Stop-Process -Id $Id -Force -ErrorAction SilentlyContinue } catch {}
}

function Test-CdpEndpoint {
  param([int]$EndpointPort)
  try {
    $result = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/json/version" -f $EndpointPort) -TimeoutSec 2
    return $null -ne $result.webSocketDebuggerUrl
  } catch {
    return $false
  }
}

function Wait-CdpEndpoint {
  param([int]$EndpointPort)
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-CdpEndpoint -EndpointPort $EndpointPort)) {
    if ((Get-Date) -gt $deadline) { throw "Codex did not expose the local debug port within 30 seconds." }
    Start-Sleep -Milliseconds 300
  }
}

function Resolve-CodexPath {
  param([string]$RequestedPath)
  if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
    $fullPath = [IO.Path]::GetFullPath($RequestedPath)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Codex executable not found: $fullPath" }
    return $fullPath
  }
  $folders = @(Get-ChildItem -Path "C:\Program Files\WindowsApps\OpenAI.Codex*" -Directory -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)
  foreach ($folder in $folders) {
    $candidate = Join-Path $folder.FullName "app\ChatGPT.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  throw "Codex executable was not found. Pass -CodexExe with the ChatGPT.exe path."
}

function Stop-Session {
  param(
    [int]$WatchdogProcessId = 0,
    [int]$AdapterProcessId = 0,
    [int]$CodexProcessId = 0,
    [int]$ControllerProcessId = 0
  )
  Stop-OwnedProcess -Id $WatchdogProcessId -ExpectedNames @("powershell", "pwsh")
  Stop-OwnedProcess -Id $AdapterProcessId -ExpectedNames @("node")
  Stop-OwnedProcess -Id $CodexProcessId -ExpectedNames @("ChatGPT")
  if ($ControllerProcessId -and $ControllerProcessId -ne $PID) {
    Stop-OwnedProcess -Id $ControllerProcessId -ExpectedNames @("powershell", "pwsh")
  }
  if (Test-Path -LiteralPath $statePath) {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
}

if ($Action -eq "Watchdog") {
  while (Get-SafeProcess -Id $ParentPid) { Start-Sleep -Milliseconds 500 }
  Stop-OwnedProcess -Id $AdapterPid -ExpectedNames @("node")
  Stop-OwnedProcess -Id $CodexPid -ExpectedNames @("ChatGPT")
  exit 0
}

if ($Action -eq "Stop") {
  if (-not (Test-Path -LiteralPath $statePath)) {
    Write-Host "[codex-windows] no active themed session found."
    exit 0
  }
  try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $state = $null }
  if ($state) {
    Stop-Session -WatchdogProcessId ([int]$state.WatchdogPid) -AdapterProcessId ([int]$state.AdapterPid) -CodexProcessId ([int]$state.CodexPid) -ControllerProcessId ([int]$state.ControllerPid)
  } else {
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[codex-windows] themed session stopped."
  exit 0
}

if (Test-Path -LiteralPath $statePath) {
  try { $oldState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $oldState = $null }
  if ($oldState -and (Get-SafeProcess -Id ([int]$oldState.CodexPid))) {
    throw "A themed session is already active. Double-click Stop-Codex-Theme.cmd first."
  }
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
}

if (Test-CdpEndpoint -EndpointPort $Port) {
  throw "Codex is already running with the local debug port. Close it before using the themed launcher."
}
$existingCodex = Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingCodex) {
  throw "Codex is already running. Close it before using the themed launcher."
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw "Node.js 22 or newer is required." }
$resolvedCodex = Resolve-CodexPath -RequestedPath $CodexExe
$codexProcess = $null
$adapterProcess = $null
$watchdogProcess = $null

try {
  $codexProcess = Start-Process -FilePath $resolvedCodex -ArgumentList @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port"
  ) -PassThru
  Wait-CdpEndpoint -EndpointPort $Port
 $adapterProcess = Start-Process -FilePath $nodeCommand.Source -WorkingDirectory $scriptDir -ArgumentList @(
    ('"{0}"' -f $themeScript),
   "--port",
   "$Port",
   "--theme-dir",
    ('"{0}"' -f $themeDir)
 ) -NoNewWindow -PassThru
  $watchdogProcess = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
    "-NoProfile",
   "-ExecutionPolicy",
   "Bypass",
   "-File",
    ('"{0}"' -f $scriptPath),
   "-Action",
    "Watchdog",
    "-ParentPid",
    "$PID",
    "-CodexPid",
    "$($codexProcess.Id)",
    "-AdapterPid",
    "$($adapterProcess.Id)"
  ) -PassThru
  $state = [ordered]@{
    ControllerPid = $PID
    CodexPid = $codexProcess.Id
    AdapterPid = $adapterProcess.Id
    WatchdogPid = $watchdogProcess.Id
    Port = $Port
  }
  ($state | ConvertTo-Json -Compress) | Set-Content -LiteralPath $statePath -Encoding ASCII
  Write-Host "[codex-windows] themed session is running."
  Write-Host "[codex-windows] close this window, press Ctrl+C, or use Stop-Codex-Theme.cmd to close Codex."
  while (Get-SafeProcess -Id $codexProcess.Id) {
    if (-not (Get-SafeProcess -Id $adapterProcess.Id)) { throw "The theme adapter exited unexpectedly." }
    Start-Sleep -Milliseconds 800
  }
} finally {
  Stop-Session -WatchdogProcessId $(if ($watchdogProcess) { $watchdogProcess.Id } else { 0 }) -AdapterProcessId $(if ($adapterProcess) { $adapterProcess.Id } else { 0 }) -CodexProcessId $(if ($codexProcess) { $codexProcess.Id } else { 0 })
}
