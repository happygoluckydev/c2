# SPDX-License-Identifier: MIT
# Registers a weekly local catalog refresh. Run manually after installing the plugin.
$node = (Get-Command node).Source
$script = Join-Path $PSScriptRoot 'skills\c2\scripts\build-index.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName 'c2-catalog-update' -Action $action -Trigger $trigger -Description 'Refresh the c2 Codex capability catalog' -Force | Out-Null
Write-Host "Registered 'c2-catalog-update' (Monday 09:00)."
