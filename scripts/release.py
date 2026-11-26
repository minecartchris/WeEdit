#!/usr/bin/env python3
"""WeEdit release helper.

Two jobs:

  1. Change the *base* version that lives in the source ("set-version").
  2. Cut a release ("release"), which delegates to scripts/release.ps1 -- the
     same script CI mirrors. That script derives the published version as
     <base>.<git-commit-count>, builds + signs the installer, writes
     latest.json, and publishes a GitHub Release.

The "base" is the first two segments of the version string (e.g. 0.0 from
0.0.1). The release script reads it from src-tauri/tauri.conf.json; we also keep
package.json and src-tauri/Cargo.toml in sync so the whole tree agrees.

Examples
  python scripts/release.py version              # show base + next release ver
  python scripts/release.py set-version 0.1      # bump base to 0.1 (-> 0.1.0)
  python scripts/release.py set-version 1.2.0    # set full version explicitly
  python scripts/release.py release --dry-run    # Windows build + sign, no publish
  python scripts/release.py release --push       # push HEAD, then publish (Windows)
  python scripts/release.py release --notes "Fix export crash"
  python scripts/release.py build-linux          # build .deb + .AppImage via WSL
  python scripts/release.py release-all --push    # Windows + Linux, one release
  python scripts/release.py release-all --dry-run # build both, publish nothing

Linux auto-update: when a signing key is available, the Linux build is signed
too, and release-all / upload-linux add `linux-x86_64-deb` and
`linux-x86_64-appimage` entries to the release's latest.json, so .deb and
AppImage installs update themselves like Windows does (the .deb installs via a
pkexec password prompt).
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TAURI_CONF = REPO_ROOT / "src-tauri" / "tauri.conf.json"
CARGO_TOML = REPO_ROOT / "src-tauri" / "Cargo.toml"
PACKAGE_JSON = REPO_ROOT / "package.json"
RELEASE_PS1 = REPO_ROOT / "scripts" / "release.ps1"
BUILD_LINUX_SH = REPO_ROOT / "scripts" / "build-linux.sh"
DIST_LINUX = REPO_ROOT / "dist-linux"
DEFAULT_KEY_PATH = Path.home() / ".tauri" / "weedit.key"
SIGN_ENV = ("TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD")


def fail(msg: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


# --- version reading / parsing -------------------------------------------------

def read_current_version() -> str:
    """The authoritative version string from tauri.conf.json (e.g. '0.0.1')."""
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    version = conf.get("version")
    if not version:
        fail(f"no 'version' field in {TAURI_CONF}")
    return version


def base_of(version: str) -> str:
    """First two segments -- what the release script uses as the base."""
    return ".".join(version.split(".")[:2])


def normalize_version(arg: str) -> str:
    """Accept X.Y or X.Y.Z; return a full semver X.Y.Z (X.Y -> X.Y.0)."""
    parts = arg.split(".")
    if len(parts) == 2:
        parts.append("0")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        fail(f"invalid version '{arg}'. Use X.Y or X.Y.Z (digits only).")
    return ".".join(parts)


def git_commit_count() -> str:
    out = subprocess.run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    if out.returncode != 0:
        fail("git rev-list failed -- are you in the repo?\n" + out.stderr.strip())
    return out.stdout.strip()


# --- version writing -----------------------------------------------------------

def _sub_once(text: str, pattern: re.Pattern[str], repl_group: str, label: str) -> str:
    new_text, n = pattern.subn(lambda m: m.group(1) + repl_group + m.group(3), text, count=1)
    if n == 0:
        fail(f"could not find the version line in {label}")
    return new_text


def write_version(full: str) -> None:
    """Write `full` (X.Y.Z) into all three source-of-truth files, in place,
    preserving each file's formatting."""
    # tauri.conf.json: top-level  "version": "..."
    t = TAURI_CONF.read_text(encoding="utf-8")
    t = _sub_once(
        t, re.compile(r'(^\s*"version"\s*:\s*")([^"]+)(")', re.MULTILINE), full,
        "tauri.conf.json",
    )
    TAURI_CONF.write_text(t, encoding="utf-8")

    # package.json: top-level  "version": "..."
    p = PACKAGE_JSON.read_text(encoding="utf-8")
    p = _sub_once(
        p, re.compile(r'(^\s*"version"\s*:\s*")([^"]+)(")', re.MULTILINE), full,
        "package.json",
    )
    PACKAGE_JSON.write_text(p, encoding="utf-8")

    # Cargo.toml: the `version = "..."` line inside the [package] section only.
    c = CARGO_TOML.read_text(encoding="utf-8")
    pkg = re.search(r'(?ms)^\[package\]\s*\n(.*?)(?=^\[|\Z)', c)
    if not pkg:
        fail("no [package] section in Cargo.toml")
    section = pkg.group(0)
    new_section = _sub_once(
        section, re.compile(r'(^\s*version\s*=\s*")([^"]+)(")', re.MULTILINE), full,
        "Cargo.toml [package]",
    )
    CARGO_TOML.write_text(c[:pkg.start()] + new_section + c[pkg.end():], encoding="utf-8")


