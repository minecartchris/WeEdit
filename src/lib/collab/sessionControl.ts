import * as Y from "yjs";

// Who may do what in a collaboration session.
//
// Kept in the shared doc (map "session"), keyed by each install's persistent
// peer id (`pid`, stable across reconnects — awareness clientIDs change every
// time). The host is whoever started the session, so a host who drops out and
// rejoins keeps the controls.
//
//   host      : pid of the session's host
//   guestRole : role for people the host hasn't set individually
//   roles     : { [pid]: "edit" | "view" }
//   kicked    : { [pid]: true }
//
// This is cooperative enforcement: every WeEdit honours it (a view-only peer's
// edits never reach the doc, a kicked peer leaves), which is the right weight
// for a session code you only hand to people you know.

export type SessionRole = "host" | "edit" | "view";
export type GuestRole = "edit" | "view";

export interface SessionControl {
  roleOf: (pid: string) => SessionRole;
  myRole: () => SessionRole;
  guestRole: () => GuestRole;
  setGuestRole: (role: GuestRole) => void;
  setRole: (pid: string, role: GuestRole) => void;
  kick: (pid: string) => void;
  unbind: () => void;
}

export function bindSessionControl(
  doc: Y.Doc,
  selfPid: string,
  isHost: boolean,
  hooks: { onChange: () => void; onKicked: () => void },
): SessionControl {
  const map = doc.getMap<unknown>("session");

  // The starter claims the host seat unless the room already has a host
  // (e.g. two people both pressed Start with the same code).
  if (isHost && !map.get("host")) {
    doc.transact(() => {
      map.set("host", selfPid);
      if (!map.get("guestRole")) map.set("guestRole", "edit");
    });
  }

  const roles = () => (map.get("roles") as Record<string, GuestRole> | undefined) ?? {};
  const kicked = () => (map.get("kicked") as Record<string, boolean> | undefined) ?? {};
  const guestRole = (): GuestRole => (map.get("guestRole") === "view" ? "view" : "edit");
  const roleOf = (pid: string): SessionRole => {
    if (map.get("host") === pid) return "host";
    return roles()[pid] ?? guestRole();
  };
  const amHost = () => map.get("host") === selfPid;

  let wasKicked = false;
  const onChange = () => {
    if (!wasKicked && kicked()[selfPid]) {
      wasKicked = true;
      hooks.onKicked();
      return;
    }
    hooks.onChange();
  };
  map.observe(onChange);

  return {
    roleOf,
    myRole: () => roleOf(selfPid),
    guestRole,
    setGuestRole: (role) => {
      if (amHost()) map.set("guestRole", role);
    },
    setRole: (pid, role) => {
      if (amHost()) map.set("roles", { ...roles(), [pid]: role });
    },
    kick: (pid) => {
      if (amHost() && pid !== selfPid) map.set("kicked", { ...kicked(), [pid]: true });
    },
    unbind: () => map.unobserve(onChange),
  };
}
