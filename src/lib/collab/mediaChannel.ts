import { WebrtcProvider } from "y-webrtc";

// A dedicated RTCDataChannel per peer, carved out of the peer connections
// y-webrtc already negotiated for the project doc.
//
// WHY NOT YJS: media bytes used to travel as base64 entries in a shared Y.Map.
// Every chunk became a CRDT operation that was encoded, broadcast to *all*
// peers, and kept in the doc's history (deleted keys leave tombstones) — so a
// multi-GB file meant hundreds of thousands of CRDT ops and a doc that grew
// heavier as the transfer went on. A raw data channel sends the bytes once, to
// one peer, with no bookkeeping.
//
// WHY A SEPARATE CHANNEL rather than simple-peer's own: file traffic and project
// edits then have independent flow control, so a running transfer can't stall
// cursor/edit messages behind a multi-megabyte send buffer, and our binary
// frames never reach y-webrtc's message decoder.
//
// Adding a data channel to a connection whose SCTP association is already up
// needs no renegotiation — it is created in-band — so this works on top of
// whatever ICE path y-webrtc established, including over TURN.

const CHANNEL_LABEL = "weedit-media";

/** Frame tag: UTF-8 JSON control message. */
export const FRAME_CONTROL = 0x01;
/** Frame tag: binary payload belonging to the transfer named in the header. */
export const FRAME_DATA = 0x02;

/** Bytes of binary header on a FRAME_DATA frame: tag, 3 pad, u32 transferId. */
export const DATA_HEADER_BYTES = 8;

export interface MediaChannel {
  /** y-webrtc's id for the remote peer (stable for the connection's lifetime). */
  peerId: string;
  /** The remote peer's awareness clientID, learned from its `hello`. Null until then. */
  clientId: number | null;
  channel: RTCDataChannel;
  /** Send a JSON control message. */
  sendControl: (msg: unknown) => void;
}

type ControlHandler = (chan: MediaChannel, msg: Record<string, unknown>) => void;
type DataHandler = (chan: MediaChannel, transferId: number, payload: Uint8Array) => void;

interface Hooks {
  /** Our own awareness clientID, sent in the `hello` handshake. */
  clientId: number;
  onControl: ControlHandler;
  onData: DataHandler;
  onOpen?: (chan: MediaChannel) => void;
  onClose?: (chan: MediaChannel) => void;
  log?: (...args: unknown[]) => void;
}

// y-webrtc's internals we reach into. Narrow structural types rather than `any`
// so a y-webrtc upgrade that changes these surfaces fails the typecheck.
interface SimplePeerLike {
  initiator: boolean;
  connected: boolean;
  _pc: RTCPeerConnection | null;
  once: (event: string, cb: () => void) => void;
}
interface WebrtcConnLike {
  remotePeerId: string;
  closed: boolean;
  peer: SimplePeerLike;
}
interface RoomLike {
  webrtcConns: Map<string, WebrtcConnLike>;
}

function roomOf(provider: WebrtcProvider): RoomLike | null {
  return (provider as unknown as { room: RoomLike | null }).room ?? null;
}

/**
 * Keep a media data channel open to every peer of `provider`, for as long as the
 * returned stop function isn't called.
 */
