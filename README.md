# claude-chrome-bridge

Run the **Claude in Chrome** extension against a **relay on your own machine**, with a local allowlist instead of a Claude account.

The extension is a capable browser-automation agent — ref-based page reads, real clicks and typing over CDP, tab grouping, console and network capture, screenshots. Normally it only works paired to Anthropic's relay (`wss://bridge.claudeusercontent.com`) through a signed-in Claude account. This project replaces that relay with a loopback server and answers the extension's permission prompts from a file on disk.

Nothing in the tool path leaves the machine.

```
OpenCode / CLI / your agent              bridge (this repo)                browser
─────────────────────────────            ────────────────────              ───────
cli.mjs …  ──HTTP──▶  127.0.0.1:8766  /tool,/status,/allow,/approvals
                      127.0.0.1:8765  WebSocket  ◀──WS──▶  Chrome for Testing
                              │                                   └ patched Claude in Chrome
                              │  permission_request
                              └── permission_response ──▶  (local allowlist)
```

---

## What is actually modified

The bundle already ships a **`localBridge`** code path: with that flag set it dials `ws://localhost:8765`, uses `dev_user_id: "dev_user_local"`, and skips OAuth entirely. It also contains a managed/enterprise mode where a desktop peer drives it locally with no relay. The local-only design is contemplated upstream — the patch set just turns it on.

Four edits, roughly ten lines. `tools/apply-patches.py` performs all of them and verifies the result:

| # | File | Change | Why |
|---|---|---|---|
| 1 | `manifest.json` | add `ws://localhost:8765` to `connect-src` | the MV3 CSP blocks the loopback socket otherwise |
| 2 | `assets/SavedPromptsService-*.js` | `localBridge:!1` → `localBridge:!0` | selects the local path — no OAuth, `dev_user_local` |
| 3 | `assets/mcpPermissions-*.js` | no-token URL-safety check returns instead of `category_unknown_error` | the hosted category lookup fails **closed** when signed out, which would block every navigation |
| 4 | `assets/service-worker.ts-*.js` | call `$t()` on worker boot, retrying briefly | the extension only dials from `chrome.runtime.onStartup`, which never fires for a CDP-installed extension |

Everything else — the executors, the CDP layer, the ref system, tab-group management, console/network capture — is untouched.

