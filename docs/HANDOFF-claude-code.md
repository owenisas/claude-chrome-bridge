# Handoff: drive this bridge from Claude Code, and retire the stock Claude in Chrome

**Created:** 2026-10-28
**From:** OpenCode session (reverse-engineering + bridge build)
**Workspace:** the root of this repository (all paths below are relative to it)
**Next focus:** stop using the store *Claude in Chrome* extension, use the patched local-bridge build instead, and give Claude Code a way to drive it.

## Resume prompt

> Read `docs/HANDOFF-claude-code.md` and continue from **Next actions**. Do not re-litigate **Decisions** or retry **Failed approaches**. The bridge already works — verify with `node bridge/cli.mjs status` before changing anything.

---

## Goal

Claude Code drives a real Chrome through the **patched** Claude in Chrome extension and this repo's loopback bridge, with a local allowlist instead of a Claude account — and the stock extension is out of the picture.

## Where we are

**Done and verified** (evidence in `RECON.md` §5, reproduced today):

- The extension connects to the bridge: `dev_user_id: dev_user_local`, v1.0.102, macOS.
- Tool path works end to end: `tabs_context_mcp`, `navigate` (denied → allowed), `read_page --interactive` (ref-based), `get_page_text`, `javascript_tool`, `computer screenshot`, `left_click` by ref, `read_console_messages`, `read_network_requests`.
- Permission gate works: empty allowlist denies, denials land in `/approvals`, `allow <host>` grants.
- No Anthropic network dependency: with `api.anthropic.com` mapped to a dead local port, everything still worked and the trap saw zero connections.

**Blocked / missing:**

- **Claude Code cannot drive the patched extension yet.** Claude Code's own paths to this extension are account-gated (relay pairing, or the claude.ai sidepanel iframe with `BROWSER_CONTROL_PERMISSION_ACCEPTED`), and the patched build points at `ws://localhost:8765` instead. The missing piece is an MCP adapter — see Next actions #2.
- `find` and `browser_batch` are degraded in local mode (`RECON.md` §6). Not fixable without Anthropic's inference service; `find` can at least be re-pointed at the CLI's local scorer.
- **The native-vs-local benchmark has not been run.** Design is below; it needs a signed-in Claude account for the native arm.
- **Coexistence is solved:** `tools/apply-patches.py --fork-id` gives the patched build its own extension id (`ioohpagdjalmcbkcmmbnbdjfokmjaodl`, name `Claude (local bridge)`) by replacing the manifest `key`, so the stock build and the forked build install **side by side in one profile**. Verified: Chrome derives exactly the id the script predicts. The current `extension-patched/` is already forked. This removes the old "disable the stock extension first" ordering constraint — both arms can run in the same browser, which is a much cleaner benchmark.
- Still true: **the bridge tracks a single extension socket** (`let ext` in `server.mjs`). Only the forked build dials it, so the benchmark is unaffected — but two forked installs in two browsers would fight over the channel.

## Decisions (do not reopen)

1. **Bridge the extension's own `localBridge` path** rather than reimplementing the relay protocol. The bundle already ships it; the patch just enables it.
2. **Four patches only** (CSP, `localBridge`, URL-safety gate, boot hook). Anything more is scope creep.
3. **The allowlist is the security boundary**, at `~/.claude-chrome-bridge/allow.json`, host-granular, empty by default. Do not add a bypass.
4. **Do not commit Anthropic's code.** `binary/`, `extension-clean/`, `extension-patched/`, `analysis/` are gitignored on purpose. Ship the patch script.
5. **`launch.mjs` owns its browser process** and deliberately passes no `--remote-debugging-port`.

## Failed approaches (do not retry as-is)

