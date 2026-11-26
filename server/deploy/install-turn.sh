#!/usr/bin/env bash
# Install a TURN relay (coturn) for WeEdit collaboration, on the same VM as the
# signaling server.
#
#   sudo TURN_HOST=turn.example.com bash deploy/install-turn.sh
#
# Why: STUN lets most peers connect directly, but some networks (symmetric NAT
# on phones, schools, offices) block that. TURN relays those connections.
#
# How auth works: coturn's use-auth-secret mode. A random secret is shared
# between coturn and the signaling server (/etc/weedit/turn.env); the app asks
# the signaling server's /api/turn for credentials that expire after 12 hours.
# No TURN password is ever shipped in the app.
#
# NETWORKING (do this yourself):
#   - TURN can't go through Cloudflare's proxy. TURN_HOST must be a DNS-only
#     (grey-cloud) record pointing at your public IP.
#   - Port-forward to this VM: 3478/udp + 3478/tcp (TURN) and the relay range
#     49160-49200/udp.
#
# Idempotent: re-running keeps the existing secret.
set -euo pipefail

TURN_HOST="${TURN_HOST:-turn.minecartchris.cc}"
ENV_FILE=/etc/weedit/turn.env
RELAY_MIN=49160
RELAY_MAX=49200

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash deploy/install-turn.sh" >&2
  exit 1
fi

echo "==> Installing coturn"
apt-get update -y
apt-get install -y coturn

mkdir -p /etc/weedit
if [[ -f "$ENV_FILE" ]] && grep -q '^TURN_SECRET=' "$ENV_FILE"; then
  SECRET="$(grep '^TURN_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
  echo "==> Keeping the existing TURN secret"
else
  SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
fi

cat > "$ENV_FILE" <<EOF
TURN_SECRET=$SECRET
TURN_URLS=turn:$TURN_HOST:3478?transport=udp,turn:$TURN_HOST:3478?transport=tcp
EOF
chmod 640 "$ENV_FILE"
chown root:weedit "$ENV_FILE" 2>/dev/null || true

echo "==> Writing /etc/turnserver.conf"
cat > /etc/turnserver.conf <<EOF
# WeEdit TURN relay (managed by deploy/install-turn.sh)
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=$TURN_HOST
server-name=$TURN_HOST
min-port=$RELAY_MIN
max-port=$RELAY_MAX
# Don't let the relay be used to reach this LAN or loopback.
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
no-cli
no-tlsv1
no-tlsv1_1
total-quota=100
stale-nonce=600
EOF

# Debian ships coturn disabled until this is set.
if [[ -f /etc/default/coturn ]]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi

systemctl enable coturn
systemctl restart coturn

echo "==> Restarting the signaling server so /api/turn picks up the secret"
systemctl restart weedit-signaling || true

echo
echo "Done. Next:"
echo "  1. DNS: $TURN_HOST -> your public IP, DNS-only (grey cloud) in Cloudflare."
echo "  2. Router: forward 3478/udp, 3478/tcp and $RELAY_MIN-$RELAY_MAX/udp to this VM."
echo "  3. Check: curl -s http://127.0.0.1:4444/api/turn   (should list a turn: URL)"
