#!/usr/bin/env node
/**
 * dsh-safe - an out-of-band safety net for DeepSeek Harness plugin development.
 *
 * The Harness loads every plugin inside the same process that boots it, and the
 * boot layer calls process.exit(1) on any uncaught error. That means a plugin
 * cannot reliably switch itself (or a sibling) off when the app refuses to
 * start: by the time the plugin runs, the process is already the one failing.
 *
 * This tool does the work from outside the process, against the profile files:
 *
 *   snapshot   back up package.json + cordis.patch.yml (+ cordis.yml)
 *   disable    remove a bundle / append a `disabled: true` patch row
 *   enable     undo the above
 *   restore    put a snapshot back
 *   recover    read crash/startup evidence and disable the likely culprit
 *   try        test-boot a COPY of the profile in an isolated DSH_HOME
 *   ui         recovery window: evidence, plugin picker, snapshots, test boot
 *   open       preflight `try`, auto-recover on failure, then launch the app
 *
 * Nothing here imports Harness code, so it keeps working while the app is down.
 *
 * Usage: node dsh-safe.mjs <command> [options]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const VERSION = '0.2.8';

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SAFETY_DIR = path.join(HOME, 'safety');
const SNAPSHOTS_DIR = path.join(SAFETY_DIR, 'snapshots');
const TRIALS_DIR = path.join(SAFETY_DIR, 'trials');
const INCIDENTS_DIR = path.join(SAFETY_DIR, 'incidents');
const STATE_FILE = path.join(SAFETY_DIR, 'state.json');
const LOGS_DIR = path.join(HOME, 'logs');
const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'cordis.yml'];
const CORE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const OPS_FILE = path.join(APPDATA, '@deepseek-ai', 'dsh-desktop', 'plugin-operations', 'operations.jsonl');
const DEFAULT_DESKTOP_EXE = path.join(LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');

const HELP = `dsh-safe ${VERSION} - keep a broken Harness plugin from locking you out

Usage:
  dsh-safe status                  show profile, plugin operations, crash evidence
  dsh-safe snapshot [-l label]     back up package.json + patch layer
  dsh-safe snapshots               list snapshots
  dsh-safe restore [id|latest]     restore a snapshot (the current state is saved first)
  dsh-safe plugins                 list selected bundles and installed-but-not-selected ones
  dsh-safe disable [name...]       disable specific plugin(s); no names = interactive picker
  dsh-safe enable  [name...]       re-enable plugin(s); no names = interactive picker
  dsh-safe try                     test-boot a copy of this profile in an isolated sandbox
  dsh-safe ui                      open the recovery page in its own window (works while the app is down)
  dsh-safe watch                   serve the recovery page and open it when Harness crashes
  dsh-safe watch --install          start the crash watcher hidden at every Windows sign-in
  dsh-safe open                    preflight, auto-fix on failure, then launch the app
  dsh-safe open --ui               preflight, and on failure open the recovery window instead
  dsh-safe recover                 explain what probably broke the last boot
  dsh-safe recover --apply         disable the likely culprit (snapshot taken first)
  dsh-safe recover --pick --apply  choose the culprit(s) yourself from the suspect list

Options:
  --profile <name>   profile name (default: $DSH_PROFILE or "desktop")
  --dry-run          show what a mutating command would do
  --apply            apply the recovery plan
  --pick             with recover: interactively choose which suspects to disable
  --suspect <name>   explicit suspect for recover (repeatable)
  --all              with recover: disable every suspect, not just the newest
  --safe-mode        with recover: keep only dsh-base + dsh-web-app
  --force            allow disabling a core bundle (you probably do not want this)
  --log <file>       use a specific startup log as evidence
  --timeout <sec>    try/open: boot deadline (default 120)
  --grace <sec>      try/open: extra watch time after the web server answers (default 5)
  --port <n>         ui: listen port (default: random free port)
  --browser          ui/open --ui: open a normal browser tab instead of the app window
  --no-browser       ui/open --ui: only serve the page, open nothing
  --install          watch: start hidden at every sign-in (Windows)
  --uninstall        watch: remove the sign-in entry
  --ui               open: on a failed preflight, start the recovery UI instead of auto-fixing
  --keep             keep the trial directory even when the boot succeeds
  --no-fix           open: never modify the profile automatically
  --skip-try         open: launch without the preflight
  --json             status/snapshots/recover: machine-readable output
  --label, -l <s>    snapshot label
  -h, --help         this text

Files:
  snapshots  ${SNAPSHOTS_DIR}
  trials     ${TRIALS_DIR}
  incidents  ${INCIDENTS_DIR}
  state      ${STATE_FILE}
`;

class UsageError extends Error {}

const exists = (p) => {
  try { return fs.existsSync(p); } catch { return false; }
};
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeFileAtomic(file, text) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function copyIfExists(src, dest) {
  if (!exists(src)) return false;
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return true;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function slug(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function humanMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/* -------------------------------------------------------------- interactive */

function interactive() {
  if (process.env.DSH_SAFE_FORCE_TTY === '1') return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function parseSelection(text, count) {
  const value = String(text ?? '').trim().toLowerCase();
  if (!value) return [];
  if (value === 'all' || value === '*') return [...Array(count).keys()];
  if (value === 'none' || value === '0') return [];
  const selected = new Set();
  for (const part of value.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const first = Number(range[1]);
      const second = Number(range[2]);
      const from = Math.min(first, second);
      const to = Math.max(first, second);
      for (let index = from; index <= to; index += 1) {
        if (index >= 1 && index <= count) selected.add(index - 1);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      const index = Number(part);
      if (index >= 1 && index <= count) selected.add(index - 1);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function pickMany(items, { title, render }) {
  if (!items.length) return [];
  line(title);
  items.forEach((item, index) => {
    line(`  ${String(index + 1).padStart(2)}. ${render(item)}`);
  });
  const answer = await ask('select> numbers or ranges (e.g. 1,3 or 2-4), "all", Enter to cancel: ');
  return parseSelection(answer, items.length);
}

function info(message) { process.stdout.write(`[info] ${message}\n`); }
function ok(message) { process.stdout.write(`[ok] ${message}\n`); }
function warn(message) { process.stdout.write(`[warn] ${message}\n`); }
function bad(message) { process.stdout.write(`[fail] ${message}\n`); }
function line(message = '') { process.stdout.write(`${message}\n`); }

/* ------------------------------------------------------------------ profile */

function profileRef(opts) {
  const name = opts.profile || process.env.DSH_PROFILE || 'desktop';
  const dir = path.join(HOME, 'profiles', name);
  const manifestPath = path.join(dir, 'package.json');
  if (!exists(manifestPath)) {
    throw new UsageError(`profile "${name}" was not found (${manifestPath})`);
  }
  return {
    name,
    dir,
    manifestPath,
    patchPath: path.join(dir, 'cordis.patch.yml'),
  };
}

function readManifest(profile) {
  return readJson(profile.manifestPath);
}

function bundlesOf(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) {
    throw new Error(`${profileLabel(manifest)}: package.json has no dsh.profile.bundles array`);
  }
  return bundles;
}

function profileLabel(manifest) {
  return manifest?.name || 'profile';
}

function writeBundles(profile, bundles) {
  const manifest = readManifest(profile);
  if (!manifest.dsh) manifest.dsh = {};
  if (!manifest.dsh.profile) manifest.dsh.profile = {};
  manifest.dsh.profile.bundles = bundles;
  writeJsonAtomic(profile.manifestPath, manifest);
}

function isCore(bundle) {
  return CORE_BUNDLES.includes(bundle);
}

/* ------------------------------------------------------------- state/snapshots */

function readState() {
  try {
    return readJson(STATE_FILE);
  } catch {
    return { version: 1, lastGood: null, lastTrial: null, lastRecover: null };
  }
}

function saveState(state) {
  writeJsonAtomic(STATE_FILE, state);
}

function takeSnapshot(profile, label = null, note = null) {
  const id = stamp() + (label ? `-${slug(label)}` : '');
  const dir = path.join(SNAPSHOTS_DIR, id);
  mkdirp(dir);
  const copied = [];
  for (const file of PROFILE_FILES) {
    if (copyIfExists(path.join(profile.dir, file), path.join(dir, file))) copied.push(file);
  }
  const manifest = readManifest(profile);
  const meta = {
    id,
    at: new Date().toISOString(),
    label: label || null,
    note: note || null,
    profile: profile.name,
    profileDir: profile.dir,
    bundles: bundlesOf(manifest),
    dependencies: Object.keys(manifest.dependencies || {}),
    files: copied,
  };
  writeJsonAtomic(path.join(dir, 'meta.json'), meta);
  return { meta, dir };
}

function listSnapshots() {
  if (!exists(SNAPSHOTS_DIR)) return [];
  const snapshots = [];
  for (const entry of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SNAPSHOTS_DIR, entry.name);
    let meta;
    try {
      meta = readJson(path.join(dir, 'meta.json'));
    } catch {
      meta = { id: entry.name };
    }
    meta.path = dir;
    snapshots.push(meta);
  }
  return snapshots.sort((a, b) => String(b.id).localeCompare(String(a.id)));
}

function findSnapshot(id) {
  const snapshots = listSnapshots();
  if (!snapshots.length) return null;
  if (!id || id === 'latest') return snapshots[0];
  return snapshots.find((s) => s.id === id) || snapshots.find((s) => s.id.startsWith(id)) || null;
}

/* --------------------------------------------------- automatic snapshots */

// Images taken by the automatic policy (bundle or CLI, no user action). They
// share one rolling pool; daily `stable-*` images are deliberately outside it.
const AUTO_LABELS = Object.freeze(['plugin-change', 'dsh-update', 'auto-backup']);
const AUTO_KEEP = 10;

function pruneAutoSnapshots(keep = AUTO_KEEP) {
  const rolling = listSnapshots().filter((snapshot) => AUTO_LABELS.includes(snapshot?.label));
  const removed = [];
  for (const stale of rolling.slice(Math.max(0, keep))) {
    const id = String(stale.id || '');
    // Only ever delete a direct child of the snapshots directory.
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(id)) continue;
    const dir = path.join(SNAPSHOTS_DIR, id);
    if (path.dirname(dir) !== SNAPSHOTS_DIR) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(id);
    } catch {
      /* a locked directory is retried on the next snapshot */
    }
  }
  return removed;
}

function takeAutoSnapshot(profile, label, note, keep = AUTO_KEEP) {
  const { meta, dir } = takeSnapshot(profile, label, note);
  const removed = pruneAutoSnapshots(keep);
  return { meta, dir, removed };
}

function dailyStableLabel(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `stable-${year}-${month}-${day}`;
}

function hasSnapshotLabel(label) {
  return listSnapshots().some((snapshot) => snapshot?.label === label);
}

/* ------------------------------------------------------------------ evidence */

function readOps(file = OPS_FILE) {
  if (!exists(file)) return [];
  const ops = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.operation && row.operation.time) ops.push(row.operation);
    } catch { /* skip a torn line */ }
  }
  return ops.sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

function startupLogs(dir = LOGS_DIR) {
  if (!exists(dir)) return [];
  const logs = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^startup-.*\.log$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      logs.push({ path: file, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size });
    } catch { /* ignore */ }
  }
  return logs.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Pull the useful parts out of an app-boot startup log:
 *   "Failed plugins (1):" -> id, required flag, package, first error
 *   "Plugins waiting for services (8):" -> id + missing service
 */
function parseStartupLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  const result = {
    file,
    mtime: fs.statSync(file).mtimeMs,
    profile: null,
    version: null,
    errorLine: null,
    failed: [],
    waiting: [],
  };
  const profileMatch = text.match(/profile:\s*'([^']+)'/);
  if (profileMatch) result.profile = profileMatch[1];
  const versionMatch = text.match(/dshVersion:\s*'([^']+)'/);
  if (versionMatch) result.version = versionMatch[1];
  const errorMatch = text.match(/error:\s*(StartupError:[^\n]+)/);
  if (errorMatch) result.errorLine = errorMatch[1].trim();

  const lines = text.split(/\r?\n/);
  let inFailed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const current = lines[i];
    if (/Failed plugins \(\d+\):/.test(current)) {
      inFailed = true;
      continue;
    }
    if (inFailed && /Plugins waiting for services/.test(current)) {
      inFailed = false;
      continue;
    }
    if (!inFailed) continue;
    const match = current.match(/^\s{4}(\S+)\s+\((required|optional)\)\s*$/);
    if (!match) continue;
    const failed = { id: match[1], required: match[2] === 'required', pkg: null, error: null };
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j += 1) {
      const pkgMatch = lines[j].match(/^\s{6}Package:\s*(\S+)/);
      const errorOfPlugin = lines[j].match(/^\s{6}Error:\s*(.*)$/);
      if (pkgMatch) {
        failed.pkg = pkgMatch[1];
        i = j;
        continue;
      }
      if (errorOfPlugin) failed.error = errorOfPlugin[1];
      if (/^\s{4}\S+\s+\((required|optional)\)\s*$/.test(lines[j])) break;
    }
    result.failed.push(failed);
  }

  const waitingStart = lines.findIndex((l) => /Plugins waiting for services/.test(l));
  if (waitingStart >= 0) {
    for (let i = waitingStart + 1; i < lines.length; i += 1) {
      if (/^\s*at\s/.test(lines[i])) break;
      const match = lines[i].match(/^\s{4,8}(\S+)\s+(\S+)\s*$/);
      if (!match || match[1] === 'Plugin') continue;
      result.waiting.push({ id: match[1], missing: match[2] });
    }
  }
  return result;
}

function latestStartupLog() {
  return startupLogs()[0] || null;
}

function appRunning() {
  if (process.env.DSH_SAFE_APP_RUNNING === '0') return false;
  if (process.env.DSH_SAFE_APP_RUNNING === '1') return true;
  if (process.platform !== 'win32') return false;
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return /DeepSeek Harness\.exe/i.test(result.stdout || '');
}

/* ------------------------------------------------------------------- commands */

function cmdStatus(opts) {
  const profile = profileRef(opts);
  const manifest = readManifest(profile);
  const bundles = bundlesOf(manifest);
  const state = readState();
  const ops = readOps(opts.ops);
  const log = latestStartupLog();
  const snapshots = listSnapshots();

  if (opts.json) {
    printJson({
      version: VERSION,
      home: HOME,
      profile: profile.name,
      profileDir: profile.dir,
      bundles,
      appRunning: appRunning(),
      state,
      latestStartupLog: log ? parseStartupLog(log.path) : null,
      recentOperations: ops.slice(-12),
      snapshots: snapshots.slice(0, 10),
    });
    return 0;
  }

  line(`dsh-safe ${VERSION}`);
  line(`home:     ${HOME}`);
  line(`profile:  ${profile.name}  (${profile.dir})`);
  line(`app:      ${appRunning() ? 'running' : 'not running'}`);
  line(`bundles:  ${bundles.length}`);
  const linked = bundles.filter((b) => String(manifest.dependencies?.[b] || '').startsWith('link:'));
  if (linked.length) line(`local:    ${linked.join(', ')}`);
  line();

  line('Plugin operations (newest last):');
  const recentOps = ops.slice(-8);
  if (!recentOps.length) line('  none recorded');
  for (const op of recentOps) {
    const target = op.target || '(install)';
    line(`  ${op.time}  ${op.reason}/${op.stage}  ${target}  ${op.enabled === undefined ? '' : op.enabled ? 'enabled' : 'disabled'}  ${op.application || op.phase}`);
  }
  line();

  line('Last failed startup:');
  if (!log) {
    line('  no startup-*.log under $DSH_HOME/logs (that is good news)');
  } else {
    const parsed = parseStartupLog(log.path);
    line(`  ${path.basename(log.path)}  (${new Date(log.mtime).toLocaleString()})`);
    if (parsed.errorLine) line(`  ${parsed.errorLine}`);
    if (parsed.failed.length) {
      for (const failed of parsed.failed) {
        line(`  - ${failed.id}${failed.required ? ' (required)' : ''}${failed.pkg ? `  ${failed.pkg}` : ''}`);
        if (failed.error) line(`      ${failed.error}`);
      }
    } else {
      line('  (log exists but no failed-plugin block was found)');
    }
    line(`  log: ${log.path}`);
  }
  line();

  line('Snapshots:');
  if (!snapshots.length) line('  none yet - run: dsh-safe snapshot');
  for (const snapshot of snapshots.slice(0, 6)) {
    line(`  ${snapshot.id}  ${snapshot.bundles ? `${snapshot.bundles.length} bundles` : ''}  ${snapshot.label || snapshot.note || ''}`);
  }
  if (snapshots.length > 6) line(`  ... ${snapshots.length - 6} older`);
  line();

  line('State:');
  if (state.lastGood) {
    line(`  last known-good: ${state.lastGood.at}  (${state.lastGood.source || 'snapshot'}, ${state.lastGood.bundles?.length ?? '?'} bundles)`);
  } else {
    line('  last known-good: none - run "dsh-safe try" or "dsh-safe snapshot --good"');
  }
  if (state.lastTrial) {
    line(`  last trial:      ${state.lastTrial.ok ? 'healthy' : 'FAILED'}  ${state.lastTrial.at}  ${state.lastTrial.reason || ''}`);
    if (!state.lastTrial.ok && state.lastTrial.log) line(`                  ${state.lastTrial.log}`);
  }
  if (state.lastRecover) {
    line(`  last recovery:   ${state.lastRecover.at}  removed: ${(state.lastRecover.removedBundles || []).join(', ') || '(none)'}`);
  }
  const incidents = exists(INCIDENTS_DIR) ? fs.readdirSync(INCIDENTS_DIR).filter((f) => f.endsWith('.json')) : [];
  if (incidents.length) line(`  incidents:       ${incidents.length} in ${INCIDENTS_DIR}`);
  return 0;
}

