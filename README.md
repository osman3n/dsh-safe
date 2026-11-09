# dsh-safe

A small out-of-band safety net for DeepSeek Harness plugin development on Windows.

The problem it solves: while you develop/install a plugin, the Harness can fail to
open — either a crash dialog loop, or the window stuck on "loading" forever. The
built-in recovery dialog ("Disable third-party plugins, back up profile patch and
restart") is all-or-nothing: it removes *every* third-party bundle and detaches the
whole patch layer. Sometimes you only want to switch off the one plugin you were
working on.

`dsh-safe` runs from a terminal while the app is closed. It edits the profile
files directly, so it does not depend on the broken Harness booting at all.

## Quick start

```bat
cd path\to\dsh-safe

dsh-safe.cmd status              :: where the profile is, what was installed recently
dsh-safe.cmd plugins             :: numbered bundle list + installed-but-not-selected
dsh-safe.cmd try                 :: test-boot a copy of the profile in a sandbox (no changes)
dsh-safe-ui.cmd                  :: recovery page in the browser (also works when the app is down)
```

Before you change anything, or right before you try a risky plugin:

```bat
dsh-safe.cmd snapshot -l before-thing-x
```

## The commands

| Command | What it does |
| --- | --- |
| `status` | Shows profile path, whether the app is running, bundle/local counts, recent plugin operations, crash evidence |
| `snapshot [-l label]` | Copies `package.json` + `cordis.yml` + `cordis.patch.yml` into a timestamped snapshot |
| `snapshots` / `list` | Lists snapshots (`--json` for scripting) |
| `restore [id\|latest]` | Puts a snapshot back; the current state is saved as a new snapshot first |
| `plugins` / `bundles` | Numbered list of selected bundles with a `[core/local/official/third-party/installed]` tag |
| `disable [name...]` | Removes bundles from `dsh.profile.bundles`; no names = interactive picker |
| `enable [name...]` | Adds installed bundles back; no names = interactive picker |
| `try` | Clone this profile under a temporary name, boot it in an isolated `DSH_HOME`, wait for the web server, probe it, then delete the clone |
| `ui` | Start a local recovery page: crash evidence, plugin checkboxes, snapshots, "test boot", "launch" |
| `recover` | Reads the newest startup log and explains which plugin failed and why |
| `recover --pick --apply` | Shows suspect plugins, lets you pick which ones to disable, applies it |
| `recover --apply` | Disables the newest safe suspect |
| `recover --safe-mode --apply` | Keeps only `dsh-base` + `dsh-web-app` (profile still intact) |
| `open` | Runs `try`; if the boot fails it auto-disables the mapped culprit, retries, and only then launches the app |

`disable`/`enable` accept names or entry ids (`include:workflow-kit`), and
`--dry-run` prints the plan. Core bundles (`@deepseek-ai/dsh-base`,
`@deepseek-ai/dsh-web-app`) are refused unless you pass `--force` — disabling them
takes the whole app down.

## Recovery recipes

**1. The app crashes on launch (dialog says "Host process exited").**
Do not click the built-in "Disable third-party plugins" button unless you want to
lose every third-party bundle. Instead:

```bat
dsh-safe.cmd recover --pick --apply
dsh-safe.cmd open
```

**2. The app opens and hangs on "loading" forever.**
The built-in dialog never appears for a hang. Run `dsh-safe.cmd recover` first: the
startup log usually names the plugin that threw during `apply()`. Then
`dsh-safe.cmd recover --pick --apply`.

**3. You installed a plugin and now nothing works.**
`status` shows the newest `install/*` operation, `plugins` shows the bundle list.
Disable the last thing you installed:

```bat
dsh-safe.cmd disable @scope/package-name
```

**4. You want to test a profile change before letting it near the real app.**
`dsh-safe.cmd try` — same bundles, same `node_modules` (via a junction), but a
throwaway profile name and `DSH_HOME`. The real profile is only read.

**5. You disabled the wrong thing.**
`dsh-safe.cmd snapshots`, then `dsh-safe.cmd restore <id>`. `restore` with no id
restores the newest snapshot; either way the current state is backed up first, so
restore is itself undoable.

## The recovery UI

`dsh-safe-ui.cmd` (or `dsh-safe.cmd ui`) starts a tiny web server on `127.0.0.1`
and opens it in your browser. It runs as a normal Node process, so it works while
the Harness is crashed, hung, or closed.

The page shows:

- **Last startup evidence** — the error line, the failed plugins with their first
  exception, which plugins waited for services, and the suspect list. Each failed
  plugin that is a selected bundle gets a one-click **Disable this** button.
- **Plugins** — every selected bundle with a checkbox, a filter box and a `kind`
  badge (core/local/official/third-party). Core bundles are locked. There is also
  an **Enable** button for installed-but-not-selected bundles. The list is sorted
  **newest install or update first**, using the app's plugin-operation log plus the
  `node_modules` timestamps, so the plugin you just added sits near the top.
- **Snapshots** — the newest 25 snapshots, each with **Restore**.
- **Recent plugin operations** — what was installed/enabled and when, so you can
  spot the change that broke the boot.
- **Test boot** — runs the same isolated preflight as `try`; the result and the
  failed-plugin list appear in the output panel.
- **Launch Harness** — starts the app (only when it is not already running).

Mutating buttons are blocked while DeepSeek Harness is running, because the app
owns `package.json` at boot. The page says so in a banner.

The server binds to `127.0.0.1` only and every URL carries a random token, so
another local page cannot drive it. **Stop this UI** (or Ctrl+C in the terminal)
ends the server.

**One-click safe reopen:** `dsh-safe-open.cmd` runs `open --ui`. It test-boots the
profile first; if the boot is healthy it launches Harness, and if it fails it
leaves the recovery page open with the preflight result already displayed. Fix
the plugin there, click **Launch Harness**, and the page shuts itself down.

## How `try` decides the boot is "healthy"

It starts the clone with `dsh --profile <trial> --no-open --port 0`, waits for the
`dsh web: http://127.0.0.1:...` line, then probes the URL until it answers. Only
then does it declare success after a short grace period (`--grace 3`). A crash
during boot shows up as a lower exit code or a `Failed plugins` block in the trial
startup log. Successful trials delete themselves; failed ones are kept under
`%USERPROFILE%\.dsh\safety\trials\` for inspection (add `--keep` to keep a
successful one).

## Safety model

- Close the Harness before `disable`, `enable`, `restore`, or `recover --apply`.
  The app reads these files at boot and the plugin manager can also write them;
  editing while it runs invites a last-writer-wins surprise on the next launch.
  (`status`, `plugins`, `snapshots`, `recover` without `--apply`, and `try` are
  read-only and safe while the app runs.)
- The real profile is never modified by `try`/`open`'s preflight. `disable`,
  `enable`, `restore`, and `recover --apply` all take a snapshot first.
- Edits are atomic (write to a temp file, then rename).
- `open` refuses to launch a second instance while the app is running.
- The desktop profile is owned by the Electron app: `dsh --profile desktop
  --dump-config` fails with "managed exclusively by the Electron application".
  That is why `try` clones it under a different profile name instead of booting it
  directly.
- A plugin that throws synchronously in `apply()` is contained by the loader (the
  app still starts with a warning). What actually kills the process is an unhandled
  rejection/uncaught exception — that is the crash this tool is designed to recover
  from, because an in-process plugin cannot catch it.

## Files it writes

| Path | Contents |
| --- | --- |
| `%USERPROFILE%\.dsh\safety\snapshots\<id>\` | `package.json`, `cordis.yml`, `cordis.patch.yml`, `meta.json` |
| `%USERPROFILE%\.dsh\safety\trials\<id>\` | disposable profile clone + isolated `home` |
| `%USERPROFILE%\.dsh\safety\incidents\` | one JSON per failed preflight (`try`/`open`) |
| `%USERPROFILE%\.dsh\safety\state.json` | snapshot counter, last trial |

Environment overrides: `DSH_HOME`, `DSH_PROFILE` (default `desktop`),
`DSH_SAFE_DSH` (path to a different `dsh` launcher), `DSH_DESKTOP_EXE` (path to
`DeepSeek Harness.exe`), `DSH_SAFE_FORCE_TTY=1` (force the picker when input is
piped, useful for tests), `DSH_SAFE_APP_RUNNING=0|1` (override the "is the app
running" check the UI uses to block mutations; for tests).

## Wrappers

- `dsh-safe.cmd` — the CLI.
- `dsh-safe-ui.cmd` — `dsh-safe ui`, opens the recovery page.
- `dsh-safe-open.cmd` — `dsh-safe open --ui`: test the profile, launch if healthy,
  otherwise open the recovery page.

All work from any directory; they resolve `dsh-safe.mjs` relative to themselves.
If you want to type `dsh-safe` from anywhere, add the folder that contains
`dsh-safe.cmd` to your PATH.
