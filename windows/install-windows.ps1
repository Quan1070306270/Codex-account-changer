param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  [string]$PairingCode = "",
  [switch]$Repair
)

$ErrorActionPreference = "Stop"
$SwitcherVersion = "1.8.0"
$SupportDir = Join-Path $env:LOCALAPPDATA "GPTAccountSwitcher"
$LogsDir = Join-Path $SupportDir "logs"
$BackupsDir = Join-Path $SupportDir "backups"
$ConfigPath = Join-Path $SupportDir "config.json"
$AgentPath = Join-Path $SupportDir "windows-agent.ps1"
$LauncherPath = Join-Path $SupportDir "start-agent.vbs"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValue = "GPTAccountSwitcher"
$TaskName = "GPT Account Switcher"
$InstallationIdPath = Join-Path $SupportDir "installation.id"

$installerCreatedNew = $false
$installerMutex = New-Object Threading.Mutex($true, "Local\GPTAccountSwitcherInstaller", [ref]$installerCreatedNew)
if (-not $installerCreatedNew) {
  Write-Host "Another installation or repair is already running."
  exit 0
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

try {
  Write-Host "[1/5] Checking the server..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ServerUrl = $ServerUrl.TrimEnd("/")
  $serverUri = [Uri]$ServerUrl
  if ($serverUri.Scheme -ne "https" -and $serverUri.Host -notin @("127.0.0.1", "localhost")) {
    throw "Remote servers must use HTTPS."
  }

  New-Item -ItemType Directory -Force -Path $SupportDir, $LogsDir, $BackupsDir | Out-Null
  if (Test-Path $InstallationIdPath) {
    $InstallationId = (Get-Content $InstallationIdPath -Raw).Trim()
  } else {
    $InstallationId = [Guid]::NewGuid().ToString("N")
    Write-Utf8NoBom $InstallationIdPath $InstallationId
  }
  if ($InstallationId -notmatch '^[a-zA-Z0-9._-]{8,128}$') {
    $InstallationId = [Guid]::NewGuid().ToString("N")
    Write-Utf8NoBom $InstallationIdPath $InstallationId
  }
  $downloads = @{
    "usage-collector.mjs" = "usage-collector.mjs"
    "install-usage-runtime.ps1" = "install-usage-runtime.ps1"
    "windows-agent.ps1" = "windows-agent.ps1"
    "apply-switch.ps1" = "apply-switch-windows.ps1"
    "uninstall-windows.ps1" = "uninstall-windows.ps1"
  }
  Write-Host "[2/5] Downloading switcher files..."
  foreach ($entry in $downloads.GetEnumerator()) {
    $destination = Join-Path $SupportDir $entry.Key
    $downloadPath = "$destination.download.$PID"
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$ServerUrl/downloads/$($entry.Value)" -OutFile $downloadPath
    Move-Item $downloadPath $destination -Force
  }
  Write-Host "Preparing usage collector runtime (first install may take a few minutes)..."
  & (Join-Path $SupportDir "install-usage-runtime.ps1")

  $existing = $null
  $existingIsValid = $false
  $activeServerAccountId = ""
  if (Test-Path $ConfigPath) {
    try {
      $existing = Get-Content $ConfigPath -Raw | ConvertFrom-Json
      if ($existing.deviceId -and $existing.deviceToken) {
        $pingHeaders = @{
          Authorization = "Bearer $($existing.deviceToken)"
          "X-Switcher-Version" = $SwitcherVersion
          "X-Device-Installation-Id" = $InstallationId
        }
        $ping = Invoke-RestMethod -Method Get -TimeoutSec 20 -Uri "$ServerUrl/api/device/ping" -Headers $pingHeaders
        $existingIsValid = [bool]$ping.ok
        $activeServerAccountId = [string]$ping.activeAccountId
      }
    } catch {
      $existingIsValid = $false
    }
  }

  if ($existingIsValid) {
    $configData = [ordered]@{
      serverUrl = $ServerUrl
      deviceId = [string]$existing.deviceId
      deviceToken = [string]$existing.deviceToken
      installationId = $InstallationId
      version = $SwitcherVersion
    }
  } else {
    if ($Repair) { throw "The existing device identity is no longer valid. Use Connect Windows to pair this PC again." }
    if (-not $PairingCode) { throw "A pairing code is required for a new installation." }
    $headers = @{ "X-Switcher-Version" = $SwitcherVersion }
    $body = @{ code = $PairingCode; name = $env:COMPUTERNAME; installationId = $InstallationId }
    $registered = Invoke-RestMethod -Method Post -TimeoutSec 30 -Uri "$ServerUrl/api/device/register" -Headers $headers -ContentType "application/x-www-form-urlencoded" -Body $body
    if (-not $registered.deviceId -or -not $registered.token) {
      throw "The server did not return a valid device token."
    }
    $configData = [ordered]@{
      serverUrl = $ServerUrl
      deviceId = [string]$registered.deviceId
      deviceToken = [string]$registered.token
      installationId = $InstallationId
      version = $SwitcherVersion
    }
  }
  Write-Utf8NoBom $ConfigPath ($configData | ConvertTo-Json)
  Write-Host "[3/5] Saving this PC connection..."

  $statePath = Join-Path $SupportDir "state.json"
  if ($existingIsValid -and $activeServerAccountId -match '^[0-9a-fA-F-]+$' -and (Test-Path $statePath)) {
    $stateData = Get-Content $statePath -Raw | ConvertFrom-Json
    $stateData | Add-Member -NotePropertyName serverAccountId -NotePropertyValue $activeServerAccountId -Force
    Write-Utf8NoBom $statePath ($stateData | ConvertTo-Json)
  }

  $CodexDir = Join-Path $env:USERPROFILE ".codex"
  New-Item -ItemType Directory -Force -Path $CodexDir | Out-Null
  $authPath = Join-Path $CodexDir "auth.json"
  $initialBackup = Join-Path $BackupsDir "auth-before-switcher.json"
  if ((Test-Path $authPath) -and -not (Test-Path $initialBackup)) {
    Copy-Item $authPath $initialBackup
  }

  $escapedAgentPath = $AgentPath.Replace('"', '""')
  $launcher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedAgentPath""", 0, False
"@
  Write-Utf8NoBom $LauncherPath $launcher

  $runCommand = 'wscript.exe "' + $LauncherPath + '"'
  New-Item -Path $RunKey -Force | Out-Null
  New-ItemProperty -Path $RunKey -Name $RunValue -Value $runCommand -PropertyType String -Force | Out-Null

  try {
    Write-Host "[4/5] Updating automatic startup..."
    $taskAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\wscript.exe") -Argument ('"' + $LauncherPath + '"')
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $taskSettings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Description "Keeps the GPT account switcher connected after sign-in." -Force | Out-Null
  } catch {
    # The per-user Run entry remains the fallback on restricted PCs.
  }

  $pidPath = Join-Path $SupportDir "agent.pid"
  if (Test-Path $pidPath) {
    $oldPid = [int](Get-Content $pidPath -ErrorAction SilentlyContinue)
    if ($oldPid) {
      $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction SilentlyContinue
      if ($oldProcess.CommandLine -like "*windows-agent.ps1*") { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
    }
    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  }

  Write-Host "[5/5] Starting the background switcher..."
  Start-Process (Join-Path $env:SystemRoot "System32\wscript.exe") -WindowStyle Hidden -ArgumentList ('"' + $LauncherPath + '"')
  $agentStarted = $false
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $pidPath) { $agentStarted = $true; break }
  }
  if (-not $agentStarted) { throw "The background switcher did not start. Check $LogsDir\agent.log." }

  $result = if ($Repair) { "Repair complete." } else { "Installation complete." }
  Write-Host "$result This Windows PC can now receive account switches after every sign-in."
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  Get-ChildItem $SupportDir -Filter "*.download.$PID" -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  if ($installerMutex) {
    try { $installerMutex.ReleaseMutex() } catch { }
    $installerMutex.Dispose()
  }
}