function cmdSnapshot(opts) {
  const profile = profileRef(opts);
  const { meta, dir } = takeSnapshot(profile, opts.label || 'manual', 'manual snapshot');
  if (opts.good) {
    const state = readState();
    state.lastGood = {
      at: meta.at,
      source: 'snapshot',
      profile: profile.name,
      snapshot: meta.id,
      bundles: meta.bundles,
    };
    saveState(state);
  }
  ok(`snapshot ${meta.id}  (${dir})`);
  info(`${meta.bundles.length} bundles, files: ${meta.files.join(', ')}`);
  return 0;
}

function cmdSnapshots(opts) {
  const snapshots = listSnapshots();
  if (opts.json) {
    printJson(snapshots);
    return 0;
  }
  if (!snapshots.length) {
    info('no snapshots yet');
    return 0;
  }
  for (const snapshot of snapshots) {
    line(`${snapshot.id}  ${snapshot.bundles ? `${snapshot.bundles.length} bundles` : '?'}  ${snapshot.label || snapshot.note || ''}`);
  }
  return 0;
}

function cmdRestore(opts, id) {
  const profile = profileRef(opts);
  const snapshot = findSnapshot(id);
  if (!snapshot) {
    bad(id ? `no snapshot matches "${id}"` : 'no snapshots exist');
    return 2;
  }
  const files = PROFILE_FILES.filter((f) => exists(path.join(snapshot.path, f)));
  if (!files.length) {
    bad(`snapshot ${snapshot.id} has no profile files`);
    return 2;
  }
  if (opts['dry-run']) {
    info(`would restore ${files.join(', ')} from ${snapshot.id}`);
    return 0;
  }
  const pre = takeSnapshot(profile, 'pre-restore', `restore ${snapshot.id}`);
  for (const file of files) {
    fs.copyFileSync(path.join(snapshot.path, file), path.join(profile.dir, file));
  }
  ok(`restored ${files.join(', ')} from ${snapshot.id}`);
  info(`previous state saved as ${pre.meta.id}`);
  info('Restart the Harness to apply the restored profile.');
  return 0;
}

