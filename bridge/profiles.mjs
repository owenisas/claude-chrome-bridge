/**
 * Which browser profile a connected extension lives in.
 *
 * The extension sends a display_name only when one was set in its own UI (or
 * handed over by the desktop app's native host), so several profiles with the
 * fork installed show up as bare device ids. It does keep that id in the
 * profile's extension storage (chrome.storage.local, key bridgeDeviceId), so
 * the bridge finds the profile directory whose storage holds the id and reads
 * the profile's name from the browser's Local State. Read-only.
 *
 * macOS keeps a launchd-run process out of other apps' data (EPERM on the
 * Chrome folder), so a bridge run as a LaunchAgent can't do this lookup. The
 * clients (the MCP adapter inside Claude Code, the CLI in a shell) can, so they
 * label browsers and resolve profile names themselves with withProfiles() and
 * resolveDevice().
 *
 * CCB_PROFILE_ROOTS adds user-data directories (':'-separated, optionally
 * "Label=/path").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// the forked build, and the patched build when it keeps the store id
const EXT_IDS = ['ioohpagdjalmcbkcmmbnbdjfokmjaodl', 'fcoeoabgfenejglbffodgkkbkcdhcgfn'];
const RETRY_MISS_MS = 30000;   // a fresh install may not have flushed its storage yet

function roots() {
  const as = path.join(os.homedir(), 'Library', 'Application Support');
  const list = [
    ['Chrome', path.join(as, 'Google', 'Chrome')],
    ['Chrome Beta', path.join(as, 'Google', 'Chrome Beta')],
    ['Chrome Canary', path.join(as, 'Google', 'Chrome Canary')],
    ['Chromium', path.join(as, 'Chromium')],
    ['Edge', path.join(as, 'Microsoft Edge')],
    ['Brave', path.join(as, 'BraveSoftware', 'Brave-Browser')],
    ['Arc', path.join(as, 'Arc', 'User Data')],
    ['launch.mjs browser', path.resolve(HERE, '..', 'tmp', 'ccb-profile')],
  ];
  for (const entry of (process.env.CCB_PROFILE_ROOTS || '').split(':').filter(Boolean)) {
    const [label, dir] = entry.includes('=') ? entry.split('=', 2) : [path.basename(entry), entry];
    list.unshift([label, dir]);
  }
  return list;
}

function profileNames(root) {
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(root, 'Local State'), 'utf8')).profile?.info_cache || {};
    return Object.fromEntries(Object.entries(cache).map(([dir, info]) => [dir, info?.name]));
  } catch {
    return {};
  }
}

function holdsId(dir, needle) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return false; }
  return files.some((f) => /\.(log|ldb)$/.test(f) && (() => {
    try { return fs.readFileSync(path.join(dir, f)).includes(needle); } catch { return false; }
  })());
}

function scan(deviceId) {
  const needle = Buffer.from(deviceId);
  for (const [browser, root] of roots()) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    let names;
    for (const entry of entries) {
      for (const ext of EXT_IDS) {
        if (!holdsId(path.join(root, entry, 'Local Extension Settings', ext), needle)) continue;
        names ??= profileNames(root);
        return { browser, dir: entry, name: names[entry] || entry };
      }
    }
  }
  return null;
}

const cache = new Map();   // device_id -> {profile, at}

export function profileFor(deviceId) {
  if (!deviceId) return null;
  const hit = cache.get(deviceId);
  if (hit && (hit.profile || Date.now() - hit.at < RETRY_MISS_MS)) return hit.profile;
  const profile = scan(String(deviceId));
  cache.set(deviceId, { profile, at: Date.now() });
  return profile;
}

// "parafield.ai", "Profile 32" or "Chrome/parafield.ai" all name the same profile
export function profileMatches(profile, wanted) {
  if (!profile || !wanted) return false;
  const w = String(wanted).toLowerCase();
  return [profile.name, profile.dir, `${profile.browser}/${profile.name}`, `${profile.browser}/${profile.dir}`]
    .some((v) => String(v).toLowerCase() === w);
}

export function profileLabel(profile) {
  return profile ? `${profile.name} (${profile.browser}, ${profile.dir})` : null;
}

// fill in what the bridge couldn't look up (see the header)
export function withProfiles(extensions = []) {
  return extensions.map((e) => {
    const profile = e.profile || profileFor(e.device_id);
    return { ...e, profile, label: e.label || e.display_name || profileLabel(profile) };
  });
}

// A profile name ("parafield.ai") becomes the device_id of the one connected
// browser it names; anything else goes to the bridge unchanged.
export function resolveDevice(extensions, wanted) {
  if (!wanted) return wanted;
  const list = withProfiles(extensions);
  if (list.some((e) => e.device_id === wanted || String(e.device_id).startsWith(wanted))) return wanted;
  const hits = list.filter((e) => profileMatches(e.profile, wanted));
  return hits.length === 1 ? hits[0].device_id : wanted;
}
