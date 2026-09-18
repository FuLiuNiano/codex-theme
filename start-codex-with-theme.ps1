param(
  [string]$CodexExe = "",
  [int]$Port = 9222,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$themeScript = Join-Path $scriptDir "codex-video-theme.mjs"
$themeDir = Join-Path $scriptDir "tools\theme"

function Test-CdpEndpoint {
  param([int]$EndpointPort)
  try {
    $result = Invoke-RestMethod -Uri "http://127.0.0.1:$EndpointPort/json/version" -TimeoutSec 2
    return $null -ne $result.webSocketDebuggerUrl
  } catch {
    return $false
  }
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw "Node.js 22 or newer is required."
}

if (-not (Test-CdpEndpoint -EndpointPort $Port)) {
  $running = Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running) {
    throw "Codex is already running without the local debug port. Close all Codex windows and run this script again with -CodexExe. This script will not terminate Codex."
  }
  if ($NoStart) {
    throw "-NoStart requires Codex to already be running with --remote-debugging-port=$Port."
  }
  if ([string]::IsNullOrWhiteSpace($CodexExe)) {
    throw "Specify the Codex executable on first launch, for example: -CodexExe 'C:\Program Files\WindowsApps\OpenAI.Codex_xxx\app\ChatGPT.exe'"
  }
  $CodexExe = [IO.Path]::GetFullPath($CodexExe)
  if (-not (Test-Path -LiteralPath $CodexExe -PathType Leaf)) {
    throw "Codex executable not found: $CodexExe"
  }
  Start-Process -FilePath $CodexExe -ArgumentList @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$Port"
  ) | Out-Null
}

$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-CdpEndpoint -EndpointPort $Port)) {
  if ((Get-Date) -gt $deadline) {
    throw "Codex did not expose local debug port $Port within 30 seconds."
  }
  Start-Sleep -Milliseconds 300
}

& $nodeCommand.Source $themeScript --port $Port --theme-dir $themeDir

