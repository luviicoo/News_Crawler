'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadProfile, validateProfile, profileWarnings } = require('../src/config/profile');
const { createClassifier } = require('../src/utils/articleClassifier');
const { buildSearchPlan } = require('../src/crawler/plan');
const { runCrawl } = require('../src/crawler/run');
const { runEnrich } = require('../src/enrich/enrich');
const { exportCsv } = require('../src/output/export');
const { openStore } = require('../src/store/db');
const { parseArgs, isPublishDateWithinRange } = require('../src/index');
const { filterGoogleState, buildUserAgent } = require('../src/crawler/browser');
const { shouldBlockRequest } = require('../src/crawler/article');

// A different industry, declared only as data: no engine code knows it.
const bank = {
  name: 'bank-test', industryLabel: 'Ngành ngân hàng', publishers: ['example.vn'],
  topic: { description: 'ngan hang', keywords: ['ngân hàng', 'tín dụng'], negativeTitleKeywords: ['bóng đá'] },
  excludePhrases: ['Alpha Group Singapore'],
  brands: [
    { brand: 'Alpha Bank', aliases: ['Alpha Bank', 'Alpha'], queries: ['"Alpha Bank"'],
      excludePhrases: ['Alpha Securities'], requirePattern: /\bAlpha\b/u,
      lookalikes: [/\bAlpha\s*\/\s*Beta\b/gu] },
    { brand: 'Beta Bank', aliases: ['Beta Bank'], queries: ['beta bank'],
      mentionMatcher: (raw, { normalizeText }) => /\bbeta bank viet nam\b/.test(normalizeText(raw)) },
  ],
};

test('a data-only profile drives mention rules, exclusions and topic checks', async () => {
  validateProfile(bank, 'bank-test');
  const classifier = createClassifier(bank);
  const mentioned = (title, content = '') => classifier.findMentionedBrands({ title, content }, bank.brands);
  assert.deepEqual(mentioned('Alpha Bank và Beta Bank Việt Nam tăng tín dụng'), ['Alpha Bank', 'Beta Bank']);
  assert.deepEqual(mentioned('Beta Bank tăng tín dụng'), []);
  assert.deepEqual(mentioned('Alpha Securities báo lãi'), []);
  assert.deepEqual(mentioned('Alpha Group Singapore mua lại'), []);
  assert.deepEqual(mentioned('Mô hình Alpha/Beta trong thống kê'), []);
  assert.deepEqual(mentioned('alpha của thị trường'), [], 'requirePattern is checked on raw text');

  const env = { CLASSIFIER_MODE: 'rules' };
  const alpha = bank.brands[0];
  const accept = await classifier.classifyArticle({ title: 'Alpha Bank giảm lãi suất', content: 'Ngân hàng Alpha Bank.' }, alpha, bank.brands, env);
  assert.equal(accept.decision, 'accept');
  const sameName = await classifier.classifyArticle({ title: 'Alpha Securities báo lãi', content: 'Alpha Bank' }, alpha, bank.brands, env);
  assert.match(sameName.reason, /same-name entity "alpha securities"/);
  const offTopic = await classifier.classifyArticle({ title: 'Bóng đá: Alpha Bank tài trợ', content: '' }, alpha, bank.brands, env);
  assert.equal(offTopic.decision, 'reject');
  assert.equal(classifier.isTopicRelated('Alpha Bank mở rộng tín dụng'), true);
  assert.equal(createClassifier({ ...bank, topic: { keywords: [] } }).isTopicRelated('Bất kỳ tiêu đề nào'), true);
});

// Crawl one plan of the bank profile into a fresh store, then enrich it (rules only).
async function crawlAndEnrich(t, { cards, fetchArticle, plan }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-profile-'));
  const store = openStore(path.join(dir, 'news.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const range = { from: '2024-01-01', to: '2024-01-31' };
  await runCrawl({ profileName: bank.name, dateRange: range, plan: plan(range), store, concurrency: 5,
    searchDelayMin: 0, searchDelayMax: 0, rssDelayMin: 0, rssDelayMax: 0 }, {
    launchBrowser: async () => {}, closeBrowser: async () => {}, searchRss: async () => cards, fetchArticle,
  });
  const classifier = createClassifier(bank);
  const env = { CLASSIFIER_MODE: 'rules' };
  const stats = await runEnrich(store, { profile: bank, classifier: { ...classifier,
    classifyArticle: (article, brand, brands) => classifier.classifyArticle(article, brand, brands, env),
    classifyTopic: article => classifier.classifyTopic(article, env) } });
  const outputPath = path.join(dir, 'out.csv');
  await exportCsv(store, { profile: bank, dateRange: range, withinRange: isPublishDateWithinRange, outputPath });
  return { stats, store, csv: fs.readFileSync(outputPath, 'utf8').trim().split('\n') };
}

test('multi-brand articles use the profile industry label', async t => {
  const { stats, csv } = await crawlAndEnrich(t, {
    plan: range => buildSearchPlan(bank.brands.slice(0, 1), range, { publishers: bank.publishers, web: false })
      .filter(task => task.kind !== 'publisher-year'),
    cards: [{ title: 'x', url: 'https://example.vn/a', publisherDomain: 'example.vn' }],
    fetchArticle: async url => ({ finalUrl: url, articleTitle: 'Alpha Bank và Beta Bank Việt Nam hợp tác tín dụng',
      publishDate: '2024-01-12T02:00:00Z', articleText: 'Ngân hàng tín dụng. '.repeat(20), alternateUrls: [] }),
  });
  assert.equal(stats.accepted, 1);
  assert.ok(csv[1].startsWith('Ngành ngân hàng,Alpha Bank; Beta Bank,'));
  assert.deepEqual(stats.noisy_queries, []);
});

test('industry queries keep relevant news that names no brand, and noisy queries are reported', async t => {
  const cards = Array.from({ length: 25 }, (_, index) => ({ title: 'x', url: `https://example.vn/${index}`, publisherDomain: 'example.vn' }));
  const { stats, store, csv } = await crawlAndEnrich(t, {
    plan: range => buildSearchPlan(bank.brands.slice(0, 1), range,
      { publishers: bank.publishers, web: false, industryQueries: ['"tín dụng ngân hàng"'] })
      .filter(task => task.kind !== 'publisher-year'),
    cards: [...cards, { title: 'y', url: 'https://example.vn/industry', publisherDomain: 'example.vn' }],
    fetchArticle: async url => (url.endsWith('/industry')
      ? { finalUrl: url, articleTitle: 'Tín dụng ngân hàng tăng mạnh cuối năm', publishDate: '2024-01-12T02:00:00Z',
        articleText: 'Tăng trưởng tín dụng của hệ thống ngân hàng. '.repeat(10), alternateUrls: [] }
      : { finalUrl: url, articleTitle: 'Tin thời sự không liên quan', publishDate: '2024-01-12T02:00:00Z',
        articleText: 'Nội dung khác. '.repeat(30), alternateUrls: [] }),
  });
  // Every query returned every card; only the industry story is relevant, with no brand named.
  assert.equal(stats.accepted, 1);
  assert.equal(csv.length, 2);
  assert.ok(csv[1].startsWith('Ngành ngân hàng,,Tín dụng ngân hàng tăng mạnh cuối năm,'));
  assert.equal(store.sql("SELECT COUNT(*) AS n FROM article_labels WHERE relevance = 'rejected'").get().n, 25);
  const noisy = stats.noisy_queries.find(group => group.query === '"Alpha Bank"');
  assert.equal(noisy.rejected, 25);
});

test('profile loader validates fields and warns about unquoted site: queries', t => {
  assert.throws(() => validateProfile({ ...bank, brands: [] }, 'x'), /"brands" must be a non-empty list/);
  assert.throws(() => validateProfile({ ...bank, brands: [bank.brands[0], bank.brands[0]] }, 'x'), /duplicate brand/);
  assert.throws(() => validateProfile({ ...bank, brands: [{ ...bank.brands[0], aliases: [] }] }, 'x'), /Alpha Bank.*aliases/);
  assert.throws(() => validateProfile({ ...bank, publishers: ['not a domain'] }, 'x'), /publishers/);
  assert.throws(() => validateProfile({ ...bank, brands: [{ ...bank.brands[0], lookalikes: [/x/] }] }, 'x'), /g flag/);
  assert.throws(() => loadProfile('does-not-exist'), /Profile not found/);
  assert.deepEqual(profileWarnings(bank).map(warning => warning.includes('Beta Bank')), [true]);
  assert.deepEqual(profileWarnings(loadProfile('_template')), []);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-profile-')), 'bank.js');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  fs.writeFileSync(file, `module.exports = ${JSON.stringify({ ...bank, brands: [{ brand: 'Alpha Bank', aliases: ['Alpha'], queries: ['"Alpha"'] }] })};`);
  const parsed = parseArgs(['--profile', file, '--daily'], {});
  assert.equal(parsed.profile.name, 'bank-test');
  assert.deepEqual(parsed.publishers, ['example.vn']);
  assert.match(path.basename(parsed.outputPath), /^bank-test_daily_alpha_bank\.csv$/);
  assert.match(path.basename(parseArgs(['--daily'], {}).outputPath), /^daily_all_brands\.csv$/);
});

test('browser keeps only Google session state, matches its real version and drops heavy resources', () => {
  const state = filterGoogleState({
    cookies: [{ domain: '.google.com' }, { domain: 'news.google.com' }, { domain: '.google.com.vn' }, { domain: '.mgid.com' }, { domain: 'vnexpress.net' }],
    origins: [{ origin: 'https://www.google.com' }, { origin: 'https://vnexpress.net' }, { origin: 'https://notgoogle.com' }],
  });
  assert.deepEqual(state.cookies.map(cookie => cookie.domain), ['.google.com', 'news.google.com', '.google.com.vn']);
  assert.deepEqual(state.origins.map(entry => entry.origin), ['https://www.google.com']);
  assert.match(buildUserAgent('141.0.7390.37', 'darwin'), /Macintosh.*Chrome\/141\.0\.0\.0/);
  assert.equal(shouldBlockRequest('https://vnexpress.net/a.jpg'), true);
  assert.equal(shouldBlockRequest('https://i1.vnecdn.net/a.webp?w=680'), true);
  assert.equal(shouldBlockRequest('https://servicer.mgid.com/x.js'), true);
  assert.equal(shouldBlockRequest('https://mgid.com/x.js'), true);
  assert.equal(shouldBlockRequest('https://vnexpress.net/bai-viet.html'), false);
  assert.equal(shouldBlockRequest('https://vnexpress.net/app.js'), false);
});

test('dairy-kids-vn profile separates brands from lookalike names', async () => {
  const dairy = loadProfile('dairy-kids-vn');
  assert.deepEqual(profileWarnings(dairy), []);
  const classifier = createClassifier(dairy);
  const mentioned = (title, content = '') => classifier.findMentionedBrands({ title, content }, dairy.brands);
  assert.deepEqual(mentioned('Nestlé MILO tài trợ giải bóng đá học đường'), ['Milo']);
  assert.deepEqual(mentioned('Tổng thống Milo Đukanović thăm Việt Nam'), []);
  assert.deepEqual(mentioned('Kun Agüero ghi bàn'), []);
  assert.deepEqual(mentioned('IDP tổ chức hội thảo du học'), []);
  assert.deepEqual(mentioned('Sữa Kun của LOF ra mắt bao bì mới'), ['LOF (Kun)']);
  assert.deepEqual(mentioned('Tai nạn giao thông trên quốc lộ', 'NẠN NHÂN được cấp cứu'), []);
  assert.deepEqual(mentioned('Nestlé NAN Optipro mới'), ['Nestle NAN']);
  assert.deepEqual(mentioned('Thí sinh sửa bài thi', 'th true là cụm tiếng Anh'), []);
  assert.deepEqual(mentioned('Bac A Bank tăng vốn', 'Tập đoàn TH góp vốn Bac A Bank'), ['TH true MILK']);
  assert.deepEqual(mentioned('Abbott Laboratories ra mắt kit xét nghiệm Abbott'), []);
  assert.deepEqual(mentioned('Vinamilk và TH true MILK tăng giá sữa tươi'), ['Vinamilk', 'TH true MILK']);
  assert.deepEqual(mentioned('Ovaltine và Cô Gái Hà Lan khuyến mãi'), ['FrieslandCampina Viet Nam']);

  const env = { CLASSIFIER_MODE: 'rules' };
  const vinamilk = dairy.brands.find(def => def.brand === 'Vinamilk');
  const stock = await classifier.classifyArticle({ title: 'Cổ phiếu VNM giảm sàn', content: 'Vinamilk' }, vinamilk, dairy.brands, env);
  assert.equal(stock.decision, 'reject');
  const earnings = await classifier.classifyArticle({ title: 'Vinamilk báo lợi nhuận tăng, cổ phiếu khởi sắc', content: 'Vinamilk bán sữa bột trẻ em.' }, vinamilk, dairy.brands, env);
  assert.equal(earnings.decision, 'accept');
});
