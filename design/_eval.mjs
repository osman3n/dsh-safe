/*
 * Evaluate JavaScript inside the preview and report console output.
 *
 *   node _eval.mjs <file-url> "<js expression>" [waitMs]
 *
 * Prints the expression result as JSON plus every console message and uncaught
 * error the page produced. Chrome is started with the same flags as _shot.mjs
 * so the two helpers agree on rendering.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 9334;

const url = process.argv[2];
const expr = process.argv[3];
const wait = Number(process.argv[4] || 1600);
if (!url || !expr) {
  console.error('usage: node _eval.mjs <file-url> "<js>" [waitMs]');
  process.exit(2);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
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
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    logs.push('LOG error: ' + msg.params.entry.text);
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
await send('Log.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});
await send('Page.navigate', { url });
await sleep(wait);

const out = await send('Runtime.evaluate', {
  expression: expr, returnByValue: true, awaitPromise: true,
});

console.log(JSON.stringify({
  result: out.result?.value ?? out.result?.description ?? null,
  threw: out.exceptionDetails?.text ?? null,
  logs,
}, null, 1));

ws.close();
chrome.kill();