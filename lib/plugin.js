/**
 * In-harness half of dsh-safe.
 *
 * The recovery work itself happens outside the Harness process, in the CLI that
 * ships with this package (dsh-safe.mjs). This file only exposes the read-mostly
 * pieces to the model while the app is healthy:
 *
 *   dsh_safe_status    profile, selected bundles, snapshots, last boot evidence
 *   dsh_safe_snapshot  copy package.json + the patch layer before a plugin edit
 *
 * Both tools reuse the same functions as the CLI, so a snapshot made here is
 * the same snapshot `dsh-safe snapshots` lists and `dsh-safe restore` accepts.
 */

import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AUTO_KEEP,
  AUTO_LABELS,
  appRunning,
  bundlesOf,
  dailyStableLabel,
  hasSnapshotLabel,
  latestStartupLog,
  listSnapshots,
  parseStartupLog,
  profileRef,
  readManifest,
  readState,
  SAFETY_DIR,
  takeAutoSnapshot,
  takeSnapshot,
} from '../dsh-safe.mjs';

export const name = 'dsh-safe';
export const inject = ['tools'];

const TEXT = (text) => [{ type: 'text', text }];

const STATUS_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    home: { type: 'string' },
    profile: { type: 'string' },
    profileDir: { type: 'string' },
    appRunning: { type: 'boolean' },
    bundles: { type: 'array', items: { type: 'string' } },
    localBundles: { type: 'array', items: { type: 'string' } },
    snapshots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          at: { type: 'string' },
          label: { type: 'string' },
          note: { type: 'string' },
          bundles: { type: 'integer' },
        },
        required: ['id', 'at', 'label', 'note', 'bundles'],
      },
    },
    lastGoodAt: { type: 'string' },
    lastGoodSnapshot: { type: 'string' },
    lastTrialAt: { type: 'string' },
    lastTrialStatus: { type: 'string' },
    lastRecoveryAt: { type: 'string' },
    lastRemoved: { type: 'array', items: { type: 'string' } },
    startupFile: { type: 'string' },
    startupError: { type: 'string' },
    startupFailed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          required: { type: 'boolean' },
          pkg: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['id', 'required', 'pkg', 'error'],
      },
    },
    startupWaiting: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          missing: { type: 'string' },
        },
        required: ['id', 'missing'],
      },
    },
  },
  required: [
    'home',
    'profile',
    'profileDir',
    'appRunning',
    'bundles',
    'localBundles',
    'snapshots',
    'lastGoodAt',
    'lastGoodSnapshot',
    'lastTrialAt',
    'lastTrialStatus',
    'lastRecoveryAt',
    'lastRemoved',
    'startupFile',
    'startupError',
    'startupFailed',
    'startupWaiting',
  ],
};

const SNAPSHOT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    directory: { type: 'string' },
    at: { type: 'string' },
    bundles: { type: 'integer' },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'directory', 'at', 'bundles', 'files'],
};

function normalizeConfig(config) {
  const profile =
    config && typeof config.profile === 'string' && config.profile.trim() !== ''
      ? config.profile.trim()
      : undefined;
  return { profile };
}

function optionsFor(args, settings) {
  const fromArgs = args && typeof args.profile === 'string' ? args.profile.trim() : '';
  return { profile: fromArgs || settings.profile };
}

function startupEvidence() {
  try {
    const log = latestStartupLog();
    if (!log) return null;
    return parseStartupLog(log.path);
  } catch {
    return null;
  }
}

function collectStatus(options) {
  const profile = profileRef(options);
  const manifest = readManifest(profile);
  const home = homeOf(profile);
  const bundles = bundlesOf(manifest);
  const dependencies = manifest.dependencies || {};
  const localBundles = bundles.filter(
    (bundle) => typeof dependencies[bundle] === 'string' && dependencies[bundle].startsWith('link:'),
  );
  const state = readState();
  const snapshots = listSnapshots();
  const startup = startupEvidence();

  return {
    home,
    profile: profile.name,
    profileDir: profile.dir,
    appRunning: appRunning(),
    bundles: bundles.map((bundle) => String(bundle)),
    localBundles,
    snapshots: snapshots.slice(0, 5).map((snapshot) => ({
      id: String(snapshot.id || ''),
      at: String(snapshot.at || ''),
      label: String(snapshot.label || ''),
      note: String(snapshot.note || ''),
      bundles: Array.isArray(snapshot.bundles) ? snapshot.bundles.length : 0,
    })),
    lastGoodAt: state.lastGood ? String(state.lastGood.at || '') : '',
    lastGoodSnapshot: state.lastGood ? String(state.lastGood.snapshot || '') : '',
    lastTrialAt: state.lastTrial ? String(state.lastTrial.at || '') : '',
    lastTrialStatus: state.lastTrial ? (state.lastTrial.ok ? 'healthy' : 'failed') : 'none',
    lastRecoveryAt: state.lastRecover ? String(state.lastRecover.at || '') : '',
    lastRemoved: state.lastRecover
      ? (Array.isArray(state.lastRecover.removedBundles)
          ? state.lastRecover.removedBundles.map((bundle) => String(bundle))
          : [])
      : [],
    startupFile: startup ? String(startup.file || '') : '',
    startupError: startup ? String(startup.errorLine || '') : '',
    startupFailed: startup
      ? startup.failed.map((entry) => ({
          id: String(entry.id || ''),
          required: entry.required === true,
          pkg: String(entry.pkg || ''),
          error: String(entry.error || ''),
        }))
      : [],
    startupWaiting: startup
      ? startup.waiting.map((entry) => ({ id: String(entry.id || ''), missing: String(entry.missing || '') }))
      : [],
  };
}