# --- commands ------------------------------------------------------------------

def cmd_version(_args: argparse.Namespace) -> None:
    current = read_current_version()
    base = base_of(current)
    count = git_commit_count()
    print(f"source version : {current}")
    print(f"base           : {base}")
    print(f"commit count   : {count}")
    print(f"next release   : {base}.{count}")


def cmd_set_version(args: argparse.Namespace) -> None:
    full = normalize_version(args.version)
    old = read_current_version()
    write_version(full)
    print(f"version: {old} -> {full}")
    print(f"new base: {base_of(full)}  (releases will be {base_of(full)}.<commit-count>)")
    print("updated: src-tauri/tauri.conf.json, package.json, src-tauri/Cargo.toml")
    print("note: run `cargo update -p weedit` or build once so Cargo.lock picks it up.")


def next_release_version() -> str:
    """The version the next release gets: <base>.<commit-count>."""
    return f"{base_of(read_current_version())}.{git_commit_count()}"


def wslpath(distro: str, win_path: str) -> str:
    """Convert a Windows path to its /mnt/... path inside the given WSL distro."""
    out = subprocess.run(
        ["wsl", "-d", distro, "wslpath", "-a", win_path],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        fail(f"wslpath failed for {win_path!r} (is the '{distro}' WSL distro installed?)\n"
             + out.stderr.strip())
    return out.stdout.strip()


def release_tag() -> str:
    """The GitHub release tag release.ps1 publishes to: build-<short-sha>."""
    out = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    if out.returncode != 0:
        fail("git rev-parse failed.\n" + out.stderr.strip())
    return f"build-{out.stdout.strip()}"


def run_windows_release(*, dry_run: bool, push: bool, notes: str | None,
                        key_path: str | None) -> int:
    """Build, sign, and (unless dry_run) publish the Windows release via
    release.ps1. Returns the child process exit code."""
    if not RELEASE_PS1.exists():
        fail(f"missing {RELEASE_PS1}")
    cmd = [
        "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", str(RELEASE_PS1),
    ]
    if dry_run:
        cmd.append("-DryRun")
    if push:
        cmd.append("-Push")
    if notes:
        cmd += ["-Notes", notes]
    if key_path:
        cmd += ["-KeyPath", key_path]

    print(f"==> releasing {next_release_version()} (Windows) via release.ps1")
    return subprocess.run(cmd, cwd=REPO_ROOT).returncode


def default_distro() -> str:
    """Ubuntu if it's installed, else Debian, else whatever WSL lists first."""
    out = subprocess.run(["wsl", "-l", "-q"], capture_output=True)
    # `wsl -l` writes UTF-16 on Windows.
    text = out.stdout.decode("utf-16-le", errors="ignore") if out.stdout else ""
    names = [n.strip().strip("\x00") for n in text.splitlines() if n.strip().strip("\x00")]
    names = [n for n in names if not n.lower().startswith("docker-desktop")]
    for preferred in ("Ubuntu", "Debian"):
        for n in names:
            if n.lower().startswith(preferred.lower()):
                return n
    return names[0] if names else "Ubuntu"


def prepare_signing(key_path: str | None, *, required: bool) -> bool:
    """Load the updater signing key (and its password) into the environment so
    both the Windows build and the WSL Linux build can sign. Returns whether a
    key is available. Asks for the password once, up front, instead of having
    each build prompt for it after minutes of compiling."""
    if not os.environ.get("TAURI_SIGNING_PRIVATE_KEY"):
        path = Path(key_path) if key_path else DEFAULT_KEY_PATH
        if path.exists():
            os.environ["TAURI_SIGNING_PRIVATE_KEY"] = path.read_text(encoding="utf-8").strip()
            print(f"==> using signing key {path}")
        elif required:
            fail(f"no signing key: set TAURI_SIGNING_PRIVATE_KEY or put the key at {path}")
        else:
            print("==> no signing key found -- the Linux build won't be signed for auto-update")
            return False
    if "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" not in os.environ and sys.stdin.isatty():
        pw = getpass.getpass("Signing key password (Enter if it has none): ")
        if pw:
            os.environ["TAURI_SIGNING_PRIVATE_KEY_PASSWORD"] = pw
    # Forward the key + password into WSL without putting them on a command line.
    forwarded = [f"{name}/u" for name in SIGN_ENV if name in os.environ]
    existing = [e for e in os.environ.get("WSLENV", "").split(":") if e]
    os.environ["WSLENV"] = ":".join(dict.fromkeys(existing + forwarded))
    return True


def publish_linux_updater(tag: str, version: str) -> int:
    """Add the signed Linux bundles to the release's latest.json so installed
    Linux copies auto-update. Keys follow tauri-plugin-updater's lookup order:
    `{os}-{arch}-{bundle}` first, then `{os}-{arch}`."""
    repo = subprocess.run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
        cwd=REPO_ROOT, capture_output=True, text=True,
    ).stdout.strip()
    if not repo:
        fail("couldn't determine the GitHub repo (gh repo view).")

    entries: dict[str, dict[str, str]] = {}
    for bundle, pattern in (("deb", "*.deb"), ("appimage", "*.AppImage")):
        art = next((p for p in DIST_LINUX.glob(pattern) if f"_{version}_" in p.name), None)
        sig = art.with_name(art.name + ".sig") if art else None
        if not art or not sig or not sig.exists():
            print(f"    (no signed {bundle} for {version}; skipping its updater entry)")
            continue
        entries[f"linux-x86_64-{bundle}"] = {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/{repo}/releases/download/{tag}/{art.name}",
        }
    if not entries:
        print("==> no signed Linux bundles -- Linux installs won't auto-update this release")
        return 0
    # Plain `linux-x86_64` (no bundle suffix) for older updaters: the AppImage
    # is the format they knew how to install.
    if "linux-x86_64-appimage" in entries:
        entries["linux-x86_64"] = entries["linux-x86_64-appimage"]

    with tempfile.TemporaryDirectory() as tmp:
        got = subprocess.run(
            ["gh", "release", "download", tag, "-p", "latest.json", "-D", tmp, "--clobber"],
            cwd=REPO_ROOT,
        )
        if got.returncode != 0:
            fail(f"couldn't download latest.json from release {tag}")
        latest_path = Path(tmp) / "latest.json"
        latest = json.loads(latest_path.read_text(encoding="utf-8-sig"))
        latest.setdefault("platforms", {}).update(entries)
        latest_path.write_text(json.dumps(latest, indent=2), encoding="utf-8")
        print(f"==> adding {', '.join(entries)} to latest.json on {tag}")
        return subprocess.run(
            ["gh", "release", "upload", tag, str(latest_path), "--clobber"], cwd=REPO_ROOT,
        ).returncode


