#!/usr/bin/env node
/**
 * Arm B of the native-vs-local benchmark: the patched extension through this
 * repo's bridge. Runs the 15 tasks from docs/HANDOFF-claude-code.md against the
 * fixture and writes bench/results/arm-b-<stamp>.json.
 *
 *   node bench/serve.mjs &                      # fixture on 127.0.0.1:8899
 *   node bridge/cli.mjs allow 127.0.0.1         # operator grants the fixture host
 *   CCB_DEVICE=<device_id> node bench/arm-b.mjs
 *   node bridge/cli.mjs deny 127.0.0.1          # and takes it back
 *
 * Calls go straight to POST /tool, so `ms` is the bridge round trip (HTTP +
 * WebSocket + extension work), with no agent in the loop. Where the CLI and the
 * MCP adapter apply a local fallback (find, browser_batch), this does the same
 * and scores the task "degraded". Permission prompts are counted from the
 * bridge log: one line per permission_request the allowlist answered.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, refOf, expect, BACKGROUND } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVICE = process.env.CCB_DEVICE || undefined;
const FIXTURE = process.env.BENCH_URL || 'http://127.0.0.1:8899/';
const OTHER_HOST = FIXTURE.replace('127.0.0.1', 'localhost');
const PNG = fs.readFileSync(path.join(HERE, 'fixture', 'pixel.png'));

let tab;
const { call, js, note, verdictOf, task, target, write } = createRun({ device: DEVICE, getTab: () => tab });

// The extension leaves label-wrapped inputs unnamed (`textbox [ref_1]`), so the
// fixture's Name and Email fields are the first and second textbox.
const nameRef = () => refOf(snap, /^\s*textbox\b/, 0);
const emailRef = () => refOf(snap, /^\s*textbox\b/, 1);

// ---------------------------------------------------------------- tasks
let snap = '';
let frame = null;   // last screenshot size, for converting CSS px to the screenshot frame
let shotId = null;

// refs die with the document, so re-read after anything that reloads the page
async function snapshot() {
  snap = (await call('read_page', { tabId: tab, filter: 'interactive' })).fullText;
  return snap;
}

async function screenshot() {
  const r = await call('computer', { action: 'screenshot', tabId: tab });
  const dims = /\((\d+)x(\d+)/.exec(r.text);
  if (dims) frame = { w: +dims[1], h: +dims[2] };
  shotId = /ID:\s*(\S+?)(?:\s|$|—)/.exec(r.text)?.[1] || shotId;
  return r;
}

async function toFrame(cssX, cssY) {
  const vw = await js('window.innerWidth');
  const k = frame ? frame.w / vw : 1;
  return [Math.round(cssX * k), Math.round(cssY * k)];
}

const dev = await target();
const started = new Date();
console.log(`arm B: device ${dev?.device_id} (extension ${dev?.extension_version}), fixture ${FIXTURE}\n`);

await task(1, 'navigate to the fixture', 'transport + permission gating', async () => {
  const ctx = await call('tabs_context_mcp', { createIfEmpty: true });
  const json = JSON.parse(ctx.fullText.split('\n')[0]);
  tab = json.selectedTabId ?? json.availableTabs?.[0]?.tabId;
  expect(tab, 'no tab from tabs_context_mcp');
  const nav = await call('navigate', { url: FIXTURE, tabId: tab });
  expect(nav.ok, `navigate failed: ${nav.error}`);
  expect((await js('location.href')).startsWith(FIXTURE), 'not on the fixture');
});

await task(2, 'read_page interactive: count refs, locate the submit button', 'snapshot quality', async () => {
  await snapshot();
  const refs = (snap.match(/\[ref_\d+\]/g) || []).length;
  note(`${refs} refs`);
  expect(refOf(snap, /Submit order/), 'submit button not in snapshot');
});

await task(3, 'find "submit button"', 'semantic find (expected to diverge)', async () => {
  // run by the bridge: the configured model, or the keyword scorer when none
  const r = await call('find', { query: 'submit button', tabId: tab });
  expect(r.ok, `find failed: ${r.error}`);
  expect(/Submit order/.test(r.fullText.split('\n')[2] || ''), 'the submit button is not the top match');
  const engine = /\(find: (.+)\)/.exec(r.fullText)?.[1] || '?';
  note(`${r.fullText.split('\n')[2]} [${engine}, ${r.ms} ms]`);
  return engine.startsWith('model') ? 'pass' : 'degraded';
});

await task(4, 'form_input fill, then computer type', 'the two input paths', async () => {
  expect(nameRef() && emailRef(), 'name/email refs missing');
  await call('form_input', { ref: nameRef(), value: 'Ada', tabId: tab });
  await call('computer', { action: 'left_click', ref: emailRef(), tabId: tab });
  await call('computer', { action: 'type', text: 'ada@example.test', tabId: tab });
  const v = await js('[document.getElementById("name").value, document.getElementById("email").value]');
  expect(v[0] === 'Ada', `form_input gave ${JSON.stringify(v[0])}`);
  expect(v[1] === 'ada@example.test', `type gave ${JSON.stringify(v[1])}`);
});

await task(5, 'left_click by ref on the mutating button', 'ref resolution + real input events', async () => {
  const ref = refOf(snap, /Change hash/);
  expect(ref, 'button ref missing');
  await call('computer', { action: 'left_click', ref, tabId: tab });
  const v = await js('[location.hash, document.getElementById("hashtext").textContent]');
  expect(v[0] === '#clicked' && v[1].startsWith('clicked at'), `DOM unchanged: ${JSON.stringify(v)}`);
});

await task(6, 'computer screenshot', 'capture', async () => {
  const r = await screenshot();
  expect(r.images.length && r.images[0].bytes > 1000, 'no image or trivially small');
  note(`${frame?.w}x${frame?.h}, ${r.images[0].media}, ${r.images[0].bytes} bytes, id ${shotId}`);
});

await task(7, 'javascript_tool reads a page variable', 'JS eval', async () => {
  expect((await js('window.FIXTURE_VAR.n')) === 42, 'wrong value');
});

await task(8, 'read_console_messages after triggering an error', 'console capture', async () => {
  await call('read_console_messages', { tabId: tab, clear: true });
  await call('computer', { action: 'left_click', ref: refOf(snap, /Log error and fetch/), tabId: tab });
  const r = await call('read_console_messages', { tabId: tab, onlyErrors: true, pattern: 'ccb-fixture-error' });
  expect(r.ok && r.fullText.includes('ccb-fixture-error'), `error not captured: ${r.error || r.text}`);
});

await task(9, 'read_network_requests after a fetch', 'network capture', async () => {
  await call('read_network_requests', { tabId: tab, clear: true });
  await call('computer', { action: 'left_click', ref: refOf(snap, /Log error and fetch/), tabId: tab });
  await call('computer', { action: 'wait', duration: 1, tabId: tab });
  const r = await call('read_network_requests', { tabId: tab, urlPattern: '/api/ping' });
  expect(r.ok && r.fullText.includes('/api/ping'), `fetch not captured: ${r.error || r.text}`);
});

await task(10, 'multi-step: fill, submit, assert the result', 'orchestration, step count', async () => {
  await call('form_input', { ref: nameRef(), value: 'Grace', tabId: tab });
  await call('form_input', { ref: emailRef(), value: 'grace@example.test', tabId: tab });
  await call('form_input', { ref: refOf(snap, /combobox/), value: 'green', tabId: tab });
  await call('form_input', { ref: refOf(snap, /checkbox/), value: true, tabId: tab });
  await call('computer', { action: 'left_click', ref: refOf(snap, /Submit order/), tabId: tab });
  const v = await js('document.getElementById("result").textContent');
  expect(v === 'submitted:Grace|grace@example.test|green|true', `result was ${JSON.stringify(v)}`);
});

await task(11, 'cross-domain hop, count permission prompts', 'the permission model', async () => {
  const hop = await call('navigate', { url: OTHER_HOST, tabId: tab });
  note(hop.ok ? `hop to ${OTHER_HOST} allowed` : `hop to ${OTHER_HOST} refused: ${hop.error_code || hop.error}`);
  const back = await call('navigate', { url: FIXTURE, tabId: tab });
  expect(back.ok, 'could not return to the fixture');
  // the allowlist holds only the fixture host, so the hop must be refused
  expect(!hop.ok && hop.error_code === 'permission_denied_user', 'hop was not gated');
});

await task(12, 'browser_batch with a prompt-gated action', 'batch gating (expected to diverge)', async () => {
  const actions = [
    { name: 'navigate', input: { url: `${FIXTURE}#batch`, tabId: tab } },
    { name: 'computer', input: { action: 'screenshot', tabId: tab } },
  ];
  // run by the bridge in one call, each action checked against the allowlist
  const r = await call('browser_batch', { actions }, 120000);
  expect(r.ok, `batch failed: ${r.error}`);
  expect(/\[navigate\]/.test(r.fullText) && r.images.length === 1, 'batch output incomplete');
});

await task(13, 'tabs_create_mcp / tabs_close_mcp lifecycle', 'tab grouping', async () => {
  const tabIds = async () => {
    const r = await call('tabs_context_mcp', {});
    return (JSON.parse(r.fullText.split('\n')[0]).availableTabs || []).map((t) => t.tabId);
  };
  const before = await tabIds();
  const c = await call('tabs_create_mcp', {});
  expect(c.ok, `tabs_create_mcp failed: ${c.error}`);
  const added = (await tabIds()).filter((id) => !before.includes(id));
  expect(added.length === 1, `expected one new tab in the group, got ${JSON.stringify(added)}`);
  const closed = await call('tabs_close_mcp', { tabId: added[0] });
  expect(closed.ok, `tabs_close_mcp failed: ${closed.error}`);
  expect(!(await tabIds()).includes(added[0]), 'tab still listed after close');
});

await task(14, 'resize_window, zoom, scroll, scroll_to, hover, drag', 'the unverified tail', async () => {
  const sub = {};
  const run = async (key, fn) => {
    try { sub[key] = (await fn()) || 'pass'; } catch (err) { sub[key] = `fail: ${err.message}`; }
  };
  await js('(window.scrollTo(0, 0), 0)');
  await snapshot();

  await run('resize_window', async () => {
    // in a session group the tab shares the operator's window; don't resize it
    if (BACKGROUND) return 'skipped: the tab lives in the operator\'s window in background mode';
    const r = await call('resize_window', { width: 1100, height: 820, tabId: tab });
    expect(r.ok, r.error);
    const w = await js('window.outerWidth');
    expect(Math.abs(w - 1100) <= 40, `outerWidth ${w}`);
  });
  await screenshot();
  await run('zoom', async () => {
    const r = await call('computer', { action: 'zoom', region: [0, 0, 400, 300], tabId: tab });
    expect(r.ok && r.images.length, r.error || 'no image');
  });
  await run('scroll', async () => {
    const c = await js('(() => { const r = document.getElementById("scroller").getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()');
    const r = await call('computer', { action: 'scroll', coordinate: await toFrame(c[0], c[1]), scroll_direction: 'down', scroll_amount: 3, tabId: tab });
    expect(r.ok, r.error);
    expect((await js('document.getElementById("scroller").scrollTop')) > 0, 'scroll box did not move');
  });
  await run('scroll_to', async () => {
    // the interactive filter only lists elements inside the viewport; the full
    // tree includes off-screen ones, and find (LLM-backed) is the fallback
    let ref = refOf((await call('read_page', { tabId: tab })).fullText, /Far button/);
    if (!ref) {
      const f = await call('find', { query: 'Far button', tabId: tab });
      ref = f.ok ? /\[?(ref_\d+)/.exec(f.fullText)?.[1] : null;
      if (!ref) return `degraded: no ref for the off-screen button (read_page is viewport-limited; find: ${f.error || 'no match'})`;
    }
    const r = await call('computer', { action: 'scroll_to', ref, tabId: tab });
    expect(r.ok, r.error);
    const top = await js('document.getElementById("far").getBoundingClientRect().top');
    expect(top >= 0 && top < (await js('window.innerHeight')), `far button top ${top}`);
  });
  await js('(window.scrollTo(0, 0), 0)');
  await run('hover', async () => {
    const r = await call('computer', { action: 'hover', ref: refOf(snap, /Hover target/), tabId: tab });
    expect(r.ok, r.error);
    expect((await js('document.getElementById("hover").dataset.hovered')) === '1', 'no mouseenter');
  });
  await run('drag', async () => {
    await screenshot();
    const pts = await js('["drag", "drop"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })');
    const r = await call('computer', { action: 'left_click_drag', start_coordinate: await toFrame(...pts[0]), coordinate: await toFrame(...pts[1]), tabId: tab });
    expect(r.ok, r.error);
    expect((await js('document.getElementById("drop").textContent')) === 'dropped', 'drop not registered');
  });

  return verdictOf(sub);
});

await task(15, 'upload_image / file_upload with the fixture PNG', 'file paths', async () => {
  const sub = {};
  await snapshot();
  const fu = await call('file_upload', { ref: refOf(snap, /Upload one/), tabId: tab, files: [{ name: 'pixel.png', mimeType: 'image/png', data: PNG.toString('base64') }] });
  sub.file_upload = fu.ok && (await js('document.getElementById("file1").files[0]?.name')) === 'pixel.png' ? 'pass' : `fail: ${fu.error || 'file not set'}`;
  await screenshot();
  const ui = await call('upload_image', { imageId: shotId, ref: refOf(snap, /Upload two/), tabId: tab, filename: 'shot.png' });
  sub.upload_image = ui.ok && (await js('document.getElementById("file2").files.length')) === 1 ? 'pass' : `fail: ${ui.error || 'file not set'}`;
  return verdictOf(sub);
});

// ---------------------------------------------------------------- report
const browser = await js('navigator.userAgent').catch(() => null);
if (tab) await call('tabs_close_mcp', { tabId: tab });
write(path.join(HERE, 'results'), 'arm-b', {
  arm: 'B',
  suite: 'fixture',
  label: 'patched extension via local bridge (POST /tool)',
  started_at: started.toISOString(),
  device_id: dev?.device_id,
  extension_version: dev?.extension_version,
  browser,
  fixture: FIXTURE,
});
