/*
 * Keyboard + contrast audit for the recovery preview.
 *
 *   node _a11y.mjs <file-url> [tabSteps]
 *
 * 1. Presses Tab N times through the page and records what receives focus,
 *    whether the focus ring is painted, and the accessible name.
 * 2. Computes WCAG contrast for the text/background pairs the design relies on.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 9335;

const url = process.argv[2];
const steps = Number(process.argv[3] || 26);
if (!url) {
  console.error('usage: node _a11y.mjs <file-url> [tabs]');
  process.exit(2);
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(here, '_chrome-profile')}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('Chrome did not expose a page target');
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const waiting = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.id && waiting.has(msg.id)) {
    const { res, rej } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    id += 1;
    waiting.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url });
await sleep(1600);

/* ------------------------------------------------------------- tab run -- */
const describe = `(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { tag: 'BODY' };
  const cs = getComputedStyle(a);
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
    || cs.boxShadow !== 'none';
  const label = a.getAttribute('aria-label')
    || (a.labels && a.labels[0] && a.labels[0].textContent.trim())
    || a.textContent.trim().slice(0, 48)
    || a.getAttribute('placeholder') || '';
  const r = a.getBoundingClientRect();
  return {
    tag: a.tagName.toLowerCase(),
    cls: a.className && String(a.className).slice(0, 30),
    name: label,
    ring,
    box: [Math.round(r.width), Math.round(r.height)],
  };
})()`;

const order = [];
for (let i = 0; i < steps; i += 1) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
  await sleep(30);
  order.push(await evaluate(describe));
}

/* ------------------------------------------------------------ contrast -- */
const contrast = await evaluate(`(() => {
  const lum = (c) => {
    const [r, g, b] = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const parse = (str) => {
    const m = str.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((n) => parseFloat(n));
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  };
  const bgOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const b = parse(getComputedStyle(node).backgroundColor);
      if (b && b.a > 0.95) return b.rgb;
      node = node.parentElement;
    }
    return [10, 12, 15];
  };
  const pair = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return { label, missing: true };
    const cs = getComputedStyle(el);
    const fg = parse(cs.color).rgb;
    const bg = bgOf(el);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    return {
      label,
      size: cs.fontSize,
      weight: cs.fontWeight,
      fg: '#' + fg.map((n) => Math.round(n).toString(16).padStart(2, '0')).join(''),
      bg: '#' + bg.map((n) => Math.round(n).toString(16).padStart(2, '0')).join(''),
      ratio: Math.round(ratio * 100) / 100,
      pass: ratio >= (parseFloat(cs.fontSize) >= 18.66 ? 3 : 4.5),
    };
  };
  return [
    pair('.verdict-title', 'verdict title'),
    pair('.verdict-lede', 'verdict lede'),
    pair('.verdict-meta .mono', 'evidence file'),
    pair('.verdict-meta .num', 'counts'),
    pair('.panel-title', 'panel title'),
    pair('.pname', 'plugin name'),
    pair('.pwhen', 'plugin meta'),
    pair('.pgroup', 'list group label'),
    pair('.srow-name', 'suspect name'),
    pair('.srow-why', 'suspect reason'),
    pair('.frow-err', 'failed error line'),
    pair('.quote', 'log quote'),
    pair('.stage-label', 'stage label'),
    pair('.stage-note', 'stage note'),
    pair('.rrow-label', 'snapshot label'),
    pair('.rrow-when', 'snapshot date'),
    pair('.btn', 'button label'),
    pair('.btn--solid', 'primary button'),
    pair('.linkbtn', 'text button'),
    pair('.app-state', 'app state'),
    pair('.dock-state', 'dock state'),
    pair('.foot-note', 'foot note'),
    pair('.panel-empty strong', 'empty state title'),
    pair('.chip--bad', 'status chip'),
    pair('.rrow-sub', 'snapshot id'),
    pair('.sr', 'activity row'),
    pair('.dock-hint', 'dock hint'),
    pair('.verdict-note', 'verdict note'),
  ];
})()`);

console.log(JSON.stringify({ tab: order, contrast, logs }, null, 1));
ws.close();
chrome.kill();