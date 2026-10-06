'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require('playwright');
const { searchGoogleNewsRss, getSearchStats, resetSearchStats } = require('../src/crawler/google');

// Exercise browser discovery against controlled Google-shaped HTML, with real
// Chromium DOM/pagination and no Google traffic or writes to the saved session.
function isolatedGoogle(page) {
  const file = path.resolve(__dirname, '../src/crawler/google.js');
  const actualRequire = createRequire(file);
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, __dirname: path.dirname(file), process,
    URL, AbortSignal, fetch: globalThis.fetch,
    setTimeout: callback => setTimeout(callback, 0),
    require: name => {
      if (name === './browser') return { getGooglePage: async () => page,
        saveGoogleSession: async () => {}, verifyInPopup: async () => false };
      if (name === 'fs') return { ...fs, mkdirSync: () => {}, writeFileSync: () => {} };
      if (name === '../output/logger') return new Proxy({}, { get: () => () => {} });
      return actualRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return module.exports;
}

test('web discovery unwraps article links, paginates and reports a page cap using real DOM', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const visited = [];
    await page.route('https://www.google.com/**', route => {
      const url = new URL(route.request().url());
      visited.push(url);
      const second = url.searchParams.get('start') === '10';
      const third = url.searchParams.get('start') === '20';
      const body = third ? '<div id="search">Không tìm thấy kết quả</div>' : `
        <a href="https://example.vn/sidebar">Outside results must be ignored</a>
        <div id="search">
          <a href="https://www.google.com/url?q=https%3A%2F%2Fexample.vn%2Farticle-one"><h3>Tin bảo hiểm thứ nhất</h3></a>
          <a href="https://www.google.com/preferences"><h3>Google preferences</h3></a>
          ${second ? '<a href="https://example.vn/article-two"><h3>Tin bảo hiểm thứ hai</h3></a>' : ''}
          <a id="pnnext" href="https://www.google.com/search?start=${second ? 20 : 10}">Next</a>
        </div>`;
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    });
    const google = isolatedGoogle(page);
    const opts = { dateRange: { from: '2018-01-01', to: '2018-01-31' }, maxPages: 1 };
    const limited = await google.searchGoogleWeb('Prudential Viet Nam', '"Prudential" site:example.vn', opts);
    assert.equal(limited.truncated, true);
    assert.equal(limited.cards.length, 1);
    assert.equal(limited.cards[0].url, 'https://example.vn/article-one');
    assert.match(visited[0].searchParams.get('q'), /after:2017-12-31 before:2018-02-01/);
    const full = await google.searchGoogleWeb('Prudential Viet Nam', '"Prudential"', { ...opts, maxPages: 3 });
    assert.equal(full.truncated, false);
    assert.equal(full.pages, 3);
    assert.equal(full.cards.length, 2);
    await page.unroute('https://www.google.com/**');
    await page.route('https://www.google.com/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="search">Unknown search layout</div>' }));
    await assert.rejects(google.searchGoogleWeb('Prudential Viet Nam', 'Prudential', opts), /no article headings/);
  } finally { await browser.close(); }
});

test('saturated short RSS windows split to individual days and preserve unresolved day limits', async () => {
  resetSearchStats();
  const queries = [];
  const stub = test.mock.method(globalThis, 'fetch', async url => {
    const query = new URL(url).searchParams.get('q');
    queries.push(query);
    const parent = query.includes('before:2024-01-03') && query.includes('after:2023-12-31');
    const firstDay = query.includes('before:2024-01-02');
    const count = parent || firstDay ? 100 : 1;
    const prefix = parent ? 'parent' : firstDay ? 'day1' : 'day2';
    const items = Array.from({ length: count }, (_, i) => `<item><title>Prudential ${i}</title><link>https://example.vn/${prefix}/${i}</link></item>`).join('');
    return { ok: true, text: async () => `<rss><channel>${items}</channel></rss>` };
  });
  try {
    const cards = await searchGoogleNewsRss('Prudential', { from: '2024-01-01', to: '2024-01-02' });
    assert.equal(queries.length, 3);
    assert.equal(cards.length, 201);
    assert.equal(getSearchStats().saturatedDayQueries.length, 1);
    assert.deepEqual(getSearchStats().saturatedDayQueries[0].dateRange, { from: '2024-01-01', to: '2024-01-01' });
  } finally { stub.mock.restore(); }
});

test('stop requests prevent further recursive RSS searches', async () => {
  let stopped = false;
  const stub = test.mock.method(globalThis, 'fetch', async () => {
    stopped = true;
    const items = Array.from({ length: 100 }, (_, i) => `<item><title>Prudential ${i}</title><link>https://example.vn/${i}</link></item>`).join('');
    return { ok: true, text: async () => `<rss><channel>${items}</channel></rss>` };
  });
  try {
    await assert.rejects(searchGoogleNewsRss('Prudential', { from: '2018-01-01', to: '2026-09-30' }, { shouldStop: () => stopped }), /interrupted/);
    assert.equal(stub.mock.callCount(), 1);
  } finally { stub.mock.restore(); }
});
