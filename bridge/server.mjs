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

const STATE_DIR = path.join(os.homedir(), '.claude-chrome-bridge');
const ALLOW_FILE = path.join(STATE_DIR, 'allow.json');
const LOG_FILE = path.join(STATE_DIR, 'bridge.log');
const WS_PORT = Number(process.env.CCB_WS_PORT || 8765);
const HTTP_PORT = Number(process.env.CCB_HTTP_PORT || 8766);
const TOOL_TIMEOUT_MS = 120000;

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
let ext = null;          // active extension WebSocket
let extInfo = null;      // connect frame from the extension
let connectedAt = 0;
const pending = new Map();   // tool_use_id -> {resolve, reject, timer, tool, args}
const approvals = [];        // denied permission requests (recent, capped)
const APPROVALS_MAX = 100;

function send(obj) {
  if (ext && ext.readyState === 1) {
    ext.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function rejectAllPending(reason) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    pending.delete(id);
  }
}

// ---------------------------------------------------------------- extension protocol
function handleExtMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  switch (msg.type) {
    case 'connect': {
      ext = ws;
      extInfo = msg;
      connectedAt = Date.now();
      log('extension connect', JSON.stringify({
        client_type: msg.client_type,
        device_id: msg.device_id,
        dev_user_id: msg.dev_user_id,
        extension_version: msg.extension_version,
        os_platform: msg.os_platform,
        display_name: msg.display_name,
      }));
      send({ type: 'paired', scoped_peer_disconnect: true });
      send({ type: 'peer_connected' });
      break;
    }
    case 'ping':
      send({ type: 'pong' });
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
      send({ type: 'permission_response', request_id: msg.request_id, allowed });
      log(`permission ${allowed ? 'ALLOW' : 'DENY'}`, msg.tool_type || '?', msg.url || '?');
      if (!allowed) {
        approvals.push({
          at: new Date().toISOString(),
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
      if (ext === ws) {
        ext = null;
        extInfo = null;
        connectedAt = 0;
        log('extension disconnected', code, String(reason || ''));
        rejectAllPending('extension disconnected');
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
function runTool(tool, args = {}, timeoutMs = TOOL_TIMEOUT_MS) {
  if (!ext) return Promise.reject(new Error('extension not connected'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tool timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, tool, args });
    const ok = send({
      type: 'tool_call',
      tool_use_id: id,
      tool,
      args,
      client_type: 'desktop',
      handle_permission_prompts: true,
      supports_tool_result_notices: true,
      supports_tool_result_error_code: true,
    });
    if (!ok) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('extension socket not open'));
    }
  });
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
      return json(res, 200, {
        extension: extInfo ? {
          connected: true,
          connected_at: new Date(connectedAt).toISOString(),
          device_id: extInfo.device_id,
          dev_user_id: extInfo.dev_user_id,
          extension_version: extInfo.extension_version,
          os_platform: extInfo.os_platform,
          display_name: extInfo.display_name,
        } : { connected: false },
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
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.tool) return json(res, 400, { error: 'tool required' });
      try {
        const result = await runTool(body.tool, body.args || {}, body.timeout_ms || TOOL_TIMEOUT_MS);
        return json(res, 200, { ok: !result.is_error && !result.error, result });
      } catch (err) {
        return json(res, 200, { ok: false, error: err.message });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});
httpServer.listen(HTTP_PORT, '127.0.0.1', () => log(`api listening http://127.0.0.1:${HTTP_PORT}`));

process.on('SIGINT', () => { log('shutting down'); process.exit(0); });
process.on('SIGTERM', () => { log('shutting down'); process.exit(0); });
