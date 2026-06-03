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

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 4444;
const HOST = process.env.HOST || "127.0.0.1";
const PING_TIMEOUT_MS = 30000;

const wss = new WebSocketServer({ noServer: true });

// A tiny health/landing endpoint so hitting https://weedit.minecartchris.cc in a
// browser shows something friendly (the real clients connect via the WS upgrade).
const server = http.createServer((req, res) => {
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
