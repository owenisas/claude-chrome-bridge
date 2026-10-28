/**
 * Shared plumbing for the bridge-side (arm B) benchmark suites: timed calls to
 * POST /tool, a marker-wrapped javascript_tool, per-task records with the
 * permission prompts the bridge answered, and the results file.
 *
 * Calls go straight to the bridge, so `ms` is the bridge round trip (HTTP +
 * WebSocket + extension work) with no agent in the loop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.CCB_API || 'http://127.0.0.1:8766';
const LOG = path.join(process.env.CCB_STATE_DIR || path.join(os.homedir(), '.claude-chrome-bridge'), 'bridge.log');

export const blocksOf = (r) => {
  const c = r?.content ?? r?.error?.content;
  return Array.isArray(c) ? c : typeof c === 'string' && c ? [{ type: 'text', text: c }] : [];
};
export const textOf = (blocks) => blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

export const refOf = (snapshot, re, nth = 0) => {
  const line = snapshot.split('\n').filter((l) => re.test(l))[nth];
  return line && /\[(ref_\d+)\]/.exec(line)?.[1];
};

export function expect(cond, msg) { if (!cond) throw new Error(msg); }

function redact(args) {
  if (!args?.files) return args;
  return { ...args, files: args.files.map((f) => ({ name: f.name, mimeType: f.mimeType, bytes: Buffer.byteLength(f.data, 'base64') })) };
}

// A run works in its own background tab group (an inactive tab in the
// browser's last-focused window) unless BENCH_FOREGROUND=1, which uses the
// extension's legacy path: a new, focused window.
export const BACKGROUND = process.env.BENCH_FOREGROUND !== '1';

/**
 * device: bridge device_id (or prefix); getTab: returns the tab the suite works in.
 */
export function createRun({ device, getTab }) {
  const sessionScope = BACKGROUND ? { sessionId: `ccb-bench-${Date.now()}`, displayName: 'ccb bench' } : undefined;
  const results = [];
  let cur = null;

  async function call(tool, args = {}, timeoutMs = 30000) {
    const t0 = performance.now();
    let body;
    try {
      const res = await fetch(`${API}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool, args, timeout_ms: timeoutMs, device_id: device, session_scope: sessionScope }),
      });
      body = await res.json();
    } catch (err) {
      body = { ok: false, error: err.message };
    }
    const ms = Math.round(performance.now() - t0);
    const blocks = blocksOf(body.result);
    const text = textOf(blocks);
    const rec = {
      tool,
      args: redact(args),
      ms,
      ok: !!body.ok,
      error_code: body.result?.error_code,
      text: text.slice(0, 400),
      images: blocks.filter((b) => b.type === 'image').map((b) => ({ media: b.source?.media_type, bytes: Buffer.byteLength(b.source?.data || '', 'base64') })),
      error: body.ok ? undefined : (text || body.error || 'failed').slice(0, 300),
    };
    cur?.calls.push(rec);
    return { ...rec, fullText: text };
  }

  // javascript_tool with a marker, so parsing doesn't depend on its output format
  async function js(expr) {
    const r = await call('javascript_tool', { action: 'javascript_exec', text: `'@@' + JSON.stringify(${expr}) + '@@'`, tabId: getTab() });
    const m = /@@(.*)@@/s.exec(r.fullText);
    if (!r.ok || !m) throw new Error(`javascript_tool failed: ${r.error || r.text}`);
    return JSON.parse(m[1]);
  }

  const note = (msg) => cur?.notes.push(msg);

  // sub-checks are 'pass', 'degraded: why', 'fail: why' or 'skipped: why'
  function verdictOf(sub) {
    cur.sub = sub;
    note(Object.entries(sub).map(([k, v]) => `${k}: ${v}`).join('; '));
    const vals = Object.values(sub).filter((v) => !v.startsWith('skipped'));
    if (vals.every((v) => v === 'pass')) return 'pass';
    return vals.some((v) => v === 'pass' || v.startsWith('degraded')) ? 'degraded' : 'fail';
  }

  async function task(id, name, isolates, fn) {
    cur = { id, name, isolates, verdict: 'fail', calls: [], notes: [] };
    const logStart = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
    const t0 = performance.now();
    try {
      cur.verdict = (await fn()) || 'pass';
    } catch (err) {
      cur.verdict = 'fail';
      cur.notes.push(String(err.message || err));
    }
    cur.wall_ms = Math.round(performance.now() - t0);
    cur.tool_calls = cur.calls.length;
    const added = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').slice(logStart) : '';
    const prompts = added.split('\n').filter((l) => /permission (ALLOW|DENY)/.test(l) && (!device || l.includes(device)));
    cur.permission_prompts = prompts.length;
    cur.permission_log = prompts.map((l) => l.replace(/^\[[^\]]+\]\s*/, ''));
    results.push(cur);
    console.log(`${String(id).padStart(3)}  ${cur.verdict.padEnd(8)} ${String(cur.tool_calls).padStart(2)} calls ${String(cur.wall_ms).padStart(6)} ms  prompts ${cur.permission_prompts}  ${name}${cur.notes.length ? `\n       ${cur.notes.join('\n       ')}` : ''}`);
    cur = null;
  }

  async function target() {
    const status = await (await fetch(`${API}/status`)).json();
    return (status.extensions || []).find((e) => !device || e.device_id.startsWith(device)) || status.extension;
  }

  function write(dir, prefix, meta) {
    const summary = { pass: 0, degraded: 0, fail: 0 };
    for (const r of results) summary[r.verdict]++;
    const out = {
      ...meta,
      mode: BACKGROUND ? 'background session group' : 'foreground window',
      finished_at: new Date().toISOString(),
      summary,
      total_tool_calls: results.reduce((n, r) => n + r.tool_calls, 0),
      total_permission_prompts: results.reduce((n, r) => n + r.permission_prompts, 0),
      tasks: results,
    };
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${prefix}-${meta.started_at.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log(`\n${summary.pass} pass, ${summary.degraded} degraded, ${summary.fail} fail — ${out.total_tool_calls} tool calls, ${out.total_permission_prompts} permission prompts\nwrote ${path.relative(process.cwd(), file)}`);
    return out;
  }

  return { call, js, note, verdictOf, task, target, write };
}
