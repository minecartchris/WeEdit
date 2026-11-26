// WeEdit collaboration signaling server.
//
// This is a y-webrtc–compatible signaling server: a tiny topic-based pub/sub
// over WebSocket. It does NOT see or store any project data — it only helps two
// running editors discover each other by room ("topic"). Once they've shaken
// hands, all edits and media flow directly peer-to-peer over WebRTC; this server
// is out of the loop.
//
// It listens on plain HTTP/WS on 127.0.0.1:PORT. Put nginx in front to terminate
// TLS for wss://weedit.minecartchris.cc and proxy the WebSocket upgrade here
// (see server/deploy/nginx-weedit.conf).
//
// Protocol (JSON text frames), matching y-webrtc's client:
//   { type: 'subscribe',   topics: string[] }   join those rooms
//   { type: 'unsubscribe', topics: string[] }   leave those rooms
//   { type: 'publish',     topic, ... }          fan out to everyone in `topic`
//   { type: 'ping' } -> { type: 'pong' }         keepalive
//
// Zero runtime config beyond PORT. Single dependency: `ws`.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 4444;
// Bind on all interfaces by default so the server is reachable on the LAN /
// behind a tunnel without extra config. Set HOST=127.0.0.1 to keep it private
// (e.g. when nginx on the same box is the only thing that should reach it).
const HOST = process.env.HOST || "0.0.0.0";
const PING_TIMEOUT_MS = 30000;

const wss = new WebSocketServer({ noServer: true });

// ── Usage counter ────────────────────────────────────────────────────────────
//
// Behind the website's "people using WeEdit" number. Each install of the app
// makes up a random ID and pings POST /api/ping at most once a day (users can
// switch it off in Settings → Privacy). We keep only: that random ID, first /
// last seen day, app version and OS family — no IPs, names, files or projects.
// GET /api/stats returns the aggregate counts, never the IDs.
//
// Storage is one JSON file. systemd's StateDirectory= gives the service a
// writable /var/lib/weedit-signaling (the rest of the FS is read-only under the
// unit's hardening); DATA_DIR overrides it for running by hand.

const DATA_DIR = process.env.STATE_DIRECTORY || process.env.DATA_DIR || path.resolve("data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[a-z0-9-]{16,64}$/;
const OS_VALUES = new Set(["windows", "linux", "macos", "web", "other"]);

/** id -> { first, last, version, os }  (first/last are epoch days). */
let installs = {};
try {
  installs = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8")).installs || {};
} catch {
  installs = {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${USAGE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ installs }));
      fs.renameSync(tmp, USAGE_FILE); // atomic: a crash never leaves half a file
    } catch (err) {
      console.error("usage: save failed:", err.message);
    }
  }, 5000);
}

// Per-IP rate limit so nobody can inflate the count from one machine.
const PING_LIMIT_PER_HOUR = 20;
const pingsByIp = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  let entry = pingsByIp.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60 * 60 * 1000 };
    pingsByIp.set(ip, entry);
  }
  entry.count += 1;
  return entry.count > PING_LIMIT_PER_HOUR;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of pingsByIp) if (now > e.resetAt) pingsByIp.delete(ip);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "?"
  );
}

function usageStats() {
  const today = Math.floor(Date.now() / DAY_MS);
  const stats = { users: 0, active30d: 0, activeToday: 0, webVisitors: 0, byOs: {} };
  for (const rec of Object.values(installs)) {
    if (rec.os === "web") {
      stats.webVisitors += 1; // browser tries are counted, but not as installs
      continue;
    }
    stats.users += 1;
    stats.byOs[rec.os] = (stats.byOs[rec.os] || 0) + 1;
    if (today - rec.last <= 30) stats.active30d += 1;
    if (rec.last === today) stats.activeToday += 1;
  }
  return stats;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(body == null ? "" : JSON.stringify(body));
}

function handleApi(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 204, null);

  if (req.url === "/api/stats" && req.method === "GET") {
    return sendJson(res, 200, usageStats());
  }

  if (req.url === "/api/ping" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024) req.destroy(); // pings are tiny
    });
    req.on("end", () => {
      if (rateLimited(clientIp(req))) return sendJson(res, 429, { ok: false });
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { ok: false });
      }
      const id = typeof msg.id === "string" ? msg.id.toLowerCase() : "";
      if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false });
      const os = OS_VALUES.has(msg.os) ? msg.os : "other";
      const version = typeof msg.version === "string" ? msg.version.slice(0, 32) : "";
      const today = Math.floor(Date.now() / DAY_MS);
      const prev = installs[id];
      installs[id] = { first: prev?.first ?? today, last: today, version, os };
      scheduleSave();
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  sendJson(res, 404, { ok: false });
}

// A tiny health/landing endpoint so hitting https://weedit.minecartchris.cc in a
// browser shows something friendly (the real clients connect via the WS upgrade).
const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/api/")) {
    handleApi(req, res);
    return;
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: topics.size, clients: clientCount }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(
    "WeEdit signaling server is running.\n\n" +
      "This endpoint is used by the WeEdit desktop app to connect collaborators\n" +
      "(WebRTC signaling). There's no web UI here — start a session from inside\n" +
      "the app and share the session code.\n",
  );
});

/** topic name -> Set<WebSocket> currently subscribed to it. */
const topics = new Map();
let clientCount = 0;

const READY_OPEN = 1;

function send(conn, message) {
  if (conn.readyState !== READY_OPEN) {
    conn.close();
    return;
  }
  try {
    conn.send(JSON.stringify(message));
  } catch {
    conn.close();
  }
}

function onConnection(conn) {
  clientCount += 1;
  const subscribed = new Set();
  let closed = false;
  let alive = true;

  const ping = setInterval(() => {
    if (!alive) {
      conn.close();
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch {
      conn.close();
    }
  }, PING_TIMEOUT_MS);

  conn.on("pong", () => {
    alive = true;
  });

  conn.on("close", () => {
    clearInterval(ping);
    for (const name of subscribed) {
      const subs = topics.get(name);
      if (subs) {
        subs.delete(conn);
        if (subs.size === 0) topics.delete(name);
      }
    }
    subscribed.clear();
    closed = true;
    clientCount -= 1;
  });

  conn.on("message", (data) => {
    if (closed) return;
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (!message || typeof message.type !== "string") return;

    switch (message.type) {
      case "subscribe":
        for (const name of message.topics || []) {
          if (typeof name !== "string") continue;
          let subs = topics.get(name);
          if (!subs) {
            subs = new Set();
            topics.set(name, subs);
          }
          subs.add(conn);
          subscribed.add(name);
        }
        break;

      case "unsubscribe":
        for (const name of message.topics || []) {
          const subs = topics.get(name);
          if (subs) {
            subs.delete(conn);
            if (subs.size === 0) topics.delete(name);
          }
        }
        break;

      case "publish": {
        if (typeof message.topic !== "string") break;
        const receivers = topics.get(message.topic);
        if (!receivers) break;
        message.clients = receivers.size;
        for (const receiver of receivers) send(receiver, message);
        break;
      }

      case "ping":
        send(conn, { type: "pong" });
        break;
    }
  });
}

wss.on("connection", onConnection);

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

server.listen(PORT, HOST, () => {
  console.log(`WeEdit signaling server listening on ws://${HOST}:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\nReceived ${sig}, shutting down.`);
    server.close(() => process.exit(0));
  });
}
