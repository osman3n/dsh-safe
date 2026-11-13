# dsh-safe recovery page — redesign notes

The page a user lands on when DeepSeek Harness will not boot. It has one job:
say what failed, and put the switch that fixes it within reach.

Everything here is inside a single `UI_HTML` string — no build step, no CDN, no
web fonts, no images (CSP: `default-src 'none'`). System font stack only.

---

## Files

| file | what it is |
| --- | --- |
| `recovery-preview.html` | the page, byte-identical to `UI_HTML`, plus a preview stub that fakes `fetch` with realistic data |
| `ui-html.block.js` | the exact text to drop into `dsh-safe.mjs` (`const UI_HTML = String.raw\`…\`;`) |
| `_emit.mjs` | rebuilds `ui-html.block.js` from the preview and refuses unsafe text |
| `_verify.mjs` | renders the emitted block with a real boot state and reports console errors |
| `_shot.mjs` | screenshots at any width via CDP (`Wx0` = full page) |
| `_a11y.mjs` | tabs through the page and reports focus rings + WCAG contrast |
| `_eval.mjs` | runs JS in the page and prints console output |
| `_interact.mjs` | clicks/scrolls/hovers then screenshots |

Preview states: `?state=failed` (default), `running`, `preflight`, `healthy`,
`clean`, `loading`.

---

## Revision — light tone, one switch per plugin

Two changes after the first pass, both requested from use:

1. **Light palette.** The page is now white-on-light (`--bg #f4f6f9`), because it
   is read next to the (light) Harness window on a Windows desktop, and a dark
   recovery page looked like a different application. Colour still carries the
   meaning: red for the failure, amber for waiting/blocked, green for a verified
   boot, blue for focus and selection — each on its own pale tint.
2. **A switch per plugin instead of a checkbox plus a bulk button.** The previous
   flow was tick, then find *Disable selected (N)*, then confirm. Three steps for
   one reversible edit. Now every row has `role="switch"`: on = loaded in this
   profile, flip it and the change applies, with the pre-change snapshot shown in
   the output dock. Core bundles keep their switch on and locked; installed but
   unselected bundles show an off switch that adds them back.

No confirmation dialog on a switch flip: the snapshot taken immediately before
the write, plus **Recovery points**, is the safeguard, and the dock names the
snapshot id so undo is one click away. `Restore` and `Safe mode` keep their
confirmations — those touch several bundles at once.

---

## What was wrong

The old page was five equal panels in a dark dashboard. The verdict was a
banner the same weight as everything else, the evidence card was a bordered
box with no reading order, and at 1440×900 the evidence alone was ~520px tall,
so the list you actually act on started below the fold. Nothing said "this
first". Colour was doing no work: the only saturated thing on screen was a
green primary button.

## The new reading order

One question per region, answered top to bottom:

1. **What broke?** — verdict band: state word, one sentence, one filled button.
2. **Why?** — boot evidence, a chronology: Raised → Failed → Waiting → Suspects.
3. **Which switch?** — plugins: filter, one on/off switch per row (plus *Disable this* in the evidence ledger).
4. **Can I go back?** — recovery points (snapshots) and recent changes, in a rail.
5. **What did it say?** — output dock, pinned, collapsed until something runs.

The rail is 356px and starts level with the evidence panel, so the eye gets a
second column only after it has read the reason. `align-items: start` on the
grid keeps the rail from stretching when the evidence is short.

## Type scale

Ten rungs, but four jobs. Mono text is set 0.5–1px above its sans neighbour
because Cascadia Mono reads smaller than Segoe UI at the same nominal size.

| size | role |
| --- | --- |
| 24px / 20px | verdict title (desktop / ≤420px) — the only 24px on the page |
| 15px | verdict lede |
| 13.5px | prose body, error text |
| 13px | panel titles, row names in the evidence ledger |
| 12.5px | mono ids, snapshot labels, brand name |
| 12px | chips, counts, buttons |
| 11.5px | meta: times, stage notes, dock state, foot notes |
| 11px | stage labels (Raised / Failed / Waiting / Suspects) |

Weights: 400, 500, 600. No 700 — the page is small type and a real bold at 12px
turns into a smudge. `font-variant-numeric: tabular-nums` on every number that
can change (counts, times, bundle totals) so polling never shifts a column.

## Colour roles

Chrome is neutral and carries no meaning. Three hues do all the semantic work,
each on its own pale tint, never as a large fill:

| token | value | meaning | contrast |
| --- | --- | --- | --- |
| `--bad` | `#c0392b` (`--bad-ink #a32b1e`) | boot failed, required plugin | 6.46 on `--bad-bg` |
| `--warn` | `#9a6400` (`--warn-ink #7d5200`) | still running, waiting, blocked | 5.9 on `--warn-bg` |
| `--good` | `#17804f` (`--good-ink #106b41`) | last known-good boot, ready to launch | 6.1 on `--good-bg` |
| `--sel` / `--focus` | `#1f6feb` | selection, focus ring | 4.83 on panel |