function patchHasId(file, id) {
  if (!exists(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-\\s*id:\\s*['"]?${escaped}['"]?\\s*$`, 'm').test(text);
}

function appendPatchEntry(profile, id, disabled) {
  const yamlId = /^[A-Za-z0-9_./-]+$/.test(id) ? id : `'${id.replace(/'/g, "''")}'`;
  let text = exists(profile.patchPath) ? fs.readFileSync(profile.patchPath, 'utf8') : '';
  // A freshly initialised patch layer is just "[]". Drop it before appending a list item.
  if (/^\s*\[\]\s*$/m.test(text)) text = text.replace(/^\s*\[\]\s*\n?/m, '');
  if (text.length && !text.endsWith('\n')) text += '\n';
  if (!text.length) text = '# Added by dsh-safe\n';
  text += `- id: ${yamlId}\n  disabled: ${disabled}\n`;
  writeFileAtomic(profile.patchPath, text);
}

function describeBundle(manifest, name) {
  const spec = String(manifest.dependencies?.[name] ?? '');
  if (isCore(name)) return 'core';
  if (spec.startsWith('link:')) return 'local';
  if (name.startsWith('@deepseek-ai/')) return 'official';
  if (!spec) return 'installed';
  return 'third-party';
}

function installedIn(profile, name) {
  return exists(path.join(profile.dir, 'node_modules', ...name.split('/'), 'package.json'));
}

// "Last installed or updated" per package: the newest of the app's install
// operations and the on-disk mtime of node_modules/<name>.
function pluginRecency(profile, manifest, ops = []) {
  const touch = new Map();
  const bump = (name, ms, note) => {
    if (!name || !Number.isFinite(ms)) return;
    const previous = touch.get(name);
    if (!previous || ms > previous.ms) touch.set(name, { ms, note });
  };
  for (const op of ops) {
    if (op.reason !== 'install' || op.phase !== 'settled' || !op.target) continue;
    bump(op.target, Date.parse(op.time), op.version ? `installed v${op.version}` : 'installed');
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try {
      const stat = fs.statSync(path.join(profile.dir, 'node_modules', name));
      bump(name, stat.mtimeMs, 'files updated');
    } catch { /* not installed on disk yet */ }
  }
  return touch;
}

// Core first, then newest install/update first; ties keep the bundle order.
function withRecency(rows, touch) {
  return rows
    .map((row, index) => ({ row, index, hit: touch.get(row.name) ?? null }))
    .sort((a, b) => {
      if (Boolean(a.row.core) !== Boolean(b.row.core)) return a.row.core ? -1 : 1;
      const left = a.hit?.ms ?? 0;
      const right = b.hit?.ms ?? 0;
      if (left !== right) return right - left;
      return a.index - b.index;
    })
    .map(({ row, hit }) => ({
      ...row,
      recency: hit ? { at: new Date(hit.ms).toISOString(), note: hit.note } : null,
    }));
}

function cmdPlugins(opts) {
  const profile = profileRef(opts);
  const manifest = readManifest(profile);
  const bundles = bundlesOf(manifest);
  const touch = pluginRecency(profile, manifest, readOps(opts.ops));
  const selected = withRecency(bundles.map((name) => ({
    name,
    kind: describeBundle(manifest, name),
    core: isCore(name),
  })), touch);
  const available = withRecency(Object.keys(manifest.dependencies ?? {})
    .filter((name) => !bundles.includes(name))
    .filter((name) => Boolean(manifest.dependencies[name]) || installedIn(profile, name))
    .map((name) => ({ name, kind: describeBundle(manifest, name) })), touch);

  if (opts.json) {
    printJson({ profile: profile.name, selected, available });
    return 0;
  }

  line(`profile ${profile.name}: ${bundles.length} selected bundles (newest install first)`);
  selected.forEach((row, index) => {
    const stamp = row.recency ? `  (${new Date(row.recency.at).toLocaleDateString()})` : '';
    line(`  ${String(index + 1).padStart(3)}. ${row.name}  [${row.kind}]${stamp}`);
  });
  if (available.length) {
    line('');
    line('installed but not selected (enable with "dsh-safe enable <name>"):');
    for (const row of available) line(`  - ${row.name}  [${row.kind}]`);
  }
  return 0;
}

async function cmdDisable(opts, names) {
  const profile = profileRef(opts);
  const manifest = readManifest(profile);
  const bundles = bundlesOf(manifest);
  const targets = (names ?? []).slice();

  if (!targets.length) {
    if (!interactive()) {
      throw new UsageError(
        'usage: dsh-safe disable <bundle-or-entry-id> [...more]\n' +
        '       dsh-safe disable            (interactive picker; needs a real terminal)',
      );
    }
    const candidates = bundles.filter((bundle) => !isCore(bundle));
    if (!candidates.length) {
      info('nothing to disable: only core bundles are selected');
      return 0;
    }
    const picked = await pickMany(candidates, {
      title: 'Which plugin(s) do you want to disable?',
      render: (name) => `${name}  [${describeBundle(manifest, name)}]`,
    });
    if (!picked.length) {
      info('nothing selected; profile unchanged');
      return 0;
    }
    targets.push(...picked.map((index) => candidates[index]));
  }

  const bundleTargets = [];
  const entryTargets = [];
  let unknown = false;
  for (const name of targets) {
    if (bundles.includes(name)) {
      bundleTargets.push(name);
    } else if (opts.entry || name.includes(':') || patchHasId(profile.patchPath, name)) {
      entryTargets.push(name);
    } else {
      bad(`"${name}" is neither a selected bundle nor a known patch entry id.`);
      const near = bundles.filter((bundle) => bundle.toLowerCase().includes(name.toLowerCase()));
      if (near.length) info(`Did you mean: ${near.join(', ')}`);
      info('Bundles look like "@scope/package-name"; entry ids look like "include:my-plugin".');
      unknown = true;
    }
  }
  if (unknown) return 2;

  const coreTargets = bundleTargets.filter(isCore);
  if (coreTargets.length && !opts.force) {
    bad(`refusing to disable core bundle(s): ${coreTargets.join(', ')} (pass --force if you really mean it)`);
    return 2;
  }
  if (!bundleTargets.length && !entryTargets.length) {
    info('nothing to disable');
    return 0;
  }

  if (opts['dry-run']) {
    for (const name of bundleTargets) info(`would disable bundle "${name}"`);
    for (const name of entryTargets) info(`would disable patch entry "${name}"`);
    return 0;
  }

  const allTargets = bundleTargets.concat(entryTargets);
  const snapshot = takeSnapshot(profile, `pre-disable-${slug(allTargets.join('-'))}`, `disable ${allTargets.join(', ')}`);
  if (bundleTargets.length) {
    writeBundles(profile, bundles.filter((bundle) => !bundleTargets.includes(bundle)));
  }
  for (const name of entryTargets) appendPatchEntry(profile, name, true);

  for (const name of bundleTargets) ok(`disabled bundle "${name}"`);
  for (const name of entryTargets) ok(`disabled patch entry "${name}"`);
  info(`${allTargets.length} plugin(s) disabled; ${bundles.length - bundleTargets.length} bundles remain selected.`);
  info(`pre-change snapshot: ${snapshot.meta.id}  (undo with "dsh-safe restore ${snapshot.meta.id}")`);
  info('Relaunch the Harness to apply.');
  return 0;
}

async function cmdEnable(opts, names) {
  const profile = profileRef(opts);
  const manifest = readManifest(profile);
  const bundles = bundlesOf(manifest);
  const targets = (names ?? []).slice();

  if (!targets.length) {
    if (!interactive()) {
      throw new UsageError(
        'usage: dsh-safe enable <bundle-or-entry-id> [...more]\n' +
        '       dsh-safe enable             (interactive picker; needs a real terminal)',
      );
    }
    const available = Object.keys(manifest.dependencies ?? {})
      .filter((name) => !bundles.includes(name))
      .filter((name) => Boolean(manifest.dependencies[name]) || installedIn(profile, name));
    if (!available.length) {
      info('nothing to enable: every installed dependency is already selected');
      return 0;
    }
    const picked = await pickMany(available, {
      title: 'Which installed bundle(s) do you want to enable?',
      render: (name) => `${name}  [${describeBundle(manifest, name)}]`,
    });
    if (!picked.length) {
      info('nothing selected; profile unchanged');
      return 0;
    }
    targets.push(...picked.map((index) => available[index]));
  }

  const toAdd = [];
  const entryTargets = [];
  let unknown = false;
  for (const name of targets) {
    if (bundles.includes(name)) {
      info(`bundle "${name}" is already enabled`);
      continue;
    }
    if (manifest.dependencies?.[name] || installedIn(profile, name)) {
      toAdd.push(name);
      continue;
    }
    if (opts.entry || name.includes(':') || patchHasId(profile.patchPath, name)) {
      entryTargets.push(name);
      continue;
    }
    bad(`"${name}" is not a dependency of this profile, so it cannot be selected as a bundle.`);
    info('Install it with the plugin manager first, or use --entry for a patch row id.');
    unknown = true;
  }
  if (unknown) return 2;
  if (!toAdd.length && !entryTargets.length) {
    info('nothing to enable');
    return 0;
  }

  if (opts['dry-run']) {
    for (const name of toAdd) info(`would enable bundle "${name}"`);
    for (const name of entryTargets) info(`would enable patch entry "${name}"`);
    return 0;
  }

  const allTargets = toAdd.concat(entryTargets);
  const snapshot = takeSnapshot(profile, `pre-enable-${slug(allTargets.join('-'))}`, `enable ${allTargets.join(', ')}`);
  if (toAdd.length) writeBundles(profile, [...bundles, ...toAdd.filter((name) => !bundles.includes(name))]);
  for (const name of entryTargets) appendPatchEntry(profile, name, false);

  for (const name of toAdd) ok(`enabled bundle "${name}"`);
  for (const name of entryTargets) ok(`enabled patch entry "${name}"`);
  info(`pre-change snapshot: ${snapshot.meta.id}  (undo with "dsh-safe restore ${snapshot.meta.id}")`);
  info('Relaunch the Harness to apply.');
  return 0;
}

/* -------------------------------------------------------------------- recover */

function planRecover(profile, opts, ctx = {}) {
  const manifest = readManifest(profile);
  const bundles = bundlesOf(manifest);
  const state = readState();
  const ops = readOps(opts.ops);
  const logFile = ctx.logOverride || opts.log || latestStartupLog()?.path || null;
  const parsed = logFile && exists(logFile) ? parseStartupLog(logFile) : null;
  const lastGoodAt = state.lastGood?.at ? Date.parse(state.lastGood.at) : 0;

  const suspects = [];
  const seen = new Set();
  const push = (id, kind, why) => {
    if (!id || seen.has(id)) return;
    if (kind !== 'pkg' && isCore(id)) return;
    seen.add(id);
    suspects.push({ id, kind, why });
  };

  for (const failed of parsed?.failed ?? []) {
    if (failed.pkg && bundles.includes(failed.pkg)) {
      push(failed.pkg, 'bundle', `failed plugin "${failed.id}" (${failed.pkg})`);
    } else if (failed.pkg) {
      push(failed.pkg, 'pkg', `failed plugin "${failed.id}" reports package ${failed.pkg}, which is not a selected bundle`);
    } else {
      push(failed.id, 'entry', `failed plugin "${failed.id}"`);
    }
  }

  const recentOps = ops.filter((op) => {
    if (!(Date.parse(op.time) > lastGoodAt)) return false;
    if (op.phase !== 'settled' || op.application !== 'applied' || op.changed === false) return false;
    if (!(op.reason === 'install' || op.stage === 'enable')) return false;
    return Boolean(op.target);
  });
  for (const op of recentOps.slice().reverse()) {
    if (bundles.includes(op.target)) push(op.target, 'bundle', `installed/enabled at ${op.time}`);
    else if (op.stage === 'enable') push(op.target, 'entry', `entry enabled at ${op.time}`);
  }

  if (Array.isArray(state.lastGood?.bundles)) {
    const known = new Set(state.lastGood.bundles);
    for (const bundle of bundles.slice().reverse()) {
      if (!known.has(bundle)) push(bundle, 'bundle', 'selected after the last known-good boot');
    }
  }

  let chosen = [];
  if (opts.suspect?.length) {
    for (const name of opts.suspect) {
      chosen.push({
        id: name,
        kind: bundles.includes(name) ? 'bundle' : name.includes(':') ? 'entry' : 'bundle',
        why: '--suspect',
      });
    }
  } else if (opts['safe-mode']) {
    chosen = [];
  } else {
    const auto = suspects.filter((s) => s.kind !== 'pkg');
    chosen = opts.all ? auto : auto.slice(0, 1);
  }

  return {
    profile,
    bundles,
    state,
    ops,
    recentOps,
    parsed,
    logFile,
    lastGoodAt,
    suspects,
    chosen,
    safeMode: Boolean(opts['safe-mode']),
  };
}

function planLine(plan) {
  if (plan.safeMode) return `  plan: SAFE MODE - keep only ${CORE_BUNDLES.join(' + ')}`;
  if (plan.chosen.length) return `  plan: disable ${plan.chosen.map((candidate) => candidate.id).join(', ')}`;
  return '  plan: nothing';
}

function printRecoverPlan(plan, opts, { showPlan = true } = {}) {
  const { parsed, logFile, recentOps, suspects, chosen, bundles } = plan;
  line(`[recover] profile ${plan.profile.name}  (${bundles.length} bundles)`);
  if (logFile) {
    line(`  evidence log: ${logFile}`);
    if (parsed?.errorLine) line(`  error: ${parsed.errorLine}`);
    if (parsed?.failed?.length) {
      line('  failed plugins:');
      for (const failed of parsed.failed) {
        line(`    - ${failed.id}${failed.required ? ' (required)' : ''}${failed.pkg ? `  ${failed.pkg}` : ''}`);
        if (failed.error) line(`        ${failed.error}`);
      }
    }
  } else {
    line('  evidence log: none found');
  }
  line(`  last known-good: ${plan.state.lastGood?.at || 'none (using operation history)'}`);
  line(`  recent operations since then: ${recentOps.length}`);
  for (const op of recentOps.slice(-8)) {
    line(`    ${op.time}  ${op.reason}/${op.stage}  ${op.target || '(install)'}`);
  }
  if (!suspects.length) {
    line('  suspects: none identified');
  } else {
    line('  suspects (newest first):');
    suspects.forEach((suspect, index) => {
      line(`    ${index + 1}. ${suspect.id}  [${suspect.kind}]  ${suspect.why}`);
    });
  }
  if (showPlan) {
    line(planLine(plan));
    if (!opts.apply && !opts['dry-run']) {
      line('  dry run by default - re-run with --apply to make this change.');
    }
  }
}

function applyRecover(plan, opts) {
  const { profile, bundles, chosen, safeMode, parsed, logFile, recentOps } = plan;
  let nextBundles = [...bundles];
  const disabledEntries = [];
  const removedBundles = [];

  if (safeMode) {
    nextBundles = bundles.filter((bundle) => CORE_BUNDLES.includes(bundle));
    removedBundles.push(...bundles.filter((bundle) => !CORE_BUNDLES.includes(bundle)));
  } else {
    for (const suspect of chosen) {
      if (suspect.kind === 'bundle') {
        if (isCore(suspect.id)) {
          warn(`refusing to disable core bundle ${suspect.id}`);
          continue;
        }
        if (nextBundles.includes(suspect.id)) {
          nextBundles = nextBundles.filter((bundle) => bundle !== suspect.id);
          removedBundles.push(suspect.id);
        }
      } else if (suspect.kind === 'entry') {
        disabledEntries.push(suspect.id);
      }
    }
  }

  if (!removedBundles.length && !disabledEntries.length) {
    bad('nothing to do: the chosen suspects are not selected bundles or entry ids.');
    return { applied: false };
  }

  const snapshot = takeSnapshot(profile, 'pre-recover', safeMode ? 'safe mode' : `recover ${removedBundles.join(',')}`);
  if (nextBundles.length !== bundles.length) writeBundles(profile, nextBundles);
  for (const id of disabledEntries) appendPatchEntry(profile, id, true);

  const incident = {
    at: new Date().toISOString(),
    kind: safeMode ? 'safe-mode' : 'recover',
    profile: profile.name,
    removedBundles,
    disabledEntries,
    snapshot: snapshot.meta.id,
    evidence: {
      log: logFile,
      error: parsed?.errorLine || null,
      failed: parsed?.failed || [],
      recentOperations: recentOps.slice(-20),
      previousBundles: bundles,
      newBundles: nextBundles,
    },
  };
  const incidentFile = path.join(INCIDENTS_DIR, `${stamp()}.json`);
  writeJsonAtomic(incidentFile, incident);

  const state = readState();
  state.lastRecover = {
    at: incident.at,
    incident: incidentFile,
    removedBundles,
    disabledEntries,
  };
  saveState(state);

  ok('recovery applied');
  if (removedBundles.length) info(`removed bundle(s): ${removedBundles.join(', ')}`);
  if (disabledEntries.length) info(`disabled patch entry/entries: ${disabledEntries.join(', ')}`);
  info(`pre-recovery snapshot: ${snapshot.meta.id}  (restore with "dsh-safe restore ${snapshot.meta.id}")`);
  info(`incident record: ${incidentFile}`);
  info('Relaunch the Harness now. If it still fails, run "dsh-safe recover --safe-mode --apply".');
  return { applied: true, removedBundles, disabledEntries, snapshot: snapshot.meta.id };
}

async function cmdRecover(opts) {
  const profile = profileRef(opts);
  const plan = planRecover(profile, opts);
  let pickedNow = false;

  if (opts.pick && !opts.json) {
    if (!interactive()) {
      bad('--pick needs an interactive terminal');
      return 2;
    }
    const candidates = plan.suspects.filter((suspect) => suspect.kind !== 'pkg');
    if (!candidates.length) {
      bad('no suspects to pick from; try "dsh-safe plugins" and "dsh-safe disable <name>"');
      return 1;
    }
    printRecoverPlan(plan, opts, { showPlan: false });
    const picked = await pickMany(candidates, {
      title: 'Which suspect(s) do you want to disable?',
      render: (suspect) => `${suspect.id}  [${suspect.kind}]  ${suspect.why}`,
    });
    if (!picked.length) {
      info('nothing selected; profile unchanged');
      return 0;
    }
    plan.chosen = picked.map((index) => candidates[index]);
    pickedNow = true;
  }

  if (opts.json) {
    printJson({
      profile: profile.name,
      logFile: plan.logFile,
      parsed: plan.parsed,
      suspects: plan.suspects,
      chosen: plan.chosen,
      safeMode: plan.safeMode,
      lastGood: plan.state.lastGood,
      recentOperations: plan.recentOps,
      apply: Boolean(opts.apply),
    });
    if (!opts.apply) return 0;
  } else if (pickedNow) {
    line(planLine(plan));
    if (!opts.apply && !opts['dry-run']) {
      line('  dry run by default - re-run with --apply to make this change.');
    }
  } else {
    printRecoverPlan(plan, opts);
  }
  if (!opts.apply) {
    return 0;
  }
  if (!plan.chosen.length && !plan.safeMode) {
    bad('no safe suspect to disable; pass --suspect <name>, --pick, or --safe-mode');
    return 1;
  }
  const result = applyRecover(plan, opts);
  return result.applied ? 0 : 1;
}

/* ------------------------------------------------------------------------ try */

function removeTrial(base) {
  const name = path.basename(base);
  const profileDir = path.join(base, 'home', 'profiles', name);
  const junction = path.join(profileDir, 'node_modules');
  if (exists(junction)) {
    try {
      fs.rmdirSync(junction); // removes the junction itself, never the target
    } catch {
      try { fs.unlinkSync(junction); } catch { /* ignore */ }
    }
  }
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch (error) {
    warn(`could not remove trial directory ${base}: ${error.message}`);
  }
}

function pruneTrials(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  if (!exists(TRIALS_DIR)) return;
  const now = Date.now();
  for (const entry of fs.readdirSync(TRIALS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(TRIALS_DIR, entry.name);
    try {
      if (now - fs.statSync(base).mtimeMs > maxAgeMs) removeTrial(base);
    } catch { /* ignore */ }
  }
}

function probe(url) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = http.get(url, { timeout: 2500 }, (response) => {
        response.resume();
        finish(response.statusCode >= 200 && response.statusCode < 500);
      });
      request.on('error', () => finish(false));
      request.on('timeout', () => {
        request.destroy();
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

function makeTrial(profile, opts) {
  pruneTrials();
  const name = `trial-${stamp().replace(/[^0-9A-Za-z-]/g, '')}`;
  const base = path.join(TRIALS_DIR, name);
  const home = path.join(base, 'home');
  const trialProfileDir = path.join(home, 'profiles', name);
  mkdirp(trialProfileDir);

  for (const file of PROFILE_FILES) {
    copyIfExists(path.join(profile.dir, file), path.join(trialProfileDir, file));
  }

  const realModules = path.join(profile.dir, 'node_modules');
  if (exists(realModules)) {
    fs.symlinkSync(path.resolve(realModules), path.join(trialProfileDir, 'node_modules'), 'junction');
  } else {
    warn('profile has no node_modules; the trial boot may fail to resolve bundles');
  }

  return { name, base, home, trialProfileDir };
}

function resolveDsh() {
  const candidates = [];
  if (process.env.DSH_SAFE_DSH) candidates.push(process.env.DSH_SAFE_DSH);
  if (process.platform === 'win32') {
    const found = spawnSync('where.exe', ['dsh'], { encoding: 'utf8', windowsHide: true });
    if (!found.error && found.status === 0) {
      for (const row of String(found.stdout || '').split(/\r?\n/)) {
        const candidate = row.trim();
        if (candidate && /\.(cmd|exe)$/i.test(candidate)) candidates.push(candidate);
      }
    }
    candidates.push(path.join(path.dirname(DEFAULT_DESKTOP_EXE), 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
  } else {
    candidates.push('dsh');
  }
  return candidates.find((candidate) => exists(candidate)) || candidates[0] || 'dsh';
}

async function runTrial(opts, { quiet = false } = {}) {
  const profile = profileRef(opts);
  const timeoutMs = Math.max(10, Number.parseInt(opts.timeout ?? '120', 10) || 120) * 1000;
  const graceMs = Math.max(0, Number.parseFloat(opts.grace ?? '5') || 0) * 1000;
  const trial = makeTrial(profile, opts);
  const cwd = opts.cwd || process.cwd();
  // Absolute path matters: a bare `dsh` makes cmd expand %~dp0 in the shim to
  // nothing, and the shim then resolves DeepSeek Harness.exe against the cwd.
  const dsh = opts.dsh || resolveDsh();
  const startedAt = Date.now();

  if (!quiet) {
    info(`trial ${trial.name}`);
    info(`  profile copy: ${trial.trialProfileDir}`);
    info(`  isolated DSH_HOME: ${trial.home}`);
  }

  const env = {
    ...process.env,
    DSH_HOME: trial.home,
    DSH_PROFILE: trial.name,
    DSH_SAFE_TRIAL: '1',
  };

  // On Windows `dsh` is a .cmd shim. cmd.exe /s /c needs the whole command wrapped
  // in an extra pair of quotes, and Node must pass it verbatim or it re-quotes it.
  const child = process.platform === 'win32'
    ? spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `""${dsh}" --profile ${trial.name} --no-open --port 0"`],
        {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: true,
        },
      )
    : spawn(dsh, ['--profile', trial.name, '--no-open', '--port', '0'], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  const state = {
    child,
    stdout: '',
    stderr: '',
    url: null,
    exit: null,
    startedAt,
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.stdout += chunk;
    if (state.stdout.length > 200_000) state.stdout = state.stdout.slice(-200_000);
    if (!state.url) {
      const match = state.stdout.match(/dsh web:\s+(https?:\/\/\S+)/);
      if (match) state.url = match[1];
    }
  });
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
    if (state.stderr.length > 60_000) state.stderr = state.stderr.slice(-60_000);
  });
  child.on('exit', (code, signal) => {
    state.exit = { code, signal };
  });

  let healthy = false;
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exit) break;
    if (state.url && (await probe(state.url))) {
      healthy = true;
      break;
    }
    await sleep(250);
  }

  let reason = null;
  if (healthy && !state.exit) {
    const graceEnd = Date.now() + graceMs;
    while (Date.now() < graceEnd && !state.exit) await sleep(150);
  }
  if (state.exit) {
    reason = `exited early (code ${state.exit.code ?? 'null'}${state.exit.signal ? `, ${state.exit.signal}` : ''})`;
  } else if (!healthy) {
    reason = `did not become ready within ${timeoutMs / 1000}s`;
  } else if (state.exit) {
    reason = 'exited during the grace period';
  }

  const success = !reason;

  if (!success) {
    killTree(child.pid);
    await sleep(300);
  } else {
    killTree(child.pid);
    await sleep(200);
  }

  const trialLogs = startupLogs(path.join(trial.home, 'logs'));
  const parsed = trialLogs.length ? parseStartupLog(trialLogs[0].path) : null;
  const durationMs = Date.now() - startedAt;

  const result = {
    ok: success,
    profile: profile.name,
    trial: trial.name,
    dir: trial.base,
    url: state.url,
    reason,
    durationMs,
    stderr: state.stderr,
    stdout: state.stdout,
    log: parsed?.file || null,
    failed: parsed?.failed || [],
    parsed,
  };

  const appState = readState();
  appState.lastTrial = {
    at: new Date().toISOString(),
    ok: success,
    profile: profile.name,
    trial: trial.name,
    durationMs,
    reason,
    url: state.url,
    log: result.log,
    dir: trial.base,
  };
  if (success) {
    appState.lastGood = {
      at: new Date().toISOString(),
      source: 'trial',
      profile: profile.name,
      bundles: bundlesOf(readManifest(profile)),
    };
  }
  saveState(appState);

  if (!quiet) {
    if (success) {
      ok(`boot healthy in ${humanMs(durationMs)}  ${state.url || ''}`);
      info('real profile was not modified; the trial copy is disposable');
    } else {
      bad(`trial boot failed: ${reason}`);
      if (result.failed.length) {
        line('  failed plugins:');
        for (const failed of result.failed) {
          line(`    - ${failed.id}${failed.required ? ' (required)' : ''}${failed.pkg ? `  ${failed.pkg}` : ''}`);
          if (failed.error) line(`        ${failed.error}`);
        }
      }
      if (parsed?.errorLine) line(`  error: ${parsed.errorLine}`);
      if (result.log) line(`  startup log: ${result.log}`);
      const stderrTail = state.stderr.trim().split(/\r?\n/).slice(-12).join('\n');
      if (stderrTail) line(`  stderr tail:\n${stderrTail}`);
      line(`  trial kept for inspection: ${trial.base}`);
      line('  the real profile was NOT modified.');
      line('  next: fix the plugin, or disable the suspect:');
      line('        dsh-safe recover            (show the plan)');
      line('        dsh-safe recover --apply    (disable the likely culprit)');
    }
  }

  if (success && !opts.keep) {
    removeTrial(trial.base);
  }
  return result;
}

async function cmdTry(opts) {
  const result = await runTrial(opts);
  return result.ok ? 0 : 1;
}

/* ----------------------------------------------------------------------- open */

function desktopExe() {
  const candidates = [];
  if (process.env.DSH_DESKTOP_EXE) candidates.push(process.env.DSH_DESKTOP_EXE);
  candidates.push(DEFAULT_DESKTOP_EXE);
  if (process.platform === 'win32') {
    const where = spawnSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true });
    if (!where.error && where.status === 0) {
      for (const row of String(where.stdout || '').split(/\r?\n/)) {
        const match = row.trim().match(/^(.*?)[\\/]resources[\\/]/i);
        if (match) candidates.push(path.join(match[1], 'DeepSeek Harness.exe'));
      }
    }
  }
  return candidates.find((candidate) => exists(candidate)) || null;
}

/* ------------------------------------------------------------------------ ui */

