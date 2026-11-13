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
<meta name="color-scheme" content="dark">
<title>Harness recovery</title>

<style>
/* =====================================================================
   dsh-safe recovery page
   One self-contained document: system fonts only, no network, no build.
   ===================================================================== */

:root {
  color-scheme: dark;

  /* surfaces -- a dark instrument, one tone step per layer, hairlines do
     the separating work so nothing needs a shadow */
  --bg:        #0a0c0f;
  --panel:     #0f1216;
  --panel-2:   #0c0f13;   /* panel footer bands */
  --well:      #141920;   /* inset: quotes, log, ids */
  --line:      #1c222a;
  --line-2:    #2b333d;   /* interactive borders */
  --line-3:    #3b4552;   /* hover borders */

  /* text -- three tiers, all >= 4.5:1 on --panel */
  /* Text ladder, measured against #0f1216 / #141920 so every rung clears
     WCAG AA 4.5:1 on the darkest and the lightest ground:
     17.2 | 11.6 | 7.4 | 5.4 */
  --ink:       #f2f5f8;
  --ink-2:     #c3ccd6;
  --ink-3:     #9aa3ae;
  --ink-4:     #828b96;

  /* status -- hue on its own dark tint, nothing else is coloured */
  --bad:       #ff7b72;
  --bad-ink:   #ffb3ad;
  --bad-bg:    #231315;
  --bad-line:  #46232a;
  --warn:      #e9b64d;
  --warn-ink:  #f0c877;
  --warn-bg:   #211b0e;
  --warn-line: #3f3214;
  --good:      #4ad295;
  --good-ink:  #7ee3b7;
  --good-bg:   #0e231b;
  --good-line: #1d4436;

  /* the product's own blue, borrowed from icon.svg -- focus + selection only */
  --focus:     #6ea8fe;
  --sel:       #2f81f7;

  /* radii: panel / control / chip */
  --r-panel: 8px;
  --r-ctl:   6px;
  --r-chip:  4px;

  --sans: ui-sans-serif, "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "Cascadia Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;

  --bar-h: 56px;
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
.btn:hover:not(:disabled) { background: #171d25; border-color: var(--line-3); }
.btn:active:not(:disabled) { background: #1b222b; transform: translateY(1px); }
.btn:disabled { color: var(--ink-4); border-color: var(--line); cursor: not-allowed; }

.btn--solid {
  background: #e9eef4; border-color: #e9eef4; color: #0a0d11; font-weight: 600;
}
.btn--solid:hover:not(:disabled) { background: #ffffff; border-color: #ffffff; }
.btn--solid:active:not(:disabled) { background: #d5dde6; border-color: #d5dde6; }
.btn--solid:disabled {
  background: transparent; border-color: var(--line-2); color: var(--ink-4); font-weight: 500;
}

.btn--xs { height: 26px; padding: 0 9px; font-size: 12px; }
.btn--bulk { min-width: 172px; }
.btn--bulk:not(:disabled):hover { border-color: var(--bad-line); color: var(--bad-ink); background: #1a1214; }

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
.menu[open] > summary { background: #171d25; border-color: var(--line-3); }
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
  letter-spacing: -0.01em; color: #ffffff; white-space: nowrap;
}

.verdict-lede {
  margin: 8px 0 0; max-width: 62ch;
  font-size: 13.5px; line-height: 1.58; color: var(--ink-2);
}

.verdict-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
.verdict-note { font-size: 12px; color: var(--ink-4); }

/* ============================================================= grids == */

.cols {
  display: grid; grid-template-columns: minmax(0, 1fr) 356px;
  gap: 20px; margin-top: 20px; align-items: start;
}
.col-main, .rail { display: grid; gap: 20px; align-content: start; min-width: 0; }

/* ============================================================ panels == */

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-panel);
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
.skl-bar { display: block; height: 11px; border-radius: 3px; background: #171e26; }
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
  color: #cdd5de;
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
.chip--warn { color: var(--warn); border-color: #3d3520; background: #1d1a10; }

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
.filter input:focus { border-color: var(--focus); outline: none; box-shadow: 0 0 0 3px rgba(110, 168, 254, 0.16); }
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
.plist { max-height: 385px; overflow: auto; overscroll-behavior: contain; }

.pgroup {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 20px 7px;
  background: var(--panel); box-shadow: 0 1px 0 var(--line);
  font-size: 12px; font-weight: 600; color: var(--ink-3);
}
.pgroup span:last-child { font-weight: 400; color: var(--ink-4); }

.prow {
  display: grid; grid-template-columns: 36px minmax(0, 1fr) 84px;
  align-items: center; gap: 6px;
  height: 44px; padding: 0 20px 0 12px;
  border-bottom: 1px solid var(--line);
  transition: background-color 100ms ease;
}
.prow:last-child { border-bottom: 0; }
.prow:hover { background: #12171e; }
/* keyboard users get the same row cue as the pointer */
.prow:focus-within { background: #12171e; }

/* position: relative keeps the visually-hidden .sr label inside the clipped
   list box; without it the label anchors to the page and stretches the
   document scroll height by its own offset. */
.phit { position: relative; display: flex; align-items: center; justify-content: center; height: 44px; cursor: pointer; }

.cbx {
  appearance: none; -webkit-appearance: none;
  width: 16px; height: 16px; margin: 0; position: relative;
  border: 1px solid var(--line-3); border-radius: var(--r-chip);
  background: var(--bg); cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.cbx:hover { border-color: #4d5a6a; }
.cbx:checked { background: var(--sel); border-color: var(--sel); }
.cbx:checked::after {
  content: ""; position: absolute; left: 4.5px; top: 1.5px;
  width: 4px; height: 8px; border: solid #fff; border-width: 0 1.7px 1.7px 0;
  transform: rotate(40deg);
}
.cbx:disabled { opacity: 0.35; cursor: not-allowed; }
.cbx[aria-disabled="true"] { opacity: 0.35; }

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
  background: #2b333d; border: 3px solid transparent; background-clip: content-box; border-radius: 6px;
}
.plist::-webkit-scrollbar-thumb:hover, .rlist::-webkit-scrollbar-thumb:hover, #log::-webkit-scrollbar-thumb:hover { background: #3b4552; background-clip: content-box; }
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
  background: #080a0d;
  font: 12px/1.55 var(--mono); color: #c5cdd6;
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
body[data-busy="1"] .cbx { pointer-events: none; }

.net {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 16px; padding: 10px 14px;
  border: 1px solid var(--bad-line); border-radius: var(--r-ctl);
  background: var(--bad-bg); color: var(--bad-ink); font-size: 12.5px;
}
.net[hidden] { display: none; }

.sk { display: block; height: 11px; border-radius: 3px; background: #1a2028; }
.sk--title { height: 22px; width: 44%; }
.sk--lede  { width: 64%; margin-top: 10px; }
.sk--row   { height: 12px; width: 100%; }

/* ======================================================== responsive == */

@media (max-width: 1100px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .rail { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}

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
  .rail { grid-template-columns: minmax(0, 1fr); }
  .verdict { padding: 18px 16px 16px; }
  .verdict-title { font-size: 20px; }
  .panel-head { padding: 12px 16px; }
  .ledger { padding: 4px 16px 14px; }
  .prow { padding: 0 16px 0 8px; }
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
    grid-template-columns: 34px minmax(0, 1fr) auto;
    height: auto; min-height: 52px; padding: 7px 16px 7px 8px; gap: 2px 6px;
  }
  .pmain { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
  .ptags { justify-content: flex-start; }
  .phit { height: 44px; }
  .pact { align-self: center; }
  .frow { grid-template-columns: minmax(0, 1fr); }
  .frow-act { grid-row: auto; grid-column: 1; justify-self: start; margin-top: 4px; }
  .srow { grid-template-columns: 16px minmax(0, 1fr) auto; }
  .foot-note { margin-left: 0; text-align: left; width: 100%; }
  .btn--bulk { flex: 1 1 auto; }
}

@media (max-width: 420px) {
  .verdict-title { font-size: 20px; }
  .brand-name { font-size: 12.5px; }
}

/* Touch: the visual box stays dense, the target grows to 40px. */
@media (pointer: coarse) {
  .btn, .btn--xs { height: 40px; min-width: 40px; }
  .btn--xs { padding: 0 12px; }
  .phit { height: 48px; }
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

  <div class="cols">
    <div class="col-main">

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
          <button class="btn btn--bulk" type="button" id="disable-selected" data-act="disable-selected" disabled>
            Disable selected (0)
          </button>
          <button class="linkbtn" type="button" data-act="safe-mode" title="Keep only the two core bundles and remove every other bundle from the profile">Safe mode&hellip;</button>
          <span class="foot-note" id="pl-note">A snapshot is taken before every change.</span>
        </div>
      </section>

    </div>

    <aside class="rail">

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

    </aside>
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
  var picked = new Set();
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
    var hit = el('label', 'phit');

    if (mode === 'selected') {
      var box = el('input', 'cbx');
      box.type = 'checkbox';
      box.checked = picked.has(p.name);
      box.setAttribute('data-pick', p.name);
      box.setAttribute('data-key', 'chk:' + p.name);
      if (p.core) {
        box.setAttribute('aria-disabled', 'true');
        box.title = 'Core bundle: dsh-safe never disables it.';
      } else {
        box.setAttribute('aria-label', 'Select ' + p.name);
      }
      add(hit, box);
    } else {
      add(hit, el('span', 'sr'));
    }
    add(row, hit);

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
    if (mode === 'available') {
      add(act, actionBtn('Enable', 'enable-one', { name: p.name },
        null, state.appRunning, state.appRunning ? 'Quit DeepSeek Harness first.' : ''));
    }
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

    // drop picks that no longer exist
    var live = new Set(all.map(function (p) { return p.name; }));
    Array.from(picked).forEach(function (name) {
      if (!live.has(name)) picked.delete(name);
    });

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
    var bulk = $('disable-selected');
    var locked = Boolean(state && state.appRunning);
    bulk.textContent = 'Disable selected (' + picked.size + ')';
    bulk.disabled = picked.size === 0 || locked || !state;
    bulk.title = locked ? lockReason() : (picked.size === 0 ? 'Tick a plugin first.' : '');

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
    if (list.length > 1 && !confirm('Disable ' + list.length + ' plugins?\n\n' + list.join('\n'))) return;
    if (list.length === 1 && !confirm('Disable ' + list[0] + '?')) return;
    picked.clear();
    renderPlugins();
    syncActions();
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

  function pick(name, on) {
    if (on) picked.add(name);
    else picked.delete(name);
    syncActions();
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
    if (actName === 'disable-selected') { disable(Array.from(picked)); return; }
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

  document.addEventListener('change', function (event) {
    var box = event.target;
    if (!box || !box.getAttribute) return;
    var name = box.getAttribute('data-pick');
    if (!name) return;
    pick(name, box.checked);
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
})();
</script>
</body>
</html>
`;
