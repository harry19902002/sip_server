[CmdletBinding()]
param(
  [int]$FrontendPort = 3000,
  [int]$TimeoutSeconds = 180,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RuntimeDirectory = Join-Path $ProjectRoot ".runtime"
$EnvironmentFile = Join-Path $ProjectRoot ".env"
$EnvironmentExample = Join-Path $ProjectRoot ".env.example"
$FrontendPidFile = Join-Path $RuntimeDirectory "frontend.pid"
$FrontendOutputLog = Join-Path $RuntimeDirectory "frontend.out.log"
$FrontendErrorLog = Join-Path $RuntimeDirectory "frontend.err.log"

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Assert-LastExitCode([string]$Message) {
  if ($LASTEXITCODE -ne 0) {
    throw "$Message (exit code: $LASTEXITCODE)"
  }
}

function Get-DotEnvValue([string]$Name) {
  $pattern = "^\s*" + [regex]::Escape($Name) + "\s*=\s*(.*)\s*$"
  $match = Get-Content -LiteralPath $EnvironmentFile |
    Where-Object { $_ -match $pattern } |
    Select-Object -Last 1

  if (-not $match) { return $null }
  $value = [regex]::Match($match, $pattern).Groups[1].Value.Trim()
  return $value.Trim('"').Trim("'")
}

function Test-HttpEndpoint([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Wait-HttpEndpoint([string]$Name, [string]$Url, [int]$Timeout) {
  $deadline = (Get-Date).AddSeconds($Timeout)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpEndpoint $Url) {
      Write-Host "$Name is ready: $Url" -ForegroundColor Green
      return
    }
    Start-Sleep -Seconds 2
  }
  throw "$Name did not become ready within $Timeout seconds: $Url"
}

function Test-DockerEngine {
  $dockerCommand = (Get-Command docker).Source
  $probe = Start-Process -FilePath $dockerCommand -ArgumentList @("info") -WindowStyle Hidden -Wait -PassThru
  return $probe.ExitCode -eq 0
}

function Start-DockerDesktopIfNeeded {
  if (Test-DockerEngine) { return }

  $dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (-not (Test-Path -LiteralPath $dockerDesktop)) {
    throw "Docker Engine is unavailable. Start Docker Desktop (Linux containers) and retry."
  }

  Write-Step "Starting Docker Desktop"
  Start-Process -FilePath $dockerDesktop -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    if (Test-DockerEngine) { return }
  }
  throw "Docker Desktop did not become ready within $TimeoutSeconds seconds."
}

function Stop-ManagedFrontend {
  if (-not (Test-Path -LiteralPath $FrontendPidFile)) { return }

  $savedPid = (Get-Content -LiteralPath $FrontendPidFile -Raw).Trim()
  if ($savedPid -match '^\d+$') {
    $process = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") {
      Write-Step "Stopping the previously managed frontend"
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit(5000)
    }
  }
  Remove-Item -LiteralPath $FrontendPidFile -Force -ErrorAction SilentlyContinue
}

function Assert-FrontendPortAvailable {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $FrontendPort -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { return }

  $ownerIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($ownerId in $ownerIds) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
    if ($processInfo -and $processInfo.Name -eq "node.exe" -and $processInfo.CommandLine -like "*$ProjectRoot*") {
      Write-Step "Stopping the project frontend already listening on port $FrontendPort"
      Stop-Process -Id $ownerId -Force
      Start-Sleep -Seconds 1
      continue
    }
    throw "Port $FrontendPort is occupied by PID $ownerId. Stop that process or use -FrontendPort with another port."
  }
}

Set-Location -LiteralPath $ProjectRoot

Write-Step "Validating prerequisites"
foreach ($commandName in @("node", "npm.cmd", "docker")) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $commandName"
  }
}

$nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]"22.13.0") {
  throw "Node.js 22.13.0 or newer is required; found $nodeVersion."
}

if (-not (Test-Path -LiteralPath $EnvironmentFile)) {
  Copy-Item -LiteralPath $EnvironmentExample -Destination $EnvironmentFile
  throw "Created .env from .env.example. Replace all replace-with-* values, then run this script again."
}

foreach ($name in @("ESL_PASSWORD", "FREESWITCH_API_KEY", "SIP_DEFAULT_PASSWORD")) {
  $value = Get-DotEnvValue $name
  if ([string]::IsNullOrWhiteSpace($value) -or $value -match 'replace-with|change-me|example') {
    throw "Set a non-placeholder value for $name in .env."
  }
}

Start-DockerDesktopIfNeeded
& docker compose config --quiet
Assert-LastExitCode "Docker Compose configuration validation failed"

if ($ValidateOnly) {
  Write-Host "Deployment configuration is valid." -ForegroundColor Green
  exit 0
}

if (-not $SkipInstall) {
  Write-Step "Installing locked Node.js dependencies"
  & npm.cmd ci
  Assert-LastExitCode "npm ci failed"
}

Write-Step "Building and starting FreeSWITCH and the backend API"
if ($SkipBuild) {
  & docker compose up -d
} else {
  & docker compose up -d --build
}
Assert-LastExitCode "Docker Compose startup failed"

$apiPort = Get-DotEnvValue "FREESWITCH_API_PORT"
if ([string]::IsNullOrWhiteSpace($apiPort)) { $apiPort = "3001" }
$apiHealthUrl = "http://127.0.0.1:$apiPort/health"
Wait-HttpEndpoint "Backend API" $apiHealthUrl $TimeoutSeconds

Write-Step "Building the management frontend"
& npm.cmd run build
Assert-LastExitCode "Frontend build failed"

New-Item -ItemType Directory -Path $RuntimeDirectory -Force | Out-Null
Stop-ManagedFrontend
Assert-FrontendPortAvailable
Remove-Item -LiteralPath $FrontendOutputLog, $FrontendErrorLog -Force -ErrorAction SilentlyContinue

Write-Step "Starting the management frontend"
$nodeCommand = (Get-Command node).Source
$frontendProcess = Start-Process `
  -FilePath $nodeCommand `
  -ArgumentList @("node_modules/vinext/dist/cli.js", "start", "--hostname", "0.0.0.0", "--port", "$FrontendPort") `
  -WorkingDirectory $ProjectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $FrontendOutputLog `
  -RedirectStandardError $FrontendErrorLog `
  -PassThru
Set-Content -LiteralPath $FrontendPidFile -Value $frontendProcess.Id -NoNewline

try {
  Wait-HttpEndpoint "Management frontend" "http://127.0.0.1:$FrontendPort/" 60
} catch {
  Write-Host "Frontend stdout: $FrontendOutputLog" -ForegroundColor Yellow
  Write-Host "Frontend stderr: $FrontendErrorLog" -ForegroundColor Yellow
  throw
}

Write-Step "Deployment completed"
& docker compose ps
Write-Host "Management UI : http://127.0.0.1:$FrontendPort/" -ForegroundColor Green
Write-Host "Backend health: $apiHealthUrl" -ForegroundColor Green
Write-Host "Stop services : npm run deploy:stop:windows"
