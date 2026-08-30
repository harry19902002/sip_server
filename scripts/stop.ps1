[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$FrontendPidFile = Join-Path $ProjectRoot ".runtime\frontend.pid"

if (Test-Path -LiteralPath $FrontendPidFile) {
  $savedPid = (Get-Content -LiteralPath $FrontendPidFile -Raw).Trim()
  if ($savedPid -match '^\d+$') {
    $process = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq "node") {
      Stop-Process -Id $process.Id -Force
      $process.WaitForExit(5000)
      Write-Host "Management frontend stopped."
    }
  }
  Remove-Item -LiteralPath $FrontendPidFile -Force -ErrorAction SilentlyContinue
}

Set-Location -LiteralPath $ProjectRoot
& docker compose down
if ($LASTEXITCODE -ne 0) { throw "Docker Compose shutdown failed (exit code: $LASTEXITCODE)" }
Write-Host "FreeSWITCH and backend API stopped. Persistent volumes were preserved."
