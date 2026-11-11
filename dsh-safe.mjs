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
 *   ui         browser recovery page: evidence, plugin picker, snapshots, test boot
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

const VERSION = '0.2.4';

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
  dsh-safe ui                      open a recovery page in the browser (works while the app is down)
  dsh-safe watch                   serve the recovery page and open it when Harness crashes
  dsh-safe watch --install          start the crash watcher hidden at every Windows sign-in
  dsh-safe open                    preflight, auto-fix on failure, then launch the app
  dsh-safe open --ui               preflight, and on failure open the recovery page instead
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
  --no-browser       ui: do not open a browser automatically
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

async function createUiServer(opts, { preflight = null } = {}) {
  const token = crypto.randomBytes(9).toString('hex');
  const ctx = { token, opts, preflight, server: null };
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
  return { server, token, url: `http://127.0.0.1:${actual}/${token}/` };
}

async function startUi(opts, { openBrowser = false, preflight = null } = {}) {
  const { server, url } = await createUiServer(opts, { preflight });
  line('');
  ok(`recovery UI: ${url}`);
  info(`profile ${profileRef(opts).name}   app ${appRunning() ? 'is running' : 'is not running'}`);
  if (preflight) info(`preflight: ${preflight.ok ? 'healthy' : 'failed'} (${preflight.reason || 'unknown reason'})`);
  line('Keep this window open while you use the page; Ctrl+C (or the Stop button) ends it.');
  if (openBrowser) openUrl(url);

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
        openUrl(url);
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

const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness recovery</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
    background: #0d1117; color: #e6edf3;
  }
  header {
    position: sticky; top: 0; z-index: 3; display: flex; flex-wrap: wrap; gap: 12px 16px;
    align-items: center; justify-content: space-between; padding: 12px 20px;
    background: #161b22; border-bottom: 1px solid #30363d;
  }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 260px; }
  .brand h1 { font-size: 15px; margin: 0; letter-spacing: .02em; }
  .ver { color: #484f58; font-size: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #3fb950; box-shadow: 0 0 8px #3fb95088; }
  .pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .pill {
    border: 1px solid #30363d; border-radius: 999px; padding: 2px 10px;
    font-size: 12px; color: #8b949e; background: #0d1117;
  }
  .pill b { color: #e6edf3; font-weight: 600; }
  .pill.bad { border-color: #6e2b2b; color: #f85149; }
  .pill.good { border-color: #2b5c33; color: #3fb950; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  main { max-width: 1120px; margin: 0 auto; padding: 18px 20px 60px; display: grid; gap: 14px; }
  .banner {
    border-radius: 10px; padding: 10px 14px; font-size: 13px; border: 1px solid #6e2b2b;
    background: #2a1416; color: #ffb4ae;
  }
  .banner.warn { border-color: #5c4a1f; background: #271f0f; color: #e3b341; }
  .banner.hidden, .hidden { display: none !important; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 14px 16px; }
  .card h2 { font-size: 13px; margin: 0 0 10px; color: #8b949e; text-transform: uppercase; letter-spacing: .08em; }
  .card h2 .count { color: #484f58; text-transform: none; letter-spacing: 0; font-weight: 400; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .row { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid #21262d; }
  .row:last-child { border-bottom: 0; }
  .row .name { font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px; overflow-wrap: anywhere; }
  .row .grow { flex: 1; min-width: 0; }
  .row.core { opacity: .55; }
  .row input[type=checkbox] { width: 16px; height: 16px; accent-color: #238636; }
  .badge {
    display: inline-block; border-radius: 999px; padding: 0 8px; font-size: 11px;
    border: 1px solid #30363d; color: #8b949e;
  }
  .badge.core { color: #d2a8ff; border-color: #4c3a66; }
  .badge.local { color: #56d364; border-color: #2b5c33; }
  .badge.official { color: #79c0ff; border-color: #1f4b73; }
  .badge.third-party { color: #ffa657; border-color: #6b4a1f; }
  .badge.installed { color: #8b949e; }
  .btn {
    font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 7px; cursor: pointer;
    background: #21262d; color: #e6edf3; border: 1px solid #30363d;
  }
  .btn:hover { background: #30363d; }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: #238636; border-color: #2ea043; color: #fff; }
  .btn.primary:hover { background: #2ea043; }
  .btn.danger { background: #3d1518; border-color: #6e2b2b; color: #ff7b72; }
  .btn.danger:hover { background: #5a1e22; }
  .btn.small { padding: 2px 8px; font-size: 11px; }
  .muted { color: #8b949e; }
  .tiny { font-size: 11px; color: #6e7681; }
  .err { color: #ff7b72; font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
  .mono { font-family: Consolas, "Cascadia Mono", monospace; font-size: 12px; overflow-wrap: anywhere; }
  .field { display: flex; gap: 8px; align-items: center; margin: 8px 0 4px; }
  input[type=text] {
    width: 100%; padding: 6px 10px; border-radius: 7px; border: 1px solid #30363d;
    background: #0d1117; color: #e6edf3; font: inherit; font-size: 13px;
  }
  pre {
    margin: 0; padding: 10px 12px; border-radius: 8px; background: #0d1117; border: 1px solid #21262d;
    color: #c9d1d9; font: 12px/1.55 Consolas, "Cascadia Mono", monospace;
    max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .empty { color: #6e7681; font-size: 12px; padding: 6px 2px; }
  .scroll { max-height: 320px; overflow: auto; padding-right: 4px; }
  .footnote { color: #6e7681; font-size: 11px; margin-top: 10px; }
  .danger-zone { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="dot"></span>
    <h1>Harness recovery</h1>
    <span class="ver" id="ver"></span>
  </div>
  <div class="pills" id="pills"></div>
  <div class="actions">
    <button class="btn" id="refresh">Refresh</button>
    <button class="btn" id="snapshot">Snapshot now</button>
    <button class="btn" id="try">Test boot</button>
    <button class="btn primary" id="launch">Launch Harness</button>
  </div>
</header>
<main>
  <div class="banner hidden" id="banner"></div>

  <section class="card" id="evidence-card">
    <h2>Last startup evidence</h2>
    <div id="evidence"></div>
  </section>

  <section class="card">
    <h2>Plugins <span class="count" id="plugin-count"></span> <span class="tiny">newest install or update first</span></h2>
    <div class="field">
      <input type="text" id="filter" placeholder="filter by name...">
    </div>
    <div id="plugins"></div>
    <div class="danger-zone">
      <button class="btn danger" id="disable-selected" disabled>Disable selected</button>
      <button class="btn" id="safe-mode">Safe mode (keep core only)</button>
    </div>
    <div class="footnote">Disabling removes the bundle from the profile; core bundles are protected. A snapshot is taken first.</div>
  </section>

  <div class="grid">
    <section class="card">
      <h2>Snapshots</h2>
      <div id="snapshots"></div>
    </section>
    <section class="card">
      <h2>Recent plugin operations</h2>
      <div id="activity"></div>
    </section>
  </div>

  <section class="card">
    <h2>Output</h2>
    <pre id="log">Ready. Nothing has been changed yet.</pre>
    <div class="danger-zone">
      <button class="btn" id="stop">Stop this UI</button>
    </div>
  </section>
</main>
<script>
window.__BOOT_STATE__ = __BOOT__;
(function () {
  'use strict';
  var state = window.__BOOT_STATE__ || null;
  var selected = new Set();
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }
  function setLog(text) { $('log').textContent = text; }

  function stamp(recency) {
    var when = new Date(recency.at);
    if (isNaN(when.getTime())) return recency.note;
    return recency.note + ' - ' + when.toLocaleDateString() + ' ' +
      when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function badge(kind) {
    return el('span', 'badge ' + kind, kind);
  }

  function showBanner(text, warn) {
    var node = $('banner');
    if (!text) { node.className = 'banner hidden'; node.textContent = ''; return; }
    node.className = 'banner' + (warn ? ' warn' : '');
    node.textContent = text;
  }

  function renderPills() {
    var box = $('pills');
    box.textContent = '';
    if (!state) return;
    var p1 = el('span', 'pill');
    p1.textContent = 'profile ';
    var strong = el('b', null, state.profile.name);
    p1.appendChild(strong);
    box.appendChild(p1);
    var p2 = el('span', 'pill');
    p2.textContent = state.profile.bundleCount + ' bundles';
    box.appendChild(p2);
    var p3 = el('span', 'pill ' + (state.appRunning ? 'bad' : 'good'));
    p3.textContent = state.appRunning ? 'app running' : 'app not running';
    box.appendChild(p3);
    $('ver').textContent = 'dsh-safe ' + state.version;
    var launch = $('launch');
    if (launch) launch.disabled = Boolean(state.appRunning);
  }

  function renderBanner() {
    if (!state) return;
    if (state.preflight && state.preflight.ok === false) {
      showBanner('Preflight boot FAILED: ' + (state.preflight.reason || 'unknown reason') +
        '. Pick the plugin to disable below, then Launch Harness.', false);
      return;
    }
    if (state.appRunning) {
      showBanner('DeepSeek Harness is running. Quit it before disabling plugins — ' +
        'mutating actions are blocked until the app exits.', true);
      return;
    }
    showBanner('');
  }

  function failedRow(failed) {
    var row = el('div', 'row');
    var grow = el('div', 'grow');
    var line = el('div', 'mono');
    line.textContent = failed.id + (failed.required ? '  (required)' : '');
    grow.appendChild(line);
    if (failed.pkg) {
      var sub = el('div', 'tiny mono', failed.pkg);
      grow.appendChild(sub);
    }
    if (failed.error) {
      var err = el('div', 'err', failed.error);
      grow.appendChild(err);
    }
    row.appendChild(grow);
    if (failed.pkg && state.selected.some(function (row) { return row.name === failed.pkg; })) {
      var button = el('button', 'btn small danger', 'Disable this');
      button.disabled = Boolean(state.appRunning);
      button.addEventListener('click', function () { disable([failed.pkg]); });
      row.appendChild(button);
    }
    return row;
  }

  function renderEvidence() {
    var box = $('evidence');
    box.textContent = '';
    var card = $('evidence-card');
    if (!state || !state.evidence) {
      card.className = 'card hidden';
      return;
    }
    card.className = 'card';
    var ev = state.evidence;
    if (ev.error) {
      var err = el('div', 'err', ev.error);
      box.appendChild(err);
    }
    var meta = el('div', 'tiny mono', ev.file || '');
    box.appendChild(meta);

    if (ev.failed.length) {
      var label = el('div', 'tiny', 'Failed plugins:');
      label.style.marginTop = '8px';
      box.appendChild(label);
      ev.failed.forEach(function (failed) { box.appendChild(failedRow(failed)); });
    }
    if (ev.waiting.length) {
      var wait = el('div', 'tiny');
      wait.style.marginTop = '8px';
      wait.textContent = 'Plugins that never got their services: ' +
        ev.waiting.map(function (w) { return w.id; }).join(', ');
      box.appendChild(wait);
    }
    if (state.suspects.length) {
      var s = el('div', 'tiny');
      s.style.marginTop = '10px';
      s.textContent = 'Suspects (newest first):';
      box.appendChild(s);
      var scroll = el('div', 'scroll');
      state.suspects.forEach(function (suspect) {
        var row = el('div', 'row');
        var grow = el('div', 'grow');
        var mono = el('div', 'mono', suspect.id);
        grow.appendChild(mono);
        var why = el('div', 'tiny', suspect.why);
        grow.appendChild(why);
        row.appendChild(grow);
        var kind = el('span', 'badge', suspect.kind);
        row.appendChild(kind);
        if (suspect.kind !== 'pkg') {
          var button = el('button', 'btn small danger', 'Disable');
          button.disabled = Boolean(state.appRunning);
          button.addEventListener('click', function () { disable([suspect.id]); });
          row.appendChild(button);
        }
        scroll.appendChild(row);
      });
      box.appendChild(scroll);
    }
  }

  function pluginRow(plugin, selectable) {
    var row = el('div', 'row' + (plugin.core ? ' core' : ''));
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.value = plugin.name;
    box.disabled = !selectable || plugin.core;
    box.checked = selected.has(plugin.name);
    box.addEventListener('change', function () {
      if (box.checked) selected.add(plugin.name); else selected.delete(plugin.name);
      updateDisableButton();
    });
    if (selectable) row.appendChild(box);
    var grow = el('div', 'grow');
    var name = el('div', 'name', plugin.name);
    grow.appendChild(name);
    if (plugin.recency) grow.appendChild(el('div', 'tiny', stamp(plugin.recency)));
    row.appendChild(grow);
    row.appendChild(badge(plugin.kind));
    if (plugin.core) row.appendChild(el('span', 'tiny', 'core - protected'));
    return row;
  }

  function renderPlugins() {
    var box = $('plugins');
    box.textContent = '';
    var filter = ($('filter').value || '').toLowerCase();
    var shown = 0;
    state.selected.forEach(function (plugin) {
      if (filter && plugin.name.toLowerCase().indexOf(filter) === -1) return;
      box.appendChild(pluginRow(plugin, true));
      shown += 1;
    });
    if (!shown) box.appendChild(el('div', 'empty', 'no selected bundle matches the filter'));
    if (state.available.length) {
      var header = el('div', 'tiny', 'Installed but not selected:');
      header.style.marginTop = '12px';
      box.appendChild(header);
      state.available.forEach(function (plugin) {
        if (filter && plugin.name.toLowerCase().indexOf(filter) === -1) return;
        var row = el('div', 'row');
        var grow = el('div', 'grow');
        grow.appendChild(el('div', 'name', plugin.name));
        if (plugin.recency) grow.appendChild(el('div', 'tiny', stamp(plugin.recency)));
        row.appendChild(grow);
        row.appendChild(badge(plugin.kind));
        var button = el('button', 'btn small', 'Enable');
        button.addEventListener('click', function () { enable([plugin.name]); });
        row.appendChild(button);
        box.appendChild(row);
      });
    }
    $('plugin-count').textContent = '(' + state.selected.length + ' selected)';
    updateDisableButton();
  }

  function updateDisableButton() {
    var button = $('disable-selected');
    var count = selected.size;
    button.disabled = count === 0 || busy || (state && state.appRunning);
    button.textContent = count ? 'Disable selected (' + count + ')' : 'Disable selected';
  }

  function renderSnapshots() {
    var box = $('snapshots');
    box.textContent = '';
    if (!state.snapshots.length) {
      box.appendChild(el('div', 'empty', 'no snapshots yet'));
      return;
    }
    state.snapshots.forEach(function (snap) {
      var row = el('div', 'row');
      var grow = el('div', 'grow');
      grow.appendChild(el('div', 'mono', snap.id));
      var detail = (snap.label ? snap.label + '  ' : '');
      if (snap.at) detail += new Date(snap.at).toLocaleString() + '  ';
      if (snap.bundles !== null) detail += snap.bundles + ' bundles';
      grow.appendChild(el('div', 'tiny', detail.trim()));
      row.appendChild(grow);
      var button = el('button', 'btn small', 'Restore');
      button.addEventListener('click', function () { restore(snap.id); });
      row.appendChild(button);
      box.appendChild(row);
    });
  }

  function renderActivity() {
    var box = $('activity');
    box.textContent = '';
    if (!state.operations.length) {
      box.appendChild(el('div', 'empty', 'no plugin operations recorded'));
      return;
    }
    state.operations.slice().reverse().forEach(function (op) {
      var row = el('div', 'row');
      var grow = el('div', 'grow');
      grow.appendChild(el('div', 'mono', op.target));
      var when = new Date(op.time).toLocaleString() + '  ' + op.what;
      grow.appendChild(el('div', 'tiny', when));
      row.appendChild(grow);
      if (op.phase) row.appendChild(el('span', 'badge', op.phase));
      box.appendChild(row);
    });
  }

  function renderAll() {
    renderPills();
    renderBanner();
    renderEvidence();
    renderPlugins();
    renderSnapshots();
    renderActivity();
  }

  function refresh() {
    return fetch('api/state', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (!data.ok) throw new Error(data.output || 'could not read state');
        state = data.state;
        renderAll();
      })
      .catch(function (error) { setLog('state error: ' + error.message); });
  }

  function act(body) {
    if (busy) return Promise.resolve();
    busy = true;
    updateDisableButton();
    var label = body.action === 'try' ? 'test boot running (about 30s)...' : 'working...';
    setLog(label);
    return fetch('api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        var text = (data.output || '').trim();
        if (data.blocked) text = 'BLOCKED: ' + text;
        setLog(text || (data.ok ? 'done.' : 'action failed.'));
        if (body.action === 'launch' || body.action === 'shutdown') return null;
        return refresh();
      })
      .catch(function (error) { setLog('action error: ' + error.message); })
      .then(function () { busy = false; updateDisableButton(); });
  }

  function disable(names) {
    var list = names.slice();
    if (list.length > 1 && !confirm('Disable ' + list.length + ' plugins?\n\n' + list.join('\n'))) return;
    if (list.length === 1 && !confirm('Disable ' + list[0] + '?')) return;
    selected.clear();
    act({ action: 'disable', names: list });
  }

  function enable(names) {
    if (!confirm('Enable ' + names.join(', ') + '?')) return;
    act({ action: 'enable', names: names });
  }

  function restore(id) {
    if (!confirm('Restore snapshot?\n\n' + id + '\n\nThe current state is saved as a new snapshot first.')) return;
    act({ action: 'restore', id: id });
  }

  $('refresh').addEventListener('click', refresh);
  $('filter').addEventListener('input', function () { if (state) renderPlugins(); });

  $('snapshot').addEventListener('click', function () {
    act({ action: 'snapshot', label: 'ui' });
  });

  $('try').addEventListener('click', function () { act({ action: 'try' }); });

  $('launch').addEventListener('click', function () {
    if (!confirm('Launch DeepSeek Harness now?')) return;
    act({ action: 'launch' }).then(function () {
      setLog($('log').textContent + '\nThe UI will stop after the app starts.');
    });
  });

  $('disable-selected').addEventListener('click', function () {
    disable(Array.from(selected));
  });

  $('safe-mode').addEventListener('click', function () {
    if (!confirm('Safe mode: keep only @deepseek-ai/dsh-base and @deepseek-ai/dsh-web-app?\n' +
      'Every other bundle is removed from the profile (a snapshot is taken first).')) return;
    act({ action: 'safe-mode' });
  });

  $('stop').addEventListener('click', function () {
    act({ action: 'shutdown' });
  });

  if (state) renderAll();
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
})();
</script>
</body>
</html>`;

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
      return startUi(opts, { openBrowser: !opts['no-browser'] });
    case 'watch':
      return cmdWatch(opts);
    case 'open': {
      if (opts.ui) {
        // The recovery shortcut: show the page immediately, even while the app
        // is running (mutating actions stay blocked there). Preflight is the
        // page's "Test boot" button, so opening the page stays fast.
        return startUi(opts, { openBrowser: true });
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
          return startUi(opts, { openBrowser: true, preflight: result });
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
