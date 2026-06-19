param(
  [ValidateSet("Install", "Uninstall", "Status", "Run")]
  [string]$Action = "Install",
  [string]$TaskName = "whatsapp-chatbot-warmup",
  [int]$DelaySeconds = 30,
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "start-chatbot.ps1"
$taskPath = "\"
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Get-ChatbotTask {
  Get-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Write-TaskStatus {
  $task = Get-ChatbotTask
  if (-not $task) {
    Write-Host "Scheduled task '$TaskName' is not installed." -ForegroundColor Yellow
    return
  }

  $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $TaskName
  Write-Host "Scheduled task: $TaskName" -ForegroundColor Cyan
  Write-Host "State:          $($task.State)"
  Write-Host "User:           $($task.Principal.UserId)"
  Write-Host "Last run:       $($info.LastRunTime)"
  Write-Host "Last result:    $($info.LastTaskResult)"
  Write-Host "Next run:       $($info.NextRunTime)"
  Write-Host "Action:         $($task.Actions.Execute) $($task.Actions.Arguments)"
}

function Write-RuntimeStatus {
  Write-Host ""
  Write-Host "Runtime status:" -ForegroundColor Cyan
  Push-Location $root
  try {
    cmd /c npm run warmup:status
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $launcher)) {
  throw "Launcher not found: $launcher"
}

if ($Action -eq "Install") {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found on PATH. Install Node.js/npm before installing the startup task."
  }

  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`" -NoPause -LogToFile"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $trigger.Delay = "PT${DelaySeconds}S"
  $actionDef = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument $arguments `
    -WorkingDirectory $root
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)
  $principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited

  Register-ScheduledTask `
    -TaskPath $taskPath `
    -TaskName $TaskName `
    -Action $actionDef `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts the OpenClaw WhatsApp chatbot stack for this checkout at Windows logon." `
    -Force | Out-Null

  Write-Host "Installed scheduled task '$TaskName' for user $currentUser." -ForegroundColor Green
  Write-Host "It will run start-chatbot.ps1 -NoPause -LogToFile after logon."
  Write-Host "Startup log: data\runtime\start-chatbot.log"

  if ($RunNow) {
    Start-ScheduledTask -TaskPath $taskPath -TaskName $TaskName
    Write-Host "Started scheduled task '$TaskName'."
  }

  Write-TaskStatus
  exit 0
}

if ($Action -eq "Uninstall") {
  $task = Get-ChatbotTask
  if (-not $task) {
    Write-Host "Scheduled task '$TaskName' is not installed." -ForegroundColor Yellow
    exit 0
  }

  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  Write-Host "Running chatbot processes were not stopped. Use npm run warmup:stop if you want to stop them."
  exit 0
}

if ($Action -eq "Run") {
  $task = Get-ChatbotTask
  if (-not $task) {
    throw "Scheduled task '$TaskName' is not installed. Run npm run service:install first."
  }

  Start-ScheduledTask -TaskPath $taskPath -TaskName $TaskName
  Write-Host "Started scheduled task '$TaskName'." -ForegroundColor Green
  Start-Sleep -Seconds 3
  Write-TaskStatus
  Write-RuntimeStatus
  exit $LASTEXITCODE
}

Write-TaskStatus
Write-RuntimeStatus
