$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root "data\runtime"
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Set-Location $root

function Import-DotEnv {
  $envPath = Join-Path $root ".env"
  if (-not (Test-Path $envPath)) {
    return
  }

  Get-Content $envPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
      return
    }

    $parts = $line.Split("=", 2)
    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"')
    if ($key) {
      Set-Item -Path "Env:$key" -Value $value
    }
  }
}

function Get-DotEnvValue($key, $fallback) {
  $envPath = Join-Path $root ".env"
  if (-not (Test-Path $envPath)) {
    return $fallback
  }

  $line = Get-Content $envPath |
    Where-Object { $_ -match "^\s*$([regex]::Escape($key))=" } |
    Select-Object -First 1

  if (-not $line) {
    return $fallback
  }

  return ($line -replace "^\s*$([regex]::Escape($key))=", "").Trim().Trim('"')
}

Import-DotEnv

$openclawCommand = Get-DotEnvValue "OPENCLAW_COMMAND" "openclaw"
$openclawCommandForCmd = if ($openclawCommand -match '\s') { "`"$openclawCommand`"" } else { $openclawCommand }
$codexProxyEnabled = (Get-DotEnvValue "CODEX_PROXY_ENABLED" "false") -eq "true"
$claudeProxyEnabled = (Get-DotEnvValue "CLAUDE_PROXY_ENABLED" "false") -eq "true"
$whisperLocalEnabled = (Get-DotEnvValue "WHISPER_LOCAL_ENABLED" "false") -eq "true"

function Test-Port($port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect("127.0.0.1", $port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500, $false)) {
      return $false
    }

    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Wait-Port($port, $timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Port $port) {
      Write-Host "port $port healthy"
      return $true
    }
    Start-Sleep -Milliseconds 500
  }

  Write-Host "port $port not healthy after ${timeoutSeconds}s"
  return $false
}

$ports = @()
if ($codexProxyEnabled) {
  $ports += [int](Get-DotEnvValue "CODEX_PROXY_PORT" "8787")
}
if ($claudeProxyEnabled) {
  $ports += [int](Get-DotEnvValue "CLAUDE_PROXY_PORT" "8789")
}
if ($whisperLocalEnabled) {
  $ports += [int](Get-DotEnvValue "WHISPER_LOCAL_PORT" "2022")
}
$ports += [int](Get-DotEnvValue "OPENCLAW_CONTROL_PORT" "8788")
$ports += [int](Get-DotEnvValue "WHATSAPP_ASSISTANT_HOOK_PORT" "8790")
$ports += [int](Get-DotEnvValue "OPENCLAW_GATEWAY_PORT" "18789")
foreach ($port in $ports) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    Where-Object { $_ -and $_ -ne $PID } |
    ForEach-Object {
      Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      Write-Host "cleared port $port pid $_"
    }
}

$whatsappInspect = cmd /d /c "$openclawCommandForCmd plugins inspect whatsapp" 2>&1
if ($LASTEXITCODE -ne 0 -or -not ($whatsappInspect | Select-String -Pattern "Status: loaded" -Quiet)) {
  cmd /d /c "$openclawCommandForCmd plugins install clawhub:@openclaw/whatsapp --pin --force"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "openclaw whatsapp plugin install failed; run: cmd /c npm run openclaw:install-whatsapp"
  }
} else {
  Write-Host "openclaw whatsapp plugin already installed"
}

cmd /d /c npm run openclaw:patch-whatsapp-stickers
if ($LASTEXITCODE -ne 0) {
  Write-Host "whatsapp sticker patch failed; native sticker sending may fail"
}

$dispatchPluginPath = Join-Path $root "openclaw-plugins\whatsapp-policy-dispatch"
cmd /d /c "$openclawCommandForCmd plugins install `"$dispatchPluginPath`" --force"
if ($LASTEXITCODE -ne 0) {
  Write-Host "whatsapp-policy-dispatch install failed; auto-reply will not intercept before native agent dispatch"
}

cmd /d /c npm run openclaw:repair-config
if ($LASTEXITCODE -ne 0) {
  Write-Host "openclaw config repair failed; gateway may not start"
}

function Start-Managed($name, $command) {
  $log = Join-Path $runtime "$name.log"
  $pidFile = Join-Path $runtime "$name.pid.json"
  $escapedLog = $log.Replace('"', '\"')
  $cmd = "/d /c $command >> `"$escapedLog`" 2>&1"
  $process = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList $cmd `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru

  $pidInfo = @{
    name = $name
    pid = $process.Id
    command = "cmd.exe"
    args = @($cmd)
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    logPath = $log
  } | ConvertTo-Json -Depth 4

  Set-Content -Path $pidFile -Value $pidInfo
  Write-Host "$name started pid=$($process.Id) log=$log"
}

if ($claudeProxyEnabled) {
  Start-Managed "claude-proxy" "npm run claude-proxy"
} else {
  Write-Host "claude-proxy skipped CLAUDE_PROXY_ENABLED=false"
}
if ($codexProxyEnabled) {
  Start-Managed "codex-proxy" "npm run codex-proxy"
} else {
  Write-Host "codex-proxy skipped CODEX_PROXY_ENABLED=false"
}
if ($whisperLocalEnabled) {
  cmd /d /c npm run warmup:whisper
  if ($LASTEXITCODE -ne 0) {
    Write-Host "whisper-local failed to start; voice transcription may fail"
  }
} else {
  Write-Host "whisper-local skipped WHISPER_LOCAL_ENABLED=false"
}
Start-Managed "openclaw-gateway" "$openclawCommandForCmd gateway run --force --allow-unconfigured"
Start-Managed "openclaw-control" "npm run openclaw:control"
Start-Managed "openclaw-worker" "npm run openclaw:worker"

Write-Host ""
Wait-Port 18789 45 | Out-Null
cmd /d /c npm run warmup:status
