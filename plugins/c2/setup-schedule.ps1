# SPDX-License-Identifier: MIT
# Registers a weekly local catalog refresh. Run manually after installing the plugin.
$node = (Get-Command node).Source
$script = Join-Path $PSScriptRoot 'skills\c2\scripts\build-index.mjs'
# Task Scheduler keeps no job output, which would hide a crawl that reports failures and exits
# non-zero, so the scheduled run keeps its own log next to the catalog.
$dataDir = Join-Path $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }) 'c2'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$log = Join-Path $dataDir 'cron.log'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$node`" `"$script`" >> `"$log`" 2>&1`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Register-ScheduledTask -TaskName 'c2-catalog-update' -Action $action -Trigger $trigger -Description 'Refresh the c2 Codex capability catalog' -Force | Out-Null
Write-Host "Registered 'c2-catalog-update' (Monday 09:00); output goes to $log."
