#!/bin/bash
# Launch one bridge instance from a rendered user-data file and set up its
# external termination backstop. Idempotent where it can be; safe to re-run
# after a failure. Requires AWS CLI configured for the target account.
#
# Usage:
#   ./launch.sh /tmp/userdata-final.sh [region]
#
# What it does:
#   1. Ensures the IAM instance role (SSM core + read on the password parameter),
#      the scheduler execution role, and a no-inbound security group exist.
#   2. Launches one t3.micro Amazon Linux 2023 instance, terminate-on-shutdown,
#      standard CPU credits, your rendered user-data.
#   3. Creates a one-time EventBridge schedule that terminates the instance at
#      the failsafe time from the rendered file's WA-BRIDGE-CONFIG marker
#      (setup + session + 1h; the on-instance systemd poweroff is the other backstop).
#   4. Polls the EC2 console output and prints the WA-BRIDGE-URL when it appears.
#
# Not paid-deployment tested end to end in this repo form; it encodes the exact
# manual console run this project executed. Review before first use.
set -euo pipefail

USERDATA_FILE="${1:?usage: ./launch.sh <rendered-userdata-file> [region]}"
REGION="${2:-us-east-1}"
NAME="wa-bridge-24h"
INSTANCE_ROLE="wa-bridge-instance"
SCHEDULER_ROLE="wa-bridge-scheduler-exec"
SG_NAME="wa-bridge-no-inbound"
SSM_PARAM="/wa-bridge/bridge-password"
# The failsafe hour count comes from the rendered user-data's config marker, so
# the cloud backstop always matches the timing chosen at render time.
MARKER=$(grep -m1 '^# WA-BRIDGE-CONFIG ' "$USERDATA_FILE" || true)
if [ -n "$MARKER" ]; then
  RUN_HOURS=$(printf '%s' "$MARKER" | sed -n 's/.*failsafe=\([0-9.]*\).*/\1/p')
else
  echo "WARNING: no WA-BRIDGE-CONFIG marker in $USERDATA_FILE; defaulting the backstop to 26h." >&2
  echo "Re-render with build-userdata.sh to keep app timing and backstops in sync." >&2
  RUN_HOURS=26
fi
echo "Backstop: +${RUN_HOURS}h. The instance bills from launch until termination; deploy/cleanup.sh ends it sooner."

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Account: $ACCOUNT_ID  Region: $REGION"

# --- 1a. Instance role: SSM core + read on the bridge password parameter ---
if ! aws iam get-role --role-name "$INSTANCE_ROLE" >/dev/null 2>&1; then
  echo "Creating instance role $INSTANCE_ROLE"
  aws iam create-role --role-name "$INSTANCE_ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$INSTANCE_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name "$INSTANCE_ROLE" --policy-name wa-bridge-read-password --policy-document "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\"],
      \"Resource\":\"arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${SSM_PARAM}\"}]}"
fi
if ! aws iam get-instance-profile --instance-profile-name "$INSTANCE_ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$INSTANCE_ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$INSTANCE_ROLE" --role-name "$INSTANCE_ROLE"
  echo "Waiting for instance profile to propagate"
  sleep 10
fi

# --- 1b. Password parameter must exist before boot (instance retries 30 min) ---
if ! aws ssm get-parameter --name "$SSM_PARAM" --region "$REGION" >/dev/null 2>&1; then
  echo "ERROR: SSM parameter $SSM_PARAM not found in $REGION."
  echo "Create it as a SecureString first (see README step 2), then re-run."
  exit 1
fi

# --- 1c. Security group with no inbound rules (tunnel is outbound-only) ---
SG_ID=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
  SG_ID=$(aws ec2 create-security-group --region "$REGION" --group-name "$SG_NAME" \
    --description "wa-bridge: no inbound, outbound only" --vpc-id "$VPC_ID" --query GroupId --output text)
  echo "Created security group $SG_ID (no inbound rules)"
fi

# --- 2. Launch ---
AMI=$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --query Parameter.Value --output text)
echo "Launching t3.micro from AMI $AMI"
INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI" --instance-type t3.micro --count 1 \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile Name="$INSTANCE_ROLE" \
  --instance-initiated-shutdown-behavior terminate \
  --credit-specification CpuCredits=standard \
  --user-data "file://$USERDATA_FILE" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "Instance: $INSTANCE_ID"

# --- 3. EventBridge one-time termination backstop at now+RUN_HOURS ---
if ! aws iam get-role --role-name "$SCHEDULER_ROLE" >/dev/null 2>&1; then
  echo "Creating scheduler role $SCHEDULER_ROLE"
  aws iam create-role --role-name "$SCHEDULER_ROLE" --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
fi
aws iam put-role-policy --role-name "$SCHEDULER_ROLE" --policy-name wa-bridge-terminate-instance --policy-document "{
  \"Version\":\"2012-10-17\",
  \"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ec2:TerminateInstances\"],
    \"Resource\":\"arn:aws:ec2:${REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}\"}]}"
ROLE_ARN=$(aws iam get-role --role-name "$SCHEDULER_ROLE" --query Role.Arn --output text)
AT_TIME=$(date -u -d "+${RUN_HOURS} hours" +%Y-%m-%dT%H:%M:%S)
aws scheduler create-schedule --region "$REGION" --name wa-bridge-failsafe-terminate \
  --schedule-expression "at(${AT_TIME})" \
  --flexible-time-window Mode=OFF \
  --target "{\"Arn\":\"arn:aws:scheduler:::aws-sdk:ec2:terminateInstances\",\"RoleArn\":\"${ROLE_ARN}\",\"Input\":\"{\\\"InstanceIds\\\":[\\\"${INSTANCE_ID}\\\"]}\"}" >/dev/null
echo "Failsafe: TerminateInstances at ${AT_TIME}Z (on-instance systemd poweroff is the second backstop)"

# --- 4. Wait for the tunnel URL in the console output ---
echo "Waiting for boot and tunnel (usually 3-6 min)..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
for i in $(seq 1 40); do
  OUT=$(aws ec2 get-console-output --region "$REGION" --instance-id "$INSTANCE_ID" --latest --output text 2>/dev/null || true)
  URL=$(printf '%s' "$OUT" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | head -1 || true)
  if [ -n "$URL" ]; then
    echo "WA-BRIDGE-URL: $URL"
    echo "Open it, sign in with the bridge password, and link WhatsApp within 2 hours."
    exit 0
  fi
  if printf '%s' "$OUT" | grep -q 'WA-BRIDGE-ERROR'; then
    echo "Boot reported WA-BRIDGE-ERROR - check Get system log in the console."
    exit 1
  fi
  sleep 15
done
echo "Timed out waiting for the URL. Check EC2 > Get system log for $INSTANCE_ID."
exit 1
