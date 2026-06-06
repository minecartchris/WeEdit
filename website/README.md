# WeEdit website

The public site for WeEdit. Two things live here:

1. **Landing page** (`index.html`, `styles.css`, `main.js`) — markets the desktop
   app and deep-links every Download button to the newest GitHub release.
2. **Web editor** — the *same* React editor, built for the browser so people can
   try the interface instantly. It's built from the app source (not stored here);
   `npm run build:web` produces it into `dist-web/`. Native-only features
   (ffmpeg export, Twitch/yt-dlp VOD download, NAS, save-to-disk) are unavailable
   in a browser and degrade gracefully behind a "web preview" banner — the
   desktop app keeps its full native performance, untouched.

```
weedit.minecartchris.cc/          -> landing page  (this folder)
weedit.minecartchris.cc/editor/   -> web editor    (dist-web/)
```

The collaboration **signaling** server is a separate service (see [`../server/`](../server/))
on port 8443 and is unrelated to this site.

---

## Build

From the **repo root** (not this folder):

```bash
npm install          # once
npm run build:web    # -> dist-web/   (the browser copy of the editor)
```

The landing page itself is plain static files — no build step. `main.js` calls
the GitHub API at runtime to resolve the latest release version + direct
installer link; if GitHub is unreachable the buttons fall back to the
`/releases/latest` redirect, so downloads always work.

Preview the editor build locally:

```bash
npm run preview:web   # serves dist-web at http://localhost:4173/editor/
```

## Deploy (nginx)

On the server, with DNS for `weedit.minecartchris.cc` pointed at it and the
built `dist-web/` present in the repo checkout:

```bash
npm run build:web                  # if not already built
sudo bash website/deploy/deploy.sh  # copies files to /var/www/weedit + nginx
```

That publishes the landing page to `/var/www/weedit`, the editor to
`/var/www/weedit/editor`, installs the nginx site, and reloads. Override the
target with `sudo WEB_ROOT=/srv/weedit DOMAIN=example.com bash website/deploy/deploy.sh`.

### Manual deploy

The same steps by hand:

```bash
# 1. Landing page
sudo mkdir -p /var/www/weedit
sudo cp website/{index.html,styles.css,main.js,logo.png,favicon.png} /var/www/weedit/

# 2. Web editor (built with base /editor/)
sudo rm -rf /var/www/weedit/editor
sudo cp -r dist-web /var/www/weedit/editor

# 3. nginx site
sudo cp website/deploy/nginx-weedit-web.conf /etc/nginx/sites-available/weedit-web
sudo ln -sf /etc/nginx/sites-available/weedit-web /etc/nginx/sites-enabled/weedit-web
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## TLS

Two options, same as the signaling server:

- **Cloudflare (Flexible)** — keep the `listen 80;` lines in the nginx config and
  set the Cloudflare SSL/TLS mode to *Flexible*. Cloudflare serves HTTPS at the
  edge and talks to this origin over plain HTTP on :80. No cert on the box.
- **certbot** — terminate TLS here instead. Comment out the `listen 80;` lines,
  then `sudo certbot --nginx -d weedit.minecartchris.cc`. See the commented block
  at the bottom of `deploy/nginx-weedit-web.conf`.

### Port :80 and the signaling server

The signaling config (`server/deploy/nginx-weedit.conf`) also has `listen 80;`
for the same hostname — only for LAN health checks. nginx can't give port 80 to
two server blocks with the same `server_name`, so this site (the real :80 site)
wins. Remove the two `listen 80;` / `listen [::]:80;` lines from the signaling
config and reload nginx. The signaling server keeps its dedicated `:8443`, so
collaboration is unaffected.

## How the desktop/web split works in the code

- `src/lib/platform.ts` — `isTauri()` / `isWeb()`, detecting the desktop shell.
- `src/components/WebBanner.tsx` — the web-preview strip + download CTA, rendered
  only when `isWeb()`.
- `src/lib/links.ts` — the canonical GitHub / release / website URLs.
- `vite.web.config.ts` — the web build (base `/editor/`, output `dist-web/`). The
  desktop Tauri build still uses `vite.config.ts`, so it's unchanged.