function uiState(opts, preflight) {
  const profile = profileRef(opts);
  const manifest = readManifest(profile);
  const bundles = bundlesOf(manifest);
  const dependencies = manifest.dependencies ?? {};
  const touch = pluginRecency(profile, manifest, readOps(opts.ops));
  const selected = withRecency(bundles.map((name) => ({
    name,
    kind: describeBundle(manifest, name),
    core: isCore(name),
  })), touch);
  const available = withRecency(Object.keys(dependencies)
    .filter((name) => !bundles.includes(name))
    .filter((name) => Boolean(dependencies[name]) || installedIn(profile, name))
    .map((name) => ({ name, kind: describeBundle(manifest, name) })), touch);

  let plan;
  try {
    plan = planRecover(profile, opts);
  } catch {
    plan = { parsed: null, logFile: null, suspects: [], ops: [], state: readState() };
  }
  const state = plan.state ?? readState();

  return {
    version: VERSION,
    now: new Date().toISOString(),
    profile: {
      name: profile.name,
      dir: profile.dir,
      bundleCount: bundles.length,
      dependencyCount: Object.keys(dependencies).length,
    },
    appRunning: appRunning(),
    selected,
    available,
    evidence: plan.logFile
      ? {
          file: plan.logFile,
          error: plan.parsed?.errorLine ?? null,
          failed: plan.parsed?.failed ?? [],
          waiting: (plan.parsed?.waiting ?? []).slice(0, 10),
        }
      : null,
    suspects: plan.suspects ?? [],
    snapshots: listSnapshots()
      .slice(0, 25)
      .map((snap) => ({
        id: snap.id,
        at: snap.at ?? null,
        label: snap.label ?? null,
        note: snap.note ?? null,
        bundles: Array.isArray(snap.bundles) ? snap.bundles.length : null,
      })),
    operations: (plan.ops ?? [])
      .slice(-12)
      .map((op) => ({
        time: op.time,
        what: `${op.reason ?? '?'}/${op.stage ?? '?'}`,
        target: op.target || '(install)',
        phase: op.phase ?? null,
      })),
    lastGood: state.lastGood?.at ?? null,
    lastRecovery: state.lastRecover ?? null,
    preflight: preflight
      ? {
          ok: Boolean(preflight.ok),
          reason: preflight.reason ?? null,
          durationMs: preflight.durationMs ?? null,
          failed: preflight.failed ?? [],
          log: preflight.log ?? null,
          stderr: String(preflight.stderr ?? '').split(/\r?\n/).slice(-14).join('\n'),
        }
      : null,
  };
}

// Mutating actions are delegated to this same CLI so the UI cannot drift from
// the code paths that are already tested.
function runSelfCli(opts, argv, timeoutMs) {
  const env = { ...process.env };
  if (opts.profile) env.DSH_PROFILE = opts.profile;
  const result = spawnSync(process.execPath, [process.argv[1], ...argv], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    env,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    output: output || (result.error ? String(result.error.message) : ''),
  };
}

function uiAction(opts, body, ctx) {
  const action = String(body?.action ?? '');
  const names = Array.isArray(body?.names)
    ? body.names.filter((name) => typeof name === 'string' && name.trim()).slice(0, 100)
    : [];
  const mutating = ['disable', 'enable', 'restore', 'safe-mode'].includes(action);

  if (mutating && appRunning()) {
    return {
      ok: false,
      blocked: true,
      output:
        'DeepSeek Harness is running. Quit it first: the app owns package.json at boot, ' +
        'so edits made while it runs can be lost on the next launch.',
    };
  }

  switch (action) {
    case 'snapshot':
      return runSelfCli(opts, ['snapshot', '-l', String(body.label || 'ui')], 60000);
    case 'try':
      return runSelfCli(
        opts,
        ['try', '--timeout', String(opts.timeout ?? '120'), '--grace', String(opts.grace ?? '3')],
        11 * 60 * 1000,
      );
    case 'disable': {
      if (!names.length) return { ok: false, output: 'no plugins selected' };
      const core = names.filter(isCore);
      if (core.length) return { ok: false, output: `refusing to disable core bundle(s): ${core.join(', ')}` };
      return runSelfCli(opts, ['disable', ...names], 120000);
    }
    case 'enable': {
      if (!names.length) return { ok: false, output: 'no plugins selected' };
      return runSelfCli(opts, ['enable', ...names], 120000);
    }
    case 'restore': {
      const id = String(body?.id || 'latest');
      return runSelfCli(opts, ['restore', id], 120000);
    }
    case 'safe-mode':
      return runSelfCli(opts, ['recover', '--safe-mode', '--apply'], 120000);
    case 'launch': {
      if (appRunning()) return { ok: false, output: 'DeepSeek Harness is already running' };
      const exe = desktopExe();
      if (!exe) return { ok: false, output: 'could not find "DeepSeek Harness.exe"' };
      const child = spawn(exe, [], {
        cwd: opts.cwd || process.cwd(),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return { ok: true, output: `launched ${exe}`, shutdown: true };
    }
    case 'shutdown':
      return { ok: true, output: 'stopping the recovery UI', shutdown: true };
    default:
      return { ok: false, output: `unknown action "${action}"` };
  }
}

function sendJson(res, status, value) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
  });
  res.end(payload);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleUiRequest(req, res, ctx) {
  ctx.lastRequest = Date.now();
  const url = new URL(req.url, 'http://127.0.0.1');
  const prefix = `/${ctx.token}`;
  if (!url.pathname.startsWith(prefix)) {
    sendJson(res, 404, { ok: false, output: 'not found' });
    return;
  }
  const route = url.pathname.slice(prefix.length) || '/';

  if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
    let boot = 'null';
    try {
      boot = JSON.stringify(uiState(ctx.opts, ctx.preflight)).replace(/</g, '\\u003c');
    } catch { /* the page retries over /api/state */ }
    sendHtml(res, UI_HTML.replace('__BOOT__', boot));
    return;
  }

  if (req.method === 'GET' && route === '/api/ping') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && route === '/api/state') {
    try {
      sendJson(res, 200, { ok: true, state: uiState(ctx.opts, ctx.preflight) });
    } catch (error) {
      sendJson(res, 500, { ok: false, output: String(error?.message || error) });
    }
    return;
  }

  if (req.method === 'POST' && route === '/api/action') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJson(res, 400, { ok: false, output: 'bad request body' });
      return;
    }
    const result = uiAction(ctx.opts, body, ctx);
    try {
      result.state = uiState(ctx.opts, ctx.preflight);
    } catch { /* state refresh is best effort */ }
    sendJson(res, result.ok === false ? 200 : 200, result);
    if (result.shutdown) {
      setTimeout(() => ctx.server.close(), 900);
    }
    return;
  }

  sendJson(res, 404, { ok: false, output: 'not found' });
}

function openUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* the URL is still printed */ }
}

/* A dedicated profile directory keeps the app window out of the user's normal
 * browser session: no tabs, no history, no session restore, its own icon. */
const UI_WINDOW_DIR = path.join(SAFETY_DIR, 'ui-window');

const APP_BROWSERS = [
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
];

function appBrowser() {
  for (const candidate of APP_BROWSERS) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch { /* try the next one */ }
  }
  return null;
}

/* Opens the recovery page in a chromeless window of the system browser: a
 * normal title bar, a taskbar entry, no address bar and no tab strip. Falls
 * back to a normal browser tab when no Chromium build is installed. */
function openAppWindow(url, { width = 1180, height = 860 } = {}) {
  const browser = appBrowser();
  if (!browser) {
    openUrl(url);
    return false;
  }
  try {
    fs.mkdirSync(UI_WINDOW_DIR, { recursive: true });
    spawn(browser, [
      `--app=${url}`,
      `--user-data-dir=${UI_WINDOW_DIR}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ], {
      detached: true,
      stdio: 'ignore',
      // No windowsHide: Chromium applies STARTUPINFO's hidden flag to its own
      // first window, which would open the app window invisible.
      windowsHide: false,
    }).unref();
    return true;
  } catch {
    openUrl(url);
    return false;
  }
}

async function createUiServer(opts, { preflight = null } = {}) {
  const token = crypto.randomBytes(9).toString('hex');
  const ctx = { token, opts, preflight, server: null, lastRequest: Date.now() };
  const server = http.createServer((req, res) => {
    handleUiRequest(req, res, ctx).catch((error) => {
      try {
        sendJson(res, 500, { ok: false, output: String(error?.message || error) });
      } catch { /* response may be gone */ }
    });
  });
  ctx.server = server;

  const port = Number.parseInt(opts.port ?? '0', 10) || 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const actual = server.address().port;
  return { server, ctx, token, url: `http://127.0.0.1:${actual}/${token}/` };
}

/* openMode: 'window' (its own app window), 'browser' (a normal tab), 'none'. */
async function startUi(opts, { openMode = 'none', preflight = null } = {}) {
  const { server, ctx, url } = await createUiServer(opts, { preflight });
  line('');
  ok(`recovery UI: ${url}`);
  info(`profile ${profileRef(opts).name}   app ${appRunning() ? 'is running' : 'is not running'}`);
  if (preflight) info(`preflight: ${preflight.ok ? 'healthy' : 'failed'} (${preflight.reason || 'unknown reason'})`);
  if (openMode === 'window') {
    if (openAppWindow(url)) info('opened in its own window');
    else warn('no Edge or Chrome found; opened in the default browser');
  } else if (openMode === 'browser') {
    openUrl(url);
  }
  line('Keep this window open while you use the page; Ctrl+C (or the Stop button) ends it.');

  if (openMode === 'window') {
    // The page pings every 20 s. When the window is gone the ping stops, and
    // the server ends itself instead of leaving a hidden process behind.
    const idleMs = Number(process.env.DSH_SAFE_UI_IDLE_MS || 120000);
    const every = Math.max(1000, Math.min(30000, Math.floor(idleMs / 4)));
    const reaper = setInterval(() => {
      if (Date.now() - ctx.lastRequest < idleMs) return;
      clearInterval(reaper);
      warn('the window was closed; stopping the recovery UI');
      server.close();
    }, every);
    reaper.unref();
    server.once('close', () => clearInterval(reaper));
  }

  await new Promise((resolve) => server.once('close', resolve));
  info('recovery UI stopped');
  return 0;
}

/* ------------------------------------------------------------ crash watcher */

const CRASH_DIR = process.env.DSH_SAFE_CRASH_DIR || path.join(APPDATA, '@deepseek-ai', 'dsh-desktop', 'logs');
const WATCH_LOG = path.join(SAFETY_DIR, 'watch.log');
const STARTUP_DIR = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const STARTUP_FILE = path.join(STARTUP_DIR, 'dsh-safe-watch.vbs');

function watchEntries() {
  const entries = [];
  for (const dir of [CRASH_DIR, LOGS_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('crash-') && !name.startsWith('startup-')) continue;
      if (!name.endsWith('.log')) continue;
      entries.push({ name, file: path.join(dir, name) });
    }
  }
  return entries;
}

function failureOf(entry) {
  let text = '';
  try { text = fs.readFileSync(entry.file, 'utf8').slice(0, 20000); } catch { return null; }
  const lines = text.split(/\r?\n/);
  if (entry.name.startsWith('crash-')) {
    const hit = lines.find((row) => /error|fatal|did not activate|failed/i.test(row));
    return { kind: 'crash', line: (hit || lines[0] || '').trim() };
  }
  if (!/startup failed/i.test(text)) return null;
  const hit = lines.find((row) => /StartupError|startup failed/i.test(row));
  return { kind: 'startup', line: (hit || '').trim() };
}

function installWatch() {
  if (process.platform !== 'win32') {
    bad('watch --install is only available on Windows.');
    return 1;
  }
  const script = path.resolve(process.argv[1] || '.');
  const command = `"${process.execPath}" "${script}" watch`;
  const vbs = [
    "' dsh-safe: start the crash watcher hidden at sign-in.",
    "' Delete this file (or run: dsh-safe watch --uninstall) to stop it.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_FILE, vbs, 'utf8');
  ok(`installed: ${STARTUP_FILE}`);
  info('The watcher starts hidden at your next sign-in.');
  info('remove it with: dsh-safe watch --uninstall');
  return 0;
}

function uninstallWatch() {
  try {
    fs.rmSync(STARTUP_FILE, { force: true });
    ok(`removed: ${STARTUP_FILE}`);
    return 0;
  } catch (error) {
    bad(`could not remove ${STARTUP_FILE}: ${error.message}`);
    return 1;
  }
}

async function cmdWatch(opts) {
  if (opts.install) return installWatch();
  if (opts.uninstall) return uninstallWatch();

  const { server, url } = await createUiServer(opts, {});
  ok(`recovery UI: ${url}`);
  info(`profile ${profileRef(opts).name}`);
  info(`watching ${CRASH_DIR}`);
  info(`      and ${LOGS_DIR}`);
  line('Crash logs open the recovery page automatically. Ctrl+C stops the watcher.');
  line('Start it hidden at every sign-in with: dsh-safe watch --install');
  try {
    fs.mkdirSync(SAFETY_DIR, { recursive: true });
    fs.appendFileSync(WATCH_LOG, `${new Date().toISOString()}\tstarted\tpid=${process.pid}\n`);
  } catch { /* the log is optional */ }

  const seen = new Set(watchEntries().map((entry) => entry.file));
  const every = Math.max(1000, Number.parseInt(process.env.DSH_SAFE_WATCH_INTERVAL ?? '3000', 10) || 3000);
  let lastOpen = 0;

  const tick = () => {
    for (const entry of watchEntries()) {
      if (seen.has(entry.file)) continue;
      seen.add(entry.file);
      const failure = failureOf(entry);
      if (!failure) continue;
      const stamp = new Date().toISOString();
      try {
        fs.mkdirSync(SAFETY_DIR, { recursive: true });
        fs.appendFileSync(WATCH_LOG, `${stamp}\t${failure.kind}\t${entry.file}\t${failure.line}\n`);
      } catch { /* the page still opens */ }
      warn(`Harness failure detected (${failure.kind}): ${path.basename(entry.file)}`);
      if (failure.line) line(`  ${failure.line}`);
      const now = Date.now();
      if (process.env.DSH_SAFE_WATCH_OPEN !== '0' && now - lastOpen > 5000) {
        lastOpen = now;
        openAppWindow(url);
        info('opened the recovery page. If Harness is still up, quit it, then disable the plugin.');
      }
    }
  };

  tick();
  const timer = setInterval(tick, every);
  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      try { server.close(); } catch { /* already closed */ }
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', () => {
      clearInterval(timer);
      resolve();
    });
  });
  info('watcher stopped');
  return 0;
}

/* dsh-safe recovery page
 *
 * Do not edit by hand to change behaviour: the design study lives in
 * design/recovery-preview.html and design/README.md. This string is rendered
 * by createUiServer() with the boot-time state substituted into the single
 * placeholder below.
 */
const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Harness recovery</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2064%2064'%3E%20%3Cdefs%3E%20%3ClinearGradient%20id='dsh-safe-blue'%20x1='0'%20y1='0'%20x2='0'%20y2='1'%3E%20%3Cstop%20offset='0'%20stop-color='%232f81f7'/%3E%20%3Cstop%20offset='1'%20stop-color='%230b3d91'/%3E%20%3C/linearGradient%3E%20%3C/defs%3E%20%3Cpath%20fill='%23ffffff'%20stroke='url(%23dsh-safe-blue)'%20stroke-width='4'%20stroke-linejoin='round'%20d='M32%204.5%209.5%2013.2v17.4c0%2014%209.8%2024%2022.5%2027.9%2012.7-3.9%2022.5-13.9%2022.5-27.9V13.2L32%204.5Z'/%3E%20%3Cpath%20d='M21.5%2032.5%2028.5%2039.5%2043%2024.5'%20fill='none'%20stroke='url(%23dsh-safe-blue)'%20stroke-width='5'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%20%3C/svg%3E">

<style>
/* =====================================================================
   dsh-safe recovery page
   One self-contained document: system fonts only, no network, no build.
   ===================================================================== */

