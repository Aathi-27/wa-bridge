#Requires -Version 5.1
<#
.SYNOPSIS
  End a bridge run: terminate the instance, delete the EventBridge failsafe,
  and verify no volumes remain (Windows equivalent of cleanup.sh).
.DESCRIPTION
  Requires AWS CLI v2 configured for the account.
.EXAMPLE
  .\cleanup.ps1 i-0123456789abcdef0
#>
param(
  [Parameter(Mandatory = $true)][string]$InstanceId,
  [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'

Write-Host "Terminating $InstanceId in $Region"
aws ec2 terminate-instances --region $Region --instance-ids $InstanceId | Out-Null
aws ec2 wait instance-terminated --region $Region --instance-ids $InstanceId
Write-Host "Terminated."

aws scheduler get-schedule --region $Region --name wa-bridge-failsafe-terminate 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  aws scheduler delete-schedule --region $Region --name wa-bridge-failsafe-terminate
  Write-Host "EventBridge failsafe schedule deleted."
} else {
  Write-Host "No failsafe schedule found (already deleted or never created)."
}

$vols = (aws ec2 describe-volumes --region $Region --filters "Name=attachment.instance-id,Values=$InstanceId" --query 'Volumes[].VolumeId' --output text)
if (-not $vols) {
  Write-Host "Volumes: none attached to $InstanceId. Cleanup complete."
} else {
  throw "WARNING: volumes still present: $vols - check the console before closing this out."
}