| Approach | Why it fails |
|---|---|
| `--load-extension` | Ignored by branded Chrome **and Chrome for Testing** from M137. Do not conclude "it loaded" from `Preferences` — unpacked entries live in Secure Preferences. Check with `chrome.developerPrivate.getExtensionsInfo` instead. |
| Seeding the profile with an unpacked entry | macOS Secure Preferences (MAC-protected) drops it silently on next start. |
| `Extensions.loadUnpacked` over TCP | `Method not available`. It exists only on the **pipe** transport, so no `--remote-debugging-port`. |
| Puppeteer's `browser.installExtension()` | Returns the id, then destroys the freshly-created service worker target. Send the CDP command yourself, as `launch.mjs` does. |
| `chrome.runtime.onStartup` as the trigger | Never fires for a CDP-installed (session-only) extension. That is why patch 4 exists. |
| `js-beautify` on the bundles | Corrupts template literals (`` `data: ${r}` `` → broken multi-line `$ {`), a syntax error that kills the worker's import graph. The extension then reports **enabled, zero errors** in `chrome.developerPrivate` while never connecting. Use prettier + `node --check`. |
| Waiting for the stock `com.anthropic.claude_code_browser_extension` native host | Not registered anywhere on this machine, and the extension's native retry loop only re-arms for `managed` profiles. |

## Key paths & commands

```
tools/apply-patches.py     patch a copy you supply (--crx or --src), verifies bundles parse
bridge/server.mjs          relay replacement + allowlist API   (8765 ws / 8766 http)
bridge/launch.mjs          Chrome for Testing + patched extension, profile tmp/ccb-profile
bridge/cli.mjs             every tool as a subcommand
RECON.md                   protocol, patch rationale, evidence, failure modes
```

```bash
node bridge/server.mjs &                  # relay + allowlist API
node bridge/launch.mjs &                  # browser with the patched extension
node bridge/cli.mjs status                # must show extension.connected: true
node bridge/cli.mjs approvals             # what got blocked
node bridge/cli.mjs allow example.com     # grant a host (permission change — ask first)
```

HTTP API for an adapter to sit on: `GET /status`, `GET /approvals`, `POST /allow`, `POST /deny`, `POST /tool` with `{tool, args, timeout_ms}`.

## Artifacts

- `RECON.md` — the authoritative write-up. Read §2 (protocol), §3 (patches), §5 (evidence), §6 (limits).
- `README.md` — public-facing overview, same content in shorter form.
- `docs/HANDOFF-claude-code.md` — this file.

## Benchmark: native vs local

**Not run yet.** This is the measurement that decides whether the local path is a
real substitute or a degraded copy. It should produce numbers, not impressions.

### Two arms