def run_linux_build(*, distro: str, no_install: bool, version: str | None = None) -> int:
    """Build the Linux .deb + .AppImage in WSL. Returns the child exit code."""
    if not BUILD_LINUX_SH.exists():
        fail(f"missing {BUILD_LINUX_SH}")
    version = version or next_release_version()
    DIST_LINUX.mkdir(exist_ok=True)

    src_wsl = wslpath(distro, str(REPO_ROOT))
    out_wsl = wslpath(distro, str(DIST_LINUX))
    script_wsl = wslpath(distro, str(BUILD_LINUX_SH))

    print(f"==> building Linux bundle {version} in WSL ({distro})")
    print(f"    output -> {DIST_LINUX}")
    cmd = [
        "wsl", "-d", distro, "env",
        f"SRC_DIR={src_wsl}",
        f"VERSION={version}",
        f"OUT_DIR={out_wsl}",
        f"AUTO_INSTALL={'0' if no_install else '1'}",
        "bash", script_wsl,
    ]
    return subprocess.run(cmd, cwd=REPO_ROOT).returncode


def upload_linux_assets(tag: str, version: str) -> int:
    """Attach this version's Linux artifacts to the existing GitHub release."""
    files = sorted(
        p for pattern in ("*.deb", "*.AppImage")
        for p in DIST_LINUX.glob(pattern)
        if version in p.name
    )
    if not files:
        fail(f"no Linux artifacts matching {version} in {DIST_LINUX} to upload.")
    print(f"==> uploading {len(files)} Linux artifact(s) to release {tag}")
    for f in files:
        print(f"    {f.name}")
    return subprocess.run(
        ["gh", "release", "upload", tag, *[str(f) for f in files], "--clobber"],
        cwd=REPO_ROOT,
    ).returncode


def cmd_build_linux(args: argparse.Namespace) -> None:
    prepare_signing(None, required=False)
    sys.exit(run_linux_build(distro=args.distro or default_distro(), no_install=args.no_install,
                             version=args.version))


