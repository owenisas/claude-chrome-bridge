/**
 * Local side panel. Talks only to the bridge on loopback.
 *
 *   GET  /status     bridge + connected browsers + allowlist + recent denials
 *   POST /chat       one headless agent turn (bridge/chat.mjs)
 *   POST /allow      grant a host — the operator's decision, made by a click
 *
 * The extension already has <all_urls> host permission, so these fetches are
 * cross-origin but not CORS-gated; the MV3 CSP connect-src is patched to allow
 * the two loopback origins.
 */
const API = 'http://127.0.0.1:8766';

// What the Claude Code CLI accepts on --model, plus the default. Verified against
// the installed CLI (`fable`, `opus`, `sonnet`, `haiku` all resolve).
const MODELS = [
  ['', 'Default model'],
  ['fable', 'Fable'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
];
const MODEL_KEY = 'ccb.panel.model';

const $ = (id) => document.getElementById(id);
const log = $('log');
let sessionId = null;
let busy = false;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function say(cls, text) {
  const n = el('div', cls, text);
  log.appendChild(n);
  log.scrollTop = log.scrollHeight;
  return n;
}

/** Escape, then render the little markdown the model actually emits: **bold**,
 *  `code`, - bullets. Keeps the serif response face looking like the original. */
function renderMarkdown(target, text) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const blocks = text.split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));
    if (isList) {
      const ul = document.createElement('ul');
      for (const l of lines) {
        const li = document.createElement('li');
        li.innerHTML = inline(l.replace(/^\s*[-*]\s+/, ''));
        ul.appendChild(li);
      }
      target.appendChild(ul);
    } else {
      const p = document.createElement('p');
      p.innerHTML = inline(block).replace(/\n/g, '<br>');
      target.appendChild(p);
    }
  }
}

async function api(path, init) {
  const res = await fetch(API + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- status

async function refresh() {
  let s;
  try {
    s = await api('/status');
  } catch (err) {
    $('dot').className = 'dot off';
    $('where').textContent = 'bridge unreachable';
    $('allow').textContent = '—';
    $('approvals').textContent = '—';
    return;
  }
  const list = s.extensions || (s.extension?.connected ? [s.extension] : []);
  $('dot').className = `dot ${list.length ? 'on' : 'off'}`;
  $('where').textContent = list.length ? `${list.length} browser${list.length > 1 ? 's' : ''}` : 'no browser';

  // One entry per connected browser. Several are common (a daily profile plus a
  // test one), and the bridge cannot guess, so the panel asks.
  const keep = $('pick').value;
  $('pick').replaceChildren(...(list.length ? list.map((b) => {
    const o = el('option', null, b.profile || b.display_name || `${String(b.device_id).slice(0, 8)}…`);
    o.value = b.device_id;
    return o;
  }) : [el('option', null, 'no browser')]));
  const ids = list.map((b) => b.device_id);
  $('pick').value = ids.includes(keep) ? keep : (ids[0] || '');

  const allowAll = !!s.allow?.allowAll;
  const domainList = s.allow?.domains || [];
  $('allow').replaceChildren(...(allowAll
    ? [el('span', 'chip warn', 'all hosts')]
    : domainList.length
      ? domainList.map((d) => el('span', 'chip', d))
      : [el('span', null, 'nothing yet — every host is denied')]));

  const approvals = s.approvals || [];
  $('approvals').textContent = approvals.length ? `${approvals.length} recent` : 'none';
  renderAsks(approvals);
}

function renderAsks(approvals) {
  for (const a of approvals) {
    const host = a.host || a.url;
    if (!host || document.querySelector(`.ask[data-host="${CSS.escape(host)}"]`)) continue;
    const box = el('div', 'ask');
    box.dataset.host = host;
    box.appendChild(el('p', null, `A tool asked to reach ${host}. The allowlist refused it.`));
    const btns = el('div', 'btns');
    const allow = el('button', 'ctl primary', 'Allow this host');
    const deny = el('button', 'ctl', 'Keep blocked');
    allow.addEventListener('click', async () => {
      allow.disabled = deny.disabled = true;
      try {
        await api('/allow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: host }) });
        box.replaceChildren(el('p', null, `Allowed ${host}. Ask again to run it.`));
        refresh();
      } catch (err) {
        box.replaceChildren(el('p', null, `Could not allow ${host}: ${err.message}`));
      }
    });
    deny.addEventListener('click', () => box.replaceChildren(el('p', null, `Keeping ${host} blocked.`)));
    btns.append(allow, deny);
    box.appendChild(btns);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }
}

// ---------------------------------------------------------------- chat

async function send() {
  const input = $('input');
  const message = input.value.trim();
  if (!message || busy) return;
  input.value = '';
  input.style.height = 'auto';
  say('me', message);

  busy = true;
  $('send').disabled = true;
  const pending = say('working', 'working');

  try {
    const r = await api('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        session_id: sessionId,
        device_id: $('pick').value || undefined,
        model: $('model').value || undefined,
      }),
    });
    sessionId = r.session_id || sessionId;
    pending.remove();

    const shown = (r.tools || []).filter((t) => !t.internal);
    if (shown.length) {
      const wrap = el('div', 'tools');
      for (const t of shown) wrap.appendChild(el('span', 'chip', t.name));
      log.appendChild(wrap);
    }

    if (r.text && r.text.trim()) {
      const bot = el('div', 'bot');
      renderMarkdown(bot, r.text.trim());
      log.appendChild(bot);
      log.scrollTop = log.scrollHeight;
    }
    if (r.error) say('note', `turn failed: ${r.error}`);

    await refresh();
    if (r.error && /denied|allow/i.test(r.error)) say('note', 'Grant the host above, then send the message again.');
  } catch (err) {
    pending.remove();
    say('note', `bridge error: ${err.message}`);
  } finally {
    busy = false;
    $('send').disabled = false;
    input.focus();
  }
}

$('model').replaceChildren(...MODELS.map(([v, label]) => {
  const o = el('option', null, label);
  o.value = v;
  return o;
}));
let saved = '';
try { saved = localStorage.getItem(MODEL_KEY) || ''; } catch {}
$('model').value = MODELS.some(([v]) => v === saved) ? saved : '';
$('model').addEventListener('change', () => {
  try { localStorage.setItem(MODEL_KEY, $('model').value); } catch {}
  say('note', `model: ${$('model').selectedOptions[0].textContent}`);
});

$('send').addEventListener('click', send);
$('refresh').addEventListener('click', refresh);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 150)}px`;
});

refresh();
setInterval(refresh, 5000);
