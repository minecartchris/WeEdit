// Collaboration transport config — single source of truth for both the project
// doc (collabDoc) and the peer-to-peer media room (mediaSync).
//
// SIGNALING is the y-webrtc signaling server(s). It only brokers the WebRTC
// handshake (who's-in-which-room) — the actual edits + media flow directly
// peer-to-peer. The public yjs signaling servers proved unreliable ("connected"
// but peers never found each other), so this points at the self-hosted server.
// Deploy it from the `server/` folder in this repo.
export const SIGNALING = ["wss://weedit.minecartchris.cc"];

// ICE servers for the peer connections. STUN lets peers discover their public
// address so they can connect through most home routers without port
// forwarding. Symmetric-NAT networks additionally need a TURN relay — add one
// here (with credentials) if some peers still fail to connect.
export const PEER_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

/** Options passed to y-webrtc's WebrtcProvider (shared by both rooms). */
export function webrtcProviderOptions() {
  return {
    signaling: SIGNALING,
    peerOpts: { config: { iceServers: PEER_ICE_SERVERS } },
  };
}
