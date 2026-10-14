'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openStore } = require('../src/store/db');
const { importLegacy, parseDateVN } = require('../src/store/importLegacy');
const { runEnrich, markRepublished, ENRICH_VERSION } = require('../src/enrich/enrich');
const { exportCsv, splitContent, CELL_LIMIT } = require('../src/output/export');
const { createCsvWriter } = require('../src/output/artifacts');
const { readCsvFile, parseCsv } = require('../src/output/csvRead');
const { createClassifier } = require('../src/utils/articleClassifier');
const { loadProfile } = require('../src/config/profile');
const { buildSearchPlan } = require('../src/crawler/plan');
const { isPublishDateWithinRange } = require('../src/index');

const profile = loadProfile('insurance-vn');
const range = { from: '2024-01-01', to: '2024-01-31' };

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-store-'));
  const store = openStore(path.join(dir, 'news.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}
const save = (store, id, extra = {}) => store.saveArticle({ articleId: id, url: `https://${extra.domain || 'a.vn'}/${id}`,
  publisherDomain: extra.domain || 'a.vn', title: 'Tiêu đề', titleNorm: 'tieu de', publishDate: '2024-01-10T02:00:00.000Z',
  body: 'Nội dung', ...extra });

test('content splits into two CSV cells at a space, and the remainder always fits the second cell', () => {
  assert.deepEqual(splitContent('ngắn'), ['ngắn', '']);
  const words = 'chữ '.repeat(15000).trim(); // 59,999 characters.
  const [first, second] = splitContent(words);
  assert.ok(first.length <= CELL_LIMIT && second.length <= CELL_LIMIT);
  assert.equal(`${first} ${second}`, words);
  assert.ok(!first.endsWith(' ') && !second.startsWith(' '));
  const solid = 'x'.repeat(40000);
  assert.deepEqual(splitContent(solid).map(part => part.length), [CELL_LIMIT, 8000]);
  // The cut moves left of the limit only as far as the second cell can absorb.
  const tight = `${'y'.repeat(31990)} ${'z'.repeat(32005)}`;
  const parts = splitContent(tight);
  assert.ok(parts[1].length <= CELL_LIMIT);
  assert.equal(parts.join('').length, tight.length);
});

test('CSV reader round-trips quoted cells, embedded newlines and the BOM', async t => {
  const { dir } = tempStore(t);
  const file = path.join(dir, 'rows.csv');
  const writer = createCsvWriter(file);
  await writer.writeRow({ brand: 'A', article_title: 'Có "nháy", dấu phẩy', content: 'dòng 1\ndòng 2', article_id: 'art_1' });
  await writer.finalize();
  const [row] = readCsvFile(file);
  assert.equal(row.brand, 'A');
  assert.equal(row.article_title, 'Có "nháy", dấu phẩy');
  assert.equal(row.content, 'dòng 1\ndòng 2');
  assert.deepEqual(parseCsv('a,b\n1,2'), [{ a: '1', b: '2' }]);
});

test('republished stories point to the earliest copy at another publisher', t => {
  const { store } = tempStore(t);
  const title = 'prudential viet nam ra mat san pham bao hiem moi cho gia dinh';
  save(store, 'first', { domain: 'a.vn', titleNorm: title, publishDate: '2024-01-10T02:00:00.000Z' });
  save(store, 'copy', { domain: 'b.vn', titleNorm: title, publishDate: '2024-01-11T02:00:00.000Z' });
  save(store, 'same-site', { domain: 'a.vn', titleNorm: title, publishDate: '2024-01-12T02:00:00.000Z' });
  save(store, 'same-body', { domain: 'c.vn', titleNorm: 'tieu de khac han', contentHash: 'h1', publishDate: '2024-01-13T02:00:00.000Z' });
  save(store, 'body-source', { domain: 'd.vn', titleNorm: 'mot tieu de khac', contentHash: 'h1', publishDate: '2024-01-09T02:00:00.000Z' });
  save(store, 'short', { domain: 'e.vn', titleNorm: 'bao hiem', publishDate: '2024-01-14T02:00:00.000Z' });
  save(store, 'short-2', { domain: 'f.vn', titleNorm: 'bao hiem', publishDate: '2024-01-15T02:00:00.000Z' });
  assert.equal(markRepublished(store), 2);
  const of = id => store.getArticle(id).republished_of;
  assert.equal(of('copy'), 'first');
  assert.equal(of('same-site'), null); // Same publisher: not a republication.
  assert.equal(of('same-body'), 'body-source');
  assert.equal(of('short-2'), null); // Short titles are too common to prove a copy.
});

test('a legacy checkpoint imports queries, URLs and accepted rows; export reproduces the old CSV and enrich re-reads bodies', async t => {
  const { dir, store } = tempStore(t);
  const prudential = profile.brands.find(def => def.brand === 'Prudential Viet Nam');
  const plan = buildSearchPlan([prudential], range, { publishers: profile.publishers, web: false });
  const journal = path.join(dir, 'old.csv.state.jsonl');
  const card = (id, url) => ({ id, url, title: 't', publisherDomain: 'example.vn', brand: prudential.brand });
  const row = { brand: prudential.brand, mentioned_brands: prudential.brand, article_title: 'Prudential ra mắt',
    article_url: 'https://example.vn/good.html', publisher_domain: 'example.vn', publisher_homepage: 'https://example.vn',
    publish_date: '09:00:00 12/01/2024', sentiment: 'positive', classification_source: 'gemini', article_id: 'art_000000000001' };
  fs.writeFileSync(journal, [
    { type: 'config', value: { version: 1, dateRange: range, brands: [prudential.brand], plan: plan.map(task => task.id) } },
    { type: 'query', id: plan[0].id, cards: [card('c1', 'https://news.google.com/rss/articles/A1'), card('c2', 'https://example.vn/noise.html')],
      value: { status: 'done', results: 2 } },
    { type: 'candidate', id: 'c1', value: { status: 'accepted', row, identity: { finalUrl: row.article_url, title: row.article_title } } },
    { type: 'candidate', id: 'c2', value: { status: 'rejected', reason: 'No target mention' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n{"type":"cand');
  const counts = importLegacy(store, profile, journal);
  assert.deepEqual(counts, { queries: 1, urls: 2, articles: 1, labels: 1 });
  // Importing again adds nothing.
  assert.deepEqual(importLegacy(store, profile, journal), { queries: 0, urls: 0, articles: 0, labels: 0 });
  assert.equal(store.getQuery(plan[0].id).kind, plan[0].kind);
  assert.deepEqual(store.sql('SELECT status FROM discovered_urls ORDER BY status').all().map(r => r.status), ['fetched', 'legacy-rejected']);
  assert.equal(parseDateVN('09:00:00 12/01/2024'), '2024-01-12T02:00:00.000Z');

  const output = path.join(dir, 'out.csv');
  await exportCsv(store, { profile, dateRange: range, withinRange: isPublishDateWithinRange, outputPath: output });
  const [exported] = readCsvFile(output);
  for (const key of Object.keys(row)) assert.equal(exported[key], row[key], key);

  // Enrich reads the missing body but keeps the imported label.
  const fetched = [];
  const classifier = createClassifier(profile);
  const stats = await runEnrich(store, { profile, classifier, fetchArticle: async url => {
    fetched.push(url);
    return { finalUrl: url, articleTitle: 'Prudential ra mắt', articleText: 'Prudential Việt Nam ra mắt. '.repeat(20),
      publishDate: '2024-01-12T02:00:00.000Z', meta: { sapo: 'Sapo', tags: ['bảo hiểm'], prSignals: [] }, fetchMethod: 'http' };
  } });
  assert.deepEqual(fetched, [row.article_url]);
  assert.equal(stats.refetched, 1);
  assert.equal(stats.classified, 0);
  assert.equal(store.getArticle(row.article_id).content_status, 'ok');
  assert.equal(store.getLabel(row.article_id, profile.name).sentiment, 'positive');
  await runEnrich(store, { profile, classifier, fetchArticle: async () => assert.fail('no refetch once the body is stored') });
});

test('a daily CSV written by the old version keeps its rows when new columns are added', async t => {
  const { dir, store } = tempStore(t);
  const output = path.join(dir, 'daily.csv');
  fs.writeFileSync(output, '﻿brand,mentioned_brands,article_title,article_url,publisher_domain,publisher_homepage,publish_date,sentiment,classification_source,article_id\n' +
    'AIA Viet Nam,AIA Viet Nam,"Bài cũ, có phẩy",https://a.vn/old,a.vn,https://a.vn,07:00:00 01/01/2024,neutral,rules,art_old\n');
  save(store, 'art_new', { title: 'AIA Việt Nam ra mắt', body: 'AIA Việt Nam ra mắt sản phẩm bảo hiểm nhân thọ. '.repeat(10) });
  store.saveLabel('art_new', profile.name, { relevance: 'accepted', label: 'AIA Viet Nam', mentionedBrands: ['AIA Viet Nam'],
    sentiment: 'neutral', source: 'rules', enrichVersion: ENRICH_VERSION });
  const first = await exportCsv(store, { profile, dateRange: range, withinRange: isPublishDateWithinRange, outputPath: output, daily: true });
  assert.deepEqual([first.added, first.rows], [1, 2]);
  const rows = readCsvFile(output);
  assert.equal(rows[0].article_title, 'Bài cũ, có phẩy');
  assert.equal(rows[0].content, '');
  assert.ok(rows[1].content.startsWith('AIA Việt Nam ra mắt'));
  const again = await exportCsv(store, { profile, dateRange: range, withinRange: isPublishDateWithinRange, outputPath: output, daily: true });
  assert.equal(again.added, 0);
});
