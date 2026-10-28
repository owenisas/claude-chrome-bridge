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
 *
 * Both pickers are chip + custom menu. A native <select> renders the OS menu,
 * which looks nothing like the original panel, so they are built by hand.
 */
const API = 'http://127.0.0.1:8766';

// What the Claude Code CLI accepts on --model, plus the default. Verified against
// the installed CLI (`fable`, `opus`, `sonnet`, `haiku` all resolve).
const MODELS = [
  { value: '', label: 'Default model' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];
const MODEL_KEY = 'ccb.panel.model';

const CHECK = '<svg class="check" width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 7.6 5.6 10.6 11.5 4"/></svg>';

const $ = (id) => document.getElementById(id);
const log = $('log');
let sessionId = null;
let busy = false;
let device = '';
let model = '';

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
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l))) {
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

// ------------------------------------------------------------------ pickers

/** Wire a chip button to a menu: click to toggle, click-away / Escape to close,
 *  Enter and arrows to move. `getItems` is re-read on open so a dynamic list
 *  (the connected browsers) is always current. */
function makePicker({ button, menu, label, getItems, onPick }) {
  let open = false;

  const close = () => {
    open = false;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };

  const draw = () => {
    const items = getItems();
    menu.replaceChildren(...items.map((it) => {
      const b = el('button', 'item');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(!!it.selected));
      b.innerHTML = CHECK;
      const span = el('span', null, it.label);
      b.appendChild(span);
      if (it.hint) b.appendChild(el('span', 'sub', it.hint));
      b.addEventListener('click', () => { close(); onPick(it); });
      return b;
    }));
  };

  const openMenu = () => {
    draw();
    if (!menu.childElementCount) return;
    open = true;
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('.item[aria-selected="true"]')?.focus();
  };

  button.addEventListener('click', (e) => { e.stopPropagation(); open ? close() : openMenu(); });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); }
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(i + 1, items.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(i - 1, 0)]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); button.focus(); }
  });
  document.addEventListener('click', () => { if (open) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { close(); button.focus(); } });

  return { close, setLabel: (t) => { label.textContent = t; } };
}

// -------------------------------------------------------------------- status

let browsers = [];
const pickPicker = makePicker({
  button: $('pick-btn'), menu: $('pick-menu'), label: $('pick-label'),
  getItems: () => (browsers.length
    ? browsers.map((b) => {
        const named = b.profile || b.display_name;
        const short = String(b.device_id).slice(0, 8);
        return {
          value: b.device_id,
          label: named || `${short}…`,
          // only worth showing the id when the label isn't already the id
          hint: named ? short : '',
          selected: b.device_id === device,
        };
      })
    : [{ value: '', label: 'no browser connected', selected: true, disabled: true }]),
  onPick: (it) => {
    if (!it.value) return;
    device = it.value;
    pickPicker.setLabel(it.label);
  },
});

const modelPicker = makePicker({
  button: $('model-btn'), menu: $('model-menu'), label: $('model-label'),
  getItems: () => MODELS.map((m) => ({ value: m.value, label: m.label, selected: m.value === model })),
  onPick: (it) => {
    model = it.value;
    modelPicker.setLabel(it.label);
    try { localStorage.setItem(MODEL_KEY, model); } catch {}
    say('note', `model: ${it.label}`);
  },
});

async function refresh() {
  let s;
  try {
    s = await api('/status');
  } catch (err) {
    $('dot').className = 'dot off';
    $('allow').textContent = '—';
    $('approvals').textContent = '—';
    return;
  }
  browsers = s.extensions || (s.extension?.connected ? [s.extension] : []);
  $('dot').className = `dot ${browsers.length ? 'on' : 'off'}`;
  $('dot').title = browsers.length
    ? `bridge connected — ${browsers.length} browser${browsers.length > 1 ? 's' : ''}`
    : 'no browser connected to the bridge';

  const ids = browsers.map((b) => b.device_id);
  if (!ids.includes(device)) device = ids[0] || '';
  const current = browsers.find((b) => b.device_id === device);
  pickPicker.setLabel(current
    ? (current.profile || current.display_name || `${String(current.device_id).slice(0, 8)}…`)
    : 'no browser');

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

// ---------------------------------------------------------------------- chat

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
      body: JSON.stringify({ message, session_id: sessionId, device_id: device || undefined, model: model || undefined }),
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

// ------------------------------------------------------------------- wiring

let saved = '';
try { saved = localStorage.getItem(MODEL_KEY) || ''; } catch {}
const initial = MODELS.find((m) => m.value === saved) || MODELS[0];
model = initial.value;
modelPicker.setLabel(initial.label);

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