export function createMediaChannels(provider: WebrtcProvider, hooks: Hooks) {
  const log = hooks.log ?? (() => {});
  const channels = new Map<string, MediaChannel>();
  const wired = new WeakSet<object>();
  let stopped = false;

  function adopt(peerId: string, channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    const chan: MediaChannel = {
      peerId,
      clientId: null,
      channel,
      sendControl: (msg) => {
        if (channel.readyState !== "open") return;
        const json = new TextEncoder().encode(JSON.stringify(msg));
        const frame = new Uint8Array(1 + json.byteLength);
        frame[0] = FRAME_CONTROL;
        frame.set(json, 1);
        try {
          channel.send(frame);
        } catch (err) {
          console.error("[mediaChannel] control send failed:", err);
        }
      },
    };

    const onOpen = () => {
      channels.set(peerId, chan);
      // Identify ourselves so both sides can map this channel to the awareness
      // clientID that advertises which files it holds.
      chan.sendControl({ t: "hello", clientId: hooks.clientId });
      log("channel open to", peerId.slice(0, 8));
      hooks.onOpen?.(chan);
    };

    channel.addEventListener("message", (ev: MessageEvent) => {
      const data = ev.data;
      if (!(data instanceof ArrayBuffer)) return;
      if (data.byteLength < 1) return;
      const view = new Uint8Array(data);
      if (view[0] === FRAME_CONTROL) {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(new TextDecoder().decode(view.subarray(1)));
        } catch {
          return;
        }
        if (msg.t === "hello" && typeof msg.clientId === "number") {
          chan.clientId = msg.clientId;
          log("channel", peerId.slice(0, 8), "is clientId", msg.clientId);
          return;
        }
        hooks.onControl(chan, msg);
      } else if (view[0] === FRAME_DATA && data.byteLength >= DATA_HEADER_BYTES) {
        const transferId = new DataView(data).getUint32(4, true);
        hooks.onData(chan, transferId, view.subarray(DATA_HEADER_BYTES));
      }
    });
    channel.addEventListener("close", () => {
      channels.delete(peerId);
      hooks.onClose?.(chan);
    });
    channel.addEventListener("error", (ev) => {
      console.error("[mediaChannel] channel error:", ev);
    });

    if (channel.readyState === "open") onOpen();
    else channel.addEventListener("open", onOpen);
  }

  // Attach to one of y-webrtc's peer connections.
  //
  // WHICH SIDE OPENS THE CHANNEL MATTERS. simple-peer only installs
  // `pc.ondatachannel` on the NON-initiator (the initiator creates its channel
  // itself), and that handler adopts any incoming channel as simple-peer's own —
  // so a channel we opened towards the non-initiator would replace the project
  // doc's channel and break collaboration. Opening ours from the non-initiator
  // instead means it lands on the initiator, whose `ondatachannel` simple-peer
  // never touches, so there is nothing to race with and nothing to monkey-patch.
  function wire(conn: WebrtcConnLike): void {
    const peer = conn.peer;
    if (!peer || wired.has(peer)) return;
    wired.add(peer);

    // Listen from the moment the connection object exists — the remote may open
    // its channel the instant SCTP comes up, before our next sweep.
    const pc = peer._pc;
    if (pc) {
      pc.addEventListener("datachannel", (ev: RTCDataChannelEvent) => {
        if (ev.channel.label === CHANNEL_LABEL) adopt(conn.remotePeerId, ev.channel);
      });
    }

    if (peer.initiator) return; // the other side opens it; we just listen

    const open = () => {
      if (stopped || conn.closed) return;
      const live = peer._pc;
      if (!live) return;
      try {
        adopt(conn.remotePeerId, live.createDataChannel(CHANNEL_LABEL, { ordered: true }));
      } catch (err) {
        console.error("[mediaChannel] createDataChannel failed:", err);
      }
    };

    // simple-peer's `connect` fires once its own channel is open, which means
    // the SCTP association is up — an extra channel then needs no renegotiation.
    if (peer.connected) open();
    else peer.once("connect", open);
  }

  function sweep(): void {
    if (stopped) return;
    roomOf(provider)?.webrtcConns.forEach(wire);
  }

  // y-webrtc announces peer churn, but a conn can also appear between events
  // (and `room` itself is created asynchronously), so poll as a safety net.
  const onPeers = () => sweep();
  provider.on("peers", onPeers);
  const timer = window.setInterval(sweep, 2000);
  sweep();

  return {
    /** Open channels, keyed by y-webrtc peerId. */
    channels,
    /** The open channel to a peer's awareness clientID, if we have one. */
    byClientId(clientId: number): MediaChannel | null {
      for (const chan of channels.values()) {
        if (chan.clientId === clientId && chan.channel.readyState === "open") return chan;
      }
      return null;
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
      provider.off("peers", onPeers);
      for (const chan of channels.values()) {
        try {
          chan.channel.close();
        } catch {
          // already gone
        }
      }
      channels.clear();
    },
  };
}

/** Build a FRAME_DATA frame for `transferId` around `payload`. */
export function dataFrame(transferId: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(DATA_HEADER_BYTES + payload.byteLength);
  new DataView(frame.buffer).setUint32(4, transferId, true);
  frame[0] = FRAME_DATA;
  frame.set(payload, DATA_HEADER_BYTES);
  return frame;
}
