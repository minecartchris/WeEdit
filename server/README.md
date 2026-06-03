# WeEdit signaling server

This is the rendezvous server that lets two running WeEdit editors find each
other for real-time collaboration. It's a small [y-webrtc][y-webrtc]–compatible
**signaling** server — a topic-based pub/sub over WebSocket.

**What it does:** brokers the WebRTC handshake ("who is in room `ab3f9c2`?").
**What it does NOT do:** see, store, or relay your project or media. Once two
editors are introduced, all edits and media transfer **directly peer-to-peer**;
this server is out of the loop. So it stays tiny and cheap to run.

The desktop app is already pointed at `wss://weedit.minecartchris.cc`
(see `src/lib/collab/config.ts`). Deploy this so that hostname resolves to your
VM and serves the WebSocket.

> Why this exists: the public yjs signaling servers were unreliable — the app
> showed "connected" (the provider came up) but peers never actually found each
> other. A signaling server you control fixes that.

---

## One-line deploy

With DNS for `weedit.minecartchris.cc` pointed at the VM and ports 80/443 open,
copy this `server/` folder to the VM, then from inside it run:

```bash
sudo bash deploy/install.sh
```

That installs Node + nginx, deploys the server to `/opt/weedit-signaling` as a
systemd service, configures the nginx site, and requests a TLS cert via certbot.
Re-run it any time to update. Override the domain with
`sudo DOMAIN=other.example.com bash deploy/install.sh`.

Just want to test the server in the foreground without nginx/systemd?

```bash
cd server && npm install --omit=dev && node signaling.mjs
```

The manual steps below are the same thing broken out, if you'd rather do it by
hand or the script hits something specific to your box.

## Deploy on a Debian VM (with nginx) — manual

Assumes a fresh Debian and that DNS for `weedit.minecartchris.cc` already points
an A/AAAA record at the VM's public IP, and ports 80/443 are open.

### 1. Install Node.js + nginx

```bash
sudo apt update
sudo apt install -y nginx
# Node 20 LTS:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Put the server in place

Copy the `server/` folder from this repo to `/opt/weedit-signaling` on the VM
(via `scp`, `git clone`, etc.), then install its one dependency:

```bash
sudo mkdir -p /opt/weedit-signaling
# copy signaling.mjs + package.json here, then:
cd /opt/weedit-signaling
sudo npm install --omit=dev      # installs `ws`
```

### 3. Run it as a service

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin weedit
sudo chown -R weedit:weedit /opt/weedit-signaling

sudo cp deploy/weedit-signaling.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now weedit-signaling

# Verify it's up on loopback:
curl -s http://127.0.0.1:4444/health   # -> {"ok":true,"rooms":0,"clients":0}
sudo systemctl status weedit-signaling
```

### 4. Front it with nginx + TLS

```bash
sudo cp deploy/nginx-weedit.conf /etc/nginx/sites-available/weedit
sudo ln -s /etc/nginx/sites-available/weedit /etc/nginx/sites-enabled/weedit
sudo nginx -t && sudo systemctl reload nginx

# Get a Let's Encrypt cert (rewrites the site to add the :443 ssl block):
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d weedit.minecartchris.cc
sudo systemctl reload nginx
```

### 5. Test

- Browser: open `https://weedit.minecartchris.cc/health` → JSON with `ok: true`.
- App: launch WeEdit on two machines, **Start a session** on one, copy the code,
  **Join** on the other. The collaborate button should show `2`, and each peer's
  playhead should appear on the other's timeline.

A quick WebSocket smoke test from any machine:

```bash
npx wscat -c wss://weedit.minecartchris.cc
> {"type":"subscribe","topics":["test"]}
> {"type":"publish","topic":"test","hello":"world"}   # echoes back to subscribers
```

---

## Operating notes

- **Logs:** `journalctl -u weedit-signaling -f`
- **Restart:** `sudo systemctl restart weedit-signaling`
- **Update:** copy a new `signaling.mjs`, then `sudo systemctl restart weedit-signaling`
- **Port:** defaults to `127.0.0.1:4444`; change via `Environment=PORT=` in the
  unit file (keep it on loopback — nginx is the public face).
- **Resource use:** negligible. It holds a WebSocket per online collaborator and
  forwards a handful of tiny handshake messages per session.

## If some peers still can't connect

Signaling only introduces peers; the WebRTC connection itself still has to punch
through NAT. STUN (already configured in the app) handles most home routers, but
**symmetric NAT** (some corporate/mobile networks) needs a **TURN relay**. To add
one, stand up [coturn][coturn] and add it to `PEER_ICE_SERVERS` in
`src/lib/collab/config.ts`:

```ts
{ urls: "turn:weedit.minecartchris.cc:3478", username: "weedit", credential: "…" }
```

TURN relays the media, so it uses real bandwidth — only needed for peers STUN
can't connect.

[y-webrtc]: https://github.com/yjs/y-webrtc
[coturn]: https://github.com/coturn/coturn
