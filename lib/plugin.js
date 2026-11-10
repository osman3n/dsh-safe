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

import {
  appRunning,
  bundlesOf,
  latestStartupLog,
  listSnapshots,
  parseStartupLog,
  profileRef,
  readManifest,
  readState,
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

  // git-autobackup emits this from run(), i.e. only for a run the user approved
  // (or clicked with "Back up now"). It fires before the build copies
  // ~/.dsh/safety/snapshots into the backup tree, so the fresh snapshot is part
  // of the same backup instead of the next one.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('git-autobackup/before-run', (payload) => {
        try {
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
          takeSnapshot(profileRef({ profile: settings.profile }), 'auto-backup', note);
        } catch {
          /* a snapshot must never break the backup itself */
        }
      });
      return typeof off === 'function' ? off : () => {};
    });
  }
}
