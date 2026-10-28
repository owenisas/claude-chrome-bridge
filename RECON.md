# Claude in Chrome — local reverse engineering + bridge

**Last updated: 2026-10-28**

The official *Claude in Chrome* extension (`fcoeoabgfenejglbffodgkkbkcdhcgfn`, v1.0.102)
drives a real browser and is normally paired to Anthropic's relay
(`wss://bridge.claudeusercontent.com`) through a Claude account. This project
replaces that relay with a **loopback bridge on this Mac** and replaces the
account with a **local allowlist**, so the extension's full tool surface is
available to OpenCode without any Anthropic-side login or data path.

Everything below was verified on 2026-10-28 on this Mac.

---

## 1. Architecture

```
OpenCode / CLI                     bridge (this repo)                 browser
─────────────────                  ───────────────────                ───────
node bridge/cli.mjs …  ──HTTP──▶  127.0.0.1:8766  /tool               ┌──────────────┐
                                  127.0.0.1:8766  /status,/allow,…    │ Chrome for   │
                                  127.0.0.1:8765  WebSocket  ◀──WS──▶ │ Testing      │
                                          │                          │  └ Claude    │
                                          │  permission_request      │    extension │
                                          └── permission_response ──▶│  (patched)   │
                                             (local allowlist)       └──────────────┘
```

* **Nothing leaves the Mac.** No OAuth token, no `bridge.claudeusercontent.com`,
  no `api.anthropic.com` calls for the tool path.
* The extension believes it is talking to its relay; it is talking to
  `ws://localhost:8765/chrome/dev_user_local`.
* The permission prompt that normally reaches the Claude account is answered
  here from `~/.claude-chrome-bridge/allow.json`.

### Why the extension was reusable as-is

The bundle already contains a **`localBridge` code path**: with that flag set it
uses `ws://localhost:8765`, sets `dev_user_id = "dev_user_local"`, and skips
OAuth entirely. It also contains a documented managed/enterprise mode
(`forceLoginOrgUUID`) where a desktop peer drives the extension with no relay.
The local-only design is contemplated upstream; the patch set just turns it on.

---

## 2. Protocol (relay ↔ extension)

Frames observed and exercised against the live extension:

| Direction | Frame | Notes |
|---|---|---|
| ext → relay | `connect` | `{client_type:"chrome-extension", device_id, dev_user_id, os_platform, extension_version, scoped_peer_disconnect:true}` |
| relay → ext | `paired` | `{scoped_peer_disconnect:true}` |
| relay → ext | `peer_connected` | sent immediately after `paired` |
| relay → ext | `tool_call` | `{tool_use_id, tool, args, client_type:"desktop", handle_permission_prompts:true, supports_tool_result_notices, supports_tool_result_error_code}` |
| ext → relay | `tool_result` | `{tool_use_id, content:[{type:"text"\|"image",…}], is_error?, error_code?}` |
| ext → relay | `permission_request` | `{request_id, tool_use_id, tool_type, url, action_data?}` |
| relay → ext | `permission_response` | `{request_id, allowed:bool}` |
| ext → relay | `ping` / relay → ext `pong` | 20 s keepalive from the extension |

Tool registry in the extension: `navigate`, `read_page`, `get_page_text`, `find`,
`form_input`, `javascript_tool`, `computer`, `browser_batch`, `resize_window`,
`gif_creator`, `upload_image`, `file_upload`, `tabs_context_mcp`,
`tabs_create_mcp`, `tabs_close_mcp`, `read_console_messages`,
`read_network_requests`.

`computer` actions: `left_click`, `right_click`, `type`, `screenshot`, `wait`,
`scroll`, `key`, `left_click_drag`, `double_click`, `triple_click`, `zoom`,
`scroll_to`, `hover`.

Permission categories seen: `navigate`, `read_page_content`, `click`, `type`,
`execute_javascript`, `domain_transition`, `plan_approval`, `remote_mcp`.
Modes: `ask`, `skip_all_permission_checks`, `follow_a_plan`.

---

## 3. Patch set (4 edits, `extension-clean/` → `extension-patched/`)

