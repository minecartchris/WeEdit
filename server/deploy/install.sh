#!/usr/bin/env bash
# One-shot deploy of the WeEdit signaling server on Debian/Ubuntu.
#
# Run as root from the repo's server/ folder:
#   sudo bash deploy/install.sh
# Override the domain if needed:
#   sudo DOMAIN=weedit.example.com bash deploy/install.sh
#
# Idempotent: safe to re-run after pulling a new signaling.mjs (it re-copies,
# reinstalls deps, and restarts the service).
#
# TLS is handled by Cloudflare at the edge — this sets up nginx on plain HTTP:80
# as the Cloudflare origin. No certbot. Make sure the hostname is a proxied
# (orange-cloud) record in Cloudflare and the origin is reachable (port-forward
# 80 to this VM, or a Cloudflare Tunnel).

set -euo pipefail

DOMAIN="${DOMAIN:-weedit.minecartchris.cc}"
APP_DIR="/opt/weedit-signaling"
SERVICE_USER="weedit"

# Resolve the server/ folder this script lives in (deploy/.. = server/).
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash deploy/install.sh" >&2
  exit 1
fi

echo "==> Installing prerequisites (node, nginx)"
apt-get update -y
apt-get install -y nginx curl ca-certificates
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Deploying server to ${APP_DIR}"
id -u "$SERVICE_USER" >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$APP_DIR"
cp "$SRC_DIR/signaling.mjs" "$SRC_DIR/package.json" "$APP_DIR/"
( cd "$APP_DIR" && npm install --omit=dev --silent )
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "==> Installing systemd service"
cp "$SRC_DIR/deploy/weedit-signaling.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now weedit-signaling
systemctl restart weedit-signaling

echo "==> Configuring nginx for ${DOMAIN}"
# Render the bundled site with the chosen domain (the file ships hard-coded to
# weedit.minecartchris.cc; swap it if DOMAIN was overridden).
sed "s/weedit\.minecartchris\.cc/${DOMAIN}/g" \
  "$SRC_DIR/deploy/nginx-weedit.conf" > /etc/nginx/sites-available/weedit
ln -sf /etc/nginx/sites-available/weedit /etc/nginx/sites-enabled/weedit
# Disable the default site so it doesn't shadow ours on port 80.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

LAN_IP="$(hostname -I | awk '{print $1}')"
echo
echo "==> Done. TLS is handled by Cloudflare — no cert installed here."
echo
echo "    Local check:   $(curl -s http://127.0.0.1:4444/health || echo '(node not responding)')"
echo "    LAN check:     http://${LAN_IP}:4444/health   (node, direct)"
echo "    Origin check:  http://${LAN_IP}/health        (through nginx :80)"
echo
echo "    Service:  systemctl status weedit-signaling"
echo "    Logs:     journalctl -u weedit-signaling -f"
echo
echo "Cloudflare: point ${DOMAIN} at this origin (proxied / orange cloud) and set"
echo "SSL/TLS mode to Flexible. The origin must be reachable from Cloudflare —"
echo "forward port 80 to this VM, or run a Cloudflare Tunnel to localhost:80."