def cmd_upload_linux(args: argparse.Namespace) -> None:
    """Attach the already-built dist-linux artifacts to a GitHub release.
    Defaults to this commit's tag + version; pass --tag and --version to
    resume a previous release after a mid-flight fix."""
    tag = args.tag or release_tag()
    version = args.release_version or next_release_version()
    code = upload_linux_assets(tag, version)
    if code == 0:
        code = publish_linux_updater(tag, version)
    sys.exit(code)


def cmd_release(args: argparse.Namespace) -> None:
    sys.exit(run_windows_release(
        dry_run=args.dry_run, push=args.push, notes=args.notes, key_path=args.key_path))


def cmd_release_all(args: argparse.Namespace) -> None:
    """Full release: Windows (publishes the GitHub release) + Linux (.deb +
    .AppImage), then attach the Linux artifacts to that same release."""
    version = next_release_version()
    print(f"==> FULL RELEASE {version}: Windows + Linux"
          + (" (dry run)" if args.dry_run else ""))
    # One key + password for both platforms, asked for before any building.
    prepare_signing(args.key_path, required=True)
    distro = args.distro or default_distro()

    # 1. Windows first -- this is what creates/updates the GitHub release that
    # the Linux artifacts get attached to.
    if run_windows_release(dry_run=args.dry_run, push=args.push,
                           notes=args.notes, key_path=args.key_path) != 0:
        fail("Windows release failed; aborting before the Linux build.")

    # 2. Linux build (local artifacts in dist-linux/).
    if run_linux_build(distro=distro, no_install=args.no_install) != 0:
        state = "built" if args.dry_run else "already published"
        fail(f"Linux build failed. The Windows release is {state}; re-run "
             f"`build-linux` once fixed, then `gh release upload`.")

    # 3. Attach Linux artifacts to the release (a dry run never published one).
    if args.dry_run:
        print("==> dry run: built Windows + Linux locally; nothing uploaded.")
        return
    if upload_linux_assets(release_tag(), version) != 0:
        fail("Linux artifact upload failed.")
    if publish_linux_updater(release_tag(), version) != 0:
        fail("Couldn't add the Linux builds to latest.json (Linux installs won't auto-update).")
    print(f"==> Full release {version} done -- Windows + Linux at tag {release_tag()}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="release.py", description="WeEdit version + release helper.")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("version", help="show the base version and the next release version").set_defaults(func=cmd_version)

    sv = sub.add_parser("set-version", help="change the base version in the source")
    sv.add_argument("version", help="new version: X.Y (sets X.Y.0) or X.Y.Z")
    sv.set_defaults(func=cmd_set_version)

    rel = sub.add_parser("release", help="build, sign, and publish a Windows release (via release.ps1)")
    rel.add_argument("--dry-run", action="store_true", help="build + sign only; don't publish")
    rel.add_argument("--push", action="store_true", help="push HEAD to origin before tagging")
    rel.add_argument("--notes", help="release notes text")
    rel.add_argument("--key-path", help="path to the minisign private key")
    rel.set_defaults(func=cmd_release)

    bl = sub.add_parser("build-linux", help="build a Linux .deb + .AppImage via WSL")
    bl.add_argument("--distro", default=None, help="WSL distro to build in (default: Ubuntu, else Debian)")
    bl.add_argument("--no-install", action="store_true",
                    help="don't auto-install missing build deps; print the commands instead")
    bl.add_argument("--version", default=None,
                    help="override the version baked into artifacts (default: base.commit-count)")
    bl.set_defaults(func=cmd_build_linux)

    ra = sub.add_parser(
        "release-all",
        help="full release: publish Windows + build Linux + attach Linux artifacts")
    ra.add_argument("--dry-run", action="store_true",
                    help="build both locally; don't publish or upload anything")
    ra.add_argument("--push", action="store_true", help="push HEAD to origin before tagging")
    ra.add_argument("--notes", help="release notes text")
    ra.add_argument("--key-path", help="path to the minisign private key (Windows signing)")
    ra.add_argument("--distro", default=None, help="WSL distro for the Linux build (default: Ubuntu, else Debian)")
    ra.add_argument("--no-install", action="store_true",
                    help="don't auto-install missing Linux build deps")
    ra.set_defaults(func=cmd_release_all)

    ul = sub.add_parser(
        "upload-linux",
        help="attach existing dist-linux artifacts to this commit's release",
    )
    ul.add_argument("--tag", default=None,
                    help="override the release tag (default: build-<current HEAD sha>)")
    ul.add_argument("--release-version", default=None, dest="release_version",
                    help="override the version to match artifacts (default: current base.count)")
    ul.set_defaults(func=cmd_upload_linux)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
