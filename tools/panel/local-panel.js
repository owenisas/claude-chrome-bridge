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
  const n = el('div', `msg ${cls}`, text);
  log.appendChild(n);
  log.scrollTop = log.scrollHeight;
  return n;
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
    $('pick').replaceChildren(el('option', null, 'bridge unreachable'));
    $('allow').textContent = '—';
    $('approvals').textContent = '—';
    return;
  }
  const list = s.extensions || (s.extension?.connected ? [s.extension] : []);
  $('dot').className = `dot ${list.length ? 'on' : 'off'}`;

  // One entry per connected browser. Several are common (a daily profile plus a
  // test one), and the bridge cannot guess, so the panel asks.
  const keep = $('pick').value;
  $('pick').replaceChildren(...(list.length ? list.map((b) => {
    const o = el('option', null, b.profile || b.display_name || `${String(b.device_id).slice(0, 8)}…`);
    o.value = b.device_id;
    return o;
  }) : [el('option', null, 'no browser connected')]));
  const ids = list.map((b) => b.device_id);
  $('pick').value = ids.includes(keep) ? keep : (ids[0] || '');

  const domainList = s.allow?.allowAll ? ['all hosts (allowAll)'] : (s.allow?.domains || []);
  $('allow').replaceChildren(...(domainList.length
    ? domainList.map((d) => el('span', 'chip', d))
    : [el('span', null, 'nothing — every host is denied until you allow it')]));

  const approvals = s.approvals || [];
  $('approvals').textContent = approvals.length ? `${approvals.length} recent` : 'none';
  renderAsks(approvals);
}

function renderAsks(approvals) {
  for (const a of approvals) {
    const host = a.host || a.url;
    if (!host || document.querySelector(`.ask[data-host="${CSS.escape(host)}"]`)) continue;
    if (document.querySelector(`.chip[data-allowed="${CSS.escape(host)}"]`)) continue;
    if (log.querySelector('.msg.sys')) log.querySelectorAll('.msg.sys').forEach((n) => n.remove());
    const box = el('div', 'ask');
    box.dataset.host = host;
    box.appendChild(el('p', null, `A tool asked to reach ${host}. The allowlist refused it.`));
    const btns = el('div', 'btns');
    const allow = el('button', 'primary', 'Allow this host');
    const deny = el('button', null, 'Keep blocked');
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
  const pending = say('sys working', 'working — the model may drive the browser; a denied host will appear here');

  try {
    const r = await api('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, session_id: sessionId, device_id: $('pick').value || undefined }),
    });
    sessionId = r.session_id || sessionId;
    pending.remove();

    const shown = (r.tools || []).filter((t) => !t.internal);
    if (shown.length) {
      const wrap = el('div', 'tools');
      for (const t of shown) wrap.appendChild(el('span', 'chip', t.name));
      log.appendChild(wrap);
    }

    const text = (r.text || '').trim() || (r.error ? '' : '(no reply)');
    if (text) say('bot', text);
    if (r.error) say('sys', `turn failed: ${r.error}`);

    await refresh();
    // A turn that hit the allowlist leaves a fresh denial; surface it as a prompt.
    if (r.error && /denied|allow/i.test(r.error)) {
      say('sys', 'Grant the host above, then send the message again.');
    }
  } catch (err) {
    pending.remove();
    say('sys', `bridge error: ${err.message}`);
  } finally {
    busy = false;
    $('send').disabled = false;
    input.focus();
  }
}

$('send').addEventListener('click', send);
$('refresh').addEventListener('click', refresh);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});

refresh();
setInterval(refresh, 5000);