Apply with `tools/apply-patches.py` against a copy of the extension you supply
(see section 7). The vendor-derived directories below are **not distributed** —
they are gitignored and regenerated locally, because the bundle is Anthropic's
code and this project ships only the patch.

| # | File | Change | Why |
|---|---|---|---|
| 1 | `manifest.json` | add `ws://localhost:8765` to `connect-src` | MV3 CSP blocks the local socket otherwise |
| 2 | `assets/SavedPromptsService-N06kd8Mw.js` | `localBridge:!1` → `localBridge:!0` | selects the local path (no OAuth, `dev_user_local`) |
| 3 | `assets/mcpPermissions-BAI1woDG.js` | no-token URL-safety check returns instead of `category_unknown_error` | the hosted category lookup fails closed when signed out; that would block navigation |
| 4 | `assets/service-worker.ts-jNvObEJy.js` | call `$t()` (dial the bridge) on worker boot, retrying briefly | the extension only dials from `chrome.runtime.onStartup`, which never fires for a session-only CDP install |

Patch 4 is additive; patches 1–3 are the minimum needed for the local path.

> **Watch out:** the first unpack of this CRX was corrupted while being beautified.
> **`js-beautify` 2.0.3 mis-formats this bundle's template literals** — it turns
> `` `data: ${r}${s}` `` into a broken multi-line `$ {` form, and the resulting
> syntax error killed the worker's import graph, so the service worker never
> booted and the extension silently never connected. Nothing surfaced in
> `chrome.developerPrivate`; it looked exactly like "the extension just doesn't
> dial out".
>
> Use **prettier** (`npx prettier@3 --parser babel --print-width 100`) for these
> bundles, re-extract from the CRX if anything looks off, and `node --check`
> every patched asset (rename to `.mjs` first).

---

## 4. Runbook

```bash
cd ~/Documents/Automation-agents/claude-chrome-re

# one-time: a browser whose Extensions CDP domain works
npx @puppeteer/browsers install chrome@stable --path ./tmp/browsers

# 1. bridge (loopback relay + allowlist API)
node bridge/server.mjs            # ws://127.0.0.1:8765 (+ ::1), http://127.0.0.1:8766

# 2. a browser with the patched extension, connected to the bridge
node bridge/launch.mjs            # dedicated profile: ./tmp/ccb-profile

# 3. drive it
node bridge/cli.mjs status
node bridge/cli.mjs tabs
node bridge/cli.mjs open https://example.com
node bridge/cli.mjs read --interactive
node bridge/cli.mjs screenshot --file /tmp/shot.png
```

`node bridge/cli.mjs help` lists every command (`open`, `read`, `text`, `find`,
`click`, `hover`, `type`, `key`, `scroll`, `drag`, `fill`, `js`, `console`,
`network`, `screenshot`, `resize`, `batch`, `raw`, plus `allow`/`deny`/`approvals`).

### Installing into your own Chrome (daily use)

`--load-extension` no longer works in branded Chrome (M137+), and macOS
*Secure Preferences* rejects a seeded profile, so a scripted install into your
daily profile is not possible. Do it once by hand:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `claude-chrome-re/extension-patched`
3. Keep `node bridge/server.mjs` running

A user-initiated install persists, so the extension then dials the bridge on
every browser start.

---

## 5. Verified behaviour (2026-10-28)

Against `example.com` on Chrome for Testing 136, profile `tmp/ccb-profile`:

| Check | Result |
|---|---|
| extension → bridge connect | ✅ `dev_user_id: dev_user_local`, `extension_version 1.0.102`, `os_platform macOS` |
| `tabs_context_mcp` | ✅ returned `tabId 1741883292` in the MCP group |
| `navigate` with empty allowlist | ✅ **denied**, recorded in `/approvals` as `navigate \| example.com` |
| `navigate` after `allow example.com` | ✅ "Navigated to https://example.com/" |
| `read_page --interactive` | ✅ `link "Learn more" [ref_1] href="…"` |
| `get_page_text` | ✅ page text with truncation notice |
| `javascript_tool` | ✅ `document.title` → `Example Domain` |
| `computer screenshot` | ✅ 1200×766 JPEG, 51,618 bytes written to disk |
| `computer left_click` by ref | ✅ followed the link to `www.iana.org` |
| `read_console_messages` | ✅ (empty until tracking starts, as documented by the extension) |
| `read_network_requests` | ✅ denied for `www.iana.org`, allowed after `allow iana.org` |
| `browser_batch` | ⚠️ see limitations — CLI falls back to sequential standalone calls |