Text ladder measured against the panel (`#ffffff`):

| token | value | on panel |
| --- | --- | --- |
| `--ink` | `#0f1720` | 17.9 |
| `--ink-2` | `#33404f` | 10.0 |
| `--ink-3` | `#55636f` | 6.2 |
| `--ink-4` | `#68737f` | 4.9 |

The only filled control on the page is the primary action (white on `--ink`).
Everything else is a 1px border. Surfaces are one tone step apart
(`#f4f6f9` → `#ffffff` → `#f1f4f8`) and hairlines (`#e3e7ee`) do the
separating; a single 1px ambient shadow lifts the panels, nothing glows.

## Spacing and metrics

- 4px base: 4 / 6 / 8 / 10 / 12 / 14 / 20 / 24 / 32.
- Page gutter 24px desktop, 16px ≤640. Verdict padding 22/24/20. Panel head 13/20 (min-height 50). Ledger 4/20/14.
- Row heights: plugin 44, failed 2-line block, suspect 2-line block, snapshot 53, stage head 32.
- Controls 32px (`--xs` 26), inputs 30. Radii 8 (panel) / 6 (control) / 4 (chip).
- Bracket rules (`1px 1px 1px 1px` borders on every list row) were replaced by
  a single divider per row and one divider between stages, so the page reads as
  three flat surfaces instead of a stack of cards.

## States

**Empty** — the frame never disappears. "No snapshots yet. / Take one now to
make the next change reversible." with the action on its own line. Zeros are
printed as `0`, missing values as `—`. A brand-new profile gets a different
verdict: *"There is no startup log to read."* with **Launch Harness** filled —
the only case where the primary action is a launch.

**Loading** — the final layout with flat grey bars, no shimmer, no spinner.
Each region states what it is reading ("Reading package.json…"). The skeleton
runs before the first `fetch` resolves, so the page never starts blank.

