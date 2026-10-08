'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { patchFile } = require('../scripts/patch-playwright-extra');

test('playwright-extra page caches become WeakMaps, idempotently', t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-extra-')), 'index.cjs.js');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, 'const cache = {\n    objectToShim: new Map(),\n    cdpSession: {\n        page: new Map(),\n        browser: new Map()\n    }\n};\n');
  assert.equal(patchFile(file), 'patched');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /new Map\(\)/);
  assert.equal(patchFile(file), 'already patched');
  fs.writeFileSync(file, 'const other = new Map();\n');
  assert.equal(patchFile(file), 'cache block not found');
});

test('installed playwright-extra is patched', () => {
  const file = path.join(path.dirname(require.resolve('playwright-extra/package.json')), 'dist', 'index.cjs.js');
  assert.match(fs.readFileSync(file, 'utf8'), /objectToShim: new WeakMap\(\)/);
});