/**
 * home is derived from the profile path, but profileRef does not expose it.
 * Recompute it from the known layout: <home>/profiles/<profile>/package.json.
 */
function homeOf(profile) {
  return profile.manifestPath
    .replace(/[\\/]profiles[\\/][^\\/]+[\\/]package\.json$/, '');
}

function renderStatus(value) {
  const lines = [];
  lines.push(`dsh-safe — profile "${value.profile}" (${value.bundles.length} bundles)`);
  lines.push(`  app: ${value.appRunning ? 'running (quit it before changing profile files)' : 'not running'}`);
  lines.push(`  home: ${value.home}`);
  if (value.localBundles.length > 0) {
    lines.push(`  local bundles: ${value.localBundles.join(', ')}`);
  }
  if (value.snapshots.length > 0) {
    lines.push(`  snapshots (${value.snapshots.length} shown):`);
    for (const snapshot of value.snapshots) {
      const label = snapshot.label || snapshot.note || 'snapshot';
      lines.push(`    ${snapshot.id}  ${snapshot.bundles} bundles  ${label}  ${snapshot.at}`);
    }
  } else {
    lines.push('  snapshots: none yet');
  }
  if (value.lastGoodAt) {
    lines.push(`  last known-good: ${value.lastGoodAt}  (${value.lastGoodSnapshot})`);
  }
  if (value.lastTrialStatus !== 'none') {
    lines.push(`  last trial: ${value.lastTrialStatus}  ${value.lastTrialAt}`);
  }
  if (value.lastRecoveryAt) {
    const removed = value.lastRemoved.length > 0 ? value.lastRemoved.join(', ') : 'nothing';
    lines.push(`  last recovery: ${value.lastRecoveryAt}  removed: ${removed}`);
  }
  if (value.startupError) {
    lines.push(`  last startup failure: ${value.startupError}`);
    lines.push(`    ${value.startupFile}`);
    for (const failed of value.startupFailed) {
      const kind = failed.required ? 'required' : 'optional';
      lines.push(`    failed: ${failed.id} (${kind})${failed.pkg ? `  ${failed.pkg}` : ''}`);
      if (failed.error) lines.push(`      ${failed.error}`);
    }
    for (const waiting of value.startupWaiting) {
      lines.push(`    waiting: ${waiting.id} — missing ${waiting.missing}`);
    }
  }
  return TEXT(lines.join('\n'));
}

function createStatusTool(settings) {
  return {
    name: 'dsh_safe_status',
    description:
      'Report the active DeepSeek Harness profile: selected bundles (and which are local links), recent dsh-safe snapshots, the last known-good snapshot, the last test-boot result, the last recovery, and the newest startup-failure log with the plugins that failed to activate. Read-only: use it to diagnose a plugin before changing anything. Changing plugins and restoring snapshots is done with the dsh-safe CLI outside the app, because the profile belongs to the running Harness process.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: {
          type: 'string',
          description: 'Profile name to inspect. Defaults to DSH_PROFILE, then "desktop".',
        },
      },
    },
    output: {
      schema: STATUS_OUTPUT,
      render(request, value) {
        return renderStatus(value);
      },
    },
    async execute(args = {}) {
      return collectStatus(optionsFor(args, settings));
    },
  };
}

