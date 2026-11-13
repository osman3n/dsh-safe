/*
 * Prove the emitted block is the page.
 *
 *   node _verify.mjs
 *
 * Takes ui-html.block.js, substitutes a real boot state for __BOOT__ the same
 * way createUiServer() does, writes _verify.html, loads it in Chrome and
 * reports console errors plus the rendered structure. The api/state fetch is
 * expected to fail on file://, so the inline error bar must be present — that
 * is the error state being exercised, not a fault.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const here = dirname(fileURLToPath(import.meta.url));
const PORT = 9337;
const PREVIEW = pathToFileURL(join(here, 'recovery-preview.html')).href + '?state=failed';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars',
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

/* 1. a real boot state from the preview */
await send('Page.navigate', { url: PREVIEW });
await sleep(1500);
const boot = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__BOOT_STATE__)', returnByValue: true });
const bootJson = boot.result.value;
if (!bootJson || bootJson.length < 100) throw new Error('no boot state');

/* 2. splice it into the emitted block, exactly like createUiServer() */
const block = readFileSync(join(here, 'ui-html.block.js'), 'utf8');
const open = block.indexOf('String.raw`') + 'String.raw`'.length;
const close = block.lastIndexOf('`;');
const body = block.slice(open, close);
const html = body.replace('__BOOT__', bootJson);
writeFileSync(join(here, '_verify.html'), html, 'utf8');

/* 3. load it cold */
logs.length = 0;
await send('Page.navigate', { url: pathToFileURL(join(here, '_verify.html')).href });
await sleep(1500);
const probe = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(function () {
    var bar = document.getElementById('net-error');
    return {
      title: document.title,
      h1: (document.querySelector('h1') || {}).textContent,
      verdictLedger: document.querySelectorAll('.stage').length,
      failedRows: document.querySelectorAll('.frow').length,
      suspects: document.querySelectorAll('.srow').length,
      pluginRows: document.querySelectorAll('.prow').length,
      snapshots: document.querySelectorAll('.rrow').length,
      operations: document.querySelectorAll('.arow').length,
      logText: (document.getElementById('log') || {}).textContent,
      netErrorShown: !!bar && bar.offsetParent !== null,
      docHeight: document.documentElement.scrollHeight,
    };
  })()`,
});

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(here, 'shot-verify.png'), Buffer.from(shot.data, 'base64'));

console.log(JSON.stringify({ rendered: probe.result.value, consoleProblems: logs }, null, 1));
ws.close();
chrome.kill();