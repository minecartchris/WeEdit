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

## TLS / Cloudflare

**Cloudflare terminates TLS at its edge**, so there's no certificate to manage on
the VM — nginx serves the origin over plain HTTP on port 80. In the Cloudflare
dashboard:

The app connects to **`wss://weedit.minecartchris.cc:8443`** — 8443 is one of
Cloudflare's proxiable HTTPS ports, so the edge cert covers it.

1. Make `weedit.minecartchris.cc` a **proxied (orange-cloud)** record pointing at
   the origin.
2. Set **SSL/TLS mode → Flexible** (edge → origin over plain HTTP).
3. Cloudflare proxies WebSockets automatically, so `wss://…:8443` reaches the
   origin as a normal `ws` upgrade — nothing extra to enable.

Cloudflare forwards to the origin on the **same port (8443)**, so nginx listens
on 8443 (it also keeps :80 for convenient direct LAN checks). The node server
stays on :4444 behind it. (4444 itself is *not* a Cloudflare-proxiable port,
which is why nginx fronts it.)

The origin has to be reachable *from Cloudflare*. Since this VM is on a private
LAN (e.g. `192.168.1.242`), use one of:

- **Cloudflare Tunnel** (no port forwarding — fits the rest of WeEdit): install
  `cloudflared`, then route the hostname to `http://localhost:8443` (or straight
  to `http://localhost:4444` and skip nginx entirely).
- **Port forward** 8443 on your router to this VM, with Cloudflare DNS pointed at
  your public IP.

## Deploy on a Debian VM (with nginx) — manual

These are the same steps `install.sh` runs, broken out.

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

# Verify it's up (binds 0.0.0.0:4444 — reachable on the LAN too):
curl -s http://127.0.0.1:4444/health   # -> {"ok":true,"rooms":0,"clients":0}
sudo systemctl status weedit-signaling
```

### 4. Front it with nginx (Cloudflare provides TLS)

```bash
sudo cp deploy/nginx-weedit.conf /etc/nginx/sites-available/weedit
sudo ln -sf /etc/nginx/sites-available/weedit /etc/nginx/sites-enabled/weedit
sudo rm -f /etc/nginx/sites-enabled/default   # don't let it shadow ours on :80
sudo nginx -t && sudo systemctl reload nginx
```

No certbot — see the **TLS / Cloudflare** section above.

### 5. Test

- Direct (LAN): `http://<vm-ip>:4444/health` → JSON with `ok: true`.
- Through nginx: `http://<vm-ip>:8443/health` (the Cloudflare origin port).
- Public: `https://weedit.minecartchris.cc:8443/health` once Cloudflare is
  pointed at the origin.
- App: launch WeEdit on two machines, **Start a session** on one, copy the code,
  **Join** on the other. The collaborate button should show `2`, and each peer's
  playhead should appear on the other's timeline.

A quick WebSocket smoke test from any machine:

```bash
npx wscat -c wss://weedit.minecartchris.cc:8443
> {"type":"subscribe","topics":["test"]}
> {"type":"publish","topic":"test","hello":"world"}   # echoes back to subscribers
```

---

## Operating notes

- **Logs:** `journalctl -u weedit-signaling -f`
- **Restart:** `sudo systemctl restart weedit-signaling`
- **Update:** copy a new `signaling.mjs`, then `sudo systemctl restart weedit-signaling`
- **Bind address / port:** defaults to `0.0.0.0:4444` (reachable on the LAN).
  Change via `Environment=HOST=`/`PORT=` in the unit file; set `HOST=127.0.0.1`
  if you want only a local nginx proxy to reach it.
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
