#!/usr/bin/env node
/**
 * Launch a Chrome for Testing instance with the patched Claude extension
 * loaded and connected to the local bridge.
 *
 * Why this shape:
 *  - `--load-extension` no longer works in branded Chrome builds (M137+), so
 *    the extension is installed over CDP via `Extensions.loadUnpacked`, which
 *    needs the pipe transport and `--enable-unsafe-extension-debugging`.
 *  - That install is session-only (macOS Secure Preferences rejects a seeded
 *    profile), which is fine: we own this browser process.
 *  - puppeteer's own `installExtension()` destroys the freshly created service
 *    worker target, so we send the CDP command ourselves.
 *
 *   node launch.mjs [--port 9222] [--profile DIR] [--headless] [--keep]
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '../extension-patched');
const API = process.env.CCB_API || 'http://127.0.0.1:8766';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const PROFILE = path.resolve(arg('profile', path.join(__dirname, '../tmp/ccb-profile')));
const PORT = Number(arg('port', 9222));
const HEADLESS = flag('headless');
const KEEP = flag('keep');

function findChrome() {
  const explicit = process.env.CCB_CHROME || arg('chrome', null);
  if (explicit) return explicit;
  const roots = [
    path.join(__dirname, '../tmp/browsers/chrome'),
    path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'),
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name === 'Google Chrome for Testing' && p.includes('MacOS')) return p;
      }
    }
  }
  throw new Error('Chrome for Testing not found. Install with:\n  npx @puppeteer/browsers install chrome@stable --path ./tmp/browsers\nor set CCB_CHROME=/path/to/chrome');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`patched extension missing at ${EXT}`);
  const executablePath = findChrome();
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log(`chrome:  ${executablePath}`);
  console.log(`profile: ${PROFILE}`);

  const browser = await puppeteer.launch({
    executablePath,
    userDataDir: PROFILE,
    enableExtensions: true, // suppresses puppeteer's --disable-extensions
    pipe: true,
    headless: HEADLESS,
    args: [
      // Makes the Extensions CDP domain available. Note: adding an explicit
      // --remote-debugging-port makes Chrome route CDP over TCP and the
      // Extensions domain disappears, so the pipe stays the only transport.
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-component-update',
      '--disable-features=DialMediaRouteProvider',
    ],
    defaultViewport: null,
  });

  // Install over CDP ourselves: puppeteer's installExtension() tears down the
  // service worker target it just created, which kills the bridge connection.
  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT });
  console.log(`extension installed: ${id}`);

  let connected = false;
  for (let i = 0; i < 20; i++) {
    await sleep(750);
    try {
      const st = await (await fetch(`${API}/status`)).json();
      if (st.extension?.connected) { connected = true; console.log(`bridge connected (${st.extension.device_id})`); break; }
    } catch { /* bridge not up yet */ }
  }
  if (!connected) console.warn('warning: extension did not reach the bridge — is bridge/server.mjs running?');

  console.log('browser ready. Ctrl-C to close.');
  const shutdown = async () => { try { await browser.close(); } catch {} process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  browser.on('disconnected', () => { if (!KEEP) process.exit(0); });
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
