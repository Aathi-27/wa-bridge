#Requires -Version 5.1
<#
.SYNOPSIS
  Renders the final EC2 user-data from deploy/user-data.template.sh (Windows).
  Produces the same file as build-userdata.sh: bridge payload embedded, chat JID,
  pairing phone and timing substituted.
.DESCRIPTION
  Needs tar.exe (bsdtar), which ships with Windows 10 1803 and later.
  The rendered file contains your phone numbers in plaintext - treat it as
  private and do not commit it.
.EXAMPLE
  .\build-userdata.ps1 -AllowedJid '14155551234@s.whatsapp.net' -PairingPhone '14155559876' -OutFile "$env:TEMP\userdata-final.sh"
.EXAMPLE
  .\build-userdata.ps1 -AllowedJid '14155551234@s.whatsapp.net' -SetupHours 3 -SessionHours 48 > "$env:TEMP\userdata-final.sh"
#>
param(
  [Parameter(Mandatory = $true)][string]$AllowedJid,
  [string]$PairingPhone = '',
  [double]$SetupHours = 2,
  [double]$SessionHours = 24,
  [string]$OutFile
)
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
Set-Location (Join-Path $PSScriptRoot '..')

if ($SetupHours -lt 0.25 -or $SetupHours -gt 12) { throw "SetupHours must be between 0.25 and 12 (hours to link before the app closes)" }
if ($SessionHours -lt 1 -or $SessionHours -gt 168) { throw "SessionHours must be between 1 and 168 (one week)" }
$FailsafeHours = $SetupHours + $SessionHours + 1

Write-Host "Timing: $($SetupHours.ToString($inv))h to link, $($SessionHours.ToString($inv))h of access; machine self-terminates $($FailsafeHours.ToString($inv))h after boot."
Write-Host "Cost note: the instance bills from launch until termination. Longer sessions cost proportionally more - check current EC2, public IPv4 and EBS prices for your region."

$payload = Join-Path $env:TEMP 'wa-bridge-payload.tar.gz'
& tar czf $payload package.json server.js live.js public/index.html
if ($LASTEXITCODE -ne 0) { throw "tar failed - Windows 10 1803+ ships bsdtar as tar.exe in System32" }
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($payload))
Remove-Item $payload -Force

$out = (Get-Content (Join-Path 'deploy' 'user-data.template.sh') -Raw).
  Replace('__ALLOWED_JID__', $AllowedJid).
  Replace('__PAIRING_PHONE__', $PairingPhone).
  Replace('__SETUP_HOURS__', $SetupHours.ToString($inv)).
  Replace('__SESSION_HOURS__', $SessionHours.ToString($inv)).
  Replace('__FAILSAFE_HOURS__', $FailsafeHours.ToString($inv))
$out = $out -replace '(?m)^__PAYLOAD_B64__$', $b64
# user-data runs on Linux: force LF line endings
$out = $out -replace "`r`n", "`n"

if ($OutFile) {
  [IO.File]::WriteAllText($OutFile, $out)
  Write-Host "Wrote $OutFile"
} else {
  [Console]::Out.Write($out)
}
