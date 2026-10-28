# Benchmark: official Claude in Chrome vs the local bridge

**Last updated: 2026-10-28**

Same browser, same extension version, two ways in. The question was whether the
local bridge is a real substitute for the official integration or a degraded copy.

**Short answer:** on a controlled page it is close to a substitute. 13 of 15 tasks
pass, and the two that don't are the two predicted in advance (`find`,
`browser_batch`). On a real site the bigger difference is policy, not capability.
The official build refused Reddit outright under Anthropic's URL-category check.
The local build has no such check: the operator's allowlist is its only gate.

## Setup

| | Arm A: official | Arm B: local |
|---|---|---|
| Extension | stock `Claude` 1.0.102 (`fcoeoabg…`) | patched fork `Claude (local bridge)` 1.0.102 (`ioohpag…`), same CRX |
| Browser | operator's daily Chrome 155, managed profile | the same Chrome, the same profile |
| Path | Claude Code's Claude in Chrome integration → Anthropic relay | `bridge/server.mjs` on loopback, `POST /tool` |
| Driver | an agent: a Claude Code desktop session calling `mcp__claude-in-chrome__*` | a script: `bench/arm-b.mjs`, `bench/reddit-b.mjs` |
| Tab placement | background session group (the integration's default) | background session group (`session_scope`), plus one foreground run |
| Permissions | Claude Code session in bypass-permissions mode | host allowlist: `127.0.0.1`, later `reddit.com`; reset to empty afterwards |

Both arms ran in one Chrome at the same time. The fork has its own extension id,
so it installs alongside the stock build, and the engine version isn't a variable.

## Fixture suite (15 tasks, `bench/fixture/` on `127.0.0.1:8899`)

Cells: verdict · tool calls · wall time. Wall time is measured only for arm B,
the bridge round trip with no agent in the loop.

| # | Task | A: official | B: local, background | B: local, foreground window |
|---|---|---|---|---|
| 1 | navigate to the fixture | pass · 3 | pass · 3 · 886 ms | pass · 3 · 1097 ms |
| 2 | read_page interactive, locate the submit button | pass · 1 | pass · 1 · 71 ms | pass · 1 · 113 ms |
| 3 | `find "submit button"` | **pass** · 1 | **degraded** · 1 · 7 ms | degraded · 1 · 9 ms |
| 4 | form_input fill, then computer type | pass · 4 | pass · 4 · 361 ms | pass · 4 · 215 ms |
| 5 | left_click by ref on the mutating button | pass · 2 | pass · 2 · 279 ms | pass · 2 · 198 ms |
| 6 | computer screenshot | pass · 1 | pass · 1 · 139 ms | pass · 1 · 115 ms |
| 7 | javascript_tool reads a page variable | pass · 1 | pass · 1 · 6 ms | pass · 1 · 6 ms |
| 8 | console capture after an error | pass · 3 | pass · 3 · 247 ms | pass · 3 · 177 ms |
| 9 | network capture after a fetch | pass · 4 | pass · 4 · 1376 ms | pass · 4 · 1316 ms |
| 10 | multi-step: fill, submit, assert | pass · 6 | pass · 6 · 301 ms | pass · 6 · 216 ms |
| 11 | cross-domain hop | pass · 2 | pass · 2 · 27 ms | pass · 2 · 39 ms |
| 12 | `browser_batch` with a gated action | **pass** · 1 | **degraded** · 3 · 829 ms | degraded · 3 · 759 ms |
| 13 | tabs_create / tabs_close lifecycle | pass · 4 | pass · 5 · 63 ms | pass · 5 · 85 ms |
| 14 | zoom, scroll, scroll_to, hover, drag (+ resize) | pass · 12 | pass · 21 · 1084 ms | degraded · 23 · 1692 ms |
| 15 | file_upload / upload_image | pass · 4 | pass · 6 · 243 ms | pass · 6 · 219 ms |
| | **Total** | **15 pass** · 49 calls | **13 pass, 2 degraded** · 63 calls · 5.9 s | 12 pass, 3 degraded · 65 calls · 6.3 s |

- **Task 3:** the official `find` is model-backed and returned `ref_5` with a reason. Local mode has no inference client, so the bridge falls back to a keyword scorer over the snapshot. It found the button here, but it's text matching, not understanding.
- **Task 11:** both arms "pass", but they demonstrate different permission models. Arm A allowed the hop to `localhost` with no prompt, because the session was in bypass mode. Arm B's allowlist refused it, because `localhost` wasn't listed.
- **Task 12:** the official batch ran navigate and screenshot in one call. Locally, the extension refuses any batch containing a gated action (`batch_permission_required`), so the bridge replays it as standalone calls.
- **Task 14, foreground run:** `resize_window` returned success but the window stayed 1200 px wide, because the operator's Chrome was in full screen. In background mode the agent's tab lives in the operator's window, so resizing is skipped on purpose.

## Real site: Reddit, read-only (10 tasks)

The operator asked for a real, signed-in site. The suite only browses, reads,
searches, scrolls, opens a post and goes back: it never votes, joins, comments,
posts or follows.

| # | Task | A: official | B: local, background |
|---|---|---|---|
| R1 | open `/r/programming` | **fail** · 2 | pass · 9 · 2964 ms |
| R2 | get_page_text on the feed | not run | degraded · 2 · 121 ms |
| R3 | read_page interactive | not run | degraded · 1 · 72 ms |
| R4 | `find "search box"` | not run | fail · 1 · 14 ms |
| R5 | search for "rust" | not run | degraded · 13 · 3117 ms |
| R6 | screenshot | not run | pass · 1 · 174 ms |
| R7 | infinite scroll + network capture | not run | pass · 11 · 1573 ms |
| R8 | console capture | not run | pass · 1 · 6 ms |
| R9 | open the first post by ref | not run | pass · 6 · 614 ms |
| R10 | navigate "back" | not run | pass · 2 · 322 ms |

- **Arm A was blocked at the door.** `navigate` returned "This site is not allowed due to safety restrictions." That message comes from the extension's hosted URL-category lookup (`category1`/`category2`); an org block has a different message. Arm A ran nothing after R1, and no attempt was made to get around the block.
- **Arm B reached Reddit only because local mode skips that lookup.** Patch 3 makes the no-token check return instead of failing closed (`RECON.md` §3). Read this as a **policy difference, not a capability win**: on the local build, Anthropic's site categories don't apply, and the operator's allowlist is the only gate.
- **R3–R5:** after hydration, Reddit's search box lives inside web components and is absent from the accessibility tree. So it has no ref, and the local keyword `find` has nothing to match. Search worked by clicking its on-screen position. The harness measured that position with JS; an agent would read it from a screenshot.
- **R2:** the text extractor takes the first `<article>`. On Reddit that is a single post or a "Repost" card, not the feed (and on a post page, not the post).

## Behaviour both arms share (same extension code)

These showed up in both arms, or follow from code they share. They matter to anyone driving either one:

- **The interactive snapshot covers only the viewport.** `read_page` with `filter: "interactive"` lists only elements on screen; the unfiltered tree includes off-screen ones.
- **Label-wrapped inputs come out unnamed** (`textbox [ref_1]`). Address them by position or by a nearby label.
- **`javascript_tool` limits its output.** Results are cut at about 1,000 characters. Results that contain a URL query string are replaced with `[BLOCKED: Cookie/query string data]`; read `location.pathname` and the individual parameters instead.
- **`navigate` can return before the new page commits** on a real site, so the next call may still see the old page. Wait on a page condition, not on the call returning.
- **A call aimed at a tab that no longer exists hangs** until the bridge's 120 s timeout, instead of failing fast.

## Background vs foreground

- **The default path opens a focused window.** Without a session, `tabs_context_mcp` with `createIfEmpty` runs `chrome.windows.create({focused: true})`, which pulls the operator out of whatever they're doing (full screen included).
- **A session scope keeps the work in the background.** With `session_scope` on the `tool_call`, the extension instead adds an inactive tab to the last-focused window and groups it per session. The bridge now passes one through: the MCP adapter sets it per session, the CLI via `CCB_SESSION`, the benchmark via a run id.
- **Background tabs still work.** In arm B's background tab the page reported `hidden` and unfocused throughout, and screenshots (rendered fully, not blank), clicks, typing and drags still worked.
- **The official integration reports differently.** Arm A's pages reported `visible` and focused. That fits the focus emulation the extension enables on its official path (`Emulation.setFocusEmulationEnabled`), which the local path doesn't turn on. Whether the official tab was also brought to the front is not verified from here.

## Latency, arm B (median per call, bridge round trip)

`javascript_tool` 6 ms (n=41) · `form_input` 7 ms · `read_console_messages` 6 ms ·
`read_page` 67 ms · `read_network_requests` 62 ms · `get_page_text` 88 ms ·
`screenshot` 162 ms · `scroll` 270 ms · `left_click` 272 ms · `navigate` 311 ms.
Arm A was driven by an agent, so its per-call latency includes model turns and
was not measured.

## Caveats

- **The arms had different drivers.** Arm A was an agent and arm B a script. Where call counts differ in tasks 13–15, the agent skipped a redundant listing, used `find` for an off-screen ref, or let the client read the upload file.
- **"Permission prompts" mean different things in the two arms.** Arm B's result files count every `permission_request` the allowlist answered automatically (56 in a fixture run, none shown to a person). Arm A showed no prompts because the session was in bypass mode.
- **One run per configuration.** Reddit is live: how many posts are rendered when a task starts varies from run to run. The Reddit harness took several iterations to get right (waits, virtualized feed, output caps); only the final run is published.
- **The native arm's Reddit result reflects this account and today's category data.** Another org, or a later category update, could differ.

## Reproduce

```bash
node bench/serve.mjs &                                   # fixture on 127.0.0.1:8899
node bridge/cli.mjs allow 127.0.0.1                      # operator grants the fixture host
CCB_DEVICE=<device_id> node bench/arm-b.mjs              # background by default; BENCH_FOREGROUND=1 for a window
node bridge/cli.mjs allow reddit.com && CCB_DEVICE=<device_id> node bench/reddit-b.mjs
node bridge/cli.mjs deny 127.0.0.1 && node bridge/cli.mjs deny reddit.com
```

Raw results are in `bench/results/`: per-task verdicts, every call with its
arguments, output excerpt and timing, and arm B's permission log. Arm A's files
were written from the session's observed outputs and carry no timings.