Patch 3 is the one to think about before using this: it disables a real safeguard (the hosted malicious-site category check) because that check cannot succeed offline. See [Limits](#limits).

---

## The relay protocol

The extension speaks a small, fixed frame vocabulary over the socket. No JSON-RPC routing, no MCP handshake — `tools/list` and `tools/call` appear nowhere in the bundle. The *payloads* are MCP-shaped; the transport is bespoke.

| Direction | Frame | Notes |
|---|---|---|
| ext → relay | `connect` | `{client_type:"chrome-extension", device_id, dev_user_id, os_platform, extension_version, scoped_peer_disconnect:true}` |
| relay → ext | `paired` | `{scoped_peer_disconnect:true}` |
| relay → ext | `peer_connected` | sent immediately after `paired` |
| relay → ext | `tool_call` | `{tool_use_id, tool, args, client_type:"desktop", handle_permission_prompts:true}` |
| ext → relay | `tool_result` | `{tool_use_id, content:[{type:"text"\|"image",…}], is_error?}` |
| ext → relay | `permission_request` | `{request_id, tool_use_id, tool_type, url, action_data?}` |
| relay → ext | `permission_response` | `{request_id, allowed:bool}` |
| ext → relay | `ping` / relay → ext `pong` | 20 s keepalive, extension-initiated |

The server side of that, in full:

```js
// bridge/server.mjs — the whole relay, minus the allowlist and HTTP wrapper
function handleExtMessage(ws, raw) {
  const msg = JSON.parse(raw.toString());
  switch (msg.type) {
    case 'connect':
      ext = ws; extInfo = msg; connectedAt = Date.now();
      send({ type: 'paired', scoped_peer_disconnect: true });
      send({ type: 'peer_connected' });           // the peer is us; we are always "connected"
      break;
    case 'tool_result': {
      const p = pending.get(msg.tool_use_id);     // resolve the caller's promise
      if (!p) break;
      pending.delete(msg.tool_use_id);
      clearTimeout(p.timer);
      p.resolve(msg);
      break;
    }
    case 'permission_request': {
      // This is where the Claude account used to decide. Now a file does.
      const allowed = isAllowed(msg.url);
      send({ type: 'permission_response', request_id: msg.request_id, allowed });
      if (!allowed) approvals.push({ at: new Date().toISOString(), tool_type: msg.tool_type,
                                     url: msg.url, host: hostOf(msg.url) });
      break;
    }
  }
}
```

And a tool call outbound:

```js
send({ type: 'tool_call', tool_use_id: crypto.randomUUID(), tool, args,
       client_type: 'desktop', handle_permission_prompts: true });
```

### Two other transports exist (and why we don't use them)

Reading the bundle turns up two more ways to drive the same extension — both account-gated, both reasons this project exists:

- **Native messaging.** The extension connects to `com.anthropic.claude_browser_extension` ("Desktop") and `com.anthropic.claude_code_browser_extension` ("Claude Code"), with an ECDH P-256 pairing handshake (`local_pairing`), org policy checks, and sealed channels. Its retry loop only re-arms when the profile is `managed`; the relay gate explicitly excludes managed profiles. Enterprise path.
- **Sidepanel iframe.** `CIC_IFRAME_TOOL_CALL` messages from a claude.ai iframe inside the side panel, `clientId: "claude-code"`, gated on `chrome_ext_cowork_iframe` + `BROWSER_CONTROL_PERMISSION_ACCEPTED` + a matching account UUID.

So: driving this extension the supported way needs a Claude account. Pointing it at loopback does not.

---

## Quickstart

```bash
# 1. patch the extension (you supply it — this repo ships no Anthropic code)
python3 tools/apply-patches.py --crx ~/Downloads/claude-chrome.crx

# 2. bridge: the relay replacement + allowlist API
cd bridge && npm install && cd ..
node bridge/server.mjs          # ws://127.0.0.1:8765 (+ ::1), http://127.0.0.1:8766

# 3. a browser that owns the extension
npx @puppeteer/browsers install chrome@stable --path ./tmp/browsers
node bridge/launch.mjs          # Chrome for Testing + patched extension

# 4. drive it
node bridge/cli.mjs status
node bridge/cli.mjs tabs
node bridge/cli.mjs open https://example.com
```

The allowlist starts **empty, which means everything is denied**. That is the
intended first-run experience:

```
$ node bridge/cli.mjs open https://example.com
error: Permission denied by user

blocked by the local allowlist. Recent denied hosts:
  example.com

grant with:  node bridge/cli.mjs allow <host>
```

`node bridge/cli.mjs help` lists every command: `open`, `read`, `text`, `find`,
`click`, `hover`, `type`, `key`, `scroll`, `drag`, `fill`, `js`, `console`,
`network`, `screenshot`, `resize`, `batch`, `raw`, plus `allow` / `deny` / `approvals`.

**Full step-by-step, including installing into your own Chrome and a
troubleshooting table: [`INSTALL.md`](INSTALL.md).**

### Using it in your everyday Chrome

One-time manual install — `--load-extension` no longer works in branded Chrome
builds (M137+), and macOS *Secure Preferences* rejects a seeded profile, so a
scripted install into a personal profile isn't possible. The exact steps, with
paths and verification, are in [`INSTALL.md`](INSTALL.md) step 5B.

#### Running both side by side

With `--fork-id` the two builds coexist in one profile, which is what you want if
you're comparing them:

| | Stock build | Forked build |
|---|---|---|
| id | `fcoeoabgfenejglbffodgkkbkcdhcgfn` | `ioohpagdjalmcbkcmmbnbdjfokmjaodl` |
| name in `chrome://extensions` | `Claude` | `Claude (local bridge)` |
| talks to | Anthropic's relay (needs an account) | `ws://localhost:8765` |

The id is a pure function of the manifest `key`, so the fork is reproducible:
`tools/apply-patches.py --fork-id` reuses `.fork-key.pem` (gitignored) and always
derives the same id. Delete that file and you get a fresh identity instead.

Both builds can talk to their own backend at the same time — the bridge keeps a
peer per connected browser. With one browser attached, commands just work; with
several, name the one you mean:

```bash
node bridge/cli.mjs status                    # lists every connected browser
node bridge/cli.mjs tabs --device a2335e1e     # device_id or an unambiguous prefix
CCB_DEVICE=a2335e1e node bridge/cli.mjs tabs   # or via the environment
```

A `device_id` is generated per browser profile, so it stays stable across
restarts of the same profile.

---

## Driving it from Claude Code

`bridge/mcp.mjs` is a stdio MCP server over the bridge's `POST /tool`. It
exposes the extension's 17 tools under their own names and argument shapes, so
instructions written for Claude in Chrome work unchanged, plus
`list_connected_browsers` / `select_browser` for picking a browser when several
are attached.

```bash
claude mcp add claude-chrome -- node "$PWD/bridge/mcp.mjs"   # run from the repo root
claude mcp get claude-chrome                                  # Status: ✔ Connected
```

It adds no permissions of its own: every host still goes through the local
allowlist, and there is deliberately no `allow` tool. A denied call comes back
as an error naming the host and the `cli.mjs allow` command for the operator.
`file_upload` takes `paths` and sends their contents (the extension no longer
reads host paths itself), but only from the directory Claude Code started it in
plus `CCB_UPLOAD_ROOTS`.

`node bridge/selftest.mjs` checks the routing and the adapter against fake
browsers on spare ports, without touching a live bridge.

## Tool surface

`navigate`, `read_page`, `get_page_text`, `find`, `form_input`, `javascript_tool`, `computer`, `browser_batch`, `resize_window`, `gif_creator`, `upload_image`, `file_upload`, `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `read_console_messages`, `read_network_requests`.

`computer` actions: `left_click`, `right_click`, `type`, `screenshot`, `wait`, `scroll`, `key`, `left_click_drag`, `double_click`, `triple_click`, `zoom`, `scroll_to`, `hover`.

Verified end-to-end against `example.com`:

| Check | Result |
|---|---|
| extension → bridge connect | `dev_user_id: dev_user_local`, v1.0.102, macOS |
| `tabs_context_mcp` | returned a tab in the MCP group |
| `navigate`, empty allowlist | **denied**, recorded in `/approvals` |
| `navigate` after `allow example.com` | navigated |
| `read_page --interactive` | `link "Learn more" [ref_1] href="…"` |
| `get_page_text` | page text with truncation notice |
| `javascript_tool` | `document.title` → `Example Domain` |
| `computer screenshot` | 1200×766 JPEG, 51,627 bytes on disk |
| `computer left_click` by ref | followed the link to `www.iana.org` |
| `read_console_messages` after nav | extension's own cross-domain guard fired |
| `read_network_requests` cross-domain | **denied** for `www.iana.org` |

Not yet exercised (same code path, unverified): `form_input`, `type`, `key`, `hover`, the remaining click variants, `drag`, `scroll`/`scroll_to`, `zoom`, `wait`, `resize_window`, `tabs_create_mcp`/`tabs_close_mcp`, `gif_creator`, `upload_image`, `file_upload`.

---

## Limits

These are structural, not bugs — each one is a feature that lived on Anthropic's servers:

- **`find` is LLM-backed.** It calls an inference service that isn't reachable in local mode, so it fails with `Anthropic client not available`. The CLI and the MCP adapter substitute a lexical scorer over the `read_page --interactive` snapshot. Semantic "find the login button" degrades to text matching.
- **`browser_batch` pre-checks the extension's internal grant store**, which stays empty locally, so it refuses any prompt-gated action. The CLI and the MCP adapter detect `permission_required` and replay the list as standalone calls — working, but no longer one atomic batch.
- **URL category blocking is off.** Patch 3 makes the hosted category lookup skip instead of failing closed, so Anthropic's malicious-site categories (`category1`/`category2`) are no longer enforced.
- **Plan approval (`follow_a_plan`) and per-site "always allow" grants** are not in the loop; the local allowlist is host-granular only.
- **Account features are inert**: scheduled tasks and skills migration (need an org UUID), saved-prompt sync, claude.ai messaging, onboarding, the permissions page.
- **The orchestrator moved.** Upstream, Claude's backend decides the next action and supplies `find`/plan-mode/inference-relay. Here the caller is the orchestrator, so an agent using this drives the loop itself.
- **Unpacked means no auto-update.** The build stays at whatever version you patched.

## Is it really local?

Pointed `api.anthropic.com` at a dead local port and ran boot → connect → tool calls (including `find`). A listener on that port saw **zero** connections, and everything still worked. So the tool path has no network dependency on Anthropic, and the telemetry pipeline that exists in the bundle (`/api/event_logging/v2/batch`) does not fire in local mode.

That is a bounded observation, not a proof — worth re-running yourself with the trap if you care.

## Security model

- Both servers bind loopback only (`127.0.0.1` and `::1`).
- No account, token, or Anthropic endpoint is involved in the tool path.
- Every `permission_request` is answered from `~/.claude-chrome-bridge/allow.json`: a host is allowed when it equals a listed domain or is a subdomain of one. Empty by default → deny everything until granted.
- Denials are logged to `~/.claude-chrome-bridge/bridge.log` and exposed via `GET /approvals`, so a human can review what the agent tried to reach.

**Known gap:** the HTTP API does not validate the `Host` header, so a page using DNS rebinding could reach it. Fix that (Host check + a token) before pointing this at a browser profile you care about.

## Files

| Path | What |
|---|---|
| `tools/apply-patches.py` | the patch set, plus CRX3 extraction and parse verification |
| `bridge/server.mjs` | relay replacement + allowlist + HTTP API |
| `bridge/launch.mjs` | launches Chrome for Testing with the patched extension connected |
| `bridge/cli.mjs` | CLI over every tool |
| `bridge/mcp.mjs` | stdio MCP server for Claude Code over the same HTTP API |
| `bridge/local-find.mjs` | the offline `find` scorer, shared by the CLI and the adapter |
| `bridge/selftest.mjs` | routing + adapter self-test with fake browsers on spare ports |
| `RECON.md` | the full reverse-engineering write-up: protocol, evidence, patch rationale, failure modes |
| `docs/HANDOFF-claude-code.md` | handoff for driving this from Claude Code |
| `tools/ctx.py` | minified-JS context extractor used during the RE |

### Why `launch.mjs` looks odd

Three findings, each of which cost real time:

1. `--load-extension` is ignored by branded Chrome **and Chrome for Testing** from M137 on — verified via `chrome.developerPrivate`, not by reading `Preferences` (unpacked entries live in Secure Preferences, so the obvious check lies).
2. `Extensions.loadUnpacked` exists only over the **pipe** transport. Adding `--remote-debugging-port` routes CDP over TCP and the method disappears, so `launch.mjs` passes no port.
3. Puppeteer's own `installExtension()` destroys the freshly-created service worker target, and this extension only dials from `onStartup` — so the launcher sends the CDP command itself and the patched bundle dials on worker boot.

Also: **do not run these bundles through `js-beautify`.** It mis-formats template literals (`` `data: ${r}` `` → a broken multi-line `$ {`), which is a syntax error that kills the worker's import graph. The extension then looks perfectly healthy in `chrome.developerPrivate` — enabled, zero errors — while never connecting. Use prettier, and `node --check` every patched bundle. `apply-patches.py` does that for you.

---

## License and legal

MIT for everything in this repository — see `LICENSE`.

**This repo contains no Anthropic code.** No CRX, no unpacked or patched bundle, no beautified source. `tools/apply-patches.py` modifies a copy *you* obtain. Don't commit a patched bundle to your own fork either; ship the script. See `NOTICE` for the full statement.

"Claude" and "Anthropic" are trademarks of Anthropic PBC. Not affiliated, not endorsed, not supported. Modifying a client you have installed and driving your own browser with it is your call to make — read the terms that apply to you.

## Related

If you just want browser automation and don't care about this specific tool surface, use CDP directly with Puppeteer or Playwright — simpler, no vendor code, no patching. This project exists for the *Claude-in-Chrome semantics*: ref-based reads, `computer` actions, MCP tab grouping, console/network readers, so instructions written against that surface work unchanged.
