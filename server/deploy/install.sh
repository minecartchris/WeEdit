#!/usr/bin/env bash
# One-shot deploy of the WeEdit signaling server on Debian/Ubuntu.
#
# Run as root from the repo's server/ folder:
#   sudo bash deploy/install.sh
# Override the domain if needed:
#   sudo DOMAIN=weedit.example.com bash deploy/install.sh
#
# Idempotent: safe to re-run after pulling a new signaling.mjs (it re-copies,
# reinstalls deps, and restarts the service). Point your DNS A/AAAA record at
# this VM and open ports 80/443 before running, so the TLS step can succeed.

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
nginx -t
systemctl reload nginx

echo "==> Requesting a TLS certificate (certbot)"
if apt-get install -y certbot python3-certbot-nginx; then
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
       --register-unsafely-without-email --redirect; then
    systemctl reload nginx
  else
    echo "!! certbot did not complete (DNS not pointed here yet, or rate-limited)."
    echo "   Re-run once DNS resolves: sudo certbot --nginx -d ${DOMAIN}"
  fi
fi

echo
echo "==> Done. Health check:"
curl -s "http://127.0.0.1:4444/health" || true
echo
echo "    Service:  systemctl status weedit-signaling"
echo "    Logs:     journalctl -u weedit-signaling -f"
echo "    Public:   https://${DOMAIN}/health"