:root {
  color-scheme: light;

  /* surfaces -- a paper instrument: white panels on a soft gray page,
     hairlines and one soft shadow do the separating work */
  --bg:        #f4f6f9;
  --panel:     #ffffff;
  --panel-2:   #fafbfc;   /* panel footer bands */
  --well:      #f1f4f8;   /* inset: quotes, log, ids */
  --line:      #e3e7ee;
  --line-2:    #cfd6e1;   /* interactive borders */
  --line-3:    #b2bccb;   /* hover borders */

  /* text -- four rungs, each measured >= 4.5:1 on white and on --well */
  --ink:       #0f1720;   /* 17.9 */
  --ink-2:     #33404f;   /* 10.0 */
  --ink-3:     #55636f;   /*  6.2 */
  --ink-4:     #68737f;   /*  4.9 */

  /* status -- ink on a pale tint, nothing else is coloured */
  --bad:       #c0392b;
  --bad-ink:   #a32b1e;
  --bad-bg:    #fdf0ee;
  --bad-line:  #f2c9c3;
  --warn:      #9a6400;
  --warn-ink:  #7d5200;
  --warn-bg:   #fdf6e7;
  --warn-line: #ecd6a8;
  --good:      #17804f;
  --good-ink:  #106b41;
  --good-bg:   #eef8f2;
  --good-line: #c3e5d2;

  /* the product's own blue, borrowed from icon.svg -- focus + selection only */
  --focus:     #1f6feb;
  --sel:       #1f6feb;

  /* radii: panel / control / chip */
  --r-panel: 8px;
  --r-ctl: 6px;
  --r-chip: 4px;

  --sans: ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --bar-h: 56px;
  --shadow: 0 1px 2px rgba(15, 23, 32, 0.05);
}

* { box-sizing: border-box; scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }

html, body { height: 100%; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 13px/1.5 var(--sans);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* one focus treatment everywhere */
:where(a, button, input, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--r-chip);
}

.mono { font-family: var(--mono); font-variant-ligatures: none; }
.num  { font-variant-numeric: tabular-nums; }
.sr {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.skip {
  position: absolute; left: 12px; top: -40px; z-index: 60;
  padding: 8px 12px; border-radius: var(--r-ctl);
  background: var(--ink); color: var(--bg); font-weight: 600; text-decoration: none;
}
.skip:focus { top: 12px; }

/* ============================================================ header == */

.bar {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; gap: 14px;
  height: var(--bar-h); padding: 0 24px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}

.brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.mark  { width: 21px; height: 21px; color: var(--ink-2); flex: none; }
.brand-name { font-size: 13px; font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; }
.brand-ver  { font-size: 12px; color: var(--ink-4); white-space: nowrap; }

.scope {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px;
  border: 1px solid var(--line); border-radius: var(--r-chip);
  background: var(--panel); color: var(--ink-3);
  font-size: 12px; white-space: nowrap; max-width: 220px;
  overflow: hidden; text-overflow: ellipsis;
}

.app-state {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--ink-3); white-space: nowrap;
}
.app-state i {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ink-4); flex: none;
}
.app-state[data-on="1"] { color: var(--warn-ink); }
.app-state[data-on="1"] i { background: var(--warn); }

.bar-spacer { flex: 1 1 auto; }

.bar-actions { display: flex; align-items: center; gap: 8px; }
.bar-launch { margin-left: 8px; }

/* =========================================================== buttons == */

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 12px;
  border: 1px solid var(--line-2); border-radius: var(--r-ctl);
  background: transparent; color: var(--ink);
  font: 500 13px/1 var(--sans); white-space: nowrap; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease, transform 80ms ease;
}
.btn:hover:not(:disabled) { background: var(--well); border-color: var(--line-3); }
.btn:active:not(:disabled) { background: var(--line); transform: translateY(1px); }
.btn:disabled { color: var(--ink-4); border-color: var(--line); cursor: not-allowed; }

.btn--solid {
  background: var(--ink); border-color: var(--ink); color: #ffffff; font-weight: 600;
}
.btn--solid:hover:not(:disabled) { background: #1d2836; border-color: #1d2836; }
.btn--solid:active:not(:disabled) { background: #2b3746; border-color: #2b3746; }
.btn--solid:disabled {
  background: transparent; border-color: var(--line-2); color: var(--ink-4); font-weight: 500;
}

.btn--xs { height: 26px; padding: 0 9px; font-size: 12px; }

.linkbtn {
  border: 0; background: none;
  /* text sits on the baseline but the hit box stays 28px tall */
  padding: 8px 2px; margin: -8px 0;
  color: var(--ink-3); font: 500 12px/1 var(--sans);
  cursor: pointer; text-decoration: underline; text-decoration-color: var(--line-3);
  text-underline-offset: 3px;
}
.linkbtn:hover { color: var(--ink); text-decoration-color: var(--ink-3); }

/* mobile overflow menu, only shown under 900px */
.menu { display: none; position: relative; }
.menu > summary {
  list-style: none; cursor: pointer;
  display: inline-flex; align-items: center; height: 32px; padding: 0 12px;
  border: 1px solid var(--line-2); border-radius: var(--r-ctl);
  font: 500 13px/1 var(--sans); color: var(--ink);
}
.menu > summary::-webkit-details-marker { display: none; }
.menu[open] > summary { background: var(--well); border-color: var(--line-3); }
.menu-panel {
  position: absolute; right: 0; top: 40px; z-index: 40;
  display: grid; gap: 6px; padding: 8px; min-width: 190px;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--r-panel);
}
.menu-panel .btn { justify-content: flex-start; }

/* ============================================================== main == */

main {
  max-width: 1200px; margin: 0 auto;
  /* --dock-h is measured by JS so the fixed output panel never covers a row */
  padding: 20px 24px calc(var(--dock-h, 46px) + 28px);
}

/* =========================================================== verdict == */

.verdict {
  padding: 22px 24px 20px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
  box-shadow: var(--shadow);
}

.status {
  display: inline-flex; align-items: center; gap: 7px;
  height: 24px; padding: 0 9px; border-radius: var(--r-ctl);
  border: 1px solid var(--tone-line, var(--line));
  background: var(--tone-bg, var(--well));
  color: var(--tone-ink, var(--ink-2));
  font-size: 12px; font-weight: 600; letter-spacing: 0.005em;
}
.status i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }

[data-tone="bad"]  { --tone: var(--bad);  --tone-ink: var(--bad-ink);  --tone-bg: var(--bad-bg);  --tone-line: var(--bad-line); }
[data-tone="warn"] { --tone: var(--warn); --tone-ink: var(--warn-ink); --tone-bg: var(--warn-bg); --tone-line: var(--warn-line); }
[data-tone="good"] { --tone: var(--good); --tone-ink: var(--good-ink); --tone-bg: var(--good-bg); --tone-line: var(--good-line); }
[data-tone="idle"] { --tone: var(--ink-3); --tone-ink: var(--ink-2); --tone-bg: var(--well); --tone-line: var(--line); }

.verdict-top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.verdict-meta {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  font-size: 12px; color: var(--ink-4);
}
.verdict-meta .mono {
  min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.verdict-meta .sep { color: var(--line-3); flex: none; }
.verdict-meta .num { flex: none; }

.verdict-title {
  margin: 12px 0 0;
  font-size: 24px; line-height: 1.22; font-weight: 600; letter-spacing: -0.018em;
  max-width: 40ch; text-wrap: balance;
}
.verdict-title .qid {
  font-family: var(--mono); font-size: 0.86em; font-weight: 500;
  letter-spacing: -0.01em; color: var(--ink); white-space: nowrap;
}

.verdict-lede {
  margin: 8px 0 0; max-width: 62ch;
  font-size: 13.5px; line-height: 1.58; color: var(--ink-2);
}

.verdict-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.verdict-note { font-size: 12px; color: var(--ink-4); }

/* ============================================================= grids == */

.stack { display: grid; gap: 20px; margin-top: 20px; min-width: 0; }

/* ============================================================ panels == */

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
  box-shadow: var(--shadow);
  min-width: 0;
}

.panel-head {
  display: flex; align-items: center; gap: 10px;
  padding: 13px 20px; border-bottom: 1px solid var(--line);
  min-height: 50px;
}
.panel-title { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.005em; }
.panel-count { font-size: 12px; color: var(--ink-3); }
.panel-file {
  margin-left: auto; min-width: 0; max-width: 58%;
  font-size: 11.5px; color: var(--ink-4);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.panel-empty {
  padding: 20px;
  color: var(--ink-3); font-size: 12.5px;
}
.panel-empty strong { color: var(--ink-2); font-weight: 600; }
/* the button belongs under the sentence, never trailing it */
.panel-empty .btn { display: flex; width: max-content; margin-top: 12px; }
/* the ledger and the rail already carry the 20px gutter */
.ledger > .panel-empty, .rlist > .panel-empty,
.ledger > .skl, .rlist > .skl { padding-left: 0; padding-right: 0; }

/* Loading: the final layout, drawn flat. No shimmer, no spinner. */
.skl { display: grid; gap: 10px; padding: 16px 20px 20px; }
.skl-bar { display: block; height: 11px; border-radius: 3px; background: var(--line); }
.skl--rows { display: block; padding: 0; }
.skl-prow {
  display: flex; align-items: center; height: 44px; padding: 0 20px;
  border-bottom: 1px solid var(--line);
}
.skl-prow:last-child { border-bottom: 0; }
.skl-prow .skl-bar { height: 10px; }

/* =================================================== boot evidence ==== */

.ledger {
  display: grid; grid-template-columns: minmax(0, 1.06fr) minmax(0, 1fr);
  padding: 4px 20px 14px;
}
.lcol { min-width: 0; padding-right: 24px; }
.lcol + .lcol { padding-right: 0; padding-left: 24px; border-left: 1px solid var(--line); }

.stage { position: relative; padding: 12px 0 0 26px; }
.stage::before {
  content: ""; position: absolute; left: 5px; top: 0; bottom: -12px; width: 1px;
  background: var(--line);
}
.stage:last-child::before { bottom: auto; height: 20px; }
.stage-dot {
  position: absolute; left: 0; top: 16px;
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--panel); border: 1.5px solid var(--line-3);
}
.stage-dot[data-solid="1"] { border-color: var(--bad); background: var(--bad); }

