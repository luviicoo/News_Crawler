'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BRANDS } = require('../src/config/brands');
const { extractPublishDate, formatDateVN, parseToISO } = require('../src/parser/dateParser');
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
const { createCsvWriter, slugify } = require('../src/output/artifacts');
const { classifyArticle, normalizeText } = require('../src/utils/articleClassifier');

test('date helpers parse and format Vietnam dates', () => {
  assert.equal(parseToISO('15/03/2024'), '2024-03-15T00:00:00.000Z');
  assert.equal(formatDateVN('2019-02-28T23:30:01.000Z'), '06:30:01 01/03/2019');
});

test('historical RSS publication date takes priority over a header clock', async () => {
  const page = {
    $eval: async () => { throw new Error('no metadata'); },
    $$eval: async () => [],
    evaluate: async () => { throw new Error('body clock must not be used before RSS'); },
  };
  assert.equal(await extractPublishDate(page, 'https://example.vn/article', {
    rssPublishDate: 'Thu, 8 Feb 2018 04:00:00 GMT',
  }), '2018-02-08T04:00:00.000Z');
});

test('article metadata is retained; a live time element cannot replace historical RSS date', async () => {
  const page = {
    $eval: async selector => {
      if (selector.includes('time[')) throw new Error('no time');
      if (selector.includes('article:published_time')) return '2019-05-20T09:00:00+07:00';
      throw new Error('no metadata');
    },
  };
  assert.equal(await extractPublishDate(page, 'https://example.vn/article', {
    rssPublishDate: 'Sun, 19 May 2019 02:00:00 GMT',
  }), '2019-05-20T02:00:00.000Z');
  page.$eval = async () => new Date().toISOString();
  assert.equal(await extractPublishDate(page, 'https://example.vn/article', {
    rssPublishDate: 'Thu, 8 Feb 2018 04:00:00 GMT',
  }), '2018-02-08T04:00:00.000Z');
  assert.equal(resolveGoogleRedirect('chrome-error://chromewebdata/'), 'chrome-error://chromewebdata/');
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

test('Prudential building names and foreign finance firms cannot establish insurer relevance', async () => {
  const brand = BRANDS.find(item => item.brand === 'Prudential Viet Nam');
  const env = { CLASSIFIER_MODE: 'rules', CLASSIFIER_REVIEW_FALLBACK: 'accept' };
  for (const content of [
    'Agoda có trụ sở ở Prudential Tower, Singapore. Công ty hỗ trợ bảo hiểm du lịch.',
    'Prudential Financial khảo sát người lao động Mỹ trong ngành bảo hiểm.',
    'Công ty tài chính Prudential Việt Nam cung cấp khoản vay tiêu dùng.',
    'Macro Prudential Assessment của ngân hàng Trung Quốc trong thị trường bảo hiểm.',
    'Prudential Financial khảo sát người lao động Mỹ. Prudential công bố kết quả về bảo hiểm.',
    'Prudential Holborn Life bán Công ty tài chính Prudential Việt Nam cho Shinhan.',
  ]) {
    const result = await classifyArticle({ title: 'Thông tin thị trường và doanh nghiệp', content }, brand, BRANDS, env);
    assert.equal(result.decision, 'reject');
  }
  const relevant = await classifyArticle({ title: 'Thị trường bảo hiểm nhân thọ',
    content: 'Prudential Financial ở Mỹ và Prudential Việt Nam là những doanh nghiệp khác nhau.' }, brand, BRANDS, env);
  assert.equal(relevant.decision, 'accept');
  const localParent = await classifyArticle({ title: 'Thị trường bảo hiểm Việt Nam',
    content: 'Tổng giám đốc Tập đoàn Prudential plc cam kết đầu tư dài hạn vào bảo hiểm tại Việt Nam.' }, brand, BRANDS, env);
  assert.equal(localParent.decision, 'accept');
  const advisor = await classifyArticle({ title: 'Chuẩn bị tài chính tuổi già',
    content: 'Chuyên viên tư vấn tài chính đến từ Prudential hướng dẫn khách hàng hoạch định cuộc sống.' }, brand, BRANDS, env);
  assert.equal(advisor.decision, 'accept');
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

test('article body identifies Prudential without treating incidental topics as headline noise', async () => {
  const target = BRANDS.find(({ brand }) => brand === 'Prudential Viet Nam');
  const result = await classifyArticle({
    title: 'Chuyển đổi số giúp khách hàng bảo hiểm thuận tiện hơn',
    content: 'Prudential Việt Nam cải tiến bảo hiểm nhân thọ. Khách hàng so sánh quyền lợi với bảo hiểm y tế.',
    url: 'https://example.vn/digital-insurance',
  }, target, BRANDS, { CLASSIFIER_MODE: 'rules' });
  assert.equal(result.decision, 'accept');
  assert.equal(result.brand, target.brand);
  const campaign = await classifyArticle({ title: 'An Concert by Prudential: Hòa nhạc đa giác quan',
    url: 'https://example.vn/an-concert' }, target, BRANDS, { CLASSIFIER_MODE: 'rules' });
  assert.equal(campaign.decision, 'accept');
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

  for (const title of ['Prudential Financial báo lãi quý 3', 'Prudential plc công bố kết quả',
    'Prudential Finance là công ty tài chính tốt nhất', 'Mua lại Prudential Finance, Shinhan ra mắt công ty tài chính']) {
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
  assert.match(content.split('\n')[0], /^\uFEFFbrand,mentioned_brands,mentioned_products,article_title,article_url,publisher_domain,publisher_homepage,publish_date,sentiment,classification_source,article_id,/);
  assert.match(content.split('\n')[0], /,content,content_2$/);
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

test('saturated RSS feeds split long windows, preserve parent results and carry publication dates', async () => {
  const { searchGoogleNewsRss } = require('../src/crawler/google');
  const calls = [];
  const stub = test.mock.method(globalThis, 'fetch', async url => {
    calls.push(new URL(url).searchParams.get('q'));
    const count = calls.length === 1 ? 100 : 1;
    const prefix = calls.length === 1 ? 'parent' : `child${calls.length}`;
    const items = Array.from({ length: count }, (_, i) => `<item><title>Prudential ${prefix} ${i}</title><link>https://example.vn/${prefix}/${i}</link><pubDate>Thu, 8 Feb 2018 04:00:00 GMT</pubDate><source url="https://example.vn">Example</source></item>`).join('');
    return { ok: true, text: async () => `<rss><channel>${items}</channel></rss>` };
  });
  try {
    const cards = await searchGoogleNewsRss('Prudential', { from: '2018-01-01', to: '2018-12-31' });
    assert.equal(calls.length, 3);
    assert.equal(cards.length, 102);
    assert.match(calls[0], /after:2017-12-31 before:2019-01-01/);
    assert.equal(cards[0].rssPublishDate, 'Thu, 8 Feb 2018 04:00:00 GMT');
  } finally { stub.mock.restore(); }
});

test('brand mentions ignore Vietnamese lookalikes and car drivetrain labels', () => {
  const { findMentionedBrands } = require('../src/utils/articleClassifier');
  const mentioned = content => findMentionedBrands({ title: 'Tin tức', content }, BRANDS);
  assert.deepEqual(mentioned('Ông Barry bảo Việt Nam là đất nước đáng để du khách ghé thăm.'), []);
  assert.deepEqual(mentioned('Theo báo Việt Nam, tăng trưởng GDP đạt 8%.'), []);
  assert.deepEqual(mentioned('Tran Ngoc Ha (Bao Viet Insurance Company Lai Chau) won second place.'), []);
  assert.deepEqual(mentioned('Ở hạng Cầu trước (FWD) và Cầu sau/Hai cầu (RWD/AWD), tay đua tranh tài.'), []);
  assert.deepEqual(mentioned('Bảo Việt Nhân thọ và Bảo hiểm FWD Việt Nam ký hợp tác.'), ['FWD Viet Nam', 'Bao Viet Nhan Tho']);
  assert.deepEqual(mentioned('Tập đoàn Bảo Việt (BVH) được vinh danh.'), ['Bao Viet Nhan Tho']);
});
