#!/usr/bin/env node
/**
 * MCP server (stdio) for the Claude Chrome Bridge.
 *
 * Exposes the extension's own tool registry under the same names and argument
 * shapes, so instructions written against Claude in Chrome work unchanged.
 * Every call goes to the bridge's loopback HTTP API (POST /tool); the bridge
 * answers the extension's permission prompts from the local allowlist.
 *
 *   claude mcp add claude-chrome -- node <repo>/bridge/mcp.mjs
 *
 * Not exposed on purpose: allow/deny. Granting a host is the operator's call
 * (`node bridge/cli.mjs allow <host>`), never the agent's.
 *
 * Env:
 *   CCB_API           bridge URL (default http://127.0.0.1:8766)
 *   CCB_DEVICE        preselect a browser by device_id
 *   CCB_UPLOAD_ROOTS  extra directories file_upload may read, ':'-separated
 *
 * stdout carries only JSON-RPC; diagnostics go to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFind } from './local-find.mjs';

const API = process.env.CCB_API || 'http://127.0.0.1:8766';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const SERVER_INFO = { name: 'claude-chrome-bridge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const UPLOAD_LIMIT = 10 << 20;   // the extension's own cap
const SLOW_TOOLS = new Set(['browser_batch', 'gif_creator']);

// file_upload reads only below these: the directory Claude Code started us in
// (the project) plus whatever the operator adds. The stock client applies its
// own file-read permissions here; this is the local equivalent.
const UPLOAD_ROOTS = [process.cwd(), ...(process.env.CCB_UPLOAD_ROOTS || '').split(':').filter(Boolean)]
  .map((p) => { try { return fs.realpathSync(p); } catch { return null; } })
  .filter(Boolean);

let device = process.env.CCB_DEVICE || undefined;   // set by select_browser

// ---------------------------------------------------------------- tool registry
const tabId = { type: 'number', description: 'Tab id from tabs_context_mcp.' };
const ref = { type: 'string', description: 'Element reference from read_page or find, e.g. "ref_3".' };
const point = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };

const TOOLS = [
  {
    name: 'tabs_context_mcp',
    description: 'List the tabs in the MCP tab group. Call this first to get tab ids. With createIfEmpty, creates the group (a new window with one empty tab) when none exists.',
    inputSchema: { type: 'object', properties: { createIfEmpty: { type: 'boolean' } } },
  },
  {
    name: 'tabs_create_mcp',
    description: 'Open a new empty tab in the MCP tab group and return its id.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_close_mcp',
    description: 'Close a tab in the MCP tab group.',
    inputSchema: { type: 'object', properties: { tabId: { type: 'integer' } }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Go to a URL in a tab, or "back" / "forward" in its history. Hosts are gated by the operator\'s local allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL (protocol optional), or "back" / "forward".' },
        tabId,
        force: { type: 'boolean', description: 'Navigate even if the page has a beforeunload prompt.' },
      },
      required: ['url', 'tabId'],
    },
  },
  {
    name: 'read_page',
    description: 'Accessibility-tree snapshot of the page. Interactive elements carry refs (ref_N) usable by computer, form_input, file_upload and upload_image.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['interactive', 'all'], description: '"interactive" returns only elements you can act on.' },
        tabId,
        depth: { type: 'number', description: 'Maximum tree depth.' },
        ref_id: { type: 'string', description: 'Restrict the snapshot to this element\'s subtree.' },
        max_chars: { type: 'number', description: 'Truncate the output at this many characters.' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'get_page_text',
    description: 'Plain text of the page, main content first.',
    inputSchema: { type: 'object', properties: { tabId, max_chars: { type: 'number' } }, required: ['tabId'] },
  },
  {
    name: 'find',
    description: 'Find elements by a natural-language description and return their refs. In local mode the match is a keyword score over the interactive snapshot, not a model.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, tabId }, required: ['query', 'tabId'] },
  },
  {
    name: 'form_input',
    description: 'Set the value of a form element (input, textarea, select, checkbox) by ref.',
    inputSchema: {
      type: 'object',
      properties: { ref, value: { type: ['string', 'boolean', 'number'] }, tabId },
      required: ['ref', 'value', 'tabId'],
    },
  },
  {
    name: 'computer',
    description: [
      'Mouse, keyboard and screenshots in a tab. Coordinates are viewport pixels in the frame of the most recent screenshot.',
      'left_click / right_click / double_click / triple_click / hover: coordinate or ref (modifiers optional).',
      'type: text. key: text as space-separated keys, e.g. "Enter" or "cmd+a" (repeat optional).',
      'scroll: coordinate, scroll_direction, scroll_amount. scroll_to: ref.',
      'left_click_drag: start_coordinate to coordinate. zoom: region [x0, y0, x1, y1].',
      'wait: duration in seconds (max 10). screenshot: scale optional; returns an ID usable by upload_image.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['left_click', 'right_click', 'type', 'screenshot', 'wait', 'scroll', 'key', 'left_click_drag',
            'double_click', 'triple_click', 'zoom', 'scroll_to', 'hover'],
        },
        coordinate: point,
        text: { type: 'string' },
        duration: { type: 'number', minimum: 0, maximum: 10 },
        scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        scroll_amount: { type: 'number', minimum: 1, maximum: 10 },
        start_coordinate: point,
        region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        scale: { type: 'number', minimum: 0.1, maximum: 1, description: 'screenshot and zoom only: shrink the returned image.' },
        repeat: { type: 'number', minimum: 1, maximum: 100 },
        ref,
        modifiers: { type: 'string', description: 'e.g. "shift" or "cmd+shift".' },
        tabId,
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: 'javascript_tool',
    description: 'Run JavaScript in the page and return the value of the last expression.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', description: 'Always "javascript_exec".' }, text: { type: 'string' }, tabId },
      required: ['action', 'text', 'tabId'],
    },
  },
  {
    name: 'read_console_messages',
    description: 'Console messages from a tab. Capture starts with the first call, so call once before triggering what you want to see.',
    inputSchema: {
      type: 'object',
      properties: { tabId, onlyErrors: { type: 'boolean' }, clear: { type: 'boolean' }, pattern: { type: 'string' }, limit: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'read_network_requests',
    description: 'Network requests from a tab. Capture starts with the first call.',
    inputSchema: {
      type: 'object',
      properties: { tabId, urlPattern: { type: 'string' }, clear: { type: 'boolean' }, limit: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'resize_window',
    description: 'Resize the browser window that holds the tab.',
    inputSchema: {
      type: 'object',
      properties: { width: { type: 'number' }, height: { type: 'number' }, tabId },
      required: ['width', 'height', 'tabId'],
    },
  },
  {
    name: 'browser_batch',
    description: 'Run several tool calls in order, stopping at the first error. Each item is {name, input} with input shaped exactly as for the standalone tool. In local mode, a batch that needs a permission prompt is replayed as standalone calls.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, input: { type: 'object' } },
            required: ['name', 'input'],
          },
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'upload_image',
    description: 'Upload a screenshot taken with computer (by its ID) to a file input (ref) or a drop target (coordinate). Screenshot IDs expire after a few minutes.',
    inputSchema: {
      type: 'object',
      properties: { imageId: { type: 'string' }, ref, coordinate: { type: 'array', items: { type: 'number' } }, tabId, filename: { type: 'string' } },
      required: ['imageId', 'tabId'],
    },
  },
  {
    name: 'file_upload',
    description: 'Put local files into a file input by ref, without opening the native picker. Pass absolute paths inside the project directory (or CCB_UPLOAD_ROOTS); 10 MB total.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } }, ref, tabId },
      required: ['ref', 'tabId'],
    },
  },
  {
    name: 'gif_creator',
    description: 'Record the tab\'s actions as an animated GIF: start_recording, stop_recording, export, clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start_recording', 'stop_recording', 'export', 'clear'] },
        tabId,
        coordinate: { type: 'array', items: { type: 'number' } },
        download: { type: 'boolean' },
        filename: { type: 'string' },
        options: {
          type: 'object',
          properties: {
            showClickIndicators: { type: 'boolean' },
            showDragPaths: { type: 'boolean' },
            showActionLabels: { type: 'boolean' },
            showProgressBar: { type: 'boolean' },
            showWatermark: { type: 'boolean' },
            quality: { type: 'number' },
          },
        },
      },
      required: ['action', 'tabId'],
    },
  },
  {
    name: 'list_connected_browsers',
    description: 'List the browsers connected to the bridge, with deviceId and which one this session uses. When more than one is connected, ask the user which to use, then call select_browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'select_browser',
    description: 'Send this session\'s tool calls to one connected browser, by deviceId from list_connected_browsers.',
    inputSchema: { type: 'object', properties: { deviceId: { type: 'string' } }, required: ['deviceId'] },
  },
];

const EXTENSION_TOOLS = new Set(TOOLS.map((t) => t.name).filter((n) => !['list_connected_browsers', 'select_browser'].includes(n)));

// ---------------------------------------------------------------- bridge client
async function api(p, opts = {}) {
  let res;
  try {
    res = await fetch(API + p, { ...opts, headers: { 'content-type': 'application/json' } });
  } catch {
    throw new Error(`The bridge is not reachable at ${API}. Ask the operator to start it: node bridge/server.mjs`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function callExtension(name, args, timeoutMs) {
  return api('/tool', {
    method: 'POST',
    body: JSON.stringify({ tool: name, args, timeout_ms: timeoutMs, device_id: device }),
  });
}

function blocksOf(result) {
  const c = result?.content ?? result?.error?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string' && c) return [{ type: 'text', text: c }];
  return [];
}

function textOf(blocks) {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// extension blocks are Anthropic-shaped ({source: {media_type, data}}); MCP
// wants {data, mimeType}
function toMcp(blocks) {
  return blocks.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
    if (b.type === 'image') {
      const src = b.source || {};
      const data = src.data || b.data;
      if (!data) return { type: 'text', text: '[image without data]' };
      return { type: 'image', data, mimeType: src.media_type || src.mimeType || b.mimeType || 'image/png' };
    }
    return { type: 'text', text: JSON.stringify(b) };
  });
}

const text = (t) => ({ type: 'text', text: t });
const ok = (t) => ({ content: [text(t)] });
const fail = (t) => ({ content: [text(t)], isError: true });

// ---------------------------------------------------------------- tool handlers
async function runTool(name, args = {}) {
  if (name === 'list_connected_browsers') return listBrowsers();
  if (name === 'select_browser') return selectBrowser(args);
  if (!EXTENSION_TOOLS.has(name)) return fail(`Unknown tool: ${name}`);
  if (name === 'file_upload') args = withFiles(args);

  const body = await callExtension(name, args, SLOW_TOOLS.has(name) ? 300000 : undefined);
  if (body.ok) return { content: toMcp(blocksOf(body.result)) };

  // The two tools that need Anthropic's service in the stock path get the same
  // local fallbacks the CLI uses.
  const msg = body.result ? textOf(blocksOf(body.result)) : body.error || '';
  if (name === 'find' && /Anthropic client not available/i.test(msg)) return findLocally(args);
  if (name === 'browser_batch' && (/permission_required/.test(msg) || body.result?.error_code === 'permission_required')) {
    return replayBatch(args.actions);
  }
  return failure(body);
}

async function failure(body) {
  const content = body.result ? toMcp(blocksOf(body.result)) : [text(body.error || 'tool failed')];
  if (!content.length) content.push(text('tool failed'));
  const code = body.result?.error_code;
  if (code) content.push(text(`error_code: ${code}`));
  const msg = body.result ? textOf(blocksOf(body.result)) : body.error || '';

  if (code === 'permission_denied_user' || /permission denied/i.test(msg)) {
    const hosts = await deniedHosts(body.result?.tool_use_id);
    const which = hosts.length ? hosts.join(', ') : 'the page\'s host';
    content.push(text(
      `Blocked by the bridge's local allowlist (${which}). Granting a host is the operator's decision: ` +
      `tell the user which host and let them run \`node ${CLI} allow <host>\`. Do not try to reach the page another way.`,
    ));
  } else if (/extension not connected/i.test(msg)) {
    content.push(text('No browser is connected to the bridge. The operator can start one with `node bridge/launch.mjs`, or load extension-patched/ unpacked in Chrome.'));
  } else if (/browsers connected/i.test(msg)) {
    content.push(text('Call list_connected_browsers, ask the user which browser to use, then select_browser.'));
  } else if (/no connected browser with device_id/i.test(msg)) {
    content.push(text('The selected browser is no longer connected. Call list_connected_browsers again.'));
  }
  return { content, isError: true };
}

async function deniedHosts(toolUseId) {
  try {
    const { approvals } = await api('/approvals');
    const mine = toolUseId ? approvals.filter((a) => a.tool_use_id === toolUseId) : [];
    const rows = mine.length ? mine : approvals.slice(-1);
    return [...new Set(rows.map((a) => a.host).filter(Boolean))];
  } catch {
    return [];
  }
}

async function findLocally(args) {
  const query = String(args.query || '');
  const body = await callExtension('read_page', { filter: 'interactive', tabId: args.tabId, max_chars: 60000 });
  if (!body.ok) return failure(body);
  const hits = localFind(textOf(blocksOf(body.result)), query);
  if (!hits.length) {
    return ok(`No local match for "${query}". (The extension's find needs Anthropic's service, which local mode does not use.) Try read_page with filter "interactive".`);
  }
  return ok(
    `Local keyword match for "${query}" (the extension's find needs Anthropic's service, which local mode does not use):\n` +
    hits.map((h) => `${h.score.toFixed(1)}  ${h.line}`).join('\n'),
  );
}

// The extension's browser_batch pre-checks its internal grant store, which
// stays empty in local mode, so it refuses any prompt-gated action. Replaying
// the list standalone sends each prompt to the bridge's allowlist instead.
async function replayBatch(actions) {
  if (!Array.isArray(actions) || !actions.length) return fail('browser_batch: actions must be a non-empty array');
  const content = [text('browser_batch needs a permission prompt in local mode; ran the actions one at a time.')];
  for (let i = 0; i < actions.length; i++) {
    const name = actions[i]?.name;
    if (name === 'browser_batch') {
      content.push(text(`actions[${i}]: browser_batch cannot be nested`));
      return { content, isError: true };
    }
    let r;
    try { r = await runTool(name, actions[i]?.input ?? {}); } catch (err) { r = fail(err.message); }
    content.push(text(`[${i + 1}/${actions.length}] ${name}`), ...r.content);
    if (r.isError) {
      content.push(text(`Stopped at actions[${i}]; ${actions.length - i - 1} not run.`));
      return { content, isError: true };
    }
  }
  return { content };
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip',
};

// The extension no longer reads host paths: the controller sends contents.
function withFiles(args) {
  const paths = Array.isArray(args.paths) ? args.paths : [];
  if (!paths.length) return args;
  const files = [];
  let total = 0;
  for (const p of paths) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`file_upload: paths must be absolute (got ${JSON.stringify(p)})`);
    let real;
    try { real = fs.realpathSync(p); } catch { throw new Error(`file_upload: no such file: ${p}`); }
    if (!UPLOAD_ROOTS.some((r) => real === r || real.startsWith(r + path.sep))) {
      throw new Error(`file_upload: ${p} is outside the readable roots (${UPLOAD_ROOTS.join(', ')}). The operator can add directories with CCB_UPLOAD_ROOTS.`);
    }
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`file_upload: not a regular file: ${p}`);
    total += st.size;
    if (total > UPLOAD_LIMIT) throw new Error('file_upload: files exceed 10 MB in total; split them across calls');
    files.push({ name: path.basename(p), mimeType: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', data: fs.readFileSync(real).toString('base64') });
  }
  const { paths: _paths, ...rest } = args;
  return { ...rest, files: [...(Array.isArray(args.files) ? args.files : []), ...files] };
}

async function listBrowsers() {
  const st = await api('/status');
  const list = st.extensions ?? (st.extension?.connected ? [st.extension] : []);
  const browsers = list.map((e) => ({
    deviceId: e.device_id,
    displayName: e.display_name || null,
    osPlatform: e.os_platform,
    extensionVersion: e.extension_version,
    connectedAt: e.connected_at,
    inUse: device ? e.device_id === device : list.length === 1,
  }));
  const out = { browsers };
  if (!st.extensions) out.note = 'This bridge predates multi-browser routing; the operator should restart bridge/server.mjs before selecting a browser.';
  else if (!list.length) out.note = 'No browser is connected to the bridge.';
  else if (device && !browsers.some((b) => b.inUse)) out.note = `The selected browser (${device}) is not connected.`;
  else if (!device && list.length > 1) out.note = 'Several browsers are connected; ask the user which one, then call select_browser.';
  return ok(JSON.stringify(out, null, 2));
}

async function selectBrowser(args) {
  const id = String(args.deviceId || '');
  const st = await api('/status');
  if (!st.extensions) return fail('This bridge predates multi-browser routing; the operator should restart bridge/server.mjs first.');
  const hit = st.extensions.find((e) => e.device_id === id);
  if (!hit) return fail(`No connected browser with deviceId "${id}". Call list_connected_browsers.`);
  device = id;
  return ok(`Selected ${id} (${hit.display_name || 'unnamed'}). This session's tool calls now go to that browser.`);
}

// ---------------------------------------------------------------- JSON-RPC over stdio
const INSTRUCTIONS = [
  'Drives a real Chrome through the patched Claude in Chrome extension and a local bridge, with no Claude account involved.',
  'Start with tabs_context_mcp (createIfEmpty: true) to get a tab id.',
  'Every site is gated by the operator\'s local allowlist. A "Permission denied" result means the host is not allowed: tell the user which host and let them decide. Never work around it.',
  'If several browsers are connected, call list_connected_browsers, ask the user which one, then select_browser.',
].join(' ');

async function dispatch(method, params) {
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      try {
        return await runTool(params?.name, params?.arguments ?? {});
      } catch (err) {
        return fail(err.message);
      }
    default: {
      const err = new Error(`Method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (msg.id === undefined || msg.id === null) return;   // notification
  try {
    write({ jsonrpc: '2.0', id: msg.id, result: await dispatch(msg.method, msg.params) });
  } catch (err) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
}

// requests run concurrently; on EOF, finish the ones in flight before exiting
let buf = '';
let inflight = 0;
let ended = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    inflight++;
    handle(line).finally(() => { if (--inflight === 0 && ended) process.exit(0); });
  }
});
process.stdin.on('end', () => { ended = true; if (inflight === 0) process.exit(0); });
