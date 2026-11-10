#!/bin/bash
# EC2 user-data: self-contained time-limited WhatsApp bridge on Amazon Linux 2023.
# - Bridge code is embedded below as a gzipped base64 tarball.
# - cloudflared quick tunnel exposes the page over HTTPS (no account/token).
# - The bridge password is read from SSM Parameter Store (/wa-bridge/bridge-password,
#   SecureString, default aws/ssm key) with a retry loop; it is never logged anywhere. The public tunnel URL
#   (not a credential; the page itself stays password-gated) is printed to the
#   serial console for retrieval via EC2 > Get system log.
# - Timing is fixed at render time: SETUP_HOURS to link, SESSION_HOURS of access
#   after linking. The on-instance failsafe powers off at boot+FAILSAFE_HOURS
#   (setup + session + 1h buffer); shutdown behavior must be 'terminate'
#   (set at launch), and an EventBridge one-time schedule is the external backstop.
set -euxo pipefail

# WA-BRIDGE-CONFIG setup=__SETUP_HOURS__ session=__SESSION_HOURS__ failsafe=__FAILSAFE_HOURS__
# (launch.sh reads the line above to place the external backstop; keep it intact.)

# Do NOT add 'curl' here: AL2023 preinstalls curl-minimal, which provides /usr/bin/curl
# (HTTP/HTTPS) and CONFLICTS with the full curl package. The single curl use below is an
# HTTPS download, which curl-minimal supports.
dnf install -y nodejs20 tar gzip

mkdir -p /opt/wa-bridge
cat > /opt/wa-bridge/payload.b64 <<'PAYLOAD'
__PAYLOAD_B64__
PAYLOAD
base64 -d /opt/wa-bridge/payload.b64 | tar xz -C /opt/wa-bridge
rm /opt/wa-bridge/payload.b64
cd /opt/wa-bridge
npm install --omit=dev

# Wait for the password to appear in Parameter Store (created from the console
# right after launch via vault fill, so it never transits logs or chat).
# Disable xtrace for this whole section: 'set -x' would log the expanded
# BRIDGE_PASSWORD=... assignment (and the .env write) to the EC2 system log.
set +x
BRIDGE_PASSWORD=""
for i in $(seq 1 180); do
  BRIDGE_PASSWORD=$(aws ssm get-parameter --name /wa-bridge/bridge-password --with-decryption --query Parameter.Value --output text --region us-east-1 2>/dev/null || true)
  [ -n "$BRIDGE_PASSWORD" ] && break
  sleep 10
done
if [ -z "$BRIDGE_PASSWORD" ]; then
  echo "WA-BRIDGE-ERROR: password parameter not found within 30 min" > /dev/console
  systemctl poweroff
fi

{
  printf 'MODE=live\nHOST=127.0.0.1\nPORT=3000\nALLOWED_CHAT_JID=__ALLOWED_JID__\nPAIRING_PHONE=__PAIRING_PHONE__\nSETUP_HOURS=__SETUP_HOURS__\nSESSION_HOURS=__SESSION_HOURS__\n'
  printf 'BRIDGE_PASSWORD=%s\n' "$BRIDGE_PASSWORD"
} > /opt/wa-bridge/.env
unset BRIDGE_PASSWORD
chmod 600 /opt/wa-bridge/.env
set -x

cat > /etc/systemd/system/wa-bridge.service <<'EOF'
[Unit]
Description=Time-limited WhatsApp bridge
After=network-online.target
[Service]
EnvironmentFile=/opt/wa-bridge/.env
WorkingDirectory=/opt/wa-bridge
ExecStart=/usr/bin/node server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF

curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared

cat > /opt/wa-bridge/run-tunnel.sh <<'EOF'
#!/bin/bash
/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate 2>&1 | while read -r line; do
  if [[ "$line" =~ https://[a-z0-9-]+\.trycloudflare\.com ]]; then
    echo "${BASH_REMATCH[0]}" > /opt/wa-bridge/tunnel-url.txt
    echo "WA-BRIDGE-URL: ${BASH_REMATCH[0]}" > /dev/console
  fi
done
EOF
chmod +x /opt/wa-bridge/run-tunnel.sh

cat > /etc/systemd/system/wa-bridge-tunnel.service <<'EOF'
[Unit]
Description=cloudflared quick tunnel for wa-bridge
After=network-online.target wa-bridge.service
[Service]
ExecStart=/opt/wa-bridge/run-tunnel.sh
Restart=on-failure
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now wa-bridge wa-bridge-tunnel

# Failsafe: power off FAILSAFE_HOURS after boot (terminate-on-shutdown is set at
# launch). In-instance backstop; EventBridge is the external one.
systemd-run --on-active=__FAILSAFE_HOURS__h --unit=wa-bridge-failsafe systemctl poweroff
