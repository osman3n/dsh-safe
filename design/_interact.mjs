/*
 * Interaction screenshots: run script in the page, optionally move the mouse,
 * then capture. Used for hover, focus, selection and dock states.
 *
 *   node _interact.mjs <file-url> <out-name> [--js "<expr>"] [--hover "x,y"] [--wait 600]
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 9336;

const args = process.argv.slice(2);
const url = args[0];
const name = args[1];
const get = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
};
const script = get('--js');
const hover = get('--hover');
const wait = Number(get('--wait') || 700);

if (!url || !name) {
  console.error('usage: node _interact.mjs <file-url> <out-name> [--js "<expr>"] [--hover "x,y"] [--wait ms]');
  process.exit(2);
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(here, '_chrome-profile')}`, 'about:blank',
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
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url });
await sleep(1500);

if (script) {
  const out = await send('Runtime.evaluate', { expression: script, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) logs.push('SCRIPT: ' + out.exceptionDetails.text);
  await sleep(wait);
} else {
  await sleep(wait);
}

if (hover) {
  const [x, y] = hover.split(',').map(Number);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(240);
}

const { data } = await send('Page.captureScreenshot', { format: 'png' });
const file = join(here, `${name}.png`);
writeFileSync(file, Buffer.from(data, 'base64'));
console.log(`${name}.png  1440x900` + (logs.length ? '  ' + logs.join(' | ') : ''));
ws.close();
chrome.kill();