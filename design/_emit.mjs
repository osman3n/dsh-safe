/*
 * Emit the drop-in UI_HTML block from the preview.
 *
 *   node _emit.mjs
 *
 * recovery-preview.html is the page plus a preview stub. This script strips
 * the stub (and the preview-only comments) and writes the exact text that
 * belongs inside `const UI_HTML = String.raw` … `;` in dsh-safe.mjs, with the
 * boot line restored to `__BOOT__`. It refuses to write if the body would
 * break the template literal (backtick or ${).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'recovery-preview.html'), 'utf8');

const fail = (why) => {
  console.error('REFUSED: ' + why);
  process.exit(1);
};

/* 1. drop the preview stub, including its marker comment */
const STUB_MARK = '<!-- ======================= PREVIEW STUB';
const stubAt = src.indexOf(STUB_MARK);
if (stubAt < 0) fail('preview stub marker not found');
const stubEnd = src.indexOf('</script>', stubAt);
if (stubEnd < 0) fail('preview stub has no closing </script>');
let body = src.slice(0, stubAt) + src.slice(stubEnd + '</script>'.length);

/* 2. drop the preview-build comment that explains the stub */
const PREVIEW_DOC = '<!--\n  PREVIEW BUILD';
const docAt = body.indexOf(PREVIEW_DOC);
if (docAt < 0) fail('preview build comment not found');
body = body.slice(0, docAt) + body.slice(body.indexOf('-->', docAt) + 3);

/* 3. drop the page marker comment */
const PAGE_MARK = '<!-- ======================= PAGE (identical to UI_HTML) ======================= -->';
body = body.replace(PAGE_MARK, '');
if (body.includes('PREVIEW STUB') || body.includes('PAGE (identical to UI_HTML)')) {
  fail('a preview marker survived');
}

/* 4. the page's first line carries the injected boot JSON */
const LIVE_BOOT = 'window.__BOOT_STATE__ = window.__BOOT_STATE__ || null;';
if (!body.includes(LIVE_BOOT)) fail('preview boot line not found');
body = body.replace(LIVE_BOOT, 'window.__BOOT_STATE__ = __BOOT__;');

/* 5. trim to the document and tidy the seams the removals left behind */
const start = body.indexOf('<!doctype html>');
const end = body.indexOf('</html>') + '</html>'.length;
if (start < 0 || end < 7) fail('document bounds not found');
body = body.slice(start, end) + '\n';
body = body.replace(/\n{3,}/g, '\n\n');

/* 6. template-literal safety */
if (body.includes('`')) fail('body contains a backtick');
if (body.includes('${')) fail('body contains ${');
if ((body.match(/__BOOT__/g) || []).length !== 1) fail('expected exactly one __BOOT__ placeholder');

const out = `/* dsh-safe recovery page
 *
 * Do not edit by hand to change behaviour: the design study lives in
 * design/recovery-preview.html and design/README.md. This string is rendered
 * by createUiServer() with the boot-time state substituted into the single
 * placeholder below.
 */
const UI_HTML = String.raw\`${body}\`;
`;

writeFileSync(join(here, 'ui-html.block.js'), out, 'utf8');

const lines = body.split('\n').length;
console.log(`ui-html.block.js  ${lines} lines, ${body.length} chars, ${(out.length / 1024).toFixed(1)} kB`);
console.log(`  css ${(body.match(/<style>[\s\S]*?<\/style>/) || [''])[0].length} chars`);
console.log(`  js  ${(body.match(/<script>[\s\S]*?<\/script>/) || [''])[0].length} chars`);