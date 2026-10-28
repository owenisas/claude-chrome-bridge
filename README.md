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

Six edits, a few dozen lines. `tools/apply-patches.py` performs all of them and verifies the result:

| # | File | Change | Why |
|---|---|---|---|
| 1 | `manifest.json` | allow the loopback bridge in `connect-src` | the MV3 CSP blocks the socket and the panel's API calls otherwise |
| 2 | `assets/SavedPromptsService-*.js` | `localBridge:!1` → `localBridge:!0` | selects the local path — no OAuth, `dev_user_local` |
| 3 | `assets/mcpPermissions-*.js` | no-token URL-safety check returns instead of `category_unknown_error` | the hosted category lookup fails **closed** when signed out, which would block every navigation |
| 4 | `assets/service-worker.ts-*.js` | call `$t()` on worker boot, retrying briefly | the extension only dials from `chrome.runtime.onStartup`, which never fires for a CDP-installed extension |
| 5 | `assets/service-worker.ts-*.js` + `tools/panel/*` | point the side panel at our own page | the stock panel needs an account token *and* a live profile fetch; it has no local mode to flip |
| 6 | `assets/service-worker.ts-*.js` | `setUninstallURL("…google.com/forms/…")` → `setUninstallURL("")` | removing the extension otherwise opens a survey tab and reports the removal |

Everything else — the executors, the CDP layer, the ref system, tab-group management, console/network capture — is untouched.

