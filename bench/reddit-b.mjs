#!/usr/bin/env node
/**
 * Arm B, real-site suite: the patched extension through the bridge on Reddit,
 * in whatever browser the device_id names (normally the operator's own Chrome,
 * signed in). Read-only by design: browse, read, search, scroll, open a post,
 * go back. Nothing here votes, joins, comments, posts or follows.
 *
 *   node bridge/cli.mjs allow reddit.com
 *   CCB_DEVICE=<device_id> node bench/reddit-b.mjs
 *   node bridge/cli.mjs deny reddit.com
 *
 * Writes bench/results/reddit-b-<stamp>.json.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFind } from '../bridge/local-find.mjs';
import { createRun, refOf, expect } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEVICE = process.env.CCB_DEVICE || undefined;
const SUB = process.env.BENCH_REDDIT || 'https://www.reddit.com/r/programming/';

let tab;
let snap = '';
let frame = null;
const { call, js, note, task, target, write } = createRun({ device: DEVICE, getTab: () => tab });

// navigate can return before the new document commits on a real site, so the
// next call may still see the old page: poll a page expression until it holds.
// Never poll location.href: the extension redacts JS results that carry a
// query string ("[BLOCKED: Cookie/query string data]").
async function waitFor(expr, test, what, tries = 12) {
  for (let i = 0; i < tries; i++) {
    const v = await js(expr).catch(() => null);
    if (v !== null && test(v)) return v;
    await call('computer', { action: 'wait', duration: 1, tabId: tab });
  }
  throw new Error(`timed out waiting for ${what}`);
}
const SUB_PATH = new URL(SUB).pathname;
const onSubreddit = () => waitFor(
  '[location.pathname, document.readyState, document.querySelectorAll("shreddit-post").length]',
  ([p, state, n]) => p === SUB_PATH && state === 'complete' && n > 0,
  'the subreddit to finish loading',
);
const postIds = () => js('[...document.querySelectorAll("shreddit-post")].map((p) => p.id)');

async function snapshot() {
  snap = (await call('read_page', { tabId: tab, filter: 'interactive' })).fullText;
  return snap;
}

async function toFrame(cssX, cssY) {
  const vw = await js('window.innerWidth');
  const k = frame ? frame.w / vw : 1;
  return [Math.round(cssX * k), Math.round(cssY * k)];
}

const postCount = () => js('document.querySelectorAll("shreddit-post").length');

const dev = await target();
const started = new Date();
console.log(`arm B / reddit: device ${dev?.device_id} (extension ${dev?.extension_version}), ${SUB}\n`);

await task('R1', 'open a subreddit', 'real-site navigation + gating', async () => {
  const ctx = await call('tabs_context_mcp', { createIfEmpty: true });
  const json = JSON.parse(ctx.fullText.split('\n')[0]);
  tab = json.selectedTabId ?? json.availableTabs?.[0]?.tabId;
  expect(tab, 'no tab');
  const nav = await call('navigate', { url: SUB, tabId: tab });
  expect(nav.ok, `navigate failed: ${nav.error}`);
  await onSubreddit();
  const n = await postCount();
  note(`${n} posts rendered; signed in: ${await js('!!document.querySelector("#expand-user-drawer-button")')}`);
  expect(n > 0, 'no posts rendered');
});

await task('R2', 'get_page_text on a heavy page', 'content extraction', async () => {
  // javascript_tool cuts results at ~1000 characters, so keep page reads small
  const titles = await js('[...document.querySelectorAll("shreddit-post")].slice(0, 10).map((p) => p.getAttribute("post-title") || "")');
  const r = await call('get_page_text', { tabId: tab });
  expect(r.ok, r.error);
  const source = /Source element: (.+)/.exec(r.fullText)?.[1] || '?';
  const found = titles.filter((t) => t && r.fullText.includes(t.slice(0, 30))).length;
  note(`${r.fullText.length} chars from ${source}; ${found} of ${titles.length} rendered post titles in it`);
  expect(found > 0, 'no post title in the extracted text');
  // the extractor prefers the first <article>, which on a feed is one post
  return found >= Math.min(3, titles.length) ? 'pass' : 'degraded';
});

await task('R3', 'read_page interactive on a web-component app', 'snapshot quality on a real site', async () => {
  await snapshot();
  const refs = (snap.match(/\[ref_\d+\]/g) || []).length;
  const postLinks = snap.split('\n').filter((l) => /^\s*link ".+" \[ref_\d+\].*\/comments\//.test(l)).length;
  const search = /search/i.test(snap);
  note(`${refs} refs, ${postLinks} titled post links, search box in snapshot: ${search}`);
  expect(postLinks > 0, 'no post links in the snapshot');
  return search ? 'pass' : 'degraded';
});

await task('R4', 'find "search box"', 'semantic find (expected to diverge)', async () => {
  const r = await call('find', { query: 'search box', tabId: tab });
  if (r.ok) {
    note(r.fullText.split('\n')[0].slice(0, 160));
    return /ref_\d+/.test(r.fullText) ? 'pass' : 'fail';
  }
  expect(/Anthropic client not available/i.test(r.fullText), `find failed: ${r.error}`);
  const hits = localFind(snap, 'search box');
  note(`extension find unavailable; local scorer top hit: ${hits[0]?.line || 'none'}`);
  return /search/i.test(hits[0]?.line || '') ? 'degraded' : 'fail';
});

await task('R5', 'search the site for "rust"', 'typing into a real control', async () => {
  let how;
  const ref = refOf(snap, /search/i);
  if (ref) {
    how = 'ref';
    await call('computer', { action: 'left_click', ref, tabId: tab });
  } else {
    // no ref reaches the box (it lives inside web components): click where it
    // is on screen. The harness measures it with JS; an agent reads it off a
    // screenshot.
    how = 'coordinates';
    const shot = await call('computer', { action: 'screenshot', tabId: tab });
    const dims = /\((\d+)x(\d+)/.exec(shot.text);
    if (dims) frame = { w: +dims[1], h: +dims[2] };
    const c = await js('(() => { const e = document.querySelector("reddit-search-large, faceplate-search-input"); const r = e.getBoundingClientRect(); return [r.x + Math.min(r.width / 2, 120), r.y + r.height / 2]; })()');
    await call('computer', { action: 'left_click', coordinate: await toFrame(c[0], c[1]), tabId: tab });
  }
  await call('computer', { action: 'type', text: 'rust', tabId: tab });
  await call('computer', { action: 'key', text: 'Enter', tabId: tab });
  await waitFor('[location.pathname, new URLSearchParams(location.search).get("q")]',
    ([p, q]) => p.startsWith('/search') && q === 'rust', 'the search results page');
  note(`clicked the search box by ${how}`);
  await call('navigate', { url: SUB, tabId: tab });
  await onSubreddit();
  return how === 'ref' ? 'pass' : 'degraded';
});

await task('R6', 'screenshot of a real page', 'capture', async () => {
  const r = await call('computer', { action: 'screenshot', tabId: tab });
  const dims = /\((\d+)x(\d+)/.exec(r.text);
  if (dims) frame = { w: +dims[1], h: +dims[2] };
  expect(r.images.length && r.images[0].bytes > 5000, 'no image or trivially small');
  note(`${frame?.w}x${frame?.h}, ${r.images[0].bytes} bytes`);
});

await task('R7', 'infinite scroll loads more posts; network capture', 'scroll + network on a real feed', async () => {
  await call('read_console_messages', { tabId: tab, clear: true });
  await call('read_network_requests', { tabId: tab, clear: true });
  // the feed is virtualized (off-screen posts are removed), so count post ids
  // that weren't there before rather than posts on the page
  const before = await postIds();
  const y0 = await js('Math.round(window.scrollY)');
  const mid = await toFrame(...(await js('[window.innerWidth / 2, window.innerHeight / 2]')));
  // scroll until the feed renders posts it didn't have before (or give up)
  let fresh = 0;
  for (let i = 0; i < 8 && !fresh; i++) {
    await call('computer', { action: 'scroll', coordinate: mid, scroll_direction: 'down', scroll_amount: 10, tabId: tab });
    await call('computer', { action: 'wait', duration: 1, tabId: tab });
    fresh = (await postIds()).filter((id) => !before.includes(id)).length;
  }
  const y1 = await js('Math.round(window.scrollY)');
  const net = await call('read_network_requests', { tabId: tab });
  const reqs = (net.fullText.match(/https?:\/\//g) || []).length;
  note(`scrolled ${y0} -> ${y1}px; ${before.length} posts rendered before, ${fresh} new post ids after; ${reqs} request URLs captured`);
  expect(net.ok && reqs > 0, `no network capture: ${net.error || net.text}`);
  expect(y1 > y0, 'the page did not scroll');
  expect(fresh > 0, 'scrolling loaded no new posts');
});

await task('R8', 'read_console_messages on a real page', 'console capture', async () => {
  const r = await call('read_console_messages', { tabId: tab });
  expect(r.ok, r.error);
  note(r.fullText.split('\n')[0].slice(0, 160));
});

await task('R9', 'open the first post by ref', 'ref click on a real link', async () => {
  await js('(window.scrollTo(0, 0), 0)');
  // the first real post whose title link is in the (viewport-limited) snapshot,
  // not a promoted or featured link that also points at /comments/
  const posts = await js('[...document.querySelectorAll("shreddit-post")].slice(0, 5).map((p) => [p.getAttribute("permalink"), p.getAttribute("post-title")])');
  // the interactive snapshot is viewport-only; fall back to the full tree
  const full = (await call('read_page', { tabId: tab, max_chars: 60000 })).fullText;
  let line;
  let permalink;
  let title;
  for ([permalink, title] of posts) {
    line = full.split('\n').find((l) => l.includes(permalink) && l.includes(`"${title}"`));
    if (line) break;
  }
  expect(line, `no post title link among ${posts.length} posts is in the snapshot`);
  const ref = /\[(ref_\d+)\]/.exec(line)[1];
  await call('computer', { action: 'left_click', ref, tabId: tab });
  // client-side routing: the path changes before the post renders
  await waitFor(`[location.pathname, !!document.querySelector('shreddit-post[permalink="${permalink}"]')]`,
    ([p, rendered]) => p === permalink && rendered, 'the post page to render');
  // the click is judged by where it landed; get_page_text is only recorded,
  // because its first-<article> heuristic is scored in R2
  const text = await call('get_page_text', { tabId: tab });
  note(`opened "${title.slice(0, 60)}"; get_page_text ${text.fullText.includes(title.slice(0, 30)) ? 'has' : 'misses'} the title (source ${/Source element: (.+)/.exec(text.fullText)?.[1] || '?'})`);
});

await task('R10', 'navigate "back"', 'history navigation', async () => {
  const r = await call('navigate', { url: 'back', tabId: tab });
  expect(r.ok, r.error);
  await waitFor('location.pathname', (p) => p === SUB_PATH, 'the subreddit after going back');
});

const browser = await js('navigator.userAgent').catch(() => null);
if (tab) await call('tabs_close_mcp', { tabId: tab });
write(path.join(HERE, 'results'), 'reddit-b', {
  arm: 'B',
  suite: 'reddit',
  label: 'patched extension via local bridge (POST /tool), real site, read-only',
  started_at: started.toISOString(),
  device_id: dev?.device_id,
  extension_version: dev?.extension_version,
  browser,
  site: SUB,
});
