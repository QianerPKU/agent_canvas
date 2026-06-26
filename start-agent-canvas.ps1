param(
  [int]$ServerPort = 4317,
  [int]$WebPort = 5317,
  [string]$ProjectsRoot = "",
  [string]$ProjectRoot = "",
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Escape-PowerShellSingleQuotedString([string]$Value) {
  return $Value.Replace("'", "''")
}

function Test-CommandAvailable([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Test-TcpPort([int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connect = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(500)) {
      return $false
    }
    $client.EndConnect($connect)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  throw "Timed out waiting for $Url"
}

function Start-AgentCanvasProcess([string]$Title, [string]$Command) {
  Start-Process -FilePath "powershell.exe" -WorkingDirectory $Root -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "& { `$Host.UI.RawUI.WindowTitle = '$Title'; $Command }"
  )
}

if (-not (Test-CommandAvailable "node")) {
  throw "Node.js was not found. Install Node.js 20 or newer first."
}

if (-not (Test-CommandAvailable "npm")) {
  throw "npm was not found. Install Node.js 20 or newer first."
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  throw "Dependencies are not installed. Run 'npm install' once from the repository root."
}

$escapedRoot = Escape-PowerShellSingleQuotedString $Root
$escapedProjectsRoot = Escape-PowerShellSingleQuotedString $ProjectsRoot
$escapedProjectRoot = Escape-PowerShellSingleQuotedString $ProjectRoot
$projectEnvCommand = ""
if ($ProjectsRoot.Trim().Length -gt 0) {
  $projectEnvCommand += "`$env:AGENT_CANVAS_PROJECTS_ROOT='$escapedProjectsRoot'; "
}
if ($ProjectRoot.Trim().Length -gt 0) {
  $projectEnvCommand += "`$env:AGENT_CANVAS_PROJECT_ROOT='$escapedProjectRoot'; "
}

if (Test-TcpPort $ServerPort) {
  Write-Host "Backend port $ServerPort is already in use; reusing the existing process."
} else {
  Write-Host "Starting Agent Canvas backend on port $ServerPort..."
  Start-AgentCanvasProcess "Agent Canvas Backend" "Set-Location -LiteralPath '$escapedRoot'; $projectEnvCommand`$env:PORT='$ServerPort'; npm run dev --workspace apps/server"
}

Wait-HttpOk "http://127.0.0.1:$ServerPort/api/health" 45

if (Test-TcpPort $WebPort) {
  Write-Host "Frontend port $WebPort is already in use; reusing the existing process."
} else {
  Write-Host "Starting Agent Canvas frontend on port $WebPort..."
  Start-AgentCanvasProcess "Agent Canvas Frontend" "Set-Location -LiteralPath '$escapedRoot'; $projectEnvCommand`$env:SERVER_PORT='$ServerPort'; npm run dev --workspace apps/web -- --host 127.0.0.1 --port $WebPort"
}

$url = "http://127.0.0.1:$WebPort/"
Wait-HttpOk $url 45

Write-Host "Agent Canvas is ready: $url"
if (-not $NoBrowser) {
  Start-Process $url
}