Patch 3 is the one to think about before using this: it disables a real safeguard (the hosted malicious-site category check) because that check cannot succeed offline. See [Limits](#limits). Patches 5 and 6 replace surfaces rather than flipping flags; both are described below.

### The side panel

The stock panel is Anthropic's chat client, so it asks you to log in: it wants an
access token *and* a live `/api/oauth/profile` fetch, and the conversation is
served from claude.ai in an iframe. `localBridge` appears zero times in its
bundles — there is no local branch to enable.

Patch 5 swaps the surface instead. The worker's two `sidePanel.setOptions` call
sites point at `local-panel.html`, which talks only to the bridge on loopback:
status, the allowlist, recent denials, and a chat box. Each message runs one
headless turn — `claude -p` with this bridge's own MCP server attached — so the
model gets the browser tools and nothing else, and permissions still come from
the allowlist. A denial renders as an **Allow / Keep blocked** prompt, where the
click is the operator's.

It is styled with the bundle's own design tokens and theme attributes, so the
palette, the Anthropic Sans/Mono faces and the serif response face are the
extension's rather than an approximation. The stylesheet URLs carry content
hashes, so the patch discovers them at build time.

The model picker in the composer maps to `claude -p --model`, offering the CLI's
aliases (`fable`, `opus`, `sonnet`, `haiku`) plus the CLI default, and remembers
your choice. Set a fixed default in `~/.claude-chrome-bridge/chat.json` instead
if you'd rather not pick each session.

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
node bridge/cli.mjs status                        # every connected browser, labelled by profile
node bridge/cli.mjs tabs --device parafield.ai     # a profile name ("Profile 32" or "Chrome/parafield.ai" work too)
node bridge/cli.mjs tabs --device a2335e1e         # or a device_id / unambiguous prefix
CCB_DEVICE=parafield.ai node bridge/cli.mjs tabs   # or via the environment
```

The extension sends no name of its own unless one was set in its UI, so each browser is labelled with its **profile**: browser, profile name and directory, e.g. `parafield.ai (Chrome, Profile 32)`. The extension keeps its device id in that profile's extension storage. The label comes from finding the profile whose storage holds the id and reading the profile's name from the browser's `Local State`.
- **Where the lookup runs.** macOS keeps a launchd-run process out of Chrome's folder (`EPERM`), so with the bridge as a LaunchAgent the lookup runs in the clients (the MCP adapter, the CLI), which can read it.
- **Ids versus names.** A `device_id` is generated per install, so it changes if the extension is reinstalled. A profile name doesn't.

---

## Driving it from Claude Code

`bridge/mcp.mjs` is a stdio MCP server over the bridge's `POST /tool`. It
exposes the extension's 17 tools under their own names and argument shapes, so
instructions written for Claude in Chrome work unchanged, plus
`list_connected_browsers` / `select_browser` for picking a browser when several
are attached.

```bash
claude mcp add -s user claude-chrome -- "$(command -v node)" "$PWD/bridge/mcp.mjs"   # run from the repo root
claude mcp get claude-chrome                                                         # Status: ✔ Connected
```

User scope makes it available in every project, in the CLI and in the desktop app's Code tab. The bridge has to be running for any of it to work. A LaunchAgent with `RunAtLoad` and `KeepAlive` that runs `node bridge/server.mjs` keeps it up across logins and crashes.

It adds no permissions of its own: every host still goes through the local
allowlist, and there is deliberately no `allow` tool. A denied call comes back
as an error naming the host and the `cli.mjs allow` command for the operator.
`file_upload` takes `paths` and sends their contents (the extension no longer
reads host paths itself), but only from the directory Claude Code started it in
plus `CCB_UPLOAD_ROOTS`.

Each MCP session works in its own background tab group: an inactive tab in the
browser's last-focused window, like the stock integration, instead of a new
focused window. The CLI uses `CCB_SESSION=<id>` when set. **Any call that names
no session gets the bridge's default group**, `Claude (local bridge)`.

Without a session, the extension's legacy path opens a new, focused window for
every tab group it creates, titled "Claude (MCP)". Chrome also keeps a saved
"Claude (MCP)" chip in the bookmarks bar for each of those groups, long after it
closes. The extension has no API for deleting saved groups, so remove old chips
by hand (right-click, then **Delete group**). Send `session_scope: false` to
`/tool` only when you want the legacy window.

In the MCP adapter, `list_connected_browsers` labels each browser with its
profile, and `select_browser` accepts a profile name. `CCB_DEVICE` in the server's
`env` picks a default, e.g. `claude mcp add -s user -e CCB_DEVICE=parafield.ai …`.

`node bridge/selftest.mjs` checks the routing and the adapter against fake
browsers on spare ports, without touching a live bridge.

[`docs/BENCHMARK.md`](docs/BENCHMARK.md) compares this path with the official
integration in the same Chrome, on a local fixture and on Reddit.

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

- **`find` is LLM-backed.** Inside the extension it asks Claude Haiku 4.5 (its `small_fast` model class) through the signed-in account, so in local mode it fails with `Anthropic client not available`. The bridge runs `find` itself instead: it reads the page's accessibility tree and asks the model configured in `~/.claude-chrome-bridge/find.json`. There are two engines:

  ```json
  {"engine": "claude-code", "model": "claude-haiku-5-5", "effort": "low"}
  {"url": "http://host:8080/v1", "model": "name", "key_file": "/path/to/key"}
  ```

  - **`claude-code`** runs a one-shot `claude -p` on the Claude Code CLI's own login, so no API key is needed. Nothing is loaded but the model: no tools, MCP servers, settings, hooks or saved session. It runs with a clean environment in a neutral directory. Add `"claude_bin"` when `claude` isn't on the bridge's PATH.
  - **The second form** is any OpenAI-compatible endpoint. Its key is read from `key_file`.

  `CCB_FIND_ENGINE`, `CCB_FIND_URL`, `CCB_FIND_MODEL` and `CCB_FIND_KEY_FILE` override the file. Refs the page doesn't have are dropped. With no model configured, or when the model call fails, the bridge falls back to a keyword scorer. The result's last line says which engine answered. **The page's accessibility tree goes to that endpoint.**
- **`browser_batch` pre-checks the extension's internal grant store**, which stays empty locally, so it refuses any prompt-gated action. The bridge runs batches itself: one call from the client, the actions in order over loopback, each checked against the allowlist. The output is in the official `[tool] output` format and stops at the first error.
- **URL category blocking is off.** Patch 3 makes the hosted category lookup skip instead of failing closed, so Anthropic's malicious-site categories (`category1`/`category2`) are no longer enforced. Concretely, the official build refuses reddit.com and this one reaches it ([`docs/BENCHMARK.md`](docs/BENCHMARK.md)). The allowlist is the only gate.
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
- Every `permission_request` is answered from `~/.claude-chrome-bridge/allow.json`: a host is allowed when it equals a listed domain or is a subdomain of one. Empty by default → deny everything until granted. `"allowAll": true` in that file allows every host; that's the operator's call, and the bridge then applies no site gate at all.
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
| `bridge/local-tools.mjs` | `find` (configured model, keyword fallback) and `browser_batch`, run by the bridge |
| `bridge/local-find.mjs` | the keyword scorer `find` falls back to |
| `bridge/selftest.mjs` | routing + adapter self-test with fake browsers on spare ports |
| `bench/` | benchmark fixture and server, the arm-B suites (`arm-b.mjs`, `reddit-b.mjs`, shared `harness.mjs`), raw `results/` |
| `docs/BENCHMARK.md` | official vs local, same browser: results and findings |
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
