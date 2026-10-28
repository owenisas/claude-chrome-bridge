/**
 * Local versions of the two extension tools that depend on Anthropic's service
 * or on its grant store, run by the bridge instead of the extension:
 *
 *  - find: the extension asks a model (Claude Haiku 4.5, its `small_fast`
 *    class) to match a description against the page's accessibility tree. In
 *    local mode it has no inference client, so the bridge does the same job:
 *    it reads the tree with read_page and asks the model configured in
 *    find.json: Claude through the Claude Code CLI (`claude -p`, on the CLI's
 *    own login) or any OpenAI-compatible chat endpoint. With no model
 *    configured, or when the model call fails, it falls back to the keyword
 *    scorer.
 *  - browser_batch: the extension refuses any batch that contains an action
 *    needing a permission prompt, because it pre-checks a grant store that
 *    stays empty locally. The bridge runs the actions itself, in order, each one
 *    checked against the allowlist exactly like a standalone call.
 *
 * Both return results shaped like the extension's own tool_result.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localFind } from './local-find.mjs';

const text = (t) => ({ type: 'text', text: t });
const failure = (msg, code) => ({ content: [text(msg)], is_error: true, error_code: code });

function blocksOf(r) {
  const c = r?.content ?? r?.error?.content;
  if (Array.isArray(c)) return c;
  return typeof c === 'string' && c ? [text(c)] : [];
}
const textOf = (r) => blocksOf(r).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const failed = (r) => !!(r?.is_error || r?.error);

/**
 * find.json in the state dir. Read on every call so edits apply without a
 * restart. Two engines:
 *   {"engine": "claude-code", "model": "claude-haiku-5-5", "effort": "low"}
 *     runs `claude -p` on the Claude Code CLI's own login (no API key);
 *     "claude_bin" names the binary when it isn't on PATH
 *   {"url": "http://host:8080/v1", "model": "name", "key_file": "/path/to/key"}
 *     any OpenAI-compatible chat endpoint; the key is read from key_file so it
 *     never sits in the config or the env
 * CCB_FIND_ENGINE / CCB_FIND_URL / CCB_FIND_MODEL / CCB_FIND_KEY_FILE override it.
 */
export function loadFindConfig(stateDir) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'find.json'), 'utf8')); } catch { /* none */ }
  const engine = process.env.CCB_FIND_ENGINE || cfg.engine || 'openai';
  const model = process.env.CCB_FIND_MODEL || cfg.model;
  const timeoutMs = Number(cfg.timeout_ms) || 30000;
  if (engine === 'claude-code') {
    if (!model) return null;
    return { engine, model, effort: cfg.effort || 'low', bin: cfg.claude_bin || 'claude', timeoutMs };
  }
  const url = process.env.CCB_FIND_URL || cfg.url;
  if (!url || !model) return null;
  const keyFile = process.env.CCB_FIND_KEY_FILE || cfg.key_file;
  let key;
  if (keyFile) {
    try { key = fs.readFileSync(keyFile, 'utf8').trim(); } catch { /* reported when the call fails */ }
  }
  return { engine: 'openai', url: url.replace(/\/+$/, ''), model, key, timeoutMs };
}

const SYSTEM = [
  'You match a description to elements of a web page.',
  'You get the page\'s accessibility tree; every element that can be targeted carries a ref such as [ref_12].',
  'Reply with one line per matching element, best match first, at most 10:',
  'ref_N | role | name | why it matches',
  'Use only refs that appear in the tree; never invent one. End with a line `FOUND: <number of matches>`.',
  'If nothing matches, reply only `FOUND: 0`.',
].join('\n');

