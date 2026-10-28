#!/usr/bin/env node
/**
 * Self-test for server.mjs multi-browser routing and the mcp.mjs adapter,
 * using fake extension peers. Runs on spare ports with a throwaway state dir,
 * so it never touches a live bridge, its log, or its allowlist.
 *
 *   node bridge/selftest.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS_PORT = Number(process.env.SELFTEST_WS_PORT || 18765);
const HTTP_PORT = Number(process.env.SELFTEST_HTTP_PORT || 18766);
const API = `http://127.0.0.1:${HTTP_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-selftest-'));
const STATE = path.join(TMP, 'state');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(STATE);
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(STATE, 'allow.json'), JSON.stringify({ domains: ['allowed.test'] }));
fs.writeFileSync(path.join(WORK, 'pixel.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail === undefined ? '' : `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}`}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opts = {}) => (await fetch(API + p, { ...opts, headers: { 'content-type': 'application/json' } })).json();
const tool = (t, args = {}, device_id) => api('/tool', { method: 'POST', body: JSON.stringify({ tool: t, args, device_id }) });
const textOf = (content) => (Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }])
  .filter((b) => b.type === 'text').map((b) => b.text).join('\n');

// ---------------------------------------------------------------- fake extension
function fakePeer(deviceId, displayName) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}/chrome/dev_user_local`);
    const peer = { ws, deviceId, pongs: 0, permissionResponses: [], calls: [] };
    const waiters = new Map();
    const ask = (toolUseId, url) => new Promise((r) => {
      const id = crypto.randomUUID();
      waiters.set(id, r);
      ws.send(JSON.stringify({ type: 'permission_request', request_id: id, tool_use_id: toolUseId, tool_type: 'navigate', url }));
    });
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'connect', client_type: 'chrome-extension', device_id: deviceId, dev_user_id: 'dev_user_local',
      extension_version: '1.0.102', os_platform: 'macOS', display_name: displayName,
    })));
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'paired') resolve(peer);
      if (m.type === 'pong') peer.pongs++;
      if (m.type === 'permission_response') { peer.permissionResponses.push(m); waiters.get(m.request_id)?.(m); }
      if (m.type !== 'tool_call') return;
      peer.calls.push(m);
      const reply = (content, extra = {}) => ws.send(JSON.stringify({ type: 'tool_result', tool_use_id: m.tool_use_id, content, ...extra }));
      switch (m.tool) {
        case 'tabs_context_mcp':
          return reply([{ type: 'text', text: `peer:${deviceId}` }]);
        case 'computer':
          return reply([
            { type: 'text', text: 'Successfully captured screenshot (2x2, jpeg) - ID: ss_test' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AA==' } },
          ]);
        case 'navigate': {
          const r = await ask(m.tool_use_id, m.args.url);
          return r.allowed
            ? reply([{ type: 'text', text: `Navigated to ${m.args.url}` }])
            : reply('Permission denied by user', { is_error: true, error_code: 'permission_denied_user' });
        }
        case 'find':
          return reply('Failed to find element: Anthropic client not available', { is_error: true });
        case 'read_page':
          return reply([{ type: 'text', text: 'link "Home" [ref_1]\nbutton "Submit order" [ref_4]\ntextbox "Email" [ref_5]' }]);
        case 'browser_batch':
          return reply('actions[0] needs a prompt (permission_required)', { is_error: true, error_code: 'permission_required' });
        case 'file_upload':
          return reply([{ type: 'text', text: JSON.stringify({ paths: m.args.paths, files: (m.args.files || []).map((f) => [f.name, f.mimeType, f.data]) }) }]);
        default:
          return reply(`unhandled ${m.tool}`, { is_error: true });
      }
    });
  });
}

// ---------------------------------------------------------------- MCP client
function mcpClient(env) {
  const child = spawn(process.execPath, [path.join(HERE, 'mcp.mjs')], { cwd: WORK, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = '';
  let nextId = 1;
  const stray = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { stray.push(line); continue; }
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result;
  return { child, request, call, stray, notify: (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
}

// ---------------------------------------------------------------- run
const server = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: { ...process.env, CCB_STATE_DIR: STATE, CCB_WS_PORT: String(WS_PORT), CCB_HTTP_PORT: String(HTTP_PORT) },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const peers = [];
const clients = [];

try {
  for (let i = 0; i < 50; i++) {
    try { await api('/status'); break; } catch { await sleep(100); }
  }

  console.log('server: multi-browser routing');
  let st = await api('/status');
  check('no browsers: extension.connected is false', st.extension.connected === false && st.extensions?.length === 0, st);
  check('no browsers: /tool reports it', /not connected/.test((await tool('tabs_context_mcp')).error), null);

  const daily = await fakePeer('aaaa1111-daily', 'owenisas-MacBook-Pro');
  const agent = await fakePeer('bbbb2222-agent');
  peers.push(daily, agent);
  st = await api('/status');
  check('/status lists both browsers', st.extensions?.length === 2, st.extensions);
  check('/status.extension is the latest connection', st.extension.device_id === 'bbbb2222-agent', st.extension);

  const undirected = await tool('tabs_context_mcp');
  check('two browsers + no device_id: refused, never guessed', !undirected.ok && /2 browsers connected/.test(undirected.error), undirected);
  check('refusal sent no tool_call to either browser', daily.calls.length === 0 && agent.calls.length === 0);

  const toAgent = await tool('tabs_context_mcp', {}, 'bbbb2222-agent');
  check('device_id routes to that browser', textOf(toAgent.result?.content) === 'peer:bbbb2222-agent', toAgent);
  const byPrefix = await tool('tabs_context_mcp', {}, 'aaaa');
  check('device_id prefix routes too', textOf(byPrefix.result?.content) === 'peer:aaaa1111-daily', byPrefix);
  const unknown = await tool('tabs_context_mcp', {}, 'zzzz');
  check('unknown device_id is an error', !unknown.ok && /no connected browser/.test(unknown.error), unknown);

  daily.ws.send(JSON.stringify({ type: 'ping' }));
  agent.ws.send(JSON.stringify({ type: 'ping' }));
  await sleep(150);
  check('each browser gets its own pong', daily.pongs === 1 && agent.pongs === 1, { daily: daily.pongs, agent: agent.pongs });

  const denied = await tool('navigate', { url: 'https://blocked.example/x', tabId: 1 }, 'aaaa');
  const allowed = await tool('navigate', { url: 'https://sub.allowed.test/', tabId: 1 }, 'aaaa');
  check('permission answered on the asking socket only', daily.permissionResponses.length === 2 && agent.permissionResponses.length === 0,
    { daily: daily.permissionResponses.length, agent: agent.permissionResponses.length });
  check('allowlist denies an unlisted host', denied.result?.error_code === 'permission_denied_user', denied);
  check('allowlist allows a subdomain of a listed host', allowed.ok, allowed);
  const appr = await api('/approvals');
  check('denial recorded with device_id and host', appr.approvals?.some((a) => a.host === 'blocked.example' && a.device_id === 'aaaa1111-daily'), appr);

  const daily2 = await fakePeer('aaaa1111-daily', 'owenisas-MacBook-Pro');
  peers.push(daily2);
  await sleep(150);
  st = await api('/status');
  check('reconnect with the same device_id replaces the stale socket', st.extensions?.length === 2 && daily.ws.readyState !== WebSocket.OPEN, st.extensions);

  agent.ws.close();
  await sleep(150);
  const single = await tool('tabs_context_mcp');
  check('one browser left: no device_id needed', textOf(single.result?.content) === 'peer:aaaa1111-daily', single);

  const agent2 = await fakePeer('bbbb2222-agent');
  peers.push(agent2);

  console.log('mcp.mjs: protocol');
  const mcp = mcpClient({ CCB_API: API, CCB_DEVICE: '', CCB_UPLOAD_ROOTS: '' });
  clients.push(mcp);
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } });
  check('initialize echoes a supported protocol version', init.result?.protocolVersion === '2025-06-18', init);
  check('initialize advertises tools and instructions', init.result?.capabilities?.tools && /allowlist/.test(init.result?.instructions || ''), init.result);
  mcp.notify('notifications/initialized');
  const list = await mcp.request('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  const expected = ['navigate', 'read_page', 'get_page_text', 'find', 'form_input', 'javascript_tool', 'computer', 'browser_batch',
    'resize_window', 'gif_creator', 'upload_image', 'file_upload', 'tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp',
    'read_console_messages', 'read_network_requests', 'list_connected_browsers', 'select_browser'];
  check('tools/list exposes the 17 extension tools + browser selection', expected.every((n) => names.includes(n)) && names.length === expected.length, names);
  check('no allow/deny tool exposed', !names.some((n) => /allow|deny/.test(n)), names);
  check('every tool has an object inputSchema', list.result.tools.every((t) => t.inputSchema?.type === 'object'));
  const nav = list.result.tools.find((t) => t.name === 'navigate');
  check('navigate keeps the extension arg shape', JSON.stringify(nav.inputSchema.required) === '["url","tabId"]', nav.inputSchema);
  const bad = await mcp.request('no/such/method', {});
  check('unknown method is JSON-RPC -32601', bad.error?.code === -32601, bad);

  console.log('mcp.mjs: tools');
  let r = await mcp.call('list_connected_browsers');
  let listed = JSON.parse(r.content[0].text);
  check('list_connected_browsers shows both, none in use yet', listed.browsers.length === 2 && !listed.browsers.some((b) => b.inUse) && /ask the user/.test(listed.note), listed);
  r = await mcp.call('tabs_context_mcp', { createIfEmpty: false });
  check('two browsers, none selected: isError with a select_browser hint', r.isError && /select_browser/.test(textOf(r.content)), r);
  r = await mcp.call('select_browser', { deviceId: 'nope' });
  check('select_browser rejects an unknown deviceId', r.isError, r);
  r = await mcp.call('select_browser', { deviceId: 'bbbb2222-agent' });
  check('select_browser accepts a connected deviceId', !r.isError, r);
  listed = JSON.parse((await mcp.call('list_connected_browsers')).content[0].text);
  check('list_connected_browsers marks the selection inUse', listed.browsers.find((b) => b.inUse)?.deviceId === 'bbbb2222-agent', listed);
  r = await mcp.call('tabs_context_mcp', {});
  check('calls go to the selected browser', textOf(r.content) === 'peer:bbbb2222-agent', r);

  r = await mcp.call('computer', { action: 'screenshot', tabId: 1 });
  const img = r.content.find((b) => b.type === 'image');
  check('image blocks are converted to MCP {data, mimeType}', img?.mimeType === 'image/jpeg' && img?.data === '/9j/AA==' && !img.source, r.content);

  r = await mcp.call('navigate', { url: 'https://blocked.example/', tabId: 1 });
  const navText = textOf(r.content);
  check('denial: isError, names the host, points at the operator', r.isError && /blocked\.example/.test(navText) && /cli\.mjs allow/.test(navText) && /error_code: permission_denied_user/.test(navText), navText);

  r = await mcp.call('find', { query: 'submit button', tabId: 1 });
  check('find falls back to the local scorer', !r.isError && /\[ref_4\]/.test(textOf(r.content).split('\n')[1] || ''), textOf(r.content));

  r = await mcp.call('browser_batch', { actions: [
    { name: 'tabs_context_mcp', input: {} },
    { name: 'computer', input: { action: 'screenshot', tabId: 1 } },
  ] });
  check('browser_batch replays standalone on permission_required', !r.isError && /\[2\/2\] computer/.test(textOf(r.content)) && r.content.some((b) => b.type === 'image'), textOf(r.content));
  r = await mcp.call('browser_batch', { actions: [
    { name: 'navigate', input: { url: 'https://blocked.example/', tabId: 1 } },
    { name: 'tabs_context_mcp', input: {} },
  ] });
  check('replayed batch stops at the first error', r.isError && /Stopped at actions\[0\]; 1 not run/.test(textOf(r.content)), textOf(r.content));

  r = await mcp.call('file_upload', { paths: [path.join(WORK, 'pixel.png')], ref: 'ref_5', tabId: 1 });
  const up = JSON.parse(r.content[0].text);
  check('file_upload reads paths into files and drops paths', !up.paths && up.files[0][0] === 'pixel.png' && up.files[0][1] === 'image/png' && up.files[0][2] === Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), up);
  r = await mcp.call('file_upload', { paths: ['/etc/hosts'], ref: 'ref_5', tabId: 1 });
  check('file_upload refuses paths outside the roots', r.isError && /outside the readable roots/.test(textOf(r.content)), r);
  r = await mcp.call('file_upload', { paths: ['relative.png'], ref: 'ref_5', tabId: 1 });
  check('file_upload refuses relative paths', r.isError && /absolute/.test(textOf(r.content)), r);

  r = await mcp.call('no_such_tool', {});
  check('unknown tool is an isError result', r.isError, r);

  const dead = mcpClient({ CCB_API: 'http://127.0.0.1:1' });
  clients.push(dead);
  r = await dead.call('tabs_context_mcp', {});
  check('bridge down: isError telling the operator how to start it', r.isError && /server\.mjs/.test(textOf(r.content)), r);

  check('stdout carried only JSON-RPC', clients.every((c) => c.stray.length === 0), clients.map((c) => c.stray));
} catch (err) {
  failures++;
  console.log(`  FAIL  harness: ${err.stack || err.message}`);
} finally {
  for (const c of clients) c.child.kill();
  for (const p of peers) p.ws.terminate();
  server.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
