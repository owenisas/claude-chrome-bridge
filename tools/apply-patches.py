#!/usr/bin/env python3
"""
apply-patches.py — turn a stock *Claude in Chrome* extension into one that talks
to a local bridge instead of Anthropic's relay.

This script ships **no Anthropic code**. It operates on a copy you obtain
yourself (the CRX from the Chrome Web Store, or a directory you already
unpacked) and rewrites four things:

  1. manifest.json            — allow the loopback socket in the MV3 CSP
  2. SavedPromptsService-*.js — flip `localBridge` to true
  3. mcpPermissions-*.js      — stop the URL-safety check failing closed offline
  4. service-worker.ts-*.js   — dial the bridge on worker boot, not only onStartup

Everything else in the bundle is left exactly as shipped.

Usage
-----
    # from a CRX you downloaded yourself
    python3 tools/apply-patches.py --crx ~/Downloads/claude-chrome.crx

    # or from an already-unpacked directory
    python3 tools/apply-patches.py --src extension-clean --out extension-patched

Both produce `extension-patched/`, which is what `bridge/launch.mjs` loads.

Why patch 3 and 4 exist is documented in RECON.md; they are not cosmetic.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path

# The store extension's stable id. Present because the manifest carries a `key`,
# so an unpacked copy keeps the same id as the store build.
EXT_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn"

PATCHES = [
    ("manifest.json", "1/4 CSP: allow ws://localhost:8765"),
    ("assets/SavedPromptsService-N06kd8Mw.js", "2/4 localBridge: true"),
    ("assets/mcpPermissions-BAI1woDG.js", "3/4 URL-safety check: skip when signed out"),
    ("assets/service-worker.ts-jNvObEJy.js", "4/4 boot hook: dial on worker start"),
]

BOOT_HOOK = """
// --- local bridge patch (4/4) -------------------------------------------------
// The extension only dials the relay from chrome.runtime.onStartup. That event
// never fires for an extension installed through the DevTools Extensions domain
// (session-only install), so dial on worker boot as well, retrying briefly
// while the posture state initialises.
;(function ccbBoot() {
    let n = 0;
    const t = setInterval(() => {
        try { $t(); } catch (e) {}
        if (++n > 40) clearInterval(t);
    }, 750);
})();
"""


def extract_crx(crx: Path, out: Path) -> None:
    """Unpack a CRX3 into `out`. CRX3 is a 12-byte preamble + protobuf header + zip."""
    raw = crx.read_bytes()
    if raw[:4] != b"Cr24":
        sys.exit(f"not a CRX file (magic={raw[:4]!r}): {crx}")
    version, = struct.unpack("<I", raw[4:8])
    if version != 3:
        sys.exit(f"unsupported CRX version {version} (only CRX3 is handled)")
    header_len, = struct.unpack("<I", raw[8:12])
    zip_start = 12 + header_len
    if raw[zip_start:zip_start + 4] != b"PK\x03\x04":
        sys.exit("CRX payload is not a zip archive")
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(BytesIO(raw[zip_start:])) as zf:
        zf.extractall(out)
    print(f"extracted CRX -> {out}")


def one(pattern: str, text: str, what: str) -> re.Match:
    """Match exactly once, or explain precisely why not."""
    hits = list(re.finditer(pattern, text))
    if len(hits) != 1:
        sys.exit(f"{what}: expected exactly 1 match, found {len(hits)}. "
                 f"Bundle layout changed — re-check against RECON.md.")
    return hits[0]


def patch_csp(path: Path) -> None:
    m = json.loads(path.read_text())
    csp = m["content_security_policy"]["extension_pages"]
    if "ws://localhost:8765" in csp:
        print("  csp already allows the bridge; skipping")
        return
    i = csp.index("connect-src")
    j = csp.index(";", i) if ";" in csp[i:] else len(csp)
    m["content_security_policy"]["extension_pages"] = csp[:j] + " ws://localhost:8765" + csp[j:]
    path.write_text(json.dumps(m, indent=2) + "\n")


def patch_local_bridge(path: Path) -> None:
    s = path.read_text()
    if "localBridge:!0" in s or "localBridge: !0" in s:
        print("  localBridge already true; skipping")
        return
    m = one(r"localBridge:\s*!1", s, "localBridge flag")
    path.write_text(s[:m.start()] + "localBridge:!0" + s[m.end():])


def patch_url_safety(path: Path) -> None:
    s = path.read_text()
    if 'return;return}' in s:
        print("  url-safety already patched; skipping")
        return
    old = '&&!(await B(K.ACCOUNT_UUID)))return;return"category_unknown_error"}'
    m = one(re.escape(old), s, "url-safety fail-closed branch")
    path.write_text(s[:m.start()] + '&&!(await B(K.ACCOUNT_UUID)))return;return}' + s[m.end():])


def patch_boot_hook(path: Path) -> None:
    s = path.read_text()
    if "ccbBoot" in s:
        print("  boot hook already present; skipping")
        return
    path.write_text(s + BOOT_HOOK)


def check_js(path: Path) -> None:
    """Parse a bundle the way Chrome will. This is the check that catches a
    mangled template literal — a beautifier once silently broke this bundle and
    the worker never booted."""
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as fh:
        fh.write(path.read_text())
        tmp = fh.name
    try:
        r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"SYNTAX ERROR in {path.name}:\n{r.stderr.strip()}")
    finally:
        os.unlink(tmp)


def main() -> None:
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--crx", type=Path, help="path to a CRX3 you downloaded")
    src.add_argument("--src", type=Path, help="path to an already-unpacked extension")
    ap.add_argument("--out", type=Path, default=here / "extension-patched")
    args = ap.parse_args()

    out = args.out.resolve()
    if out.exists():
        shutil.rmtree(out)
    if args.crx:
        extract_crx(args.crx.expanduser().resolve(), out)
    else:
        shutil.copytree(args.src.resolve(), out)

    manifest = json.loads((out / "manifest.json").read_text())
    print(f"patching {manifest.get('name')} v{manifest.get('version')} -> {out}")

    # Fail loudly if the bundle isn't the one these patches were written for.
    for rel, what in PATCHES:
        if not (out / rel).exists():
            sys.exit(f"missing {rel} — is this the Claude in Chrome extension? ({what})")

    patch_csp(out / "manifest.json")
    patch_local_bridge(out / PATCHES[1][0])
    patch_url_safety(out / PATCHES[2][0])
    patch_boot_hook(out / PATCHES[3][0])

    print("verifying bundles parse...")
    for rel, _ in PATCHES[1:]:
        check_js(out / rel)

    print(f"done. load {out} with bridge/launch.mjs (or Load unpacked by hand).")


if __name__ == "__main__":
    main()