async function askOpenAI(cfg, user) {
  const res = await fetch(`${cfg.url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.key && { authorization: `Bearer ${cfg.key}` }) },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 800,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return String(body.choices?.[0]?.message?.content ?? '');
}

// A one-shot `claude -p` with nothing loaded but the model: no tools, no MCP
// servers, no settings (so no hooks or plugins), no slash commands, no saved
// session. A minimal environment and a neutral working directory keep it from
// inheriting a parent Claude Code session or a project's CLAUDE.md, so it runs
// on the CLI's own login.
function askClaudeCode(cfg, user) {
  const args = [
    '-p', '--model', cfg.model, '--effort', cfg.effort, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json', '--system-prompt', SYSTEM,
  ];
  const env = {};
  for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']) if (process.env[k]) env[k] = process.env[k];
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.bin, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`claude -p timed out after ${cfg.timeoutMs}ms`)); }, cfg.timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let body;
      try { body = JSON.parse(out); } catch { return reject(new Error(`claude -p exit ${code}: ${(err || out).trim().slice(0, 200)}`)); }
      if (body.is_error) return reject(new Error(`claude -p: ${String(body.result || body.subtype || 'error').slice(0, 200)}`));
      resolve(String(body.result ?? ''));
    });
    child.stdin.end(user);
  });
}

async function askModel(cfg, query, tree, refs) {
  const user = `Description: ${query}\n\nAccessibility tree:\n${tree}`;
  const raw = cfg.engine === 'claude-code' ? await askClaudeCode(cfg, user) : await askOpenAI(cfg, user);
  const reply = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const hits = [];
  for (const line of reply.split('\n')) {
    const m = /^\s*-?\s*\[?(ref_\d+)\]?\s*\|\s*([^|]*)\|\s*([^|]*)(?:\|\s*(.*))?$/.exec(line);
    // a ref the tree doesn't have is a hallucination; drop it
    if (m && refs.has(m[1]) && !hits.some((h) => h.ref === m[1])) {
      hits.push({ ref: m[1], role: m[2].trim(), name: m[3].trim().replace(/^"|"$/g, ''), why: (m[4] || '').trim() });
    }
  }
  if (!hits.length && !/FOUND:\s*0/.test(reply)) throw new Error('unparseable reply');
  return hits.slice(0, 10);
}

function keywordHits(tree, query) {
  const scored = localFind(tree, query);
  if (!scored.length) return [];
  const top = scored[0].score;
  return scored.filter((s) => s.score >= top / 2).slice(0, 5).map(({ line }) => ({
    ref: /\[(ref_\d+)\]/.exec(line)[1],
    role: line.split(/[\s"]/)[0],
    name: /"([^"]*)"/.exec(line)?.[1] || '',
    why: '',
  }));
}

/**
 * call(tool, args) runs an extension tool on the same browser and session.
 */
export async function runFind(call, args, cfg, log = () => {}) {
  const query = String(args?.query || '').trim();
  if (!query) return failure('find: query is required', 'input_invalid');
  const page = await call('read_page', { tabId: args.tabId, max_chars: 60000 });
  if (failed(page)) return page;   // e.g. a denial: pass the extension's own answer through
  const tree = textOf(page);
  const refs = new Set((tree.match(/\[ref_\d+\]/g) || []).map((r) => r.slice(1, -1)));

  let hits = null;
  let engine;
  if (cfg) {
    const t0 = Date.now();
    try {
      hits = await askModel(cfg, query, tree, refs);
      engine = `model ${cfg.model}${cfg.engine === 'claude-code' ? ' (claude -p)' : ''}`;
      log(`find "${query}": ${hits.length} via ${cfg.model} in ${Date.now() - t0}ms`);
    } catch (err) {
      log(`find "${query}": model ${cfg.model} failed (${err.message}); keyword fallback`);
    }
  }
  if (!hits) {
    hits = keywordHits(tree, query);
    engine = cfg ? 'keyword scorer (the find model failed)' : 'keyword scorer (no find model configured)';
  }
  if (!hits.length) return failure(`No matching elements found (find: ${engine})`, 'find_no_match');
  const lines = hits.map((h) => `- ${h.ref}: ${h.role}${h.name ? ` "${h.name}"` : ''}${h.why ? ` - ${h.why}` : ''}`);
  return {
    content: [
      text(`Found ${hits.length} matching element${hits.length === 1 ? '' : 's'}\n\n${lines.join('\n')}`),
      text(`(find: ${engine})`),
    ],
  };
}

// per-action noise the extension appends; the batch adds one tab context at the end
const isTrailer = (b) => b.type === 'text' && /^\s*(Tab Context:|<system-reminder>)/.test(b.text);

/**
 * call(tool, args) runs a tool (find included) on the same browser and session.
 */
export async function runBatch(call, actions) {
  if (!Array.isArray(actions) || !actions.length) return failure('browser_batch: actions must be a non-empty array', 'input_invalid');
  const content = [];
  let tabContext = null;
  for (let i = 0; i < actions.length; i++) {
    const { name, input } = actions[i] || {};
    const label = name === 'computer' && input?.action ? `computer:${input.action}` : String(name);
    const stop = (msg, code) => {
      content.push(text(`actions[${i}] (${label}) failed: ${msg} (${i} completed, ${actions.length - i - 1} remaining)`));
      return { content, is_error: true, error_code: code };
    };
    if (!name) return stop('missing tool name', 'batch_unknown_tool');
    if (name === 'browser_batch') return stop('browser_batch cannot be nested', 'batch_unknown_tool');
    let r;
    try { r = await call(name, input ?? {}); } catch (err) { return stop(err.message, 'batch_subaction_failed'); }
    const blocks = blocksOf(r);
    if (failed(r)) {
      const msg = blocks.filter((b) => b.type === 'text' && !isTrailer(b)).map((b) => b.text.trim()).join(' ');
      return stop(msg || 'failed', r.error_code || 'batch_subaction_failed');
    }
    for (const b of blocks) {
      if (isTrailer(b)) { if (/Tab Context:/.test(b.text)) tabContext = b; continue; }
      content.push(b.type === 'text' ? text(`[${label}] ${b.text}`) : b);
    }
  }
  if (tabContext) content.push(tabContext);
  return { content };
}
