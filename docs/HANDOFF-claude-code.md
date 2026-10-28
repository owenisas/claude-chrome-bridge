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

## Suggested skills

- `session-handoff` — to pass this on again.
- `browser-cdp` — if the task turns out not to need the Claude-in-Chrome semantics; plain CDP is simpler.
- `contextcli` — if you need to switch GitHub CLI accounts before pushing.

## Next actions (ordered)

1. **Verify the current state before touching anything.** `node bridge/cli.mjs status` should show `connected: true`; if not, `node bridge/launch.mjs` (and check `tmp/browsers/` exists).
2. **Build the MCP adapter** — `bridge/mcp.mjs`, stdio transport, sitting on `POST /tool`. This is the only thing standing between Claude Code and the patched extension. Expose the tool registry from `RECON.md` §2; keep the extension's arg shapes so instructions written against Claude-in-Chrome work unchanged. Then register it:
   `claude mcp add claude-chrome -- node <repo>/bridge/mcp.mjs`
   Model the tool list on `bridge/cli.mjs` — it already maps every tool and its flags.
3. **Retire the stock extension.** In `chrome://extensions`, disable or remove *Claude* (id `fcoeoabgfenejglbffodgkkbkcdhcgfn`). It cannot coexist with the patched build — same id, because the manifest carries the store `key`. Then **Load unpacked** → `extension-patched/`.
4. **Keep the bridge running** whenever the patched extension is installed, or the extension sits there retrying with nothing to talk to.
5. **Harden the HTTP API** before pointing this at a daily-use profile: validate the `Host` header (DNS-rebinding gap, README "Security model") and consider a token on `/tool`.
6. **Optional:** re-point `find` at the CLI's local scorer inside the extension, so it stops erroring with `Anthropic client not available`.

## Open questions

- Should the MCP adapter expose the raw extension tools, or a smaller curated set (`read_page`, `computer`, `tabs_*`, `javascript_tool`)? The full surface is 17 tools, several of which are degraded.
- Where should the adapter live for the user — a user-scoped MCP server, or project-scoped in this repo?
- Is per-host allowlisting granular enough, or does the operator want per-action control (`click` vs `read_page_content`) that the extension already models internally?
