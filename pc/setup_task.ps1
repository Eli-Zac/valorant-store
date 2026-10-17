# Registers a scheduled task that pushes the Valorant store at logon and every 2 hours.
# Run once in PowerShell (no admin needed): .\setup_task.ps1
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $dir "config.json"))) {
  Write-Error "Create config.json first (copy config.example.json)."; exit 1
}
$py = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python -ErrorAction Stop).Source }

$action = New-ScheduledTaskAction -Execute $py -Argument "`"$dir\push_store.py`"" -WorkingDirectory $dir
$t1 = New-ScheduledTaskTrigger -AtLogOn
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "ValorantStorePush" -Action $action -Trigger @($t1, $t2) -Settings $settings -Force | Out-Null
Write-Host "Task registered. Running once now..."
Start-ScheduledTask -TaskName "ValorantStorePush"
