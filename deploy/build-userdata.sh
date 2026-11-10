#!/bin/bash
# Renders the final EC2 user-data from deploy/user-data.template.sh:
# packs the bridge source as a base64 payload and substitutes the scoped chat JID,
# the optional pairing phone number, and the timing configuration.
#
# Usage:
#   ALLOWED_JID='<destination-number>@s.whatsapp.net' \
#   [PAIRING_PHONE='<your-own-number, digits only, country code first>'] \
#   [SETUP_HOURS=2]      # 0.25-12, hours allowed to link before the app closes \
#   [SESSION_HOURS=24]   # 1-168, hours of access after linking \
#   ./build-userdata.sh > /tmp/userdata-final.sh
#
# The rendered file embeds a WA-BRIDGE-CONFIG marker that launch.sh reads to
# place the external termination backstop at setup + session + 1h. The rendered
# file contains your phone numbers in plaintext - treat it as private and do
# not commit it.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ALLOWED_JID:?set ALLOWED_JID to the destination chat JID}"
PAIRING_PHONE="${PAIRING_PHONE:-}"
SETUP_HOURS="${SETUP_HOURS:-2}"
SESSION_HOURS="${SESSION_HOURS:-24}"

num='^[0-9]+([.][0-9]+)?$'
[[ $SETUP_HOURS =~ $num ]] || { echo "SETUP_HOURS must be a positive number of hours, got '$SETUP_HOURS'" >&2; exit 1; }
[[ $SESSION_HOURS =~ $num ]] || { echo "SESSION_HOURS must be a positive number of hours, got '$SESSION_HOURS'" >&2; exit 1; }
awk -v s="$SETUP_HOURS" 'BEGIN { exit !(s >= 0.25 && s <= 12) }' || { echo "SETUP_HOURS must be between 0.25 and 12" >&2; exit 1; }
awk -v s="$SESSION_HOURS" 'BEGIN { exit !(s >= 1 && s <= 168) }' || { echo "SESSION_HOURS must be between 1 and 168 (one week)" >&2; exit 1; }
FAILSAFE_HOURS=$(awk -v a="$SETUP_HOURS" -v b="$SESSION_HOURS" 'BEGIN { printf "%g", a + b + 1 }')

echo "Timing: ${SETUP_HOURS}h to link, ${SESSION_HOURS}h of access; machine self-terminates ${FAILSAFE_HOURS}h after boot." >&2
echo "Cost note: the instance bills from launch until termination. Longer sessions cost" >&2
echo "proportionally more - check current EC2, public IPv4 and EBS prices for your region." >&2

tar czf /tmp/wa-bridge-payload.tar.gz package.json server.js live.js public/index.html
B64=$(base64 -w0 /tmp/wa-bridge-payload.tar.gz)
awk -v b64="$B64" -v jid="$ALLOWED_JID" -v phone="$PAIRING_PHONE" \
    -v setup="$SETUP_HOURS" -v session="$SESSION_HOURS" -v failsafe="$FAILSAFE_HOURS" '
  { gsub(/__ALLOWED_JID__/, jid); gsub(/__PAIRING_PHONE__/, phone);
    gsub(/__SETUP_HOURS__/, setup); gsub(/__SESSION_HOURS__/, session);
    gsub(/__FAILSAFE_HOURS__/, failsafe);
    if ($0 == "__PAYLOAD_B64__") print b64; else print }
' deploy/user-data.template.sh
