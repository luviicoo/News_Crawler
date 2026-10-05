'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BRANDS } = require('../src/config/brands');
const { formatDateVN, parseToISO } = require('../src/parser/dateParser');
const {
  buildHomepage,
  extractHostname,
  isDuplicate,
  markSeen,
  normalizeUrl,
  resetSeenUrls,
  resolveGoogleRedirect,
  seenCount,
} = require('../src/parser/urlParser');
const { createCsvWriter, isoToDateSlug, slugify } = require('../src/output/artifacts');
const { classifyArticle, normalizeText } = require('../src/utils/articleClassifier');

test('date helpers parse and format Vietnam dates', () => {
  assert.equal(parseToISO('15/03/2024'), '2024-03-15T00:00:00.000Z');
  assert.equal(formatDateVN('2019-02-28T23:30:01.000Z'), '06:30:01 01/03/2019');
  assert.equal(isoToDateSlug('2026-09-01T18:00:00.000Z'), '20260902');
});

test('URL helpers unwrap, normalize and derive publisher values', () => {
  const redirect = 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa&sa=x';
  assert.equal(resolveGoogleRedirect(redirect), 'https://example.com/a');
  assert.equal(
    normalizeUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1#fragment'),
    'https://www.example.com/a?a=1&b=2'
  );
  assert.equal(
    normalizeUrl('HTTPS://WWW.Example.com/a'),
    'https://www.example.com/a'
  );
  assert.equal(extractHostname('https://www.vnexpress.net/article'), 'vnexpress.net');
  assert.equal(buildHomepage('vnexpress.net'), 'https://vnexpress.net');
});

test('URL deduplication shares URL normalization', () => {
  resetSeenUrls();
  markSeen('https://example.com/story?utm_source=newsletter');
  assert.equal(isDuplicate('https://example.com/story'), true);
  assert.equal(seenCount(), 1);
  assert.equal(isDuplicate('https://example.com/story', 'AIA Viet Nam'), false);
  markSeen('https://example.com/story', 'AIA Viet Nam');
  assert.equal(isDuplicate('https://example.com/story', 'AIA Viet Nam'), true);
  assert.equal(isDuplicate('https://example.com/story', 'FWD Viet Nam'), false);
  resetSeenUrls();
});

test('text normalization preserves Vietnamese d-stroke as d', () => {
  assert.equal(normalizeText('Đồng hành, dẫn đầu'), 'dong hanh dan dau');
});

test('rules classifier accepts a target brand and rejects obvious noise', async () => {
  const target = BRANDS.find(({ brand }) => brand === 'Prudential Viet Nam');
  const env = { CLASSIFIER_MODE: 'rules' };

  const accepted = await classifyArticle(
    { title: 'Prudential Việt Nam chi trả quyền lợi bảo hiểm', url: 'https://example.com/a' },
    target,
    BRANDS,
    env
  );
  assert.equal(accepted.decision, 'accept');

  const rejected = await classifyArticle(
    { title: 'Kết quả bóng đá hôm nay', url: 'https://example.com/b' },
    target,
    BRANDS,
    env
  );
  assert.equal(rejected.decision, 'reject');
});

test('classifier handles sponsorship, foreign companies, Bao Viet ambiguity, and multi-brand titles', async () => {
  const rules = { CLASSIFIER_MODE: 'rules' };
  const fwd = BRANDS.find(({ brand }) => brand === 'FWD Viet Nam');
  const prudential = BRANDS.find(({ brand }) => brand === 'Prudential Viet Nam');
  const baoViet = BRANDS.find(({ brand }) => brand === 'Bao Viet Nhan Tho');
  const aia = BRANDS.find(({ brand }) => brand === 'AIA Viet Nam');

  const sponsorship = await classifyArticle(
    { title: 'FWD tài trợ giải bóng đá', url: 'https://example.com/fwd' },
    fwd,
    BRANDS,
    rules
  );
  assert.equal(sponsorship.decision, 'reject');

  for (const title of ['Prudential Financial báo lãi quý 3', 'Prudential plc công bố kết quả']) {
    const foreign = await classifyArticle({ title, url: 'https://example.com/foreign' }, prudential, BRANDS, rules);
    assert.equal(foreign.decision, 'reject');
  }

  const nonLife = await classifyArticle(
    { title: 'Bảo hiểm Bảo Việt chi trả bồi thường xe cơ giới', url: 'https://example.com/non-life' },
    baoViet,
    BRANDS,
    rules
  );
  assert.equal(nonLife.decision, 'reject');

  const title = 'AIA, FWD và Prudential hợp tác thúc đẩy thị trường bảo hiểm';
  for (const target of [aia, fwd, prudential]) {
    const result = await classifyArticle({ title, url: 'https://example.com/multi' }, target, BRANDS, rules);
    assert.equal(result.decision, 'accept');
    assert.equal(result.brand, target.brand);
    assert.deepEqual(result.matched_brands.sort(), [
      'AIA Viet Nam',
      'FWD Viet Nam',
      'Prudential Viet Nam',
    ].sort());
  }
});

test('artifact module writes UTF-8 BOM CSV and creates stable slugs', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-scraper-test-'));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const outputPath = path.join(tempDir, 'articles.csv');
  const csv = createCsvWriter(outputPath);
  await csv.writeRow({
    brand: 'AIA Viet Nam',
    article_title: 'Tiêu đề, có dấu phẩy',
    article_url: 'https://example.com/article',
    publisher_domain: 'example.com',
    publisher_homepage: 'https://example.com',
    publish_date: '07:00:00 01/01/2026',
    sentiment: 'neutral',
    classification_source: 'rules',
  });
  await csv.finalize();

  const content = fs.readFileSync(outputPath, 'utf8');
  assert.equal(content.charCodeAt(0), 0xFEFF);
  assert.match(content, /"Tiêu đề, có dấu phẩy"/);
  assert.equal(slugify('Bảo Việt Nhân Thọ'), 'bao_viet_nhan_tho');
});
