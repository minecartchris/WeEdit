#!/usr/bin/env bash
# Deploy the WeEdit website (landing page + web editor) to this machine's nginx.
#
# Run it FROM the repo root after building the web editor:
#
#   npm run build:web                       # produces dist-web/
#   sudo bash website/deploy/deploy.sh       # installs to /var/www/weedit + nginx
#
# Idempotent — re-run any time to publish a new build. Override the deploy root
# or domain with env vars:  sudo WEB_ROOT=/srv/weedit DOMAIN=example.com bash ...
set -euo pipefail

WEB_ROOT="${WEB_ROOT:-/var/www/weedit}"
DOMAIN="${DOMAIN:-weedit.minecartchris.cc}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

if [[ ! -f "$REPO_ROOT/dist-web/index.html" ]]; then
  echo "dist-web/ not found. Build the web editor first:  npm run build:web" >&2
  exit 1
fi

echo "==> Installing nginx (if missing)"
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y nginx
fi

echo "==> Publishing landing page  -> $WEB_ROOT"
mkdir -p "$WEB_ROOT"
# Landing page static files (everything in website/ except deploy/ + README).
for f in index.html styles.css main.js logo.png favicon.png; do
  install -D -m 0644 "$REPO_ROOT/website/$f" "$WEB_ROOT/$f"
done

echo "==> Publishing web editor    -> $WEB_ROOT/editor"
rm -rf "$WEB_ROOT/editor"
mkdir -p "$WEB_ROOT/editor"
cp -r "$REPO_ROOT/dist-web/." "$WEB_ROOT/editor/"

chown -R www-data:www-data "$WEB_ROOT" 2>/dev/null || true

echo "==> Configuring nginx site"
sed "s/weedit\.minecartchris\.cc/$DOMAIN/g" \
  "$REPO_ROOT/website/deploy/nginx-weedit-web.conf" \
  > /etc/nginx/sites-available/weedit-web
ln -sf /etc/nginx/sites-available/weedit-web /etc/nginx/sites-enabled/weedit-web
rm -f /etc/nginx/sites-enabled/default

echo "==> Testing + reloading nginx"
nginx -t
systemctl reload nginx

echo
echo "Done. Served at:"
echo "  http://$DOMAIN/          (landing page)"
echo "  http://$DOMAIN/editor/   (web editor)"
echo
echo "If the signaling site also has 'listen 80' for this domain, remove those"
echo "two lines from server/deploy/nginx-weedit.conf and reload nginx."
