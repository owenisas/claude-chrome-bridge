# Installing

Two ways to run this. Do **the sandboxed path first** — it proves the whole chain
works without touching the browser you use every day. Then, if you want it in
your own Chrome, that's step 5B.

```
Step 1  get the extension          (you supply it — this repo ships no Anthropic code)
Step 2  patch it                   → extension-patched/
Step 3  install the bridge         npm install (two dependencies)
Step 4  start the bridge           node bridge/server.mjs
Step 5  a browser with the extension
          5A sandboxed             Chrome for Testing, throwaway profile
          5B your own Chrome       one-time manual "Load unpacked"
Step 6  verify                     node bridge/cli.mjs status
Step 7  grant a host               the allowlist starts empty = deny everything
```

## Requirements

| | |
|---|---|
| Node.js | 18+ (uses global `fetch`; developed on 22) |
| Browser | Chrome / Chromium / Edge / Brave with the MV3 side panel API |
| `openssl` | only for `--fork-id` |
| Disk | ~700 MB if you take the sandboxed path (browser download) |
| Platform | verified on macOS. Linux should work; Windows untested (paths differ) |

---

## Step 1 — Get the extension

This repository contains **no Anthropic code**, so you bring the extension
yourself. Either form works:

**A. You have a CRX file** (e.g. `~/Downloads/claude-chrome.crx`) → use `--crx`.

**B. Copy the unpacked folder out of a Chrome profile where it is installed.**
Chrome stores store-installed extensions unpacked, so the directory is the
extension:

```bash
# macOS
ls ~/Library/Application\ Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/
# -> a version directory, e.g. 1.0.102/  <- this is what you copy

cp -R ~/Library/Application\ Support/Google/Chrome/Default/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/1.0.102 ~/claude-ext-src
```

If that path is unreadable, give your terminal **Full Disk Access** in System
Settings → Privacy & Security. Replace `Default` with the profile you actually
use (see step 5B.1).

> The patch set was written against **v1.0.102**. A different version will very
> likely still work, but the patch script asserts on exact byte patterns and will
> tell you if a bundle has changed shape rather than silently producing a broken
> build.

## Step 2 — Patch it

```bash
git clone https://github.com/owenisas/claude-chrome-bridge
cd claude-chrome-bridge

# from a CRX
python3 tools/apply-patches.py --crx ~/Downloads/claude-chrome.crx

# or from the unpacked copy
python3 tools/apply-patches.py --src ~/claude-ext-src

# or, to keep the store extension installed as well (see 5B.3)
python3 tools/apply-patches.py --crx ~/Downloads/claude-chrome.crx --fork-id
```

You get `extension-patched/`. The script parses every patched bundle with
`node --check` before declaring success — that check is what catches a mangled
bundle, a failure mode that otherwise looks exactly like "the extension just
never connects" (see Troubleshooting).

**What the four patches do:**

| # | Change | Why it's needed |
|---|---|---|
| 1 | CSP allows `ws://localhost:8765` | MV3 blocks the loopback socket otherwise |
| 2 | `localBridge: true` | selects the bundle's own local path: no OAuth, `dev_user_local` |
| 3 | URL-safety check skips when signed out | it fails **closed** offline, which would block every navigation |
| 4 | dial the bridge on worker boot | it otherwise only dials from `onStartup`, which never fires for a scripted install |

