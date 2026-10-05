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
  assert.match(content.split('\n')[0], /,article_id$/);
  assert.equal(slugify('Bảo Việt Nhân Thọ'), 'bao_viet_nhan_tho');
});

test('article key treats language, AMP, mobile and configured slug-ID variants as one article', () => {
  const { buildArticleKey, isDuplicate, markSeen } = require('../src/parser/urlParser');

  const vn = buildArticleKey('https://www.prudential.com.vn/vn/tin-tuc/bai-viet-a/');
  assert.equal(buildArticleKey('https://prudential.com.vn/en/tin-tuc/bai-viet-a?lang=en'), vn);
  assert.equal(buildArticleKey('https://m.prudential.com.vn/vi-vn/tin-tuc/bai-viet-a/amp'), vn);
  assert.notEqual(buildArticleKey('https://prudential.com.vn/en/tin-tuc/bai-viet-b'), vn);

  assert.equal(
    buildArticleKey('https://vietnam.vn/prudential-viet-nam-giu-vung-vi-the-298454'),
    buildArticleKey('https://vietnam.vn/prudential-viet-nam-giu-vung-vi-the')
  );
  // A year is not an ID suffix: different reports must stay distinct.
  assert.notEqual(
    buildArticleKey('https://vietnam.vn/prudential-cong-bo-bao-cao-tai-chinh-2024'),
    buildArticleKey('https://vietnam.vn/prudential-cong-bo-bao-cao-tai-chinh-2025')
  );
  // Numeric suffix is the article ID on other sites: must stay distinct.
  assert.notEqual(
    buildArticleKey('https://vnexpress.net/bai-viet-4567890.html'),
    buildArticleKey('https://vnexpress.net/bai-viet-4567891.html')
  );

  resetSeenUrls();
  markSeen('https://site.vn/vn/a', 'AIA Viet Nam');
  assert.equal(isDuplicate('https://site.vn/en/a', 'AIA Viet Nam'), true);
  resetSeenUrls();
});

test('article registry merges same article across URLs but not on weak evidence', () => {
  const { createArticleRegistry } = require('../src/parser/articleIdentity');
  const registry = createArticleRegistry();
  const scope = 'Prudential Viet Nam';

  const first = registry.claim({
    scope,
    finalUrl: 'https://site.vn/vn/tin-tuc/ra-mat-san-pham-moi',
    title: 'Prudential ra mắt sản phẩm mới',
    alternateUrls: ['https://site.vn/en/news/new-product-launch', 'https://site.vn/'],
  });
  assert.equal(first.duplicate, false);
  assert.match(first.articleId, /^art_[0-9a-f]{12}$/);

  // Same path, other language → same article without title match.
  const sameLangPath = registry.claim({ scope, finalUrl: 'https://site.vn/en/tin-tuc/ra-mat-san-pham-moi', title: 'Other' });
  assert.equal(sameLangPath.duplicate, true);
  assert.equal(sameLangPath.articleId, first.articleId);

  // English slug declared via hreflang → same article.
  const english = registry.claim({ scope, finalUrl: 'https://site.vn/en/news/new-product-launch', title: 'Prudential launches new product' });
  assert.equal(english.duplicate, true);
  assert.equal(english.reason, 'language-alternate');

  // Same article in another brand scope is kept.
  assert.equal(registry.claim({ scope: 'AIA Viet Nam', finalUrl: 'https://site.vn/vn/tin-tuc/ra-mat-san-pham-moi' }).duplicate, false);

  // Wrong canonical (points at another article, different title) → kept separately.
  const wrongCanonical = registry.claim({
    scope,
    finalUrl: 'https://site.vn/vn/tin-tuc/bai-khac',
    title: 'Một bài hoàn toàn khác',
    canonicalUrl: 'https://site.vn/vn/tin-tuc/ra-mat-san-pham-moi',
  });
  assert.equal(wrongCanonical.duplicate, false);

  // Canonical + same title → merged.
  const viaCanonical = registry.claim({
    scope,
    finalUrl: 'https://site.vn/chuyen-muc/ra-mat-san-pham-moi-ban-in',
    title: 'Prudential ra mắt sản phẩm mới',
    canonicalUrl: 'https://site.vn/vn/tin-tuc/ra-mat-san-pham-moi',
  });
  assert.equal(viaCanonical.duplicate, true);
  assert.equal(viaCanonical.reason, 'canonical+title');

  // Homepage hreflang must not glue unrelated articles together.
  assert.equal(registry.claim({ scope, finalUrl: 'https://site.vn/', title: 'Trang chủ site' }).duplicate, false);

  // Cross-site canonical is ignored.
  const syndicated = registry.claim({
    scope,
    finalUrl: 'https://other.vn/ra-mat-san-pham-moi',
    title: 'Prudential ra mắt sản phẩm mới',
    canonicalUrl: 'https://site.vn/vn/tin-tuc/ra-mat-san-pham-moi',
  });
  assert.equal(syndicated.duplicate, false);

  // ID is stable across runs.
  assert.equal(
    createArticleRegistry().claim({ scope, finalUrl: 'https://site.vn/en/tin-tuc/ra-mat-san-pham-moi' }).articleId,
    first.articleId
  );
});

test('Google selector config has the keys the crawler reads', () => {
  const selectors = require('../src/config/googleSelectors.json');
  for (const key of ['resultsRoot', 'cardContainerAttributes', 'headline', 'publisher', 'consentButtons', 'captchaPatterns', 'noResultsPatterns']) {
    assert.ok(Array.isArray(selectors[key]) && selectors[key].length > 0, key);
  }
  assert.equal(typeof selectors.searchBox, 'string');
});
