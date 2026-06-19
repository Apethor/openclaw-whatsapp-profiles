param(
  [switch]$NoPause,
  [switch]$LogToFile
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot
$runtime = Join-Path $ProjectRoot "data\runtime"
$transcriptStarted = $false
$exitCode = 1

if ($LogToFile) {
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $logPath = Join-Path $runtime "start-chatbot.log"
  try {
    Start-Transcript -Path $logPath -Append | Out-Null
    $transcriptStarted = $true
  } catch {
    Write-Host "Could not start transcript at ${logPath}: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

try {
  Write-Host "Starting whatsapp-chatbot..." -ForegroundColor Cyan
  Write-Host "Project: $ProjectRoot"
  Write-Host ""

  cmd /c npm run warmup
  $warmupCode = $LASTEXITCODE

  Write-Host ""
  Write-Host "Status:" -ForegroundColor Cyan
  cmd /c npm run warmup:status
  $statusCode = $LASTEXITCODE

  Write-Host ""
  if ($warmupCode -eq 0 -and $statusCode -eq 0) {
    Write-Host "Done. You can keep this window open or close it; services run in the background." -ForegroundColor Green
    $exitCode = 0
  } else {
    Write-Host "Something failed. Check the output above and logs under data\runtime." -ForegroundColor Red
    $exitCode = 1
  }
} catch {
  Write-Host "Startup failed: $($_.Exception.Message)" -ForegroundColor Red
  $exitCode = 1
} finally {
  Write-Host ""
  if (-not $NoPause) {
    Read-Host "Press Enter to close"
  }

  if ($transcriptStarted) {
    Stop-Transcript | Out-Null
  }
}

exit $exitCode
