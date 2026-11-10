#Requires -Version 5.1
<#
.SYNOPSIS
  Launch one bridge instance from a rendered user-data file and set up its
  external termination backstop (Windows equivalent of launch.sh).
.DESCRIPTION
  Requires AWS CLI v2 configured for the target account (aws configure / SSO).
  Creates the IAM instance role, scheduler execution role and a no-inbound
  security group if they do not exist, launches one t3.micro Amazon Linux 2023
  instance with terminate-on-shutdown, and places a one-time EventBridge
  schedule that terminates it at the failsafe time from the rendered file's
  WA-BRIDGE-CONFIG marker (setup + session + 1h). Polls the console output
  and prints the WA-BRIDGE-URL when it appears.
  Not paid-deployment tested end to end in this repo form; review before first use.
.EXAMPLE
  .\launch.ps1 "$env:TEMP\userdata-final.sh"
#>
param(
  [Parameter(Mandatory = $true)][string]$UserDataFile,
  [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'
$Name = 'wa-bridge-24h'
$InstanceRole = 'wa-bridge-instance'
$SchedulerRole = 'wa-bridge-scheduler-exec'
$SgName = 'wa-bridge-no-inbound'
$SsmParam = '/wa-bridge/bridge-password'

# Failsafe hours come from the rendered file's config marker so the cloud
# backstop always matches the timing chosen at render time.
$marker = Select-String -Path $UserDataFile -Pattern '^# WA-BRIDGE-CONFIG ' | Select-Object -First 1
if ($marker -and $marker.Line -match 'failsafe=([0-9.]+)') {
  $RunHours = [double]$Matches[1]
} else {
  Write-Host "WARNING: no WA-BRIDGE-CONFIG marker in $UserDataFile; defaulting the backstop to 26h."
  Write-Host "Re-render with build-userdata.ps1 to keep app timing and backstops in sync."
  $RunHours = 26
}
Write-Host "Backstop: +${RunHours}h. The instance bills from launch until termination; cleanup.ps1 ends it sooner."

$AccountId = (aws sts get-caller-identity --output json | ConvertFrom-Json).Account
Write-Host "Account: $AccountId  Region: $Region"

# --- 1a. Instance role: SSM core + read on the bridge password parameter ---
aws iam get-role --role-name $InstanceRole 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating instance role $InstanceRole"
  aws iam create-role --role-name $InstanceRole --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' | Out-Null
  aws iam attach-role-policy --role-name $InstanceRole --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  $pwPolicy = (@{
    Version = '2012-10-17'
    Statement = @(@{ Effect = 'Allow'; Action = @('ssm:GetParameter');
      Resource = "arn:aws:ssm:${Region}:${AccountId}:parameter$SsmParam" })
  } | ConvertTo-Json -Depth 5 -Compress)
  aws iam put-role-policy --role-name $InstanceRole --policy-name wa-bridge-read-password --policy-document $pwPolicy
}
aws iam get-instance-profile --instance-profile-name $InstanceRole 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  aws iam create-instance-profile --instance-profile-name $InstanceRole | Out-Null
  aws iam add-role-to-instance-profile --instance-profile-name $InstanceRole --role-name $InstanceRole
  Write-Host "Waiting for instance profile to propagate"
  Start-Sleep -Seconds 10
}

# --- 1b. Password parameter must exist before boot (instance retries 30 min) ---
aws ssm get-parameter --name $SsmParam --region $Region 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "SSM parameter $SsmParam not found in $Region. Create it as a SecureString first (see README step 2), then re-run."
}

# --- 1c. Security group with no inbound rules (tunnel is outbound-only) ---
$SgId = (aws ec2 describe-security-groups --region $Region --filters "Name=group-name,Values=$SgName" --query 'SecurityGroups[0].GroupId' --output text 2>$null)
if (-not $SgId -or $SgId -eq 'None') {
  $VpcId = (aws ec2 describe-vpcs --region $Region --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  $SgId = (aws ec2 create-security-group --region $Region --group-name $SgName --description 'wa-bridge: no inbound, outbound only' --vpc-id $VpcId --query GroupId --output text)
  Write-Host "Created security group $SgId (no inbound rules)"
}

# --- 2. Launch ---
$Ami = (aws ssm get-parameter --region $Region --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
Write-Host "Launching t3.micro from AMI $Ami"
$launchArgs = @(
  'ec2', 'run-instances', '--region', $Region,
  '--image-id', $Ami, '--instance-type', 't3.micro', '--count', '1',
  '--security-group-ids', $SgId,
  '--iam-instance-profile', "Name=$InstanceRole",
  '--instance-initiated-shutdown-behavior', 'terminate',
  '--credit-specification', 'CpuCredits=standard',
  '--user-data', "file://$UserDataFile",
  '--tag-specifications', "ResourceType=instance,Tags=[{Key=Name,Value=$Name}]",
  '--query', 'Instances[0].InstanceId', '--output', 'text'
)
$InstanceId = (& aws @launchArgs)
Write-Host "Instance: $InstanceId"

# --- 3. EventBridge one-time termination backstop at now+RunHours ---
aws iam get-role --role-name $SchedulerRole 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating scheduler role $SchedulerRole"
  aws iam create-role --role-name $SchedulerRole --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}' | Out-Null
}
$termPolicy = (@{
  Version = '2012-10-17'
  Statement = @(@{ Effect = 'Allow'; Action = @('ec2:TerminateInstances');
    Resource = "arn:aws:ec2:${Region}:${AccountId}:instance/$InstanceId" })
} | ConvertTo-Json -Depth 5 -Compress)
aws iam put-role-policy --role-name $SchedulerRole --policy-name wa-bridge-terminate-instance --policy-document $termPolicy
$RoleArn = (aws iam get-role --role-name $SchedulerRole --query Role.Arn --output text)
$AtTime = (Get-Date).ToUniversalTime().AddHours($RunHours).ToString('yyyy-MM-ddTHH:mm:ss')
$target = (@{
  Arn = 'arn:aws:scheduler:::aws-sdk:ec2:terminateInstances'
  RoleArn = $RoleArn
  Input = (@{ InstanceIds = @($InstanceId) } | ConvertTo-Json -Compress)
} | ConvertTo-Json -Compress)
aws scheduler create-schedule --region $Region --name wa-bridge-failsafe-terminate `
  --schedule-expression "at($AtTime)" --flexible-time-window Mode=OFF --target $target | Out-Null
Write-Host "Failsafe: TerminateInstances at ${AtTime}Z (on-instance systemd poweroff is the second backstop)"

# --- 4. Wait for the tunnel URL in the console output ---
Write-Host "Waiting for boot and tunnel (usually 3-6 min)..."
aws ec2 wait instance-running --region $Region --instance-ids $InstanceId
foreach ($i in 1..40) {
  $outText = (aws ec2 get-console-output --region $Region --instance-id $InstanceId --latest --output text 2>$null)
  if ($outText -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
    Write-Host "WA-BRIDGE-URL: $($Matches[0])"
    Write-Host "Open it, sign in with the bridge password, and link WhatsApp within the setup window."
    exit 0
  }
  if ($outText -match 'WA-BRIDGE-ERROR') {
    throw "Boot reported WA-BRIDGE-ERROR - check Get system log in the console."
  }
  Start-Sleep -Seconds 15
}
throw "Timed out waiting for the URL. Check EC2 > Get system log for $InstanceId."