| Arm | What runs | Requires |
|---|---|---|
| **A — native** | stock store extension, driven the supported way (Claude Code's browser integration: relay pairing or the sidepanel-iframe path) | a signed-in Claude account, `BROWSER_CONTROL_PERMISSION_ACCEPTED`, browser feature enabled |
| **B — local** | patched extension + this bridge, driven via `bridge/cli.mjs` (or `bridge/mcp.mjs` once built) | nothing but this repo |

Control what you can: **same extension version (1.0.102), same CRX.** Arm A is the
unpatched build, arm B is patched from the same file, so every tool
implementation is identical. Differences are therefore attributable to (i)
features that need Anthropic servers, (ii) the permission model, (iii) the
driver — which is exactly what we want to know. Run **both arms in the same
browser profile**: the patched build is forked (`--fork-id`), so it installs
alongside the stock extension instead of replacing it, and the engine version
stops being a variable.

**If arm A cannot be enabled** — no account, feature unavailable, org policy —
do not fake it. Fall back to the capability matrix and label it clearly as
*not* a head-to-head.

### Fixture

Deterministic local pages only. No third-party sites, no logins, no side effects
on anything you care about. Build `bench/fixture/` served on
`http://127.0.0.1:8899`, containing:

- a form: text input, select, checkbox, submit button that mutates the DOM
- a button whose click changes the URL hash and a text node
- a page that logs an error and issues a `fetch` (for the console/network readers)
- a scrollable container, plus an element that requires `scroll_to`
- a drag source and drop target
- `<input type=file>` and a small PNG to upload

Scope the allowlist to `127.0.0.1` for the run, then **reset it to empty**.

### Task suite

Score each as **pass / degraded / fail**, and record tool calls, wall-clock, and
permission prompts.

| # | Task | What it isolates |
|---|---|---|
| 1 | `navigate` to the fixture | transport + permission gating |
| 2 | `read_page --interactive`, count refs, locate a known element | snapshot quality |
| 3 | `find "submit button"` | **semantic find — expected to diverge** |
| 4 | `form_input` fill, then `computer type` | the two input paths |
| 5 | `left_click` by ref on the mutating button, assert the DOM changed | ref resolution + real input events |
| 6 | `computer screenshot`, assert dimensions and non-trivial bytes | capture |
| 7 | `javascript_tool` reading a page variable | JS eval |
| 8 | `read_console_messages` after triggering an error | console capture |
| 9 | `read_network_requests` after a fetch | network capture |
| 10 | multi-step: fill → submit → assert the result | orchestration, step count |
| 11 | cross-domain hop, count permission prompts | the permission model |
| 12 | `browser_batch` with a prompt-gated action | **batch gating — expected to diverge** |
| 13 | `tabs_create_mcp` / `tabs_close_mcp` lifecycle | tab grouping |
| 14 | `resize_window`, `zoom`, `scroll`, `scroll_to`, `hover`, `drag` | the unverified tail |
| 15 | `upload_image` / `file_upload` with the fixture PNG | file paths |

### Metrics and evidence

- Tasks passed / degraded / failed, per arm.
- Tool calls and wall-clock per task; permission prompts per task.
- Agent steps and tokens, if measurable from the Claude Code side.
- For arm B, `~/.claude-chrome-bridge/bridge.log` is an exact frame-level trace —
  use it as the evidence trail, and keep the raw JSON per run.

**Deliverable:** `docs/BENCHMARK.md` plus `bench/results/*.json`, published with
the arm-A caveats stated plainly. Two tasks are expected to differ for structural
reasons (`find`, `browser_batch`) — say so in advance so the result isn't read as
a bug report.

## Suggested skills

- `session-handoff` — to pass this on again.
- `browser-cdp` — if the task turns out not to need the Claude-in-Chrome semantics; plain CDP is simpler.
- `contextcli` — if you need to switch GitHub CLI accounts before pushing.

## Next actions (ordered)

1. **Verify the current state before touching anything.** `node bridge/cli.mjs status` should show `connected: true`; if not, `node bridge/launch.mjs` (and check `tmp/browsers/` exists).
2. **Build the MCP adapter** — `bridge/mcp.mjs`, stdio transport, sitting on `POST /tool`. This is the only thing standing between Claude Code and the patched extension. Expose the tool registry from `RECON.md` §2; keep the extension's arg shapes so instructions written against Claude-in-Chrome work unchanged. Then register it:
   `claude mcp add claude-chrome -- node <repo>/bridge/mcp.mjs`
   Model the tool list on `bridge/cli.mjs` — it already maps every tool and its flags.
3. **Run the native-vs-local benchmark** (design above). Build `bench/fixture/` and the arm-B harness first. Both arms can now run **in the same browser profile** — the patched build is forked, so it installs alongside the stock extension. Publish `docs/BENCHMARK.md` with raw results and the arm-A caveats.
4. **Install the forked build into the browser you'll benchmark in.** `chrome://extensions` → Developer mode → **Load unpacked** → `extension-patched/`. It appears as `Claude (local bridge)` with id `ioohpagdjalmcbkcmmbnbdjfokmjaodl`. The stock `Claude` extension can stay installed — that's the point of the fork. (If you ever rebuild without `--fork-id`, the ids collide again and you must disable the stock one.)
5. **Keep the bridge running** whenever the patched extension is installed, or the extension sits there retrying with nothing to talk to. (A launchd agent under `~/Library/LaunchAgents/` is the tidy option; not set up.)
6. **Harden the HTTP API** before pointing this at a daily-use profile: validate the `Host` header (DNS-rebinding gap, README "Security model") and consider a token on `/tool`.
7. **Optional:** re-point `find` at the CLI's local scorer inside the extension, so it stops erroring with `Anthropic client not available`.

## Open questions

- Should the MCP adapter expose the raw extension tools, or a smaller curated set (`read_page`, `computer`, `tabs_*`, `javascript_tool`)? The full surface is 17 tools, several of which are degraded.
- Where should the adapter live for the user — a user-scoped MCP server, or project-scoped in this repo?
- Is per-host allowlisting granular enough, or does the operator want per-action control (`click` vs `read_page_content`) that the extension already models internally?
