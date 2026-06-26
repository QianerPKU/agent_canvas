param(
  [switch]$InstallOptional,
  [switch]$SkipNpmInstall,
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-CommandAvailable([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajorVersion {
  if (-not (Test-CommandAvailable "node")) {
    return 0
  }
  $version = (& node -p "process.versions.node.split('.')[0]") 2>$null
  if ($LASTEXITCODE -ne 0) {
    return 0
  }
  return [int]$version
}

function Assert-WingetAvailable {
  if (Test-CommandAvailable "winget") {
    return
  }
  throw "winget was not found. Install Node.js 20+ and Git manually, then rerun this script."
}

function Install-WingetPackage([string]$Id, [string]$Label) {
  if ($CheckOnly) {
    Write-Host "[check] Missing or outdated: $Label"
    return
  }
  Assert-WingetAvailable
  Write-Host "Installing $Label with winget..."
  winget install --id $Id --exact --silent --accept-source-agreements --accept-package-agreements
}

function Ensure-Node {
  $major = Get-NodeMajorVersion
  if ($major -ge 20) {
    Write-Host "[ok] Node.js $((& node -v))"
    return
  }
  Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS"
}

function Ensure-Command([string]$Name, [string]$WingetId, [string]$Label) {
  if (Test-CommandAvailable $Name) {
    Write-Host "[ok] $Label"
    return
  }
  Install-WingetPackage $WingetId $Label
}

function Show-OptionalStatus([string]$Name, [string]$Label, [string]$Hint) {
  if (Test-CommandAvailable $Name) {
    Write-Host "[ok] $Label"
  } else {
    Write-Host "[optional] $Label not found. $Hint"
  }
}

Set-Location -LiteralPath $Root

Write-Host "== Agent Canvas dependency setup =="
Ensure-Node
Ensure-Command "git" "Git.Git" "Git"

if ($InstallOptional) {
  Ensure-Command "gh" "GitHub.cli" "GitHub CLI"
  Ensure-Command "code" "Microsoft.VisualStudioCode" "VS Code CLI"
}

if (-not $CheckOnly -and -not $SkipNpmInstall) {
  if (-not (Test-CommandAvailable "npm")) {
    throw "npm was not found after Node.js setup. Restart the terminal and rerun this script."
  }
  Write-Host "Installing npm workspace dependencies..."
  npm install
}

Show-OptionalStatus "codex" "Codex CLI" "Install Codex, then run 'codex login'."
Show-OptionalStatus "claude" "Claude Code / Claude CLI" "Install Claude Code/CLI or set ANTHROPIC_API_KEY."
Show-OptionalStatus "gh" "GitHub CLI" "Install it if agents should create or merge PRs with gh."
Show-OptionalStatus "code" "VS Code CLI" "Install it if you want file/workspace open buttons."

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  1. Authenticate at least one agent backend: codex login, claude login, or ANTHROPIC_API_KEY."
Write-Host "  2. Start Agent Canvas: npm run start:app"
