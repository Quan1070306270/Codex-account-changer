$ErrorActionPreference = "Stop"
$SwitcherVersion = "1.6.5"
$SupportDir = Join-Path $env:LOCALAPPDATA "GPTAccountSwitcher"
$ConfigPath = Join-Path $SupportDir "config.json"
$PidPath = Join-Path $SupportDir "agent.pid"
$LogsDir = Join-Path $SupportDir "logs"
$LogPath = Join-Path $LogsDir "agent.log"
$ProcessedDir = Join-Path $SupportDir "processed-commands"
$PollSeconds = 5
$mutex = $null

function Add-AgentLog([string]$Message) {
  try {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 1048576) {
      Move-Item $LogPath "$LogPath.old" -Force -ErrorAction SilentlyContinue
    }
    Add-Content -Path $LogPath -Value ("{0} {1}" -f [DateTime]::UtcNow.ToString("o"), $Message) -Encoding UTF8
  } catch { }
}

$createdNew = $false
try {
  $mutex = New-Object Threading.Mutex($true, "Local\GPTAccountSwitcherAgent", [ref]$createdNew)
  if (-not $createdNew) { exit 0 }
} catch {
  Add-AgentLog "Unable to acquire the single-instance lock: $($_.Exception.Message)"
  exit 1
}

function Send-Acknowledgement {
  param([string]$ServerUrl, [string]$Token, [string]$CommandId, [bool]$Ok, [string]$Message = "")
  $body = @{ ok = $Ok }
  if ($Message) { $body.error = $Message.Substring(0, [Math]::Min(500, $Message.Length)) }
  try {
    Invoke-RestMethod -Method Post -TimeoutSec 20 -Uri "$ServerUrl/api/device/commands/$CommandId/ack" `
      -Headers @{ Authorization = "Bearer $Token"; "X-Switcher-Version" = $SwitcherVersion } `
      -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) | Out-Null
  } catch { }
}

function Get-AccountCachePath([string]$OpenAiAccountId) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($OpenAiAccountId)) | ForEach-Object { $_.ToString("x2") }) -join "" }
  finally { $sha.Dispose() }
  return Join-Path (Join-Path (Join-Path $SupportDir "accounts") $hash) "auth.json"
}

function Get-CurrentCodexAccountHeader {
  $authPath = Join-Path (Join-Path $env:USERPROFILE ".codex") "auth.json"
  try {
    $auth = Get-Content $authPath -Raw | ConvertFrom-Json
    $accountId = [string]$auth.tokens.account_id
    if ($auth.auth_mode -eq "chatgpt" -and $accountId -match '^[A-Za-z0-9._:-]{1,200}$') { return $accountId }
  } catch { }
  return "signed-out"
}

function Get-ProcessedCommandPath([string]$CommandId) {
  if ($CommandId -notmatch '^[0-9a-fA-F-]+$') { return $null }
  return Join-Path $ProcessedDir $CommandId
}

function Set-CommandProcessed([string]$CommandId) {
  $path = Get-ProcessedCommandPath $CommandId
  if (-not $path) { throw "Invalid command identifier." }
  New-Item -ItemType Directory -Force -Path $ProcessedDir | Out-Null
  $tempPath = "$path.$PID.tmp"
  [IO.File]::WriteAllText($tempPath, [DateTime]::UtcNow.ToString("o"), (New-Object Text.UTF8Encoding($false)))
  Move-Item $tempPath $path -Force
}

