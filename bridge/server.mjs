#!/usr/bin/env node
/**
 * Claude Chrome Bridge — local replacement for Anthropic's hosted relay.
 *
 * The patched Claude in Chrome extension (localBridge mode) connects to
 * ws://127.0.0.1:8765/chrome/dev_user_local instead of
 * wss://bridge.claudeusercontent.com. This server answers the same protocol
 * the relay does (paired / peer_connected / tool_call / tool_result) and
 * exposes a loopback HTTP API for local callers (CLI, OpenCode).
 *
 * Permission boundary: the account login is replaced by a local allowlist at
 * ~/.claude-chrome-bridge/allow.json. The extension forwards per-site
 * permission prompts here (permission_request) and this server answers them:
 * allow when the page host matches the allowlist, deny otherwise. Denials are
 * recorded and surfaced via GET /approvals so the operator can decide.
 *
 * Loopback only. No Anthropic servers involved.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { loadFindConfig, runBatch, runFind } from './local-tools.mjs';
import { chat } from './chat.mjs';
import { profileFor, profileLabel, profileMatches } from './profiles.mjs';
import { fileURLToPath } from 'node:url';

// The panel's agent turns attach this bridge's own MCP server.
const CHAT_MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.mjs');

const STATE_DIR = process.env.CCB_STATE_DIR || path.join(os.homedir(), '.claude-chrome-bridge');
const ALLOW_FILE = path.join(STATE_DIR, 'allow.json');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');
const WS_PORT = Number(process.env.CCB_WS_PORT || 8765);
const HTTP_PORT = Number(process.env.CCB_HTTP_PORT || 8766);
const TOOL_TIMEOUT_MS = 120000;
const DEFAULT_SESSION = { sessionId: 'claude-chrome-bridge', displayName: 'Claude (local bridge)' };

fs.mkdirSync(STATE_DIR, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function loadAllow() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'));
    return { domains: Array.isArray(cfg.domains) ? cfg.domains : [], allowAll: cfg.allowAll === true };
  } catch {
    return { domains: [], allowAll: false };
  }
}

function saveAllow(cfg) {
  fs.writeFileSync(ALLOW_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isAllowed(url) {
  const cfg = loadAllow();
  if (cfg.allowAll) return true;
  const host = hostOf(url);
  if (!host) return false;
  return cfg.domains.some((d) => host === d || host.endsWith('.' + d));
}

// ---------------------------------------------------------------- state
// Several extensions can be connected at once (the forked build in a daily
// profile plus the launch.mjs browser). Each socket is its own peer; every
// reply goes back on the socket that asked, and tool calls name their target.
const peers = new Map();     // ws -> {info, connectedAt}
const pending = new Map();   // tool_use_id -> {resolve, reject, timer, tool, args, ws}
const approvals = [];        // denied permission requests (recent, capped)
const APPROVALS_MAX = 100;

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function rejectPendingFor(ws, reason) {
  for (const [id, p] of pending) {
    if (p.ws !== ws) continue;
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

function peerInfo(p) {
  const profile = profileFor(p.info.device_id);
  return {
    device_id: p.info.device_id,
    display_name: p.info.display_name,
    profile,
    label: p.info.display_name || profileLabel(profile) || null,
    dev_user_id: p.info.dev_user_id,
    extension_version: p.info.extension_version,
    os_platform: p.info.os_platform,
    connected_at: new Date(p.connectedAt).toISOString(),
  };
}

// oldest first, so the last entry is the most recent connection
function peerList() {
  return [...peers.values()].sort((a, b) => a.connectedAt - b.connectedAt).map(peerInfo);
}

// Never guess between browsers: with more than one connected, the caller must
// say which, or an agent could end up acting in someone's daily profile. A
// browser is named by device_id (or a prefix of it) or by its profile:
// "parafield.ai", "Profile 32" or "Chrome/parafield.ai".
function pickPeer(device) {
  const all = [...peers.entries()];
  if (!all.length) throw new Error('extension not connected');
  if (device) {
    const exact = all.filter(([, p]) => p.info.device_id === device);
    const byPrefix = all.filter(([, p]) => String(p.info.device_id).startsWith(device));
    const byProfile = all.filter(([, p]) => profileMatches(profileFor(p.info.device_id), device));
    const hits = exact.length ? exact : byPrefix.length ? byPrefix : byProfile;
    if (hits.length === 1) return hits[0][0];
    throw new Error(hits.length
      ? `"${device}" matches ${hits.length} browsers; use more of a device_id`
      : `no connected browser with device_id or profile "${device}"`);
  }
  if (all.length === 1) return all[0][0];
  const ids = all.map(([, p]) => `${p.info.device_id} (${p.info.display_name || profileLabel(profileFor(p.info.device_id)) || 'unknown profile'})`).join(', ');
  throw new Error(`${all.length} browsers connected: ${ids}. Pick one with device_id or a profile name`);
}

// ---------------------------------------------------------------- extension protocol
function handleExtMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  switch (msg.type) {
    case 'connect': {
      // a reconnect can arrive before the old socket's close; drop the stale one
      for (const [other, p] of peers) {
        if (other !== ws && p.info.device_id === msg.device_id) other.terminate();
      }
      peers.set(ws, { info: msg, connectedAt: Date.now() });
      log('extension connect', JSON.stringify({
        client_type: msg.client_type,
        profile: profileLabel(profileFor(msg.device_id)),
        device_id: msg.device_id,
        dev_user_id: msg.dev_user_id,
        extension_version: msg.extension_version,
        os_platform: msg.os_platform,
        display_name: msg.display_name,
      }));
      send(ws, { type: 'paired', scoped_peer_disconnect: true });
      send(ws, { type: 'peer_connected' });
      break;
    }
    case 'ping':
      send(ws, { type: 'pong' });
      break;
    case 'pong':
      break;
    case 'waiting':
      log('extension waiting (no peer)');
      break;
    case 'peer_disconnected':
      log('peer_disconnected from extension', JSON.stringify({ connection_id: msg.connection_id, mcp_peer_count: msg.mcp_peer_count }));
      break;
    case 'tool_result': {
      const p = pending.get(msg.tool_use_id);
      if (!p) { log('tool_result for unknown id', msg.tool_use_id); break; }
      pending.delete(msg.tool_use_id);
      clearTimeout(p.timer);
      p.resolve(msg);
      break;
    }
    case 'permission_request': {
      const allowed = isAllowed(msg.url);
      send(ws, { type: 'permission_response', request_id: msg.request_id, allowed });
      const device = peers.get(ws)?.info.device_id;
      log(`permission ${allowed ? 'ALLOW' : 'DENY'}`, msg.tool_type || '?', msg.url || '?', device || '?');
      if (!allowed) {
        approvals.push({
          at: new Date().toISOString(),
          device_id: device,
          request_id: msg.request_id,
          tool_use_id: msg.tool_use_id,
          tool_type: msg.tool_type,
          url: msg.url,
          host: hostOf(msg.url),
          action_data: msg.action_data,
        });
        if (approvals.length > APPROVALS_MAX) approvals.shift();
      }
      break;
    }
    case 'error':
      log('extension error frame', JSON.stringify(msg));
      break;
    default:
      log('unhandled extension frame', msg.type);
  }
}

// The extension dials ws://localhost:8765, which may resolve to ::1 or
// 127.0.0.1 depending on the resolver. Listen on both, loopback only.
function listen(host) {
  const wss = new WebSocketServer({ host, port: WS_PORT });
  wss.on('connection', (ws, req) => {
    log('ws connection', `${host}${req.url}`);
    ws.on('message', (data) => handleExtMessage(ws, data));
    ws.on('close', (code, reason) => {
      const p = peers.get(ws);
      if (p) {
        peers.delete(ws);
        log('extension disconnected', p.info.device_id, code, String(reason || ''));
        rejectPendingFor(ws, 'extension disconnected');
      }
    });
    ws.on('error', (err) => log('ws error', err.message));
  });
  wss.on('listening', () => log(`bridge listening ws://${host}:${WS_PORT}`));
  wss.on('error', (err) => log(`ws listen error on ${host}`, err.message));
  return wss;
}
listen('127.0.0.1');
listen('::1');

// ---------------------------------------------------------------- tool calls
// sessionScope ({sessionId, displayName}) puts the call in a per-session tab
// group: the extension adds an inactive tab to the last-focused window instead
// of opening a focused window, so it works in the background.
function runTool(tool, args = {}, timeoutMs = TOOL_TIMEOUT_MS, device, sessionScope) {
  let ws;
  try { ws = pickPeer(device); } catch (err) { return Promise.reject(err); }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tool timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, tool, args, ws });
    const ok = send(ws, {
      type: 'tool_call',
      tool_use_id: id,
      tool,
      args,
      client_type: 'desktop',
      handle_permission_prompts: true,
      supports_tool_result_notices: true,
      supports_tool_result_error_code: true,
      ...(sessionScope && { session_scope: sessionScope }),
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('extension socket not open'));
    }
  });
}

// find and browser_batch can't work inside the extension in local mode (no
// inference client; an empty grant store), so the bridge runs them itself on
// top of the other tools. Everything else goes straight to the extension.
function dispatch(tool, args, timeoutMs, device, sessionScope) {
  const extension = (t, a) => runTool(t, a, timeoutMs, device, sessionScope);
  if (tool === 'find') return runFind(extension, args, loadFindConfig(STATE_DIR), log);
  if (tool === 'browser_batch') {
    log('browser_batch', `${Array.isArray(args.actions) ? args.actions.length : 0} actions, run by the bridge`);
    return runBatch((t, a) => dispatch(t, a, timeoutMs, device, sessionScope), args.actions);
  }
  return extension(tool, args);
}

// ---------------------------------------------------------------- HTTP API
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${HTTP_PORT}`);
    if (req.method === 'GET' && url.pathname === '/status') {
      const list = peerList();
      return json(res, 200, {
        // `extension` is the most recent connection, kept for older callers;
        // `extensions` is every connected browser
        extension: list.length ? { connected: true, ...list[list.length - 1] } : { connected: false },
        extensions: list,
        pending_tool_calls: pending.size,
        approvals: approvals.slice(-20),
        allow: loadAllow(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/approvals') {
      return json(res, 200, { approvals });
    }
    if (req.method === 'POST' && url.pathname === '/allow') {
      const body = JSON.parse(await readBody(req) || '{}');
      const domain = String(body.domain || '').trim().toLowerCase();
      if (!domain) return json(res, 400, { error: 'domain required' });
      const cfg = loadAllow();
      if (!cfg.domains.includes(domain)) cfg.domains.push(domain);
      saveAllow(cfg);
      log('allowlist add', domain);
      return json(res, 200, { ok: true, allow: cfg });
    }
    if (req.method === 'POST' && url.pathname === '/deny') {
      const body = JSON.parse(await readBody(req) || '{}');
      const domain = String(body.domain || '').trim().toLowerCase();
      const cfg = loadAllow();
      cfg.domains = cfg.domains.filter((d) => d !== domain);
      saveAllow(cfg);
      log('allowlist remove', domain);
      return json(res, 200, { ok: true, allow: cfg });
    }
    if (req.method === 'POST' && url.pathname === '/tool') {
      // file_upload carries base64 file bodies (up to 10 MB of files)
      const body = JSON.parse(await readBody(req, 24 << 20) || '{}');
      if (!body.tool) return json(res, 400, { error: 'tool required' });
      // Without a session the extension opens a new focused window per tab
      // group, and Chrome keeps a saved "Claude (MCP)" chip for every group it
      // ever made. So a call that names no session gets the bridge's default
      // one; `session_scope: false` asks for the old window behaviour.
      const scope = body.session_scope === undefined ? DEFAULT_SESSION : body.session_scope;
      if (scope !== false && (typeof scope?.sessionId !== 'string' || !scope.sessionId)) {
        return json(res, 400, { error: 'session_scope needs a string sessionId (or false for a new window)' });
      }
      const sessionScope = scope && { sessionId: scope.sessionId, displayName: String(scope.displayName || 'Claude (local bridge)') };
      try {
        const result = await dispatch(body.tool, body.args || {}, body.timeout_ms || TOOL_TIMEOUT_MS, body.device_id, sessionScope);
        return json(res, 200, { ok: !result.is_error && !result.error, result });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      // One headless agent turn for the local side panel. See bridge/chat.mjs —
      // the model gets this bridge's browser tools and nothing else, and every
      // tool call still has to pass the allowlist.
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.message !== 'string' || !body.message.trim()) {
        return json(res, 400, { error: 'message required' });
      }
      const turn = await chat(CHAT_MCP, STATE_DIR, {
        message: body.message,
        session_id: body.session_id,
        model: body.model,
        device_id: body.device_id,
      });
      log('chat turn', `${body.session_id ? 'resume' : 'new'} ${turn.ms}ms`, `${turn.tools.length} tool call(s)`, body.device_id ? `device ${String(body.device_id).slice(0, 8)}` : 'no device', turn.error ? `ERROR ${turn.error}` : 'ok');
      return json(res, 200, { ok: !turn.error, ...turn });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});
httpServer.listen(HTTP_PORT, '127.0.0.1', () => log(`api listening http://127.0.0.1:${HTTP_PORT}`));

process.on('SIGINT', () => { log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('shutting down'); process.exit(0); });