function createSnapshotTool(settings) {
  return {
    name: 'dsh_safe_snapshot',
    description:
      'Create a dsh-safe snapshot of the active profile: copies package.json, cordis.patch.yml and cordis.yml into $DSH_HOME/safety/snapshots/<id>/ together with a meta.json listing the selected bundles. Take one before installing, updating, enabling or disabling any plugin; restore it with `dsh-safe restore <id>` if the next boot fails. Does not modify the profile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: {
          type: 'string',
          description: 'Profile name to snapshot. Defaults to DSH_PROFILE, then "desktop".',
        },
        label: {
          type: 'string',
          description: 'Short label appended to the snapshot id, e.g. "before-upgrade".',
        },
        note: {
          type: 'string',
          description: 'Free-form note stored in the snapshot metadata.',
        },
      },
    },
    output: {
      schema: SNAPSHOT_OUTPUT,
      render(request, value) {
        return TEXT(
          [
            `snapshot ${value.id} saved`,
            `  directory: ${value.directory}`,
            `  bundles: ${value.bundles}`,
            `  files: ${value.files.join(', ') || '(none)'}`,
          ].join('\n'),
        );
      },
    },
    async execute(args = {}) {
      const options = optionsFor(args, settings);
      const profile = profileRef(options);
      const label = typeof args.label === 'string' ? args.label.trim() : '';
      const note = typeof args.note === 'string' ? args.note.trim() : '';
      const { meta, dir } = takeSnapshot(profile, label || 'model', note || 'snapshot requested through dsh_safe_snapshot');
      return {
        id: String(meta.id),
        directory: dir,
        at: String(meta.at),
        bundles: Array.isArray(meta.bundles) ? meta.bundles.length : 0,
        files: Array.isArray(meta.files) ? meta.files.map((file) => String(file)) : [],
      };
    },
  };
}

/* --------------------------------------------------------- automatic images */

// Same policy as dsh-safe.mjs: the newest 10 plugin-change / dsh-update /
// auto-backup images form one rolling pool; each calendar day also gets one
// `stable-<date>` image that sits outside the pool and is never auto-deleted.
const SETTLE_MS = Math.max(200, Number(process.env.DSH_SAFE_AUTO_SETTLE_MS) || 5000);
const UPDATE_SETTLE_MS = Math.max(200, Number(process.env.DSH_SAFE_UPDATE_SETTLE_MS) || 20000);
const STABLE_DELAY_MS = Math.max(200, Number(process.env.DSH_SAFE_STABLE_DELAY_MS) || 30000);
const BACKUP_DEDUPE_MS = 5 * 60 * 1000;
const VERSION_FILE = path.join(SAFETY_DIR, 'dsh-version.json');
const AUTO_LOG = path.join(SAFETY_DIR, 'auto.log');

function autoLog(text) {
  appendFile(AUTO_LOG, `${new Date().toISOString()} ${text}\n`, 'utf8').catch(() => {});
}

/**
 * The desktop app writes its version next to the executable; the Host runs
 * under a bundled node several levels below the install directory.
 */