**Error** — an inline bar above the verdict ("Could not read the profile:
Failed to fetch" + Retry) and the same text in the dock at `error` level. The
last known state stays on screen; the bars never replace the page.

**Disabled** — while Harness is running, every mutating control is `disabled`
*dimmed but legible* (no `opacity: .4`), the panel foot says
"Locked: quit DeepSeek Harness first.", and `title` repeats the reason. The
server still refuses; the UI only removes the dead click.

**Busy** — `body[data-busy="1"]` dims actionable buttons, the dock opens, and
the state label reads `working…`. A second click is dropped by the `busy` guard
before it reaches `fetch`.

## Keyboard and focus

38 stops in the failed state, in visual order: skip link → Refresh → Snapshot now →
Test boot → Launch Harness → Disable (verdict) → Test boot → Disable this ×2 →
Disable ×3 → filter → clear-filter → 14 plugin switches → 2 Enable → Safe mode… →
5 Restore → Output → Stop this UI. Every one paints a ring (`2px solid var(--focus)`,
`offset 2px`).

- The plugin filter is `<input type="search">` with a labelled clear button;
  Escape clears it, and the empty result names the query and offers Clear.
- Rows are not clickable, so they are not tab stops; their switch is. The switch
  is a `<button role="switch">` with `aria-checked`, so Space and Enter both flip
  it, and the accessible name states the action (*Switch off dsh-pocket*).
- `renderAll()` captures the focused element's `data-key` before re-rendering
  and restores it after, so 3s polling cannot throw focus to `<body>`.
- The dock is a disclosure with `aria-expanded`; the log is `role="log"` +
  `aria-live="polite"`, `tabindex="0"` so it can be scrolled from the keyboard.
- The visually hidden per-row label sits inside a `position: relative` cell —
  without a positioned ancestor it anchors to the page and stretches the
  document scroll height.
- Destructive actions keep the native `confirm()` — it is the one dialog a
  broken profile should trust.

## Accessibility

- 27 text/background pairs measured, all ≥ 4.5:1; minimum 5.44 (was 3.47: four
  tokens were below AA before this pass).
- Interactive boxes are ≥ 32px; `@media (pointer: coarse)` raises buttons to
  40px and row hit areas to 48px without changing the visual density.
- Semantics: one `h1` (the verdict), `h2` per panel, `<ul>`/`<li>` for the
  evidence ledger and plugin list, `aria-labelledby` on each section,
  `aria-hidden` on decorative dots and the spine.
- Motion is feedback only: 100–160ms background/border transitions, one 160ms
  chevron rotation, press is a `translateY(1px)`. Everything collapses under
  `prefers-reduced-motion: reduce`.
- Zoom to 200% and text-only scaling do not clip: nothing is set in `vh`, and
  the only pixel heights are row minimums with wrapping content.

## Hover and press

| control | hover | press |
| --- | --- | --- |
| `.btn` | border `--line-3`, background `--well` | `translateY(1px)` |
| `.btn--solid` | `#1d2836` | `translateY(1px)` |
| row | nothing — rows are not clickable | — |
| row with a focused control | `--well` background (`:focus-within`) | — |
| switch | border `--ink-3` | knob slides 16px, track `--ink` |
| link button | text to `--ink` | — |
| dock toggle | text to `--ink-2` | chevron rotates |

## Responsive

- **1440** — `1fr / 356px` rail, evidence in two columns (Raised+Failed | Waiting+Suspects) with a 1px vertical rule, verdict meta on one line, plugin names on one line.
- **1101–1280** — same, rail narrows with the column.
- **≤1100** — one column: the rail drops below the plugin list and splits into two panels side by side (Recovery points | Recent changes), so snapshots stay visible without scrolling past them.
- **≤900** — header: Refresh / Snapshot now / Test boot fold into an `Actions` menu, page gutter 16px.
- **≤880** — the evidence ledger stacks; the vertical rule becomes a hairline between stages so the groups still separate.
- **≤720** — the rail's two panels stack; verdict padding 18/16, panel heads 12/16.
- **≤640** — verdict meta wraps to counts-then-filename on its own line, plugin rows grow to `min-height: 56px` with name and badges stacked and the switch kept on the right, failed rows put *Disable this* under the message, the search field takes the full panel head.
- **390** — single column, 16px gutter, title 20px, snapshots keep Restore inline, dock 46px with a 44px target. No horizontal scrolling.

The plugin list is a `min(62vh, 660px)` scroll box (one sticky group head plus
twelve 48px rows at 1440×900), so the switch you need is reachable without
scrolling the page. Snapshots are never clamped: every row is whole and every
Restore is live.

## Behaviour parity

Unchanged: the token URL, every route, `uiState`, `uiAction`, `createUiServer`,
`startUi`, the 3s poll while the app runs, `__BOOT_STATE__` injection, the
action names, the `BLOCKED:` prefix, `confirm()` on restore/safe-mode,
`setLog` replacing the log text, and the `shutdown` close.

Five things are new, all client-side and none of them touching the contract:

1. skeleton before the first state arrives;
2. an inline retry bar when a refresh fails;
3. the output dock as a collapsible pinned bar (it used to be a panel in the
   flow, so a copied log could be scrolled away from);
4. focus restoration across re-renders;
5. shortened suspect reasons for the narrow column — `failed plugin "x" (x)`
   becomes `failed at startup`, `installed/enabled at <iso>` becomes
   `installed 2 h ago`. The untouched string stays in the row `title`.

## Handoff

In `tools/dsh-safe/dsh-safe.mjs`, replace the `const UI_HTML = String.raw\`…
\`;` region (it starts with the `/* dsh-safe recovery page */` header and ends
after `</html>`; `.tmp/splice-ui.mjs` in this workspace does it mechanically and
collapses stacked headers) with the contents of `ui-html.block.js`. Nothing else
changes: `createUiServer()` already does `UI_HTML.replace('__BOOT__', boot)`, and
the block keeps exactly one `__BOOT__` placeholder on the line
`window.__BOOT_STATE__ = __BOOT__;`.

The block is inside a `String.raw` template, so it must not contain a backtick
or `${`. `_emit.mjs` refuses to write if either appears; the page's own escapes
(`\n`, `\`) are written once, which is what `String.raw` needs.

Rebuild and check:

```
cd tools/dsh-safe/design
node _emit.mjs          # preview -> ui-html.block.js (refuses unsafe text)
node --check ui-html.block.js
node _verify.mjs        # renders the block with a real boot state
node _shot.mjs "file:///…/recovery-preview.html?state=failed" 390x844 768x1024 1440x900
node _a11y.mjs "file:///…/recovery-preview.html?state=failed" 40
```

`_verify.mjs` on `file://` is expected to log a CORS failure for `api/state` —
that is the error bar and the dock being exercised, not a fault.

## Verified

- All six states rendered and read at 1440; `failed` and `clean` also at 768 and 390.
- Zero console exceptions from the page itself (only the deliberate `file://` fetch failure).
- 40 tab stops, all with a visible ring; focus survives a poll-driven re-render.
- 27 contrast pairs pass under the light palette, worst 4.66:1.
- Switch end-to-end over CDP (keyboard Space): 36 → 35 bundles, snapshot
  `…-pre-disable-dsh-pocket` written, row moves to available, Space again restores 36.
- Filter, switch, and the empty-result state exercised.