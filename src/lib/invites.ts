import { WEBSITE_URL } from "@/lib/links";
import { isTauri } from "@/lib/platform";
import { useCollab } from "@/state/collab";
import { useEditor } from "@/state/editor";
import { pickCollabMediaDir, usePrefs } from "@/state/prefs";

// Invite links for collaboration sessions.
//
//   weedit://join/<code>                      opens the desktop app and joins
//   https://<site>/editor/?join=<code>         opens the browser editor and joins
//
// The desktop app registers the weedit:// scheme (tauri-plugin-deep-link); a
// click while WeEdit is already open is forwarded to the running window by the
// single-instance plugin, so it never starts a second copy.

const CODE_RE = /^[a-z0-9-]{4,64}$/i;

export function webInviteLink(code: string): string {
  return `${WEBSITE_URL}/editor/?join=${encodeURIComponent(code)}`;
}

export function desktopInviteLink(code: string): string {
  return `weedit://join/${encodeURIComponent(code)}`;
}

/** The session code in an invite URL, or null if it isn't one. */
export function parseInvite(url: string): string | null {
  try {
    const u = new URL(url);
    let code: string | null = null;
    if (u.protocol === "weedit:") {
      // weedit://join/<code>: "join" parses as the host, the code as the path.
      const parts = `${u.host}${u.pathname}`.split("/").filter(Boolean);
      if (parts[0] === "join") code = parts[1] ?? null;
    } else {
      code = u.searchParams.get("join");
    }
    code = code ? decodeURIComponent(code).trim() : null;
    return code && CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

let joining = false;

/** Join the session behind an invite, after checking with the user. */
export async function joinFromInvite(code: string): Promise<void> {
  if (joining) return;
  const collab = useCollab.getState();
  if (collab.status !== "idle" && collab.roomId === code) return; // already in it
  joining = true;
  try {
    const hasWork = Object.keys(useEditor.getState().clips).length > 0;
    const msg = hasWork
      ? `Join collaboration session ${code}?\n\nThis replaces your current timeline with the shared project. Save first if you want to keep it.`
      : `Join collaboration session ${code}?`;
    if (!window.confirm(msg)) return;

    // Same rule as the Join button: a chosen download folder must exist first.
    const prefs = usePrefs.getState();
    if (isTauri() && !prefs.collabMediaTemp && !prefs.collabMediaDir) {
      if (!(await pickCollabMediaDir())) return;
    }
    if (collab.status !== "idle") collab.leave();
    await useCollab.getState().join(code);
  } catch (err) {
    console.error("Joining from an invite failed:", err);
    window.alert("Couldn't join that session. Check the link and try again.");
  } finally {
    joining = false;
  }
}

/** Handle the invite the app was opened with, and any that arrive later. */
export async function initInvites(): Promise<void> {
  if (!isTauri()) {
    const code = parseInvite(window.location.href);
    if (!code) return;
    // Drop ?join= so a reload doesn't ask again.
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState(null, "", url.toString());
    await joinFromInvite(code);
    return;
  }

  try {
    const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
    const handle = (urls: string[] | null) => {
      for (const u of urls ?? []) {
        const code = parseInvite(u);
        if (code) {
          void joinFromInvite(code);
          return;
        }
      }
    };
    handle(await getCurrent()); // launched by a link
    await onOpenUrl(handle); // link clicked while running
  } catch (err) {
    console.warn("Invite links unavailable:", err);
  }
}