---

## 6. Limitations and security model

**Limitations**

* `find` is **LLM-backed** inside the extension (`Failed to find element:
  Anthropic client not available`). The CLI falls back to scoring the
  `read_page --interactive` snapshot locally.
* `browser_batch` pre-checks the extension's *internal* grant store, which stays
  empty in local mode, so it refuses any prompt-gated action. The CLI detects
  `permission_required` and replays the list as standalone calls.
* A CDP install (`Extensions.loadUnpacked`) is **session-only**; that is why
  `launch.mjs` owns the browser process. For a persistent install, load the
  folder by hand (section 4).
* `Extensions.loadUnpacked` is only reachable over the **pipe** transport, and
  adding `--remote-debugging-port` makes Chrome route CDP over TCP and the
  Extensions domain disappears — so `launch.mjs` deliberately passes no port.

**Security model**

* Both servers bind loopback only (`127.0.0.1` and `::1`).
* No account, token, or Anthropic endpoint is involved in the tool path.
* Every `permission_request` is answered from `~/.claude-chrome-bridge/allow.json`:
  a host is allowed when it equals a listed domain or is a subdomain of one.
  Empty by default → everything is denied until explicitly granted.
* Denials are recorded in `~/.claude-chrome-bridge/bridge.log` and exposed via
  `GET /approvals`, so the operator can review what the agent tried to reach.

---

## 7. Files

| Path | What | Shipped? |
|---|---|---|
| `tools/apply-patches.py` | the patch set, CRX3 extraction, parse verification | yes |
| `bridge/server.mjs` | local relay + allowlist + HTTP API | yes |
| `bridge/launch.mjs` | launches Chrome for Testing with the patched extension connected | yes |
| `bridge/cli.mjs` | CLI for every tool | yes |
| `tools/ctx.py` | minified-JS context extractor used during the RE | yes |
| `binary/claude-chrome.crx` | store CRX v1.0.102 (CRX3), the pristine source | **no** — Anthropic's code |
| `extension-clean/` | clean unpack from the CRX | **no** — Anthropic's code |
| `extension-patched/` | the 4 patches above — this is what gets loaded | **no** — regenerate with the script |
| `analysis/pretty/` | beautified bundles used for the RE | **no** — Anthropic's code |
| `~/.claude-chrome-bridge/` | runtime state: `allow.json`, `bridge.log` | n/a |
| `tmp/browsers/`, `tmp/ccb-profile/` | downloaded browser + agent profile (disposable) | n/a |

### Rebuild the patch set

```bash
# from claude-chrome-re/

# from a CRX you downloaded yourself (CRX3 is parsed for you)
python3 tools/apply-patches.py --crx ~/Downloads/claude-chrome.crx

# or from an already-unpacked directory
python3 tools/apply-patches.py --src extension-clean --out extension-patched
```

The script applies all four patches, then parses every patched bundle with
`node --check` before declaring success — that check is what catches a mangled
template literal, the failure mode described in section 3.

It is byte-reproducible: patching `extension-clean/` reproduces the verified
`extension-patched/` exactly (all four bundles and the manifest) — that holds for
the default patch set. Adding `--fork-id` additionally rewrites the manifest
`key` and `name`; the four bundles are still byte-identical.

---

## 8. Relation to the CDP-direct route

`skills/browser-cdp` drives Chrome directly over loopback CDP with no extension.
It is simpler and needs no vendor code. This route exists for a different
reason: it exposes **the real Claude in Chrome tool surface** (ref-based
`read_page`, `computer` actions, `tabs_*_mcp` grouping, console/network readers)
so agent instructions written against that surface work here unchanged.
Use `browser-cdp` for plain automation; use this when the Claude-in-Chrome
semantics matter.
