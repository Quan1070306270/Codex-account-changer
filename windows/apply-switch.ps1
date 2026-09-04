param(
  [Parameter(Mandatory = $true)][string]$AuthBase64Path,
  [string]$AccountEmail = "ChatGPT account",
  [string]$DefaultModel = "gpt-5.6-terra",
  [Parameter(Mandatory = $true)][string]$ServerAccountId
)

$ErrorActionPreference = "Stop"
$SupportDir = Join-Path $env:LOCALAPPDATA "GPTAccountSwitcher"
$BackupsDir = Join-Path $SupportDir "backups"
$AccountCacheDir = Join-Path $SupportDir "accounts"
$CodexDir = Join-Path $env:USERPROFILE ".codex"
$TargetAuth = Join-Path $CodexDir "auth.json"
$TargetConfig = Join-Path $CodexDir "config.toml"
$ServerAuth = Join-Path $CodexDir ".auth.server.json"
$TempAuth = Join-Path $CodexDir ".auth.switching.json"
$TempConfig = Join-Path $CodexDir ".config.switching.toml"
$RollbackAuth = Join-Path $CodexDir ".auth.rollback.json"
$RollbackConfig = Join-Path $CodexDir ".config.rollback.toml"
$applyMutex = $null
$hadAuth = $false
$hadConfig = $false
$switchCommitted = $false

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Read-Auth([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Test-AuthFile([string]$Path, [string]$ExpectedAccountId = "") {
  $auth = Read-Auth $Path
  if (-not $auth -or $auth.auth_mode -ne "chatgpt" -or -not $auth.tokens.account_id -or -not $auth.tokens.refresh_token) { return $false }
  return (-not $ExpectedAccountId -or [string]$auth.tokens.account_id -eq $ExpectedAccountId)
}

function Get-CachePath([string]$OpenAiAccountId) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($OpenAiAccountId)) | ForEach-Object { $_.ToString("x2") }) -join "" }
  finally { $sha.Dispose() }
  return Join-Path (Join-Path $AccountCacheDir $hash) "auth.json"
}

function Save-AuthCache([string]$Source) {
  $auth = Read-Auth $Source
  if (-not $auth -or -not $auth.tokens.account_id) { return }
  $destination = Get-CachePath ([string]$auth.tokens.account_id)
  $directory = Split-Path $destination -Parent
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$destination.$PID.tmp"
  Copy-Item $Source $temporary -Force
  Move-Item $temporary $destination -Force
}

function Get-AuthRefreshTime([string]$Path) {
  $auth = Read-Auth $Path
  if ($auth -and $auth.last_refresh) {
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse([string]$auth.last_refresh, [ref]$parsed)) { return $parsed }
  }
  # Legacy files without last_refresh must never outrank a normal credential
  # merely because they were copied more recently.
  return [DateTimeOffset]::MinValue
}

function Find-NewestAuth([string]$ExpectedAccountId, [string]$ServerAuthPath) {
  $selected = $ServerAuthPath
  $selectedTime = Get-AuthRefreshTime $selected
  $candidates = @($TargetAuth, (Get-CachePath $ExpectedAccountId))
  $candidates += @(Get-ChildItem $BackupsDir -Filter "auth-*.json" -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  foreach ($candidate in $candidates) {
    if ($candidate -and $candidate -ne $selected -and (Test-AuthFile $candidate $ExpectedAccountId)) {
      $candidateTime = Get-AuthRefreshTime $candidate
      if ($candidateTime -gt $selectedTime) {
        $selected = $candidate
        $selectedTime = $candidateTime
      }
    }
  }
  return $selected
}

function Stop-ChatGPTTree {
  $processes = @(Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue)
  foreach ($process in $processes) { [void]$process.CloseMainWindow() }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if (-not (Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 400
  }
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    @(Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue) | ForEach-Object {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 400
    if (-not (Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue)) { return $true }
  }
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
      [void](Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue)
    }
  } catch { }
  Start-Sleep -Seconds 1
  # Some ChatGPT builds retain or immediately recreate a background process.
  # That process must not cancel an otherwise valid credential replacement.
  return (-not (Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue))
}

function Test-ChatGPTWindow {
  return [bool](Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1)
}