.stage-label {
  display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px;
  font-size: 12px; font-weight: 600; color: var(--ink-2);
}
.stage-count { color: var(--ink-4); font-weight: 500; }
.stage-note {
  min-width: 0; font-size: 11px; font-weight: 400; color: var(--ink-4);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ledger--one { grid-template-columns: minmax(0, 1fr); }
.ledger--one .lcol { padding-right: 0; }
.ledger--one .lcol + .lcol { padding-left: 0; border-left: 0; margin-top: 4px; }

.quote {
  margin: 0; padding: 8px 11px;
  background: var(--well); border: 1px solid var(--line);
  border-left: 2px solid var(--bad);
  border-radius: 0 var(--r-ctl) var(--r-ctl) 0;
  font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
  color: var(--ink-2);
  overflow-wrap: anywhere;
  cursor: default;
}
.quote--pre { white-space: pre-wrap; }

.frow {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px; align-items: center;
  padding: 7px 0;
}
.frow + .frow { border-top: 1px solid var(--line); }
.frow-id { display: flex; align-items: center; gap: 7px; min-width: 0; }
.frow-id .name {
  font-family: var(--mono); font-size: 12.5px; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.frow-err {
  grid-column: 1 / -1;
  font-family: var(--mono); font-size: 11.5px; line-height: 1.45;
  color: var(--ink-3);
  padding-right: 4px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  overflow-wrap: anywhere;
}
.frow-act { grid-column: 2; grid-row: 1; align-self: center; }

.chip {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border: 1px solid var(--line); border-radius: var(--r-chip);
  background: transparent; color: var(--ink-3);
  font-size: 11px; font-weight: 600; white-space: nowrap;
}
.chip--bad { color: var(--bad-ink); border-color: var(--bad-line); background: var(--bad-bg); }
.chip--mute { color: var(--ink-4); }
.chip--warn { color: var(--warn-ink); border-color: var(--warn-line); background: var(--warn-bg); }

.wrow {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 6px; min-width: 0;
  padding: 3px 0; font-size: 12px; color: var(--ink-3);
}
.wrow .mono { color: var(--ink-2); }

.srow {
  display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 2px 8px;
  align-items: center; padding: 6px 0;
}
.srow + .srow { border-top: 1px solid var(--line); }
.slist { max-height: 300px; overflow: auto; overscroll-behavior: contain; }
.srow-rank { font-family: var(--mono); font-size: 11px; color: var(--ink-4); text-align: right; }
.srow-name {
  font-family: var(--mono); font-size: 12.5px; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.srow-why {
  grid-column: 2; font-size: 11.5px; color: var(--ink-4); line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.srow-act { grid-column: 3; grid-row: 1 / span 2; }

/* ============================================================ plugins == */

.filter {
  position: relative; margin-left: auto; width: 260px; max-width: 46%;
}
.filter svg {
  position: absolute; left: 9px; top: 50%; transform: translateY(-50%);
  width: 13px; height: 13px; color: var(--ink-4); pointer-events: none;
}
.filter input {
  width: 100%; height: 32px; padding: 0 28px 0 28px;
  border: 1px solid var(--line-2); border-radius: var(--r-ctl);
  background: var(--bg); color: var(--ink);
  font: 13px/1 var(--sans);
  transition: border-color 120ms ease, background-color 120ms ease;
}
.filter input::placeholder { color: var(--ink-4); }
.filter input:hover { border-color: var(--line-3); }
.filter input:focus { border-color: var(--focus); outline: none; box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.18); }
.filter input::-webkit-search-cancel-button { display: none; }
.filter-x {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
  width: 24px; height: 24px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-chip); background: none;
  color: var(--ink-3); font-size: 15px; line-height: 1; cursor: pointer;
}
.filter-x:hover { background: var(--well); color: var(--ink); }

/* Whole rows only: one sticky group head (33px) plus eight 44px rows. A round
   400px cut showed a 15px sliver of the ninth row above the footer, which read
   as a rendering fault rather than as "the list continues". */
.plist { max-height: min(62vh, 660px); overflow: auto; overscroll-behavior: contain; }

.pgroup {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 20px 7px;
  background: var(--panel); box-shadow: 0 1px 0 var(--line);
  font-size: 12px; font-weight: 600; color: var(--ink-3);
}
.pgroup span:last-child { font-weight: 400; color: var(--ink-4); }

.prow {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px;
  height: 48px; padding: 0 20px;
  border-bottom: 1px solid var(--line);
  transition: background-color 100ms ease;
}
.prow:last-child { border-bottom: 0; }
.prow:hover { background: var(--well); }
/* keyboard users get the same row cue as the pointer */
.prow:focus-within { background: var(--well); }

/* One switch per row. The knob position carries the state without relying on
   colour, the track darkens when on, and the accessible name says which
   plugin the switch belongs to. */
.sw {
  position: relative; flex: none;
  width: 38px; height: 22px; padding: 0;
  border: 1px solid var(--line-3); border-radius: 999px;
  background: var(--panel); cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.sw::after {
  content: ""; position: absolute; top: 3px; left: 3px;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--ink-4);
  transition: transform 140ms ease, background-color 140ms ease;
}
.sw:hover:not(:disabled) { border-color: var(--ink-3); }
.sw[aria-checked="true"] { background: var(--ink); border-color: var(--ink); }
.sw[aria-checked="true"]::after { transform: translateX(16px); background: #ffffff; }
.sw:disabled { opacity: 0.5; cursor: not-allowed; }

.pmain { display: grid; grid-template-columns: minmax(0, 1fr) 176px; align-items: center; gap: 10px; min-width: 0; }
.pname {
  font-family: var(--mono); font-size: 12.5px; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ptags { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
.pwhen { font-size: 11.5px; color: var(--ink-4); white-space: nowrap; font-variant-numeric: tabular-nums; }
.pact { display: flex; justify-content: flex-end; }

.pfoot {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 20px;
  border-top: 1px solid var(--line);
  background: var(--panel-2);
  border-radius: 0 0 var(--r-panel) var(--r-panel);
}
.foot-note { margin-left: auto; font-size: 11.5px; color: var(--ink-4); text-align: right; }
.foot-note[data-lock="1"] { color: var(--warn-ink); }

/* ============================================================== rail == */

/* every snapshot stays a whole row: the list grows and the page scrolls */
.rlist { padding: 2px 20px 12px; }

/* Slim scrollbars keep the "there is more below" cue without a bright gutter. */
.plist::-webkit-scrollbar, .rlist::-webkit-scrollbar, #log::-webkit-scrollbar { width: 10px; height: 10px; }
.plist::-webkit-scrollbar-thumb, .rlist::-webkit-scrollbar-thumb, #log::-webkit-scrollbar-thumb {
  background: var(--line-2); border: 3px solid transparent; background-clip: content-box; border-radius: 6px;
}
.plist::-webkit-scrollbar-thumb:hover, .rlist::-webkit-scrollbar-thumb:hover, #log::-webkit-scrollbar-thumb:hover { background: var(--line-3); background-clip: content-box; }
.plist::-webkit-scrollbar-track, .rlist::-webkit-scrollbar-track, #log::-webkit-scrollbar-track { background: transparent; }

.rrow {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px;
  align-items: center; padding: 10px 0;
}
.rrow + .rrow { border-top: 1px solid var(--line); }
.rrow-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rrow-label {
  font-size: 12.5px; color: var(--ink); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.rrow-when { margin-left: auto; font-size: 11.5px; color: var(--ink-4); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rrow-sub {
  grid-column: 1; display: flex; align-items: center; gap: 6px; min-width: 0;
  font-family: var(--mono); font-size: 11px; color: var(--ink-4);
  white-space: nowrap;
}
.rrow-sub .trunc { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rrow-sub span:last-child { flex: none; }
.rrow-act { grid-column: 2; grid-row: 1 / span 2; }

.rail-note {
  padding: 10px 20px 13px; border-top: 1px solid var(--line);
  font-size: 11.5px; color: var(--ink-4);
}
.rail-note[data-lock="1"] { color: var(--warn-ink); }

.kv {
  display: flex; align-items: center; gap: 6px;
  padding: 9px 20px; border-bottom: 1px solid var(--line);
  font-size: 12px; color: var(--ink-3);
}
.kv b { color: var(--ink-2); font-weight: 500; }
.kv .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-4); }
.kv[data-tone="good"] .dot { background: var(--good); }

/* ============================================================== dock == */

.dock {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 25;
  background: var(--panel-2);
  border-top: 1px solid var(--line-2);
}
.dock-bar {
  display: flex; align-items: center; gap: 10px;
  height: 44px; padding: 0 20px;
  max-width: 1200px; margin: 0 auto;
}
.dock-toggle {
  display: inline-flex; align-items: center; gap: 8px;
  height: 30px; padding: 0 8px 0 4px; margin-left: -4px;
  border: 0; border-radius: var(--r-ctl); background: none;
  color: var(--ink-2); font: 600 12.5px/1 var(--sans); cursor: pointer;
}
.dock-toggle:hover { background: var(--well); color: var(--ink); }
.dock-toggle svg { width: 13px; height: 13px; color: var(--ink-4); transition: transform 160ms ease; }
.dock[data-open="1"] .dock-toggle svg { transform: rotate(180deg); }
.dock-state {
  font-size: 11.5px; color: var(--ink-4); font-weight: 500;
}
.dock-state[data-tone="busy"] { color: var(--warn-ink); }
.dock-state[data-tone="bad"]  { color: var(--bad-ink); }
.dock-state[data-tone="err"]  { color: var(--bad-ink); }
.dock-state[data-tone="good"] { color: var(--good-ink); }
.dock-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.dock-hint { font-size: 11.5px; color: var(--ink-4); }

#log {
  display: none; margin: 0; padding: 12px 20px 14px;
  max-height: 220px; overflow: auto; max-width: 1200px; margin-inline: auto;
  border-top: 1px solid var(--line);
  background: var(--well);
  font: 12px/1.55 var(--mono); color: var(--ink-2);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.dock[data-open="1"] #log { display: block; }

.progress { position: absolute; left: 0; right: 0; top: -1px; height: 1px; overflow: hidden; }
.progress i {
  position: absolute; inset: 0 auto 0 0; width: 30%;
  background: var(--warn);
  animation: sweep 1.15s ease-in-out infinite;
}
@keyframes sweep {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}
.progress[hidden] { display: none; }

/* ========================================================== feedback == */

body[data-busy="1"] [data-act]:not(.dock-toggle) { pointer-events: none; opacity: 0.6; }
body[data-busy="1"] .sw { pointer-events: none; }

.net {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 16px; padding: 10px 14px;
  border: 1px solid var(--bad-line); border-radius: var(--r-ctl);
  background: var(--bad-bg); color: var(--bad-ink); font-size: 12.5px;
}
.net[hidden] { display: none; }

.sk { display: block; height: 11px; border-radius: 3px; background: var(--line); }
.sk--title { height: 22px; width: 44%; }
.sk--lede  { width: 64%; margin-top: 10px; }
.sk--row   { height: 12px; width: 100%; }

/* ======================================================== responsive == */

@media (max-width: 900px) {
  .bar { padding: 0 16px; gap: 10px; }
  .bar-actions { display: none; }
  .menu { display: block; }
  .scope { display: none; }
  main { padding: 16px 16px calc(var(--dock-h, 46px) + 28px); }
}

@media (max-width: 880px) {
  .ledger { grid-template-columns: minmax(0, 1fr); }
  .lcol { padding-right: 0; }
  .lcol + .lcol { padding-left: 0; border-left: 0; padding-top: 4px; }
  /* stacked columns lose the vertical rule, so stages get a hairline instead */
  .lcol + .lcol > .stage:first-child { border-top: 1px solid var(--line); padding-top: 12px; }
  .lcol > .stage + .stage { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
}

@media (max-width: 720px) {
  .verdict { padding: 18px 16px 16px; }
  .verdict-title { font-size: 20px; }
  .panel-head { padding: 12px 16px; }
  .ledger { padding: 4px 16px 14px; }
  .prow { padding: 0 16px; }
  .pgroup { padding-left: 16px; padding-right: 16px; }
  .pfoot { padding: 12px 16px; flex-wrap: wrap; }
  .rlist { padding: 2px 16px 12px; }
  .rel-note { padding-inline: 16px; }
  .dock-bar { padding: 0 16px; }
  #log { padding: 12px 16px 14px; }
}

@media (max-width: 640px) {
  .bar { height: 52px; }
  .brand-ver { display: none; }
  /* the verdict card carries the primary action; the header keeps the menu */
  .bar-launch { display: none; }
  /* counts first, evidence file on its own line instead of a 5ch stub */
  .verdict-meta { flex-wrap: wrap; row-gap: 3px; }
  .verdict-meta .sep { display: none; }
  .verdict-meta .mono { order: 2; flex: 1 0 100%; }
  .filter { width: 100%; max-width: none; margin: 8px 0 0; }
  .panel-head { flex-wrap: wrap; }
  .panel-file { display: none; }
  .prow {
    grid-template-columns: minmax(0, 1fr) auto;
    height: auto; min-height: 56px; padding: 8px 16px; gap: 10px;
  }
  .pmain { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
  .ptags { justify-content: flex-start; }
  .pact { align-self: center; }
  .frow { grid-template-columns: minmax(0, 1fr); }
  .frow-act { grid-row: auto; grid-column: 1; justify-self: start; margin-top: 4px; }
  .srow { grid-template-columns: 16px minmax(0, 1fr) auto; }
  .foot-note { margin-left: 0; text-align: left; width: 100%; }
}

@media (max-width: 420px) {
  .verdict-title { font-size: 20px; }
  .brand-name { font-size: 12.5px; }
}

/* Touch: the visual box stays dense, the target grows to 40px. */
@media (pointer: coarse) {
  .btn, .btn--xs { height: 40px; min-width: 40px; }
  .btn--xs { padding: 0 12px; }
  .sw { width: 42px; height: 26px; }
  .sw::after { width: 18px; height: 18px; }
  .sw[aria-checked="true"]::after { transform: translateX(16px); }
  .dock-toggle { min-height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
  .progress i { width: 100%; background: var(--line-3); }
}
</style>
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<header class="bar">
  <div class="brand">
    <svg class="mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.9 4.6 5.8v5.9c0 4.6 3 7.9 7.4 9.4 4.4-1.5 7.4-4.8 7.4-9.4V5.8L12 2.9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="m8.7 12 2.4 2.4 4.3-4.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="brand-name">Harness recovery</span>
    <span class="brand-ver mono" id="brand-ver">dsh-safe</span>
  </div>

  <span class="scope" id="scope">profile desktop</span>
  <span class="app-state" id="app-state" title=""><i></i><span>checking…</span></span>
  <span class="bar-spacer"></span>

  <div class="bar-actions">
    <button class="btn" type="button" data-act="refresh">Refresh</button>
    <button class="btn" type="button" data-act="snapshot">Snapshot now</button>
    <button class="btn" type="button" data-act="try">Test boot</button>
  </div>

  <button class="btn bar-launch" type="button" data-act="launch">Launch Harness</button>

  <details class="menu">
    <summary>Actions</summary>
    <div class="menu-panel">
      <button class="btn" type="button" data-act="refresh">Refresh</button>
      <button class="btn" type="button" data-act="snapshot">Snapshot now</button>
      <button class="btn" type="button" data-act="try">Test boot</button>
      <button class="btn" type="button" data-act="launch">Launch Harness</button>
    </div>
  </details>
</header>

<main id="main">

  <div class="net" id="net-error" hidden>
    <span id="net-text">Could not read the profile.</span>
    <button class="btn btn--xs" type="button" data-act="refresh" style="margin-left:auto">Retry</button>
  </div>

  <section class="verdict" id="verdict" data-tone="idle" aria-labelledby="verdict-title"></section>

  <div class="stack">

    <section class="panel" aria-labelledby="ev-title">
      <div class="panel-head">
        <h2 class="panel-title" id="ev-title">Boot evidence</h2>
        <span class="panel-file mono" id="ev-file"></span>
      </div>
      <div id="evidence-body"></div>
    </section>

    <section class="panel" aria-labelledby="pl-title">
      <div class="panel-head">
        <h2 class="panel-title" id="pl-title">Plugins</h2>
        <span class="panel-count" id="pl-count">loading…</span>
        <div class="filter">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.1" stroke="currentColor" stroke-width="1.4"/>
            <path d="M10.2 10.2 14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <input id="filter" type="search" autocomplete="off" spellcheck="false"
                 placeholder="Filter plugins" aria-label="Filter plugins by name">
          <button class="filter-x" id="filter-x" type="button" data-act="clear-filter"
                  aria-label="Clear the filter" hidden>&#215;</button>
        </div>
      </div>
      <div class="plist" id="plist"></div>
      <div class="pfoot">
        <button class="linkbtn" type="button" data-act="safe-mode" title="Keep only the two core bundles and remove every other bundle from the profile">Safe mode&hellip;</button>
        <span class="foot-note" id="pl-note">A snapshot is taken before every change.</span>
      </div>
    </section>

    <section class="panel" aria-labelledby="snap-title">
      <div class="panel-head">
        <h2 class="panel-title" id="snap-title">Recovery points</h2>
        <span class="panel-count" id="snap-count"></span>
      </div>
      <div class="kv" id="snap-good"><span class="dot"></span><span>last known-good boot</span></div>
      <div class="rlist" id="snapshots"></div>
      <div class="rail-note" id="snap-note">Restore also snapshots the current state first.</div>
    </section>

    <section class="panel" aria-labelledby="act-title">
      <div class="panel-head">
        <h2 class="panel-title" id="act-title">Recent changes</h2>
        <span class="panel-count" id="act-count"></span>
      </div>
      <div class="rlist" id="activity"></div>
    </section>

  </div>
</main>

<div class="dock" id="dock" data-open="0" data-busy="0">
  <div class="progress" id="progress" hidden><i></i></div>
  <div class="dock-bar">
    <button class="dock-toggle" type="button" id="dock-toggle" data-act="dock-toggle"
            aria-expanded="false" aria-controls="log">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M4 6.5 8 10.5 12 6.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Output</span>
    </button>
    <span class="dock-state" id="dock-state" data-tone="idle">ready</span>
    <div class="dock-right">
      <span class="dock-hint" id="dock-hint"></span>
      <button class="btn btn--xs" type="button" data-act="shutdown">Stop this UI</button>
    </div>
  </div>
  <pre id="log" role="log" aria-live="polite" tabindex="0">Ready. Nothing has been changed yet.</pre>
</div>

<noscript>
  <div class="panel" style="margin:20px 24px">
    <div class="panel-head"><h2 class="panel-title">JavaScript is off</h2></div>
    <div class="panel-empty">This page reads the profile through a local API and needs JavaScript.
      The CLI still works: <span class="mono">dsh-safe status</span>.</div>
  </div>
</noscript>

<script>
window.__BOOT_STATE__ = __BOOT__;
(function () {
  'use strict';

  var state = window.__BOOT_STATE__ || null;
  var busy = false;
  var query = '';
  var dockOpen = false;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function add(parent) {
    for (var i = 1; i < arguments.length; i += 1) {
      if (arguments[i]) parent.appendChild(arguments[i]);
    }
    return parent;
  }

  /* ------------------------------------------------------------- time -- */

  function relTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var diff = Date.now() - t;
    if (diff < 0) diff = 0;
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' h ago';
    var day = Math.floor(hr / 24);
    if (day === 1) return 'yesterday';
    if (day < 7) return day + ' days ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function absTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!isFinite(t)) return String(iso);
    return new Date(t).toLocaleString();
  }

  function shortPath(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || String(p);
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : (many || one + 's'));
  }

  /* server copy, shortened for a 200px column. Each branch matches an exact
     prefix the daemon writes; anything unrecognised is shown verbatim, and the
     full string always stays in the row title. */
  function whyText(id, why) {
    var text = String(why || '');
    var failed = 'failed plugin "' + id + '"';
    if (text.indexOf(failed) === 0) return 'failed at startup';
    var at = 'installed/enabled at ';
    if (text.indexOf(at) === 0) {
      var when = relTime(text.slice(at.length).trim());
      if (when) return 'installed ' + when;
    }
    if (text === '--suspect') return 'named on the command line';
    return text;
  }

  /* --------------------------------------------------------- elements -- */

  function chip(text, mod) {
    return el('span', 'chip' + (mod ? ' ' + mod : ''), text);
  }

  function idNode(text, cls) {
    return el('span', cls || 'mono', text);
  }

  function actionBtn(label, act, data, mod, disabled, title) {
    var b = el('button', 'btn btn--xs' + (mod ? ' ' + mod : ''), label);
    b.type = 'button';
    b.setAttribute('data-act', act);
    if (data) {
      Object.keys(data).forEach(function (k) { b.setAttribute('data-' + k, data[k]); });
    }
    if (disabled) b.disabled = true;
    if (title) b.title = title;
    return b;
  }

  /* ----------------------------------------------------------- header -- */

  function renderHead() {
    var s = state;
    if (!s) return;
    $('brand-ver').textContent = 'dsh-safe ' + s.version;
    $('scope').textContent = 'profile ' + s.profile.name;
    $('scope').title = s.profile.dir;
    var node = $('app-state');
    node.setAttribute('data-on', s.appRunning ? '1' : '0');
    node.title = s.appRunning
      ? 'DeepSeek Harness holds the profile, so changes are locked until it quits.'
      : 'No DeepSeek Harness process was found.';
    node.lastChild.textContent = s.appRunning ? 'Harness running' : 'app not running';
  }

  /* ---------------------------------------------------------- verdict -- */

  function entryOf(name) {
    if (!state || !state.selected) return null;
    for (var i = 0; i < state.selected.length; i += 1) {
      if (state.selected[i].name === name) return state.selected[i];
    }
    return null;
  }

  function skeleton(host, count, rows) {
    var wrap = el('div', rows ? 'skl skl--rows' : 'skl');
    var widths = [58, 34, 76, 46, 66];
    for (var i = 0; i < count; i += 1) {
      var bar = el('span', 'skl-bar');
      bar.style.width = widths[i % widths.length] + '%';
      if (rows) {
        var line = el('div', 'skl-prow');
        add(line, bar);
        add(wrap, line);
      } else {
        add(wrap, bar);
      }
    }
    host.appendChild(wrap);
  }

  function canDisable(name) {
    var entry = entryOf(name);
    return Boolean(entry) && entry.core !== true;
  }

  function failTarget() {
    if (!state || !state.evidence) return null;
    var rows = state.evidence.failed || [];
    var i;
    for (i = 0; i < rows.length; i += 1) {
      if (rows[i].pkg && canDisable(rows[i].pkg)) return rows[i].pkg;
    }
    for (i = 0; i < rows.length; i += 1) {
      if (canDisable(rows[i].id)) return rows[i].id;
    }
    return null;
  }

  function verdictTitle(prefix, id, suffix) {
    var h = el('h1', 'verdict-title');
    h.id = 'verdict-title';
    if (prefix) h.appendChild(document.createTextNode(prefix));
    if (id) h.appendChild(el('span', 'qid', id));
    if (suffix) h.appendChild(document.createTextNode(suffix));
    return h;
  }

  function primaryBtn(label, act, data) {
    var b = actionBtn(label, act, data, 'btn--solid', false, '');
    return b;
  }

  function renderVerdict() {
    var host = $('verdict');
    clear(host);
    var s = state;

    if (!s) {
      host.setAttribute('data-tone', 'idle');
      var top = el('div', 'verdict-top');
      add(top, el('span', 'status', 'Reading the profile'));
      add(host, top);
      add(host, el('h1', 'verdict-title', 'Loading the profile…'));
      var l = el('p', 'verdict-lede');
      l.appendChild(el('span', 'sk sk--lede'));
      add(host, l);
      return;
    }

    var ev = s.evidence || null;
    var failed = (ev && ev.failed) || [];
    var waiting = (ev && ev.waiting) || [];
    var suspects = s.suspects || [];
    var pf = s.preflight;
    var target = failTarget();
    var locked = s.appRunning;
    var tone = 'good';
    var statusText = 'No startup failure';
    var title = null;
    var lede = '';
    var actions = el('div', 'verdict-actions');
    var note = '';

    if (pf && pf.ok === false) {
      tone = 'bad';
      statusText = 'Test boot failed';
      title = verdictTitle('The test boot never got to the window.', null, null);
      lede = 'It stopped: ' + (pf.reason || 'no reason was reported') + '. '
        + (pf.durationMs ? 'The trial copy ran for ' + Math.round(pf.durationMs / 1000) + ' s and was thrown away, so your profile is untouched.' : 'Your profile is untouched; the test ran on a copy.');
      if (target) {
        add(actions, primaryBtn('Disable ' + target, 'disable-one', { name: target }));
      } else {
        add(actions, primaryBtn('Test the boot again', 'try'));
      }
    } else if (ev && (failed.length || ev.error)) {
      tone = 'bad';
      statusText = 'Startup failed';
      var name = target || (failed[0] && (failed[0].pkg || failed[0].id)) || null;
      if (name) {
        title = verdictTitle('Startup failed: ', name, ' did not load.');
      } else {
        title = verdictTitle('The last boot failed.', null, null);
      }
      var bits = [];
      if (failed.length) bits.push(plural(failed.length, 'plugin') + ' failed to load');
      if (waiting.length) bits.push(plural(waiting.length, 'other') + ' never got the service it was waiting for');
      lede = (bits.length ? bits.join('; ') + '. ' : '') + 'Nothing in your profile has been changed yet.';
      if (locked) lede += ' The Harness is still running, so changes stay locked until it quits.';

      if (target) {
        add(actions, primaryBtn('Disable ' + target, 'disable-one', { name: target }));
        if (locked) actions.lastChild.disabled = true;
        add(actions, actionBtn('Test boot', 'try'));
      } else if (failed.length) {
        add(actions, primaryBtn('Reset to safe mode…', 'safe-mode'));
        if (locked) actions.lastChild.disabled = true;
      } else {
        add(actions, primaryBtn('Restore the latest snapshot', 'restore-latest'));
        if (locked) actions.lastChild.disabled = true;
      }
      note = locked ? 'Locked: quit DeepSeek Harness first.' : 'A snapshot is taken before anything changes.';
    } else if (locked) {
      tone = 'warn';
      statusText = 'Harness running';
      title = verdictTitle('DeepSeek Harness is open.', null, null);
      lede = 'Plugin changes stay locked while it runs: the app owns package.json at boot, so edits made now can be lost on the next launch. '
        + 'This page re-checks every 3 seconds and unlocks by itself when the Harness quits.';
      add(actions, primaryBtn('Test boot', 'try'));
    } else if (!ev) {
      tone = 'idle';
      statusText = 'No startup log';
      title = verdictTitle('There is no startup log to read.', null, null);
      lede = 'dsh-safe reads the newest startup log under your DSH home. Until one is written there is nothing to blame — '
        + 'take a snapshot before your next change, or launch the Harness and see.';
      add(actions, primaryBtn('Launch Harness', 'launch'));
      add(actions, actionBtn('Snapshot now', 'snapshot'));
    } else {
      tone = 'good';
      statusText = 'Booted cleanly';
      title = verdictTitle('The last boot was clean.', null, null);
      lede = 'No plugin failed to load and nothing is waiting for a service. '
        + 'Take a snapshot before your next change, or launch the Harness.';
      add(actions, primaryBtn('Launch Harness', 'launch'));
      add(actions, actionBtn('Test boot', 'try'));
    }

    host.setAttribute('data-tone', tone);

    var top = el('div', 'verdict-top');
    var badge = el('span', 'status');
    badge.setAttribute('data-tone', tone);
    badge.appendChild(el('i'));
    badge.appendChild(document.createTextNode(statusText));
    add(top, badge);

    if (ev) {
      var meta = el('div', 'verdict-meta');
      var file = el('span', 'mono', shortPath(ev.file));
      file.title = ev.file;
      add(meta, file);
      var counts = [];
      if (failed.length) counts.push(plural(failed.length, 'plugin failed', 'plugins failed'));
      if (waiting.length) counts.push(plural(waiting.length, 'service unanswered', 'services unanswered'));
      if (suspects.length) counts.push(plural(suspects.length, 'suspect'));
      if (counts.length) {
        add(meta, el('span', 'sep', '·'));
        add(meta, el('span', 'num', counts.join(' · ')));
      }
      add(top, meta);
    }
    add(host, top);
    add(host, title);
    if (lede) add(host, el('p', 'verdict-lede', lede));
    if (actions.firstChild) {
      if (note) add(actions, el('span', 'verdict-note', note));
      add(host, actions);
    }
  }

  /* --------------------------------------------------------- evidence -- */

  function stage(label, count, solid, note) {
    var wrap = el('div', 'stage');
    var dot = el('span', 'stage-dot');
    dot.setAttribute('data-solid', solid ? '1' : '0');
    add(wrap, dot);
    var head = el('div', 'stage-label');
    add(head, document.createTextNode(label));
    if (count) add(head, el('span', 'stage-count', String(count)));
    if (note) {
      var hint = el('span', 'stage-note', note);
      hint.title = note;
      add(head, hint);
    }
    add(wrap, head);
    return wrap;
  }

  function renderEvidence() {
    var host = $('evidence-body');
    var file = $('ev-file');
    clear(host);
    file.textContent = '';

    if (!state) {
      host.appendChild(el('div', 'panel-empty', 'Reading the newest startup log…'));
      skeleton(host, 3);
      return;
    }

    var ev = state.evidence;
    if (!ev) {
      var empty = el('div', 'panel-empty');
      add(empty, el('strong', null, 'No startup log found.'));
      add(empty, document.createElement('br'));
      add(empty, document.createTextNode(
        'The Harness writes one per launch. Nothing here can be blamed for a failed boot yet.'));
      host.appendChild(empty);
      return;
    }

    file.textContent = shortPath(ev.file);
    file.title = ev.file;

    var failed = ev.failed || [];
    var waiting = ev.waiting || [];
    var suspects = state.suspects || [];
    var body = el('div', 'ledger');
    var colA = el('div', 'lcol');
    var colB = el('div', 'lcol');
    var pf = state.preflight;

    if (pf && pf.ok === false && pf.stderr) {
      var trial = stage('Trial boot', null, true, 'the end of its output');
      var lines = String(pf.stderr).split('\n').filter(function (l) { return l.trim(); });
      var quoted = el('p', 'quote quote--pre', lines.slice(-3).join('\n'));
      quoted.title = String(pf.stderr);
      add(trial, quoted);
      add(colA, trial);
    }

    if (ev.error) {
      var raised = stage('Raised', null, true);
      raised.appendChild(el('p', 'quote', ev.error));
      add(colA, raised);
    }

    if (failed.length) {
      var failedStage = stage('Failed', failed.length, true);
      failed.forEach(function (row) {
        var line = el('div', 'frow');
        var idRow = el('div', 'frow-id');
        var idName = el('span', 'name', row.id);
        idName.title = row.pkg && row.pkg !== row.id ? row.id + '  in  ' + row.pkg : row.id;
        add(idRow, idName);
        add(idRow, chip(row.required ? 'required' : 'optional', row.required ? 'chip--bad' : 'chip--mute'));
        add(line, idRow);
        var errLine = el('div', 'frow-err', row.error || 'no error line in the log');
        errLine.title = row.error || '';
        add(line, errLine);

        var name = row.pkg && canDisable(row.pkg) ? row.pkg : (canDisable(row.id) ? row.id : null);
        if (name) {
          var act = el('div', 'frow-act');
          add(act, actionBtn('Disable this', 'disable-one', { name: name },
            null, state.appRunning, state.appRunning ? 'Quit DeepSeek Harness first.' : ''));
          add(line, act);
        }
        add(failedStage, line);
      });
      add(colA, failedStage);
    }

    if (waiting.length) {
      var waitStage = stage('Waiting', waiting.length, false, null);
      waiting.forEach(function (row) {
        var line = el('div', 'wrow');
        add(line, el('span', 'mono', row.id));
        add(line, document.createTextNode('never got'));
        add(line, el('span', 'mono', row.missing || 'its service'));
        add(waitStage, line);
      });
      add(colB, waitStage);
    }

    if (suspects.length) {
      var susNote = suspects.length > 1 ? 'failed plugin first, then newest changes' : null;
      var susStage = stage('Suspects', suspects.length, false, susNote);
      var susWrap = el('div', 'slist');
      suspects.forEach(function (row, index) {
        var line = el('div', 'srow');
        add(line, el('span', 'srow-rank', String(index + 1)));
        add(line, el('span', 'srow-name', row.id));
        var why = el('span', 'srow-why', whyText(row.id, row.why));
        why.title = row.why || '';
        add(line, why);
        if (canDisable(row.id)) {
          var act = el('div', 'srow-act');
          add(act, actionBtn('Disable', 'disable-one', { name: row.id },
            null, state.appRunning, state.appRunning ? 'Quit DeepSeek Harness first.' : ''));
          add(line, act);
        }
        add(susWrap, line);
      });
      add(susStage, susWrap);
      add(colB, susStage);
    }

    if (!colA.firstChild || !colB.firstChild) body.className += ' ledger--one';
    if (colA.firstChild) add(body, colA);
    if (colB.firstChild) add(body, colB);

    if (!body.firstChild) {
      var clean = el('div', 'panel-empty');
      add(clean, el('strong', null, 'Nothing failed in the latest log.'));
      add(clean, document.createElement('br'));
      add(clean, document.createTextNode(
        'No plugin failed to load and none is waiting for a service.'));
      add(body, clean);
    }

    add(host, body);
  }

  /* ---------------------------------------------------------- plugins -- */

  function matches(name) {
    return !query || name.toLowerCase().indexOf(query) >= 0;
  }

  function pluginRow(p, mode) {
    var row = el('div', 'prow');
    var on = mode === 'selected';

    var main = el('div', 'pmain');
    var name = el('span', 'pname', p.name);
    name.title = p.name;
    add(main, name);

    var tags = el('div', 'ptags');
    add(tags, chip(p.core ? 'core' : p.kind, p.core ? 'chip--mute' : null));
    if (p.recency && p.recency.at) {
      var when = el('span', 'pwhen', relTime(p.recency.at));
      when.title = (p.recency.note ? p.recency.note + ' · ' : '') + absTime(p.recency.at);
      add(tags, when);
    } else {
      add(tags, el('span', 'pwhen', '—'));
    }

    add(main, tags);
    add(row, main);

    var act = el('div', 'pact');
    var sw = el('button', 'sw');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.setAttribute('data-key', 'sw:' + p.name);
    sw.setAttribute('data-act', 'toggle');
    sw.setAttribute('data-name', p.name);
    sw.setAttribute('data-on', on ? '1' : '0');
    if (p.core) {
      sw.disabled = true;
      sw.setAttribute('aria-label', p.name + ' — core bundle, always on');
      sw.title = 'Core bundle: dsh-safe never switches it off.';
    } else if (state && state.appRunning) {
      sw.disabled = true;
      sw.setAttribute('aria-label', (on ? 'Switch off ' : 'Switch on ') + p.name);
      sw.title = 'Quit DeepSeek Harness first: it owns package.json while it runs.';
    } else {
      sw.setAttribute('aria-label', (on ? 'Switch off ' : 'Switch on ') + p.name);
      sw.title = (on ? 'Switch off ' : 'Switch on ') + p.name +
        (on ? ' (a snapshot is taken first)' : '');
    }
    add(act, sw);
    add(row, act);
    return row;
  }

  function renderPlugins() {
    var list = $('plist');
    clear(list);

    if (!state) {
      $('pl-count').textContent = 'loading…';
      list.appendChild(el('div', 'panel-empty', 'Reading package.json…'));
      skeleton(list, 5, true);
      return;
    }

    var all = state.selected || [];
    var avail = state.available || [];
    var shown = all.filter(function (p) { return matches(p.name); });
    var shownAvail = avail.filter(function (p) { return matches(p.name); });

    $('pl-count').textContent = all.length + ' selected · ' + avail.length + ' available';

    if (!shown.length && !shownAvail.length) {
      var empty = el('div', 'panel-empty');
      add(empty, el('strong', null, 'No plugin matches “' + query + '”.'));
      add(empty, document.createElement('br'));
      add(empty, document.createTextNode(all.length + ' bundles are selected in this profile.'));
      add(empty, actionBtn('Clear the filter', 'clear-filter', null, null, false, ''));
      list.appendChild(empty);
      return;
    }

    if (shown.length) {
      var g1 = el('div', 'pgroup');
      add(g1, el('span', null, 'Selected'));
      add(g1, el('span', 'num',
        shown.length === all.length ? shown.length + ' bundles' : shown.length + ' of ' + all.length + ' match'));
      add(list, g1);
      shown.forEach(function (p) { list.appendChild(pluginRow(p, 'selected')); });
    }

    if (shownAvail.length) {
      var g2 = el('div', 'pgroup');
      add(g2, el('span', null, 'Available, not selected'));
      add(g2, el('span', 'num', shownAvail.length + ' in dependencies'));
      add(list, g2);
      shownAvail.forEach(function (p) { list.appendChild(pluginRow(p, 'available')); });
    }
  }

  function lockReason() {
    if (!state) return '';
    if (state.appRunning) return 'Quit DeepSeek Harness first: it owns package.json while it runs.';
    return '';
  }

  function syncActions() {
    var note = $('pl-note');
    var reason = lockReason();
    note.textContent = reason || 'A snapshot is taken before every change.';
    note.setAttribute('data-lock', reason ? '1' : '0');
    $('filter-x').hidden = !query;
  }

  /* --------------------------------------------------------- recovery -- */

  function renderSnapshots() {
    var list = $('snapshots');
    clear(list);
    var good = $('snap-good');
    clear(good);

    if (!state) {
      $('snap-count').textContent = '';
      add(good, el('span', 'dot'));
      add(good, el('span', null, 'reading snapshots…'));
      skeleton(list, 3);
      return;
    }

    var snaps = state.snapshots || [];
    $('snap-count').textContent = snaps.length ? snaps.length + '' : '0';

    add(good, el('span', 'dot'));
    if (state.lastGood) {
      var g = el('span', null, 'last known-good');
      add(good, g);
      var when = el('b', 'num', relTime(state.lastGood));
      when.title = absTime(state.lastGood);
      add(good, when);
      good.setAttribute('data-tone', 'good');
    } else {
      add(good, el('span', null, 'no known-good boot recorded'));
      good.removeAttribute('data-tone');
    }

    if (!snaps.length) {
      var empty = el('div', 'panel-empty');
      add(empty, el('strong', null, 'No snapshots yet.'));
      add(empty, document.createElement('br'));
      add(empty, document.createTextNode('Take one now to make the next change reversible.'));
      add(empty, actionBtn('Snapshot now', 'snapshot'));
      list.appendChild(empty);
      return;
    }

    var locked = Boolean(state.appRunning);
    snaps.forEach(function (snap) {
      var row = el('div', 'rrow');
      var top = el('div', 'rrow-top');
      add(top, el('span', 'rrow-label', snap.label || 'snapshot'));
      var when = el('span', 'rrow-when', relTime(snap.at));
      when.title = absTime(snap.at);
      add(top, when);
      add(row, top);

      var sub = el('div', 'rrow-sub');
      var id = el('span', 'trunc', snap.id);
      id.title = snap.id;
      add(sub, id);
      add(sub, document.createTextNode('·'));
      add(sub, el('span', null, (snap.bundles === null || snap.bundles === undefined) ? '—' : snap.bundles + ' bundles'));
      add(row, sub);

      var act = el('div', 'rrow-act');
      add(act, actionBtn('Restore', 'restore', { id: snap.id }, null,
        locked, locked ? lockReason() : 'Restore after taking a snapshot of the current state.'));
      add(row, act);
      list.appendChild(row);
    });
  }

  function renderActivity() {
    var list = $('activity');
    clear(list);

    if (!state) {
      $('act-count').textContent = '';
      list.appendChild(el('div', 'panel-empty', 'reading the operation log…'));
      skeleton(list, 3);
      return;
    }

    var ops = (state.operations || []).slice().reverse();
    $('act-count').textContent = ops.length ? ops.length + '' : '0';

    if (!ops.length) {
      list.appendChild(el('div', 'panel-empty', 'No plugin changes recorded yet.'));
      return;
    }

    ops.forEach(function (op) {
      var row = el('div', 'rrow');
      var top = el('div', 'rrow-top');
      var label = el('span', 'rrow-label mono', op.target || '(install)');
      label.title = op.target || '(install)';
      add(top, label);
      var when = el('span', 'rrow-when', relTime(op.time));
      when.title = absTime(op.time);
      add(top, when);
      add(row, top);

      var sub = el('div', 'rrow-sub');
      add(sub, el('span', 'trunc', op.what || ''));
      if (op.phase && op.phase !== 'settled') add(sub, chip(op.phase, 'chip--warn'));
      add(row, sub);

      list.appendChild(row);
    });
  }

  /* ------------------------------------------------------------- shell -- */

  function restoreFocus(key) {
    if (!key) return;
    var nodes = document.querySelectorAll('[data-key]');
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].getAttribute('data-key') === key) {
        nodes[i].focus({ preventScroll: true });
        return;
      }
    }
    var filter = $('filter');
    if (filter) filter.focus({ preventScroll: true });
  }

  function renderAll() {
    var active = document.activeElement;
    var key = active && active.getAttribute ? active.getAttribute('data-key') : null;

    renderHead();
    renderVerdict();
    renderEvidence();
    renderPlugins();
    renderSnapshots();
    renderActivity();
    syncActions();

    if (key) restoreFocus(key);
  }

  /* -------------------------------------------------------------- data -- */

  function setLog(text, tone) {
    $('log').textContent = text;
    var label = $('dock-state');
    /* 'bad' means an action was refused, 'err' that the page lost the profile */
    var map = { busy: 'working…', bad: 'blocked', err: 'error', good: 'done', idle: 'ready' };
    label.textContent = map[tone || 'idle'] || 'ready';
    label.setAttribute('data-tone', tone || 'idle');
    syncDockSpace();
  }

  function setBusy(flag) {
    busy = flag;
    document.body.setAttribute('data-busy', flag ? '1' : '0');
    $('dock').setAttribute('data-busy', flag ? '1' : '0');
    $('progress').hidden = !flag;
    $('main').setAttribute('aria-busy', flag ? 'true' : 'false');
    $('dock-hint').textContent = flag ? 'The page updates when the action finishes.' : '';
  }

  function openDock(open) {
    dockOpen = open;
    $('dock').setAttribute('data-open', open ? '1' : '0');
    $('dock-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    syncDockSpace();
  }

  /* The dock is fixed, so the page needs room for whatever height it has now. */
  function syncDockSpace() {
    document.documentElement.style.setProperty('--dock-h', $('dock').offsetHeight + 'px');
  }

  function showNet(text) {
    var box = $('net-error');
    if (!text) { box.hidden = true; return; }
    $('net-text').textContent = text;
    box.hidden = false;
  }

  function refresh() {
    return fetch('api/state', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.output || 'could not read the profile');
        state = data.state;
        showNet('');
        renderAll();
      })
      .catch(function (error) {
        showNet('Could not read the profile: ' + error.message);
        setLog('state error: ' + error.message, 'err');
        openDock(true);
      });
  }

  function act(body) {
    if (busy) return Promise.resolve();
    setBusy(true);
    openDock(true);
    var label = body.action === 'try'
      ? 'Test boot running. It copies the profile and waits for a window — about 30 seconds.'
      : 'Working…';
    setLog(label, 'busy');

    return fetch('api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        var text = (data.output || '').trim();
        if (data.blocked) text = 'BLOCKED: ' + text;
        setLog(text || (data.ok ? 'Done.' : 'The action failed.'), data.blocked ? 'bad' : (data.ok ? 'good' : 'bad'));
        if (body.action === 'launch' || body.action === 'shutdown') return null;
        return refresh();
      })
      .catch(function (error) {
        setLog('action error: ' + error.message, 'bad');
      })
      .then(function () {
        setBusy(false);
        syncActions();
      });
  }

  function disable(names) {
    var list = names.slice();
    if (!list.length) return;
    act({ action: 'disable', names: list });
  }

  function enable(names) {
    var list = names.slice();
    if (!list.length) return;
    act({ action: 'enable', names: list });
  }

  function toggle(name, on) {
    if (on) disable([name]);
    else enable([name]);
  }

  function restore(id) {
    if (!confirm('Restore snapshot?\n\n' + id + '\n\nThe current state is saved as a new snapshot first.')) return;
    act({ action: 'restore', id: id });
  }

  function restoreLatest() {
    var snaps = (state && state.snapshots) || [];
    if (!snaps.length) { setLog('There is no snapshot to restore.', 'bad'); openDock(true); return; }
    restore(snaps[0].id);
  }

  function safeMode() {
    if (!confirm('Safe mode: keep only @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app?\n' +
      'Every other bundle is removed from the profile (a snapshot is taken first).')) return;
    act({ action: 'safe-mode' });
  }

  function launch() {
    if (!confirm('Launch DeepSeek Harness now?')) return;
    act({ action: 'launch' }).then(function () {
      setLog($('log').textContent + '\nThe page stops once the app is up.', 'good');
    });
  }

  function stopUi() {
    act({ action: 'shutdown' });
  }

  /* ------------------------------------------------------------ wiring -- */

  document.addEventListener('click', function (event) {
    var node = event.target.closest ? event.target.closest('[data-act]') : null;
    if (!node) return;
    var actName = node.getAttribute('data-act');
    var name = node.getAttribute('data-name');
    var id = node.getAttribute('data-id');

    if (actName === 'refresh') { refresh(); return; }
    if (actName === 'snapshot') { act({ action: 'snapshot', label: 'ui' }); return; }
    if (actName === 'try') { act({ action: 'try' }); return; }
    if (actName === 'launch') { launch(); return; }
    if (actName === 'disable-one') { disable([name]); return; }
    if (actName === 'toggle') {
      toggle(name, node.getAttribute('data-on') === '1');
      return;
    }
    if (actName === 'enable-one') { enable([name]); return; }
    if (actName === 'restore') { restore(id); return; }
    if (actName === 'restore-latest') { restoreLatest(); return; }
    if (actName === 'safe-mode') { safeMode(); return; }
    if (actName === 'shutdown') { stopUi(); return; }
    if (actName === 'clear-filter') {
      query = '';
      $('filter').value = '';
      renderPlugins();
      syncActions();
      $('filter').focus();
      return;
    }
    if (actName === 'dock-toggle') { openDock(!dockOpen); return; }
  });

  $('filter').addEventListener('input', function () {
    query = $('filter').value.trim().toLowerCase();
    renderPlugins();
    syncActions();
  });

  $('filter').addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      query = '';
      $('filter').value = '';
      renderPlugins();
      syncActions();
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      var menu = document.querySelector('.menu[open]');
      if (menu) menu.open = false;
    }
  });

  // First paint is always the full layout: before the first state arrives the
  // panels draw their own flat placeholders instead of staying blank.
  renderAll();
  syncDockSpace();
  window.addEventListener('resize', syncDockSpace);
  refresh();

  // While the app still holds the profile, poll until it exits so the page
  // unlocks by itself after the crash dialog closes.
  setInterval(function () {
    if (!state || !state.appRunning) return;
    fetch('api/state', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.ok && data.state && data.state.appRunning === false) {
          state = data.state;
          renderAll();
        }
      })
      .catch(function () { /* keep the current view */ });
  }, 3000);

  // A quiet window is still an open window: the server ends itself when this
  // stops arriving, so closing the window never leaves a hidden node process.
  setInterval(function () {
    fetch('api/ping', { cache: 'no-store' }).catch(function () { /* server gone */ });
  }, 20000);
})();
</script>
</body>
</html>
`;

/* ----------------------------------------------------------------------- main */

const OPTIONS = {
  profile: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  label: { type: 'string', short: 'l' },
  good: { type: 'boolean' },
  apply: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  suspect: { type: 'string', multiple: true },
  'safe-mode': { type: 'boolean' },
  pick: { type: 'boolean' },
  all: { type: 'boolean' },
  log: { type: 'string' },
  ops: { type: 'string' },
  entry: { type: 'boolean' },
  timeout: { type: 'string' },
  grace: { type: 'string' },
  port: { type: 'string' },
  'no-browser': { type: 'boolean' },
  browser: { type: 'boolean' },
  ui: { type: 'boolean' },
  install: { type: 'boolean' },
  uninstall: { type: 'boolean' },
  keep: { type: 'boolean' },
  fix: { type: 'boolean' },
  'no-fix': { type: 'boolean' },
  'skip-try': { type: 'boolean' },
  cwd: { type: 'string' },
  dsh: { type: 'string' },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    bad(error.message);
    line('Run "dsh-safe --help" for usage.');
    return 2;
  }

  const opts = parsed.values;
  const positionals = [...parsed.positionals];

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    line(VERSION);
    return 0;
  }

  const command = positionals.shift() || 'status';

  switch (command) {
    case 'status':
      return cmdStatus(opts);
    case 'snapshot':
      return cmdSnapshot(opts);
    case 'snapshots':
    case 'list':
      return cmdSnapshots(opts);
    case 'restore':
      return cmdRestore(opts, positionals[0]);
    case 'plugins':
    case 'bundles':
      return cmdPlugins(opts);
    case 'disable':
    case 'off':
      return cmdDisable(opts, positionals);
    case 'enable':
    case 'on':
      return cmdEnable(opts, positionals);
    case 'recover':
    case 'fix':
      return cmdRecover(opts);
    case 'try':
    case 'check':
      return cmdTry(opts);
    case 'ui':
      return startUi(opts, {
        openMode: opts['no-browser'] ? 'none' : (opts.browser ? 'browser' : 'window'),
      });
    case 'watch':
      return cmdWatch(opts);
    case 'open': {
      if (opts.ui) {
        // The recovery shortcut: show the page immediately, even while the app
        // is running (mutating actions stay blocked there). Preflight is the
        // page's "Test boot" button, so opening the page stays fast.
        return startUi(opts, {
          openMode: opts['no-browser'] ? 'none' : (opts.browser ? 'browser' : 'window'),
        });
      }
      if (appRunning()) {
        info('DeepSeek Harness is already running; not launching another instance.');
        return 0;
      }
      const fix = !opts['no-fix'];
      let result;
      if (opts['skip-try']) {
        info('skipping the preflight (--skip-try)');
        result = { ok: true };
      } else {
        result = await runTrial(opts);
      }
      if (!result.ok) {
        if (opts.ui) {
          warn('preflight failed; starting the recovery UI so you can choose what to disable...');
          return startUi(opts, {
            openMode: opts['no-browser'] ? 'none' : (opts.browser ? 'browser' : 'window'),
            preflight: result,
          });
        }
        if (!fix) {
          bad('preflight failed; not launching (--no-fix).');
          return 1;
        }
        warn('preflight failed; attempting automatic recovery...');
        const profile = profileRef(opts);
        const mapped = (result.failed || [])
          .map((failed) => failed.pkg)
          .filter((pkg) => pkg && bundlesOf(readManifest(profile)).includes(pkg));
        const recoverOpts = {
          ...opts,
          apply: true,
          suspect: mapped.length ? mapped : opts.suspect,
        };
        const plan = planRecover(profile, recoverOpts, { logOverride: result.log });
        if (!plan.chosen.length) {
          bad('automatic recovery could not identify a plugin that is safe to disable.');
          info('Run "dsh-safe recover" to inspect the evidence, then "dsh-safe recover --safe-mode --apply".');
          return 1;
        }
        printRecoverPlan(plan, recoverOpts);
        const applied = applyRecover(plan, recoverOpts);
        if (!applied.applied) return 1;
        warn('recovery applied; retrying the preflight...');
        result = await runTrial(opts);
        if (!result.ok) {
          bad('still failing after recovery; not launching.');
          return 1;
        }
      }
      const exe = desktopExe();
      if (!exe) {
        bad('could not find "DeepSeek Harness.exe".');
        info('Set DSH_DESKTOP_EXE to the executable path and retry, or launch the app manually.');
        return 1;
      }
      const child = spawn(exe, [], {
        cwd: opts.cwd || process.cwd(),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      ok(`launched ${exe}`);
      return 0;
    }
    case 'help':
      process.stdout.write(HELP);
      return 0;
    default:
      bad(`unknown command "${command}"`);
      line('Run "dsh-safe --help" for usage.');
      return 2;
  }
}

export {
  AUTO_KEEP,
  AUTO_LABELS,
  CORE_BUNDLES,
  HOME,
  SAFETY_DIR,
  SNAPSHOTS_DIR,
  appRunning,
  bundlesOf,
  dailyStableLabel,
  findSnapshot,
  hasSnapshotLabel,
  humanMs,
  latestStartupLog,
  listSnapshots,
  parseStartupLog,
  profileRef,
  pruneAutoSnapshots,
  readManifest,
  readOps,
  readState,
  saveState,
  startupLogs,
  takeAutoSnapshot,
  takeSnapshot,
};

// The CLI still runs when this file is executed directly, but importing it (for
// example from the in-harness plugin in lib/plugin.js) must not parse argv or
// touch the terminal.
const entryArg = process.argv[1];
const invokedDirectly =
  typeof entryArg === 'string' &&
  pathToFileURL(path.resolve(entryArg)).href === import.meta.url;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error instanceof UsageError) {
        bad(error.message);
        process.exitCode = 2;
      } else {
        bad(error?.stack || String(error));
        process.exitCode = 1;
      }
    },
  );
}
