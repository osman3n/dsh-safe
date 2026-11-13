/*
 * Screenshot helper for the recovery preview.
 *
 * Chrome headless clamps --window-size to a 502px minimum on Windows, so a
 * 390px shot is really a 502px layout cropped to 390. This drives CDP with
 * Emulation.setDeviceMetricsOverride instead, which is the only way to get a
 * true 390px (or any) layout viewport.
 *
 *   node _shot.mjs <file-url> 390x844 768x1024 1440x900
 *
 * Writes design/shot-<width>.png for each size. Node >= 22 (global WebSocket).
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 9333;

const url = process.argv[2];
const sizes = process.argv.slice(3).map((s) => s.split('x').map(Number));
if (!url || !sizes.length) {
  console.error('usage: node _shot.mjs <file-url> 390x844 [768x1024 ...]');
  process.exit(2);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(here, '_chrome-profile')}`,
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
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

await send('Page.enable');

for (const [width, height] of sizes) {
  const full = height === 0;
  await send('Emulation.setDeviceMetricsOverride', {
    width, height: full ? 900 : height, deviceScaleFactor: 1, mobile: width < 700,
  });
  await send('Page.navigate', { url });
  await sleep(1400); // preview stub resolves api/state after ~520ms
  // PRE_JS runs after settle and before capture: use it to pin a state or to
  // hide the fixed dock, which captureBeyondViewport draws at the wrong place.
  if (process.env.PRE_JS) {
    await send('Runtime.evaluate', { expression: process.env.PRE_JS, awaitPromise: false });
    await sleep(250);
  }
  const { data } = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: full,
  });
  const out = join(here, `shot-${width}${full ? '-full' : ''}${process.env.TAG ? '-' + process.env.TAG : ''}.png`);
  writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`${out.split(/[\\/]/).pop()}  ${width}x${full ? 'auto' : height}`);
}

ws.close();
chrome.kill();