// Collaboration transport config — single source of truth for both the project
// doc (collabDoc) and the peer-to-peer media room (mediaSync).
//
// SIGNALING is the y-webrtc signaling server(s). It only brokers the WebRTC
// handshake (who's-in-which-room) — the actual edits + media flow directly
// peer-to-peer. The public yjs signaling servers proved unreliable ("connected"
// but peers never found each other), so this points at the self-hosted server.
// Deploy it from the `server/` folder in this repo.
//
// Port 8443 is a Cloudflare-proxiable HTTPS port, so the Cloudflare edge cert
// covers wss:// here. Cloudflare terminates TLS at :8443 and forwards to the
// origin (nginx :8443 → node :4444). Set Cloudflare SSL/TLS mode to "Flexible".
export const SIGNALING = ["wss://weedit.minecartchris.cc:8443"];

// ICE servers for the peer connections. STUN lets peers discover their public
// address so they can connect through most home routers without port
// forwarding. Symmetric-NAT networks additionally need a TURN relay — add one
// here (with credentials) if some peers still fail to connect.
export const PEER_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

/** https:// origin of the collab server's small HTTP API (same host as signaling). */
export const COLLAB_API = SIGNALING[0].replace(/^ws/, "http").replace(/\/$/, "") + "/api";

/**
 * STUN plus, when the collab server has a TURN relay configured, short-lived
 * TURN credentials for it. TURN is what lets peers behind strict NAT (phones,
 * schools, offices) connect at all; it relays only for connections that can't
 * go direct. Never blocks a session for long: on any failure it's STUN only.
 */
export async function iceServers(): Promise<RTCIceServer[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${COLLAB_API}/turn`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return PEER_ICE_SERVERS;
    const body = (await res.json()) as { iceServers?: RTCIceServer[] };
    return [...PEER_ICE_SERVERS, ...(body.iceServers ?? [])];
  } catch {
    return PEER_ICE_SERVERS;
  }
}

/** Options passed to y-webrtc's WebrtcProvider (shared by both rooms). */
export function webrtcProviderOptions(ice: RTCIceServer[] = PEER_ICE_SERVERS) {
  return {
    signaling: SIGNALING,
    peerOpts: { config: { iceServers: ice } },
  };
}
