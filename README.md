# dsh-safe

An out-of-band safety net for DeepSeek Harness plugins, shipped as both a
command-line tool and an installable bundle.

The problem: a plugin can stop the Harness from opening. Sometimes the process
crashes and the crash dialog loops; sometimes the window hangs on "loading"
forever. The built-in recovery dialog ("Disable third-party plugins, back up the
profile patch and restart") fires only on a crash, and it is all-or-nothing: it
removes *every* third-party bundle and detaches the whole patch layer. Usually you
only want to switch off the one plugin you were working on.

`dsh-safe` runs from a terminal while the app is closed and edits the profile
files directly, so it does not depend on the broken Harness booting at all. The
bundle adds two read-mostly tools to a healthy session: inspect the profile and
boot evidence, and snapshot the profile before a change.

## Install

As a plugin, which adds the two in-harness tools:

```bat
dsh plugin --profile desktop add github:osman3n/dsh-safe
```

Restart DeepSeek Harness. The plugin manager lists **dsh-safe**, and the model can
call `dsh_safe_status` and `dsh_safe_snapshot`. The CLI files ship inside the same
package, so the recovery commands below keep working.

As a standalone CLI, no install step is required: clone the repo, open a terminal
in `tools/dsh-safe`, and run `dsh-safe.cmd` (or `node dsh-safe.mjs`). The only
dependency is Node.js 22+. The recovery CLI targets Windows (it uses `tasklist`,
`cmd.exe` and the desktop executable); the in-harness tools are plain Node and
work wherever the Harness runs.

The plugin half is a convenience, not the recovery path: when the Harness cannot
boot, nothing inside it can run. Recovery always goes through the CLI or the
recovery page, from outside the app.

## In-harness tools

| Tool | What it does |
| --- | --- |
| `dsh_safe_status` | Active profile, selected bundles (and which are local links), recent snapshots, last known-good snapshot, last test boot, last recovery, newest startup-failure log with the plugins that failed or waited for services |
| `dsh_safe_snapshot` | Copies `package.json`, `cordis.yml` and `cordis.patch.yml` into `$DSH_HOME/safety/snapshots/<id>/`; optional `label` and `note` |

Both tools call the same functions as the CLI, so a snapshot taken by the model is
the same snapshot `dsh-safe snapshots` lists and `dsh-safe restore` accepts.
Neither tool changes the plugin selection: disabling and restoring are done from
the CLI while the app is closed.

### Automatic images

The bundle keeps a short history of the profile without asking. Nothing is
prompted or printed; a small log sits at `$DSH_HOME/safety/auto.log`.

| When | Label |
| --- | --- |
| a plugin install, enable, remove or update settles successfully (applied, or restart required) | `plugin-change` |
| the Harness version changes and the new version stays up for 20 s | `dsh-update` |
| just before an approved git-autobackup run | `auto-backup` |

A plugin change is imaged only after the operation has **settled with no error**
and the app has been quiet for 5 s, so writing or fixing a plugin does not fill
the history with half-finished states. The `auto-backup` image is skipped when a
`plugin-change` or `dsh-update` image was taken in the last five minutes, so one
change does not use two slots.

The last **10** automatic images are kept; the oldest is deleted when a new one
arrives. A daily **stable** image (`stable-YYYY-MM-DD`) is taken at the start of
the day — at the first boot, or at 00:05 if Harness stays open — and does not
count against the 10. Stable images are not pruned: the folder gains one small
folder per day (~60 KB each), and you can delete old ones under
`$DSH_HOME/safety/snapshots` whenever you like.

`dsh-safe snapshots` lists them all; `dsh-safe restore <id>` puts one back. The
backup build copies the whole snapshots folder, so the images also travel with
your git-autobackup history.


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
| `watch` | Serves the recovery page and opens it when Harness writes a new crash or startup-failure log |
| `watch --install` | Starts that watcher hidden at every Windows sign-in (`--uninstall` removes it) |
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

The page opens with a **verdict band**: one sentence naming the failure, a primary
**Disable `<plugin>`** button, **Test boot**, and a note that a snapshot is taken
before anything changes. Below it:

- **Boot evidence** — a ledger with the raised error, the failed plugins (first
  exception plus a per-row **Disable this**), the plugins that waited for services,
  and the suspect list (failed plugin first, then newest changes) in a scrollable
  column.
- **Recovery points** — the newest 25 snapshots, each with **Restore**. Until a boot
  has been verified it says so instead of pretending there is a good point.
- **Plugins** — every selected bundle with a checkbox, a filter box and a `kind`
  badge (core/local/official/third-party). Core bundles are locked. There is also
  an **Enable** button for installed-but-not-selected bundles. The list is sorted
  **newest install or update first**, using the app's plugin-operation log plus the
  `node_modules` timestamps, so the plugin you just added sits near the top.
- **Activity** — recent plugin operations, so you can spot the change that broke
  the boot, next to a collapsible **Output** dock that shows what each action did.

The layout collapses to a single column on narrow windows (the header buttons fold
into **Actions**), so the page also works when the only screen left is a small one.

Mutating buttons are blocked while DeepSeek Harness is running, because the app
owns `package.json` at boot. The page says so in a banner.

The server binds to `127.0.0.1` only and every URL carries a random token, so
another local page cannot drive it. **Stop this UI** (or Ctrl+C in the terminal)
ends the server.

**One-click safe reopen:** double-click the *DeepSeek Harness (Safe)* desktop
shortcut (or run `dsh-safe-open.cmd`). It opens the recovery page immediately,
even while Harness is running, so you can inspect the profile and choose plugins
before touching anything. Use the page's **Test boot** button for a sandbox
preflight, fix what is broken, then click **Launch Harness**; the page shuts
itself down. `dsh-safe.cmd open` (without `--ui`) keeps the older
preflight-then-launch behaviour.

## Automatically on crash

`dsh-safe watch` is a small background guard. It serves the recovery page and
watches two places for new failure evidence:

- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` — written by the desktop
  app when a boot or renderer fails;
- `%USERPROFILE%\.dsh\logs\startup-*.log` — written when the host startup fails.

When a new failure appears it appends the error line to
`~/.dsh/safety/watch.log` and opens the recovery page in your browser. If the
app is still showing its own crash dialog, the page reports "Harness is
running"; it unlocks by itself once you quit the app, because it keeps polling
while the app is up.

Install it once so it starts hidden at every sign-in (Windows):

```bat
dsh-safe watch --install
```

That writes `dsh-safe-watch.vbs` into your Startup folder:
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`. Remove it with
`dsh-safe watch --uninstall`, or delete that file. The watcher remembers the
full path of `dsh-safe.mjs`, so re-run `--install` if you move this folder.

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
- `dsh-safe-open.cmd` — `dsh-safe open --ui`: opens the recovery page directly
  (the desktop shortcut points here). `dsh-safe.cmd open` still test-boots the
  profile and launches Harness when it is healthy.

All work from any directory; they resolve `dsh-safe.mjs` relative to themselves.
If you want to type `dsh-safe` from anywhere, add the folder that contains
`dsh-safe.cmd` to your PATH.