function Sync-CurrentCredentials($Config) {
  $statePath = Join-Path $SupportDir "state.json"
  $authPath = Join-Path (Join-Path $env:USERPROFILE ".codex") "auth.json"
  $markerPath = Join-Path $SupportDir "last-auth-sync"
  if ((-not (Test-Path $statePath)) -or (-not (Test-Path $authPath))) { return }
  try {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
    $auth = Get-Content $authPath -Raw | ConvertFrom-Json
    if ($state.serverAccountId -notmatch '^[0-9a-fA-F-]+$' -or $auth.auth_mode -ne "chatgpt" -or
      -not $auth.tokens.refresh_token -or [string]$auth.tokens.account_id -ne [string]$state.activeAccountId) { return }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $authHash = ($sha.ComputeHash([IO.File]::ReadAllBytes($authPath)) | ForEach-Object { $_.ToString("x2") }) -join "" }
    finally { $sha.Dispose() }
    $syncKey = "$($state.serverAccountId):$authHash"
    if ((Test-Path $markerPath) -and (Get-Content $markerPath -Raw).Trim() -eq $syncKey) { return }

    $cachePath = Get-AccountCachePath ([string]$auth.tokens.account_id)
    New-Item -ItemType Directory -Force -Path (Split-Path $cachePath -Parent) | Out-Null
    $cacheTemp = "$cachePath.$PID.tmp"
    Copy-Item $authPath $cacheTemp -Force
    Move-Item $cacheTemp $cachePath -Force

    $headers = @{ Authorization = "Bearer $($Config.deviceToken)"; "X-Switcher-Version" = $SwitcherVersion }
    if ($Config.installationId) { $headers["X-Device-Installation-Id"] = [string]$Config.installationId }
    $body = @{
      accountId = [string]$state.serverAccountId
      authBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($authPath))
    } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -TimeoutSec 20 -Uri "$($Config.serverUrl)/api/device/credentials" `
      -Headers $headers -ContentType "application/json" -Body $body | Out-Null
    [IO.File]::WriteAllText($markerPath, $syncKey, (New-Object Text.UTF8Encoding($false)))
  } catch {
    Add-AgentLog "Credential sync deferred: $($_.Exception.Message)"
  }
}

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Force -Path $ProcessedDir | Out-Null
  Get-ChildItem $ProcessedDir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7) } | Remove-Item -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($PidPath, [string]$PID, (New-Object Text.UTF8Encoding($false)))
  Add-AgentLog "Agent $SwitcherVersion started."
  $connected = $false
  $lastErrorMessage = ""
  $lastErrorLoggedAt = [DateTime]::MinValue

  while ($true) {
    try {
      if (-not (Test-Path $ConfigPath)) { throw "Configuration file not found: $ConfigPath" }
      $config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
      if (-not $config.serverUrl -or -not $config.deviceToken) { throw "Configuration is missing the server URL or device token." }
      $headers = @{ Authorization = "Bearer $($config.deviceToken)"; "X-Switcher-Version" = $SwitcherVersion }
      $headers["X-Codex-Active-Account"] = Get-CurrentCodexAccountHeader
      if ($config.installationId) { $headers["X-Device-Installation-Id"] = [string]$config.installationId }
      Sync-CurrentCredentials $config
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 20 -Uri "$($config.serverUrl)/api/device/commands/next" -Headers $headers
      if (-not $connected) { Add-AgentLog "Connected to $($config.serverUrl)."; $connected = $true }
      $lastErrorMessage = ""

      if ([int]$response.StatusCode -eq 200 -and $response.Content) {
        $command = $response.Content | ConvertFrom-Json
        if (-not $command.id -or ([string]$command.id) -notmatch '^[0-9a-fA-F-]+$' -or $command.type -ne "switch-account" -or -not $command.authBase64) {
          if ($command.id) { Send-Acknowledgement $config.serverUrl $config.deviceToken $command.id $false "Invalid switch command." }
        } else {
          $processedPath = Get-ProcessedCommandPath ([string]$command.id)
          if ($processedPath -and (Test-Path $processedPath)) {
            Send-Acknowledgement $config.serverUrl $config.deviceToken $command.id $true
            Add-AgentLog "Command $([string]$command.id) was already applied; acknowledgement retried."
            Start-Sleep -Seconds $PollSeconds
            continue
          }
          $authPath = Join-Path $SupportDir "pending-auth.base64"
          [IO.File]::WriteAllText($authPath, [string]$command.authBase64, (New-Object Text.UTF8Encoding($false)))
          $applyStatus = 1
          $output = ""
          try {
            $applyArguments = @(
              "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $SupportDir "apply-switch.ps1"),
              "-AuthBase64Path", $authPath,
              "-AccountEmail", ([string]$command.accountEmail),
              "-DefaultModel", ([string]$command.defaultModel),
              "-ServerAccountId", ([string]$command.accountId)
            )
            $previousErrorActionPreference = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $output = & (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") @applyArguments 2>&1 | Out-String
            $applyStatus = $LASTEXITCODE
            $ErrorActionPreference = $previousErrorActionPreference
          } catch {
            $ErrorActionPreference = $previousErrorActionPreference
            $output = $_.Exception.Message
            $applyStatus = 1
          }
          if ($applyStatus -eq 0) {
            Set-CommandProcessed ([string]$command.id)
            Send-Acknowledgement $config.serverUrl $config.deviceToken $command.id $true
            Add-AgentLog "Switched to $([string]$command.accountEmail)."
          } else {
            Send-Acknowledgement $config.serverUrl $config.deviceToken $command.id $false $output.Trim()
            Add-AgentLog "Switch failed: $($output.Trim())"
          }
          Remove-Item $authPath -Force -ErrorAction SilentlyContinue
        }
      }
    } catch {
      $connected = $false
      $message = $_.Exception.Message
      if ($message -ne $lastErrorMessage -or ([DateTime]::UtcNow - $lastErrorLoggedAt).TotalSeconds -ge 60) {
        Add-AgentLog "Connection failed: $message"
        $lastErrorMessage = $message
        $lastErrorLoggedAt = [DateTime]::UtcNow
      }
      Start-Sleep -Seconds $PollSeconds
      continue
    }
    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  Add-AgentLog "Agent stopped."
  Remove-Item $PidPath -Force -ErrorAction SilentlyContinue
  if ($mutex) {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
  }
}
