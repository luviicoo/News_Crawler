'use strict';

/**
 * playwright-extra caches a wrapper (and a CDP session) for every page it sees
 * in plain Maps and never removes them, so each closed article tab stays in
 * memory with its frames and requests. A long crawl ran out of memory after
 * ~16 hours. The caches are only used with get/has/set, so WeakMaps keep the
 * behaviour and let closed pages be garbage-collected.
 *
 * Runs on postinstall; safe to run repeatedly.
 */
const fs = require('fs');
const path = require('path');

const CACHE_BLOCK = /const cache = \{\s*objectToShim: new Map\(\),\s*cdpSession: \{\s*page: new Map\(\),\s*browser: new Map\(\)\s*\}\s*\};/;
const PATCHED_BLOCK = `const cache = {
    objectToShim: new WeakMap(),
    cdpSession: {
        page: new WeakMap(),
        browser: new WeakMap()
    }
};`;

function patchFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('objectToShim: new WeakMap()')) return 'already patched';
  if (!CACHE_BLOCK.test(source)) return 'cache block not found';
  fs.writeFileSync(file, source.replace(CACHE_BLOCK, PATCHED_BLOCK));
  return 'patched';
}

function main() {
  let dist;
  try {
    dist = path.join(path.dirname(require.resolve('playwright-extra/package.json')), 'dist');
  } catch (_) {
    console.warn('[patch-playwright-extra] playwright-extra not installed; skipped.');
    return;
  }
  for (const name of ['index.cjs.js', 'index.esm.js']) {
    const file = path.join(dist, name);
    if (!fs.existsSync(file)) continue;
    const result = patchFile(file);
    // A new playwright-extra version may have changed or fixed the cache.
    (result === 'cache block not found' ? console.warn : console.log)(`[patch-playwright-extra] ${name}: ${result}`);
  }
}

if (require.main === module) main();

module.exports = { patchFile };