async function readDshVersion() {
  const starts = [];
  try {
    starts.push(path.dirname(process.execPath));
  } catch {
    /* no execPath */
  }
  if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA !== '') {
    starts.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'));
  }
  starts.push(process.cwd());
  for (const start of starts) {
    let dir = start;
    for (let depth = 0; depth < 10; depth += 1) {
      try {
        const text = (await readFile(path.join(dir, 'version'), 'utf8')).trim();
        await access(path.join(dir, 'resources', 'app.asar'));
        if (/^[\w.+-]{1,64}$/u.test(text)) return text;
      } catch {
        /* not this directory */
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

async function readVersionState() {
  try {
    const parsed = JSON.parse(await readFile(VERSION_FILE, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string'
      ? parsed.version
      : null;
  } catch {
    return null;
  }
}

async function writeVersionState(version) {
  try {
    await mkdir(SAFETY_DIR, { recursive: true });
    const temporary = `${VERSION_FILE}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version, at: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    await rename(temporary, VERSION_FILE);
  } catch {
    /* best effort: the next boot compares again */
  }
}

function createAutoPolicy(settings) {
  const profileOf = () => profileRef({ profile: settings.profile });
  let settleTimer = null;

  const image = (label, note) => {
    try {
      const { meta, removed } = takeAutoSnapshot(profileOf(), label, note, AUTO_KEEP);
      autoLog(`image ${meta.id} (${label})${removed.length > 0 ? ` removed ${removed.join(', ')}` : ''}`);
    } catch {
      /* automation must never break the host */
    }
  };

  const newestAuto = () => listSnapshots().find((snapshot) => AUTO_LABELS.includes(snapshot?.label)) || null;

  const autoChangeFresh = (windowMs) => {
    const newest = newestAuto();
    if (newest === null) return false;
    const at = Date.parse(String(newest.at || ''));
    return Number.isFinite(at) && Date.now() - at < windowMs;
  };

  // Bundle operations arrive in bursts (install -> enable -> ...). Wait for the
  // last one, and only then copy the settled profile.
  const schedulePluginChange = (note) => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      image('plugin-change', note);
    }, SETTLE_MS);
    if (typeof settleTimer.unref === 'function') settleTimer.unref();
  };

  const noteOperation = (operation) => {
    try {
      if (operation === null || typeof operation !== 'object') return;
      if (operation.phase !== 'settled') return;
      if (operation.changed !== true) return;
      if (operation.errorCode !== undefined) return;
      const application = operation.application;
      if (application !== 'applied' && application !== 'restart-required') return;
      const stage = operation.stage;
      if (stage !== 'install' && stage !== 'enable' && stage !== 'remove' && stage !== 'update') return;
      const target = String(operation.target ?? operation.reason ?? 'plugin change').slice(0, 160);
      schedulePluginChange(`after ${stage} ${target}`);
    } catch {
      /* ignore malformed events */
    }
  };

  const ensureDailyStable = () => {
    try {
      const label = dailyStableLabel();
      if (hasSnapshotLabel(label)) return;
      takeSnapshot(profileOf(), label, `daily stable ${label.slice('stable-'.length)}`);
      autoLog(`image ${label} (daily stable)`);
    } catch {
      /* the stable image is best effort */
    }
  };

  const checkDshUpdate = async () => {
    try {
      const version = await readDshVersion();
      if (version === null) return;
      const known = await readVersionState();
      if (known === version) return;
      await writeVersionState(version);
      if (known === null) return; // first install: adopt the running version
      // Reaching apply() on a new version means the update booted successfully.
      const timer = setTimeout(() => image('dsh-update', `DSH ${known} -> ${version}`), UPDATE_SETTLE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      autoLog(`DSH ${known} -> ${version}: image in ${UPDATE_SETTLE_MS} ms`);
    } catch {
      /* the version probe is best effort */
    }
  };

  return {
    autoChangeFresh,
    checkDshUpdate,
    dispose: () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
    },
    ensureDailyStable,
    noteOperation,
  };
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const tools = [createStatusTool(settings), createSnapshotTool(settings)];

  for (const definition of tools) {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => ctx.tools.register(definition));
    } else {
      ctx.tools.register(definition);
    }
  }

  const policy = createAutoPolicy(settings);

  // Successful plugin install/update/enable/remove: one image after the burst
  // settles. Failed operations and no-op changes never reach the snapshot.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('plugin-manager/operation', (operation) => policy.noteOperation(operation));
      return () => {
        if (typeof off === 'function') off();
        policy.dispose();
      };
    });
  }

  // A successful DSH update is visible as a version change on the next boot.
  void policy.checkDshUpdate();

  // One stable image per calendar day: shortly after the first boot of the
  // day, and again just after midnight if the app keeps running.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const bootTimer = setTimeout(() => policy.ensureDailyStable(), STABLE_DELAY_MS);
      if (typeof bootTimer.unref === 'function') bootTimer.unref();
      let stopped = false;
      let dayTimer = null;
      const arm = () => {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
        dayTimer = setTimeout(() => {
          if (stopped) return;
          policy.ensureDailyStable();
          arm();
        }, Math.max(1000, next.getTime() - now.getTime()));
        if (typeof dayTimer.unref === 'function') dayTimer.unref();
      };
      arm();
      return () => {
        stopped = true;
        clearTimeout(bootTimer);
        if (dayTimer !== null) clearTimeout(dayTimer);
      };
    });
  }

  // git-autobackup emits this from run(), i.e. only for a run the user approved
  // (or clicked with "Back up now"). It fires before the build copies
  // ~/.dsh/safety/snapshots into the backup tree, so the fresh image is part
  // of the same backup. Skip it when a change image was just taken: the backup
  // does not need a second copy of the same state.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('git-autobackup/before-run', (payload) => {
        try {
          if (policy.autoChangeFresh(BACKUP_DEDUPE_MS)) return;
          const reason =
            payload !== null && typeof payload === 'object' && typeof payload.reason === 'string'
              ? payload.reason
              : 'run';
          const detail =
            payload !== null && typeof payload === 'object' && typeof payload.detail === 'string'
              ? payload.detail
              : '';
          const note =
            detail === ''
              ? `before git-autobackup (${reason})`
              : `before git-autobackup (${reason}: ${detail})`;
          takeAutoSnapshot(profileRef({ profile: settings.profile }), 'auto-backup', note, AUTO_KEEP);
        } catch {
          /* a snapshot must never break the backup itself */
        }
      });
      return typeof off === 'function' ? off : () => {};
    });
  }
}
