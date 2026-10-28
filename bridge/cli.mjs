#!/usr/bin/env node
/**
 * CLI for the Claude Chrome Bridge (local relay replacement).
 * Talks to the bridge server's loopback HTTP API.
 *
 *   node cli.mjs status
 *   node cli.mjs tabs
 *   node cli.mjs open https://example.com
 *   node cli.mjs screenshot --file shot.png
 *
 * Run `node cli.mjs help` for the full command list.
 */
import fs from 'node:fs';
import { localFind } from './local-find.mjs';

const API = process.env.CCB_API || 'http://127.0.0.1:8766';

function usage() {
  console.log(`Claude Chrome Bridge CLI

  status                          bridge + extension status
  allow <domain>                  add domain to the local allowlist
  deny <domain>                   remove domain from the allowlist
  approvals                       recent denied permission requests
  tabs [--no-create]              list/create tabs (tabs_context_mcp)
  open <url> [--tab N] [--force]  navigate (use "back"/"forward" for history)
  read [--tab N] [--interactive] [--depth N] [--ref ref_N] [--max N]
  text [--tab N] [--max N]        raw page text (get_page_text)
  find <query> [--tab N]          natural-language element search
  click [--tab N] (--ref ref_N | --x N --y N) [--right] [--double]
  hover [--tab N] (--ref ref_N | --x N --y N)
  type <text> [--tab N] [--ref ref_N]
  key <combo> [--tab N]           e.g. "Enter", "Meta+A"
  scroll [--tab N] --direction up|down|left|right [--amount N] [--ref ref_N]
  drag --from X,Y --to X,Y [--tab N]
  fill --ref ref_N --value <v> [--tab N]   set form value (form_input)
  js <code> [--tab N]             execute JavaScript in the page
  console --tab N [--errors] [--pattern P] [--limit N] [--clear]
  network --tab N [--pattern P] [--limit N] [--clear]
  screenshot [--tab N] [--file path] [--scale 0.1-1]
  resize --width W --height H [--tab N]
  batch <file.json>               browser_batch: [{"name":"click","input":{...}},...]
  raw <tool> <json-args>          escape hatch

  --device <id>                   target one browser when several are connected
                                  (device_id or a prefix, from status; or CCB_DEVICE)
  CCB_SESSION=<id>                work in a background tab group for session <id>
                                  instead of opening a focused window
`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true;
      } else {
        flags[name] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function blocksOf(result) {
  const c = result?.content ?? result?.error?.content;
  if (Array.isArray(c)) return c;
  if (typeof c === 'string' && c) return [{ type: 'text', text: c }];
  return [];
}

function textOf(result) {
  return blocksOf(result).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function tool(name, args = {}, timeoutMs) {
  const body = await api('/tool', {
    method: 'POST',
    body: JSON.stringify({
      tool: name,
      args,
      timeout_ms: timeoutMs,
      device_id: flags.device || process.env.CCB_DEVICE || undefined,
      // a session works in a background tab group instead of a focused window
      session_scope: process.env.CCB_SESSION ? { sessionId: process.env.CCB_SESSION, displayName: 'cli' } : undefined,
    }),
  });
  if (!body.ok) {
    // denials and tool errors arrive as a normal result with is_error set;
    // surface the extension's own message rather than a generic failure
    const detail = textOf(body.result) || body.error || 'tool failed';
    const err = new Error(detail);
    err.result = body.result;
    throw err;
  }
  return body.result;
}

function num(v) {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function printResult(result, flags) {
  const blocks = blocksOf(result);
  const out = [];
  for (const b of blocks) {
    if (b.type === 'text') out.push(b.text);
    else if (b.type === 'image') {
      const src = b.source || {};
      const data = src.data || b.data;
      const media = src.media_type || src.mimeType || 'image/png';
      if (!data) { out.push('[image]'); continue; }
      if (flags.file) {
        fs.writeFileSync(flags.file, Buffer.from(data, 'base64'));
        out.push(`[saved ${flags.file} (${media}, ${Buffer.byteLength(data, 'base64')} bytes)]`);
      } else if (flags['save-images']) {
        const ext = media.includes('jpeg') ? 'jpg' : media.split('/')[1] || 'png';
        const file = `shot-${Date.now()}.${ext}`;
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        out.push(`[saved ${file} (${media})]`);
      } else {
        out.push(`[image ${media}, ${Buffer.byteLength(data, 'base64')} bytes — use --file to save]`);
      }
    } else if (b.type === 'text_delta') {
      out.push(b.text || '');
    } else {
      out.push(JSON.stringify(b));
    }
  }
  if (result?.is_error || result?.error) out.unshift('ERROR:');
  console.log(out.join('\n'));
  if (result?.error_code) console.log(`error_code: ${result.error_code}`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

try {
  switch (cmd) {
    case undefined:
    case 'help':
      usage();
      break;

    case 'status': {
      const s = await api('/status');
      console.log(JSON.stringify(s, null, 2));
      break;
    }

    case 'allow': {
      const domain = positional[1];
      if (!domain) throw new Error('usage: allow <domain>');
      const r = await api('/allow', { method: 'POST', body: JSON.stringify({ domain }) });
      console.log(`allowed: ${r.allow.domains.join(', ') || '(none)'}`);
      break;
    }

    case 'deny': {
      const domain = positional[1];
      if (!domain) throw new Error('usage: deny <domain>');
      const r = await api('/deny', { method: 'POST', body: JSON.stringify({ domain }) });
      console.log(`allowed: ${r.allow.domains.join(', ') || '(none)'}`);
      break;
    }

    case 'approvals': {
      const r = await api('/approvals');
      console.log(JSON.stringify(r.approvals, null, 2));
      break;
    }

    case 'tabs': {
      const r = await tool('tabs_context_mcp', { createIfEmpty: !flags['no-create'] });
      printResult(r, flags);
      break;
    }

    case 'open': {
      const url = positional[1];
      if (!url) throw new Error('usage: open <url>');
      const r = await tool('navigate', { url, tabId: num(flags.tab), force: flags.force === true });
      printResult(r, flags);
      break;
    }

    case 'read': {
      const r = await tool('read_page', {
        tabId: num(flags.tab),
        filter: flags.interactive ? 'interactive' : undefined,
        depth: num(flags.depth),
        ref_id: flags.ref,
        max_chars: num(flags.max),
      });
      printResult(r, flags);
      break;
    }

    case 'text': {
      const r = await tool('get_page_text', { tabId: num(flags.tab), max_chars: num(flags.max) });
      printResult(r, flags);
      break;
    }

    case 'find': {
      const query = positional[1];
      if (!query) throw new Error('usage: find <query>');
      // The extension's own `find` is LLM-backed (it asks Anthropic to match
      // elements). In local-only mode there is no Anthropic client, so fall
      // back to scoring the interactive read_page snapshot locally.
      try {
        const r = await tool('find', { query, tabId: num(flags.tab) });
        printResult(r, flags);
      } catch (err) {
        if (!/Anthropic client not available/i.test(err.message)) throw err;
        const snap = textOf(await tool('read_page', { filter: 'interactive', tabId: num(flags.tab), max_chars: 60000 }));
        const hits = localFind(snap, query);
        if (!hits.length) console.log(`no local match for "${query}" (extension find needs an Anthropic client)`);
        else {
          console.log(`local match for "${query}" (extension find needs an Anthropic client):`);
          for (const h of hits) console.log(`  ${h.score.toFixed(1)}  ${h.line}`);
        }
      }
      break;
    }

    case 'click': {
      const coordinate = flags.x !== undefined ? [num(flags.x), num(flags.y)] : undefined;
      const action = flags.right ? 'right_click' : flags.double ? 'double_click' : 'left_click';
      const r = await tool('computer', { action, coordinate, ref: flags.ref, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'hover': {
      const coordinate = flags.x !== undefined ? [num(flags.x), num(flags.y)] : undefined;
      const r = await tool('computer', { action: 'hover', coordinate, ref: flags.ref, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'type': {
      const text = positional[1];
      if (text === undefined) throw new Error('usage: type <text>');
      const r = await tool('computer', { action: 'type', text, ref: flags.ref, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'key': {
      const text = positional[1];
      if (!text) throw new Error('usage: key <combo>');
      const r = await tool('computer', { action: 'key', text, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'scroll': {
      const direction = flags.direction || 'down';
      const r = await tool('computer', {
        action: 'scroll',
        scroll_direction: direction,
        scroll_amount: num(flags.amount) ?? 3,
        ref: flags.ref,
        tabId: num(flags.tab),
      });
      printResult(r, flags);
      break;
    }

    case 'drag': {
      const from = String(flags.from || '').split(',').map(Number);
      const to = String(flags.to || '').split(',').map(Number);
      if (from.length !== 2 || to.length !== 2) throw new Error('usage: drag --from X,Y --to X,Y');
      const r = await tool('computer', { action: 'left_click_drag', start_coordinate: from, coordinate: to, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'fill': {
      if (!flags.ref || flags.value === undefined) throw new Error('usage: fill --ref ref_N --value <v>');
      const r = await tool('form_input', { ref: flags.ref, value: flags.value, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'js': {
      const code = positional[1];
      if (!code) throw new Error('usage: js <code>');
      const r = await tool('javascript_tool', { action: 'javascript_exec', text: code, tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'console': {
      if (flags.tab === undefined) throw new Error('console requires --tab N');
      const r = await tool('read_console_messages', {
        tabId: num(flags.tab),
        onlyErrors: flags.errors === true,
        pattern: flags.pattern,
        limit: num(flags.limit),
        clear: flags.clear === true,
      });
      printResult(r, flags);
      break;
    }

    case 'network': {
      if (flags.tab === undefined) throw new Error('network requires --tab N');
      const r = await tool('read_network_requests', {
        tabId: num(flags.tab),
        urlPattern: flags.pattern,
        limit: num(flags.limit),
        clear: flags.clear === true,
      });
      printResult(r, flags);
      break;
    }

    case 'screenshot': {
      const r = await tool('computer', { action: 'screenshot', tabId: num(flags.tab), scale: num(flags.scale) });
      printResult(r, flags);
      break;
    }

    case 'resize': {
      if (!flags.width || !flags.height) throw new Error('usage: resize --width W --height H');
      const r = await tool('resize_window', { width: num(flags.width), height: num(flags.height), tabId: num(flags.tab) });
      printResult(r, flags);
      break;
    }

    case 'batch': {
      const file = positional[1];
      if (!file) throw new Error('usage: batch <file.json>');
      const actions = JSON.parse(fs.readFileSync(file, 'utf8'));
      try {
        const r = await tool('browser_batch', { actions }, 300000);
        printResult(r, flags);
      } catch (err) {
        // The extension's own browser_batch refuses any action that needs a
        // permission prompt (it pre-checks its internal grant store, which is
        // empty in local mode). Replay the same list as standalone calls.
        if (!/permission_required/.test(err.message)) throw err;
        console.log('browser_batch needs a prompt — replaying actions standalone');
        let done = 0;
        for (const a of actions) {
          const name = a.name || a.tool;
          const input = a.input ?? a.args ?? {};
          try {
            const r = await tool(name, input, 300000);
            const txt = textOf(r).split('\n')[0] || '(no output)';
            console.log(`  ${++done}/${actions.length} ${name}: ${txt.slice(0, 120)}`);
          } catch (e) {
            console.error(`  ${done + 1}/${actions.length} ${name} FAILED: ${e.message.split('\n')[0]}`);
            process.exitCode = 1;
            break;
          }
        }
      }
      break;
    }

    case 'raw': {
      const name = positional[1];
      const args = positional[2] ? JSON.parse(positional[2]) : {};
      const r = await tool(name, args);
      printResult(r, flags);
      break;
    }

    default:
      usage();
      process.exitCode = 2;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  // A denial is a normal result, not a crash: tell the operator which host
  // tripped the allowlist and how to grant it.
  if (/permission denied/i.test(err.message)) {
    try {
      const { approvals } = await api('/approvals');
      const recent = approvals.slice(-3).map((a) => a.host).filter(Boolean);
      if (recent.length) {
        console.error(`\nblocked by the local allowlist. Recent denied hosts:`);
        for (const h of [...new Set(recent)]) console.error(`  ${h}`);
        console.error(`\ngrant with:  node bridge/cli.mjs allow <host>`);
      }
    } catch { /* bridge unreachable; the original error already printed */ }
  }
  process.exitCode = 1;
}