function Wait-ChatGPTWindow([int]$Seconds = 10) {
  for ($attempt = 0; $attempt -lt ($Seconds * 2); $attempt++) {
    if (Test-ChatGPTWindow) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-ChatGPTApp {
  if (Test-ChatGPTWindow) { return $true }
  try {
    $startApp = Get-StartApps -ErrorAction Stop | Where-Object { $_.Name -eq "ChatGPT" -or $_.AppID -match "ChatGPT" } | Select-Object -First 1
    if ($startApp) {
      Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($startApp.AppID)"
      if (Wait-ChatGPTWindow 12) { return $true }
    }
  } catch { }
  foreach ($startMenuRoot in @(
    (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
    (Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs")
  )) {
    try {
      $shortcut = Get-ChildItem $startMenuRoot -Filter "*ChatGPT*.lnk" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($shortcut) {
        Start-Process $shortcut.FullName
        if (Wait-ChatGPTWindow 12) { return $true }
      }
    } catch { }
  }
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA "Programs\ChatGPT\ChatGPT.exe"),
    (Join-Path $env:LOCALAPPDATA "OpenAI\ChatGPT\ChatGPT.exe")
  )) {
    try {
      if (Test-Path $candidate) {
        Start-Process $candidate
        if (Wait-ChatGPTWindow 12) { return $true }
      }
    } catch { }
  }
  try {
    Start-Process "chatgpt:"
    if (Wait-ChatGPTWindow 12) { return $true }
  } catch { }
  return $false
}

function Update-CodexConfig([string]$Path, [string]$Destination, [string]$Model) {
  $lines = if (Test-Path $Path) { [IO.File]::ReadAllLines($Path) } else { @() }
  $result = New-Object Collections.Generic.List[string]
  $inRoot = $true
  $wroteModel = $false
  $wroteStore = $false
  $insertedMissing = $false
  foreach ($line in $lines) {
    if ($inRoot -and $line -match '^\s*\[') {
      if (-not $wroteStore) { $result.Add('cli_auth_credentials_store = "file"'); $wroteStore = $true }
      if (-not $wroteModel) { $result.Add('model = "' + $Model + '"'); $wroteModel = $true }
      $insertedMissing = $true
      $inRoot = $false
    }
    if ($inRoot -and $line -match '^\s*cli_auth_credentials_store\s*=') {
      if (-not $wroteStore) { $result.Add('cli_auth_credentials_store = "file"'); $wroteStore = $true }
      continue
    }
    if ($inRoot -and $line -match '^\s*model\s*=') {
      if (-not $wroteModel) { $result.Add('model = "' + $Model + '"'); $wroteModel = $true }
      continue
    }
    $result.Add($line)
  }
  if (-not $insertedMissing) {
    if (-not $wroteStore) { $result.Add('cli_auth_credentials_store = "file"') }
    if (-not $wroteModel) { $result.Add('model = "' + $Model + '"') }
  }
  Write-Utf8NoBom $Destination (($result -join "`r`n") + "`r`n")
}

try {
  $createdNew = $false
  $applyMutex = New-Object Threading.Mutex($true, "Local\GPTAccountSwitcherApply", [ref]$createdNew)
  if (-not $createdNew) {
    Write-Output "Another account switch is already running; this request was safely merged."
    exit 0
  }
  if ($DefaultModel -notmatch '^[a-z0-9._-]+$') { throw "Invalid default model." }
  if ($ServerAccountId -notmatch '^[0-9a-fA-F-]+$') { throw "Invalid account identifier. Update the switcher." }
  if (-not (Test-Path $AuthBase64Path)) { throw "Account credentials are empty." }
  New-Item -ItemType Directory -Force -Path $CodexDir, $SupportDir, $BackupsDir, $AccountCacheDir | Out-Null

  $encoded = (Get-Content $AuthBase64Path -Raw).Trim()
  $bytes = [Convert]::FromBase64String($encoded)
  [IO.File]::WriteAllBytes($ServerAuth, $bytes)
  if (-not (Test-AuthFile $ServerAuth)) { throw "Server account credential validation failed." }
  $serverAuthObject = Read-Auth $ServerAuth
  $targetOpenAiAccountId = [string]$serverAuthObject.tokens.account_id

  $hadAuth = Test-Path $TargetAuth
  $hadConfig = Test-Path $TargetConfig
  if ($hadAuth) { Copy-Item $TargetAuth $RollbackAuth -Force }
  if ($hadConfig) { Copy-Item $TargetConfig $RollbackConfig -Force }

  [void](Stop-ChatGPTTree)

  if (Test-AuthFile $TargetAuth) {
    Save-AuthCache $TargetAuth
  }

  # Compare every valid copy even when the App already shows the target
  # account, so a retry can replace a stale current credential.
  $sourceAuth = Find-NewestAuth $targetOpenAiAccountId $ServerAuth

  if ($sourceAuth -ne $TargetAuth) {
    if (Test-Path $TargetAuth) {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      Copy-Item $TargetAuth (Join-Path $BackupsDir "auth-$stamp.json")
    }
    Copy-Item $sourceAuth $TempAuth -Force
    Move-Item $TempAuth $TargetAuth -Force
  }
  if (-not (Test-AuthFile $TargetAuth $targetOpenAiAccountId)) {
    throw "The selected account credential was not written correctly. The previous login was restored."
  }
  Save-AuthCache $TargetAuth
  Update-CodexConfig $TargetConfig $TempConfig $DefaultModel
  Move-Item $TempConfig $TargetConfig -Force
  $switchCommitted = $true

  $state = [ordered]@{
    activeAccountEmail = $AccountEmail
    activeAccountId = $targetOpenAiAccountId
    serverAccountId = $ServerAccountId
    defaultModel = $DefaultModel
    switchedAt = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json
  Write-Utf8NoBom (Join-Path $SupportDir "state.json") $state

  Get-ChildItem $BackupsDir -Filter "auth-*.json" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force

  if (Start-ChatGPTApp) { Write-Output "Switched to $AccountEmail" }
  else { Write-Output "Switched to $AccountEmail. ChatGPT could not be opened automatically; open it manually." }
  exit 0
} catch {
  if (-not $switchCommitted) {
    if ($hadAuth -and (Test-Path $RollbackAuth)) { Copy-Item $RollbackAuth $TargetAuth -Force }
    elseif (-not $hadAuth) { Remove-Item $TargetAuth -Force -ErrorAction SilentlyContinue }
    if ($hadConfig -and (Test-Path $RollbackConfig)) { Copy-Item $RollbackConfig $TargetConfig -Force }
    elseif (-not $hadConfig) { Remove-Item $TargetConfig -Force -ErrorAction SilentlyContinue }
  }
  try { [void](Start-ChatGPTApp) } catch { }
  Write-Error $_.Exception.Message
  exit 1
} finally {
  Remove-Item $ServerAuth, $TempAuth, $TempConfig, $RollbackAuth, $RollbackConfig -Force -ErrorAction SilentlyContinue
  if ($applyMutex) {
    try { $applyMutex.ReleaseMutex() } catch { }
    $applyMutex.Dispose()
  }
}
