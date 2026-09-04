$ErrorActionPreference = "SilentlyContinue"
$SupportDir = Join-Path $env:LOCALAPPDATA "GPTAccountSwitcher"
$PidPath = Join-Path $SupportDir "agent.pid"
if (Test-Path $PidPath) {
  $agentPid = [int](Get-Content $PidPath -ErrorAction SilentlyContinue)
  if ($agentPid) {
    $agentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $agentPid" -ErrorAction SilentlyContinue
    if ($agentProcess.CommandLine -like "*windows-agent.ps1*") { Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue }
  }
}
Remove-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "GPTAccountSwitcher" -Force
Unregister-ScheduledTask -TaskName "GPT Account Switcher" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item $SupportDir -Recurse -Force
Write-Host "Windows switcher removed. Codex projects and tasks were not modified."
