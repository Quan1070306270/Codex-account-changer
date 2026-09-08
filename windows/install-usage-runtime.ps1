$ErrorActionPreference = "Stop"
$supportDir = Join-Path $env:LOCALAPPDATA "GPTAccountSwitcher"
$runtimeDir = Join-Path $supportDir "usage-runtime"
$nodePath = Join-Path $runtimeDir "node.exe"
if (Test-Path $nodePath) {
  $installedVersion = & $nodePath --version
  if ($LASTEXITCODE -eq 0 -and $installedVersion -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return }
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$workDir = Join-Path $supportDir ("node-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDir | Out-Null
try {
  $sums = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt").Content
  $match = [regex]::Match($sums, "(?m)^([a-f0-9]{64})\s+(node-(v22\.\d+\.\d+)-win-$arch\.zip)\s*$")
  if (-not $match.Success) { throw "Node runtime checksum not found." }
  $archive = $match.Groups[2].Value
  $version = $match.Groups[3].Value
  $zipPath = Join-Path $workDir $archive
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "https://nodejs.org/dist/$version/$archive" -OutFile $zipPath
  if ((Get-FileHash $zipPath -Algorithm SHA256).Hash -ne $match.Groups[1].Value) { throw "Node runtime checksum mismatch." }
  Expand-Archive -Path $zipPath -DestinationPath $workDir
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Copy-Item (Join-Path $workDir "$($archive -replace '\.zip$','')\node.exe") "$nodePath.next" -Force
  Move-Item "$nodePath.next" $nodePath -Force
} finally {
  Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
