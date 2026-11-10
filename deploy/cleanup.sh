#!/bin/bash
# End a bridge run: terminate the instance, delete the EventBridge failsafe,
# and verify no volumes remain. Requires AWS CLI configured for the account.
#
# Usage:
#   ./cleanup.sh i-0123456789abcdef0 [region]
set -euo pipefail

INSTANCE_ID="${1:?usage: ./cleanup.sh <instance-id> [region]}"
REGION="${2:-us-east-1}"

echo "Terminating $INSTANCE_ID in $REGION"
aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID"
echo "Terminated."

if aws scheduler get-schedule --region "$REGION" --name wa-bridge-failsafe-terminate >/dev/null 2>&1; then
  aws scheduler delete-schedule --region "$REGION" --name wa-bridge-failsafe-terminate
  echo "EventBridge failsafe schedule deleted."
else
  echo "No failsafe schedule found (already deleted or never created)."
fi

VOLS=$(aws ec2 describe-volumes --region "$REGION" \
  --filters "Name=attachment.instance-id,Values=$INSTANCE_ID" \
  --query 'Volumes[].VolumeId' --output text)
if [ -z "$VOLS" ]; then
  echo "Volumes: none attached to $INSTANCE_ID. Cleanup complete."
else
  echo "WARNING: volumes still present: $VOLS - check the console before closing this out."
  exit 1
fi