Patch 3 disables a real safeguard (Anthropic's malicious-site category check) —
it cannot work without their servers. That trade-off is documented in
[`RECON.md`](RECON.md) §6.

## Step 3 — Install the bridge

```bash
cd bridge
npm install          # ws + puppeteer-core, nothing else
cd ..
```

## Step 4 — Start the bridge

```bash
node bridge/server.mjs
```

It listens on **loopback only**:

- `127.0.0.1:8765` (+ `::1`) — the WebSocket the extension dials
- `127.0.0.1:8766` — HTTP API for the CLI and any adapter

Runtime state lives in `~/.claude-chrome-bridge/` (`allow.json`, `bridge.log`).
Override the ports with `CCB_WS_PORT` / `CCB_HTTP_PORT` if they clash.

**Leave it running.** Without it the extension has nothing to talk to and simply
retries. To start it at login, wrap this command in a launchd agent
(`~/Library/LaunchAgents/`).

## Step 5A — Sandboxed browser (do this first)

```bash
npx @puppeteer/browsers install chrome@stable --path ./tmp/browsers
node bridge/launch.mjs
```

`launch.mjs` starts Chrome for Testing with its own profile (`tmp/ccb-profile/`),
installs the patched extension over CDP, and leaves the browser running. It looks
roundabout because of three findings, all documented in the README:

- `--load-extension` is ignored by branded Chrome **and** Chrome for Testing from M137
- `Extensions.loadUnpacked` only exists over the **pipe** transport, so no `--remote-debugging-port`
- puppeteer's own `installExtension()` destroys the service worker it just created

Options: `--port`, `--profile DIR`, `--headless`, `--keep`, `--chrome PATH`.

## Step 5B — Your own Chrome

**1. Find out which profile you're in.** Open `chrome://version` and read the
**Profile Path** line. Extensions are per-profile, and `Default` is not always
the one you're using.

**2. Enable developer mode.** `chrome://extensions` → toggle **Developer mode**
(top right).

**3. Coexistence.** If you built with `--fork-id`, the patched build has its own
id and you can leave the stock extension installed — they appear side by side as
`Claude` and `Claude (local bridge)`. **If you did not fork**, both builds share
one id (the manifest carries the store `key`), so disable or remove the stock
`Claude` extension first.

**4. Load it.** **Load unpacked** → select:

```
<repo>/extension-patched
```

**5. Confirm it dials.** The bridge log should show a connection within a second:

```bash
tail -f ~/.claude-chrome-bridge/bridge.log
```

A user-initiated install persists across restarts, so from then on it connects
every time the browser starts — provided the bridge is running.

---

## Step 6 — Verify

```bash
node bridge/cli.mjs status     # extension.connected: true, version 1.0.102
node bridge/cli.mjs tabs       # creates/uses a tab in the MCP group
```

## Step 7 — First use

**The allowlist starts empty, which means everything is denied.** That is the
intended first-run experience, not a bug:

```
$ node bridge/cli.mjs open https://example.com
error: Permission denied by user

blocked by the local allowlist. Recent denied hosts:
  example.com

grant with:  node bridge/cli.mjs allow <host>
```

Granting a host is a **permission decision** — make it deliberately:

```bash
node bridge/cli.mjs approvals                 # what got blocked, with hosts
node bridge/cli.mjs allow example.com         # grants the host and its subdomains
node bridge/cli.mjs deny  example.com         # revoke
node bridge/cli.mjs open https://example.com
node bridge/cli.mjs read --interactive        # ref-based snapshot
node bridge/cli.mjs click --ref ref_1
node bridge/cli.mjs screenshot --file /tmp/shot.png
```

`node bridge/cli.mjs help` lists every command.

**Several browsers connected?** Commands need to know which one:

```bash
node bridge/cli.mjs status                     # lists each browser's device_id
node bridge/cli.mjs tabs --device a2335e1e     # device_id or an unambiguous prefix
CCB_DEVICE=a2335e1e node bridge/cli.mjs tabs   # or via the environment
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Extension installed, enabled, **no errors**, never connects | a patched bundle failed to parse, so the worker's import graph never evaluated. Looks identical to "won't dial" | rebuild with `tools/apply-patches.py`, which runs `node --check` on every bundle. Never beautify these files — `js-beautify` mangles their template literals |
| `Method not available` from `Extensions.loadUnpacked` | Chrome is routing CDP over TCP because `--remote-debugging-port` is set | drop the flag; the Extensions domain is pipe-only |
| `--load-extension` silently does nothing | removed in branded Chrome / Chrome for Testing M137+ | use `launch.mjs`, or Load unpacked by hand |
| Unpacked extension disappears after a restart | you seeded a profile by hand — macOS Secure Preferences drops it | install through the UI instead |
| `error: Permission denied by user` | the allowlist is empty or the host isn't granted | `node bridge/cli.mjs approvals`, then `allow <host>` — deliberately |
| `N browsers connected: … Pick one with device_id` | more than one browser is attached to the bridge | pass `--device <id|prefix>` or set `CCB_DEVICE` |
| Nothing in the bridge log at all | bridge not running, or the extension is pointed at a different port | start `bridge/server.mjs`; check `CCB_WS_PORT` |
| `find` always fails | it is LLM-backed upstream and there is no inference service in local mode | expected. Use `read --interactive` + `click --ref`, or the CLI's local scorer fallback |
| `browser_batch` refuses an action | it pre-checks the extension's internal grant store, empty in local mode | expected. The CLI replays the actions as standalone calls |
| `JavaScript execution is not allowed on chrome:// pages` | the extension's own guard | navigate to an `http(s)://` page first |
| Bridge works, browser is stale/slow after weeks | Chrome for Testing is pinned and never auto-updates | reinstall with `npx @puppeteer/browsers install chrome@stable` |

## Updating and uninstalling

```bash
# rebuild after a code change — the fork key is reused, so the id is stable
python3 tools/apply-patches.py --src ~/claude-ext-src --fork-id

# uninstall
#   browser: chrome://extensions -> remove "Claude (local bridge)"
#   state:   rm -rf ~/.claude-chrome-bridge
#   build:   rm -rf extension-patched tmp/
```

Nothing is installed system-wide: the bridge is a Node process, the extension is
an unpacked folder, and all state is under `~/.claude-chrome-bridge/`.
