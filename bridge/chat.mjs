#!/usr/bin/env node
/**
 * Chat turns for the local side panel.
 *
 * The panel is a browser page, so it cannot spawn anything. It posts a message
 * here and the bridge runs one headless agent turn:
 *
 *   claude -p <message> --mcp-config <the bridge's own MCP server>
 *                       --strict-mcp-config --allowedTools mcp__claude-chrome
 *
 * The model gets this bridge's browser tools and nothing else — no shell, no
 * file edits, no settings, no other MCP servers. Tool calls come back through
 * the bridge, so a host still has to pass the local allowlist. That is the whole
 * permission story; there is no second gate to keep in sync.
 *
 * Sessions: the first turn of a conversation passes `--session-id <uuid>`, later
 * turns `--resume <uuid>`, so the CLI keeps the history. `session_id` is returned
 * to the caller and echoed back on the next message.
 *
 * Config, `~/.claude-chrome-bridge/chat.json` (all optional):
 *   {
 *     "model": "claude-haiku-5-5",   // omit for the CLI's default
 *     "claude_bin": "/path/to/claude",
 *     "timeout_ms": 300000,
 *     "mcp_server_name": "claude-chrome"
 *   }
 * CCB_CHAT_MODEL / CCB_CHAT_BIN / CCB_CHAT_TIMEOUT override it.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadChatConfig(stateDir) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(stateDir, 'chat.json'), 'utf8')); } catch { /* defaults */ }
  return {
    model: process.env.CCB_CHAT_MODEL || cfg.model || null,
    bin: process.env.CCB_CHAT_BIN || cfg.claude_bin || 'claude',
    timeoutMs: Number(process.env.CCB_CHAT_TIMEOUT || cfg.timeout_ms) || 300_000,
    serverName: cfg.mcp_server_name || 'claude-chrome',
  };
}

/** Turn a stream-json line into something the panel can show. */
export function readStreamLine(line, acc) {
  if (!line.trim()) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (j.type === 'assistant' && Array.isArray(j.message?.content)) {
    for (const b of j.message.content) {
      if (b.type === 'text' && b.text && b.text.trim()) acc.text += (acc.text ? '\n' : '') + b.text.trim();
      if (b.type === 'tool_use' && b.name) {
        // ToolSearch is the CLI's own discovery step, not a browser action.
        acc.tools.push({ name: b.name.replace(/^mcp__[^_]+__/, ''), input: b.input ?? {}, internal: b.name === 'ToolSearch' });
      }
    }
  }
  if (j.type === 'result') {
    acc.result = typeof j.result === 'string' ? j.result : acc.result;
    acc.session_id = j.session_id || acc.session_id;
    if (j.is_error) acc.error = j.result || j.subtype || 'turn failed';
  }
}

/**
 * Run one turn. Resolves with { text, tools, session_id, ms, error? }.
 * Never rejects for a failed turn — the panel needs something to render.
 */
export function chat(mcpPath, stateDir, { message, session_id: sessionId, model, device_id: device, cwd } = {}) {
  const cfg = loadChatConfig(stateDir);
  const serverName = cfg.serverName;
  const mcpConfig = JSON.stringify({
    mcpServers: { [serverName]: { command: process.execPath, args: [mcpPath] } },
  });
  const resuming = typeof sessionId === 'string' && sessionId.length > 0;
  const sid = resuming ? sessionId : crypto.randomUUID();

  const args = [
    '-p', String(message ?? ''),
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', `mcp__${serverName}`,
    '--output-format', 'stream-json', '--verbose',
    resuming ? '--resume' : '--session-id', sid,
  ];
  const chosen = model || cfg.model;
  if (chosen) args.push('--model', chosen);

  // A minimal environment: don't inherit a parent Claude Code session or a
  // project's settings. CCB_DEVICE is what the MCP adapter reads to preselect a
  // browser, so choosing one here needs no cooperation from the model.
  const env = {};
  for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']) {
    if (process.env[k]) env[k] = process.env[k];
  }
  if (device) env.CCB_DEVICE = String(device);

  const started = Date.now();
  return new Promise((resolve) => {
    const acc = { text: '', tools: [], session_id: sid, result: undefined, error: undefined };
    let child;
    try {
      child = spawn(cfg.bin, args, { cwd: cwd || os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ text: '', tools: [], session_id: sid, ms: 0, error: `could not start ${cfg.bin}: ${err.message}` });
    }
    let stdout = '', stderr = '', pending = '';
    const finish = (error) => {
      clearTimeout(timer);
      resolve({ ...acc, ms: Date.now() - started, ...(error && { error }) });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(`timed out after ${cfg.timeoutMs} ms`);
    }, cfg.timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
      pending += d.toString();
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) readStreamLine(l, acc);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(`could not start ${cfg.bin}: ${err.message}`));
    child.on('close', (code) => {
      if (pending) readStreamLine(pending, acc);
      if (code !== 0 && !acc.text && !acc.error) {
        finish((stderr.trim() || `claude exited ${code}`).slice(0, 400));
      } else {
        finish(acc.error);
      }
    });
  });
}
