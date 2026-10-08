'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BRANDS } = require('../src/config/brands');
const { DEFAULT_PUBLISHERS, windows, buildSearchPlan } = require('../src/crawler/plan');
const { openState } = require('../src/crawler/state');
const { runCrawl } = require('../src/crawler/run');
const { classifyArticle, findMentionedBrands } = require('../src/utils/articleClassifier');
const { parseArgs, isPublishDateWithinRange } = require('../src/index');
const prudential = BRANDS.find(item => item.brand === 'Prudential Viet Nam');
const range = { from: '2024-01-01', to: '2024-02-29' };

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plan = buildSearchPlan([{ ...prudential, queries: ['"Prudential"'] }], range,
    { publishers: ['example.vn'], web: true });
  return { brands: [prudential], allBrands: BRANDS, dateRange: range, plan,
    outputPath: path.join(dir, 'articles.csv'), statePath: path.join(dir, 'state.jsonl'),
    reportPath: path.join(dir, 'coverage.json'), withinRange: isPublishDateWithinRange,
    searchDelayMin: 0, searchDelayMax: 0, concurrency: 2 };
}
const card = name => ({ title: 'Thị trường bảo hiểm nhân thọ', url: `https://example.vn/${name}`, publisherDomain: 'example.vn' });
const article = (url, extra = {}) => ({ finalUrl: url, articleTitle: 'Thị trường bảo hiểm nhân thọ',
  publishDate: '2024-01-12T02:00:00Z',
  articleText: 'AIA, FWD và Prudential Việt Nam cùng cung cấp bảo hiểm nhân thọ. ' + 'Nội dung chính của bài báo về thị trường và các sản phẩm. '.repeat(6),
  alternateUrls: [], ...extra });
const classify = (article, brand, brands) => classifyArticle(article, brand, brands, { CLASSIFIER_MODE: 'rules' });

test('coverage plan includes partial/leap months and publisher/year searches independently of feed size', () => {
  assert.deepEqual(windows({ from: '2023-12-20', to: '2024-03-03' }, 'month'), [
    { from: '2023-12-20', to: '2023-12-31' }, { from: '2024-01-01', to: '2024-01-31' },
    { from: '2024-02-01', to: '2024-02-29' }, { from: '2024-03-01', to: '2024-03-03' },
  ]);
  const plan = buildSearchPlan([prudential], { from: '2018-01-01', to: '2026-09-30' });
  assert.equal(plan.filter(task => task.kind === 'monthly' && task.channel === 'rss').length, 105 * prudential.queries.length);
  assert.equal(plan.filter(task => task.kind === 'publisher-year' && task.channel === 'rss').length, 9 * DEFAULT_PUBLISHERS.length);
  assert.equal(plan.filter(task => task.channel === 'web').length, 105 + 9 * DEFAULT_PUBLISHERS.length);
  assert.equal(new Set(plan.map(task => task.id)).size, plan.length);
  assert.deepEqual(buildSearchPlan([prudential], range), buildSearchPlan([prudential], range));
});

test('CLI selects Prudential, defaults to no screenshots, validates dates and supports checkpoints', () => {
  const parsed = parseArgs(['--brand', 'Prudential', '--date-from=2018-01-01', '--date-to', '2026-09-30'], {});
  assert.deepEqual(parsed.brands.map(def => def.brand), ['Prudential Viet Nam']);
  assert.equal(parsed.screenshots, false);
  assert.equal(parsed.web, true);
  assert.ok(parsed.statePath.endsWith('.state.jsonl'));
  assert.throws(() => parseArgs(['--date-from', '2024-02-30', '--date-to', '2024-03-01'], {}), /valid/);
  assert.throws(() => parseArgs(['--brand', 'Unknown'], {}), /Unknown brand/);
  assert.throws(() => parseArgs(['--web-pages', '0'], {}), /1..100/);
  assert.throws(() => parseArgs(['--date-from', '2024-01-01'], {}), /both valid/);
});

test('main pipeline reads body before filtering, runs complementary searches and resumes failures without duplicate CSV rows', async t => {
  const options = setup(t);
  let failing = true;
  const seenQueries = [];
  const seenArticles = [];
  let launches = 0;
  let closes = 0;
  const deps = {
    launchBrowser: async opts => { launches++; assert.equal(opts.headless, true); },
    closeBrowser: async () => { closes++; }, classifyArticle: classify,
    searchRss: async query => { seenQueries.push(['rss', query]); return [card('good'), card('retry'), card('noise')]; },
    searchWeb: async (brand, query) => { seenQueries.push(['web', query]); return { cards: [card('good'), card('web-only')], truncated: false }; },
    fetchArticle: async (url, opts) => {
      seenArticles.push(url);
      assert.equal(opts.includeContent, true);
      assert.equal(opts.screenshotDir, '');
      if (url.endsWith('/retry') && failing) return article(url, { error: 'HTTP 503', articleTitle: '', publishDate: null });
      if (url.endsWith('/noise')) return article(url, { articleText: 'Tin về doanh nghiệp khác và không liên quan. '.repeat(10) });
      return article(url);
    },
  };
  const first = await runCrawl(options, deps);
  assert.equal(seenQueries.length, options.plan.length);
  assert.equal(first.accepted_articles, 2);
  assert.equal(first.unresolved_articles.length, 1);
  assert.equal(first.coverage_checks_complete, false);
  assert.equal(first.candidate_statuses.rejected, 1);
  assert.equal(seenArticles.filter(url => url.endsWith('/good')).length, 1);
  // Deliberately corrupt the disposable CSV. Resume must restore journal rows.
  fs.writeFileSync(options.outputPath, 'interrupted CSV write');
  const queryCount = seenQueries.length;
  failing = false;
  const second = await runCrawl(options, deps);
  assert.equal(second.accepted_articles, 3);
  assert.equal(second.coverage_checks_complete, true);
  assert.equal(seenQueries.length, queryCount);
  assert.equal(seenArticles.filter(url => url.endsWith('/retry')).length, 2);
  const csv = fs.readFileSync(options.outputPath, 'utf8');
  assert.equal(csv.split('brand,mentioned_brands,article_title').length - 1, 1);
  assert.equal(csv.trim().split('\n').length, 4);
  const previousLaunches = launches;
  await runCrawl(options, deps);
  assert.equal(launches, previousLaunches);
  assert.equal(launches, closes);
});

test('failed searches and pagination limits remain unresolved and are retried on resume', async t => {
  const options = setup(t);
  let failing = true;
  const counts = { rss: 0, web: 0 };
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    fetchArticle: async url => article(url),
    searchRss: async () => { counts.rss++; if (failing) throw new Error('RSS blocked'); return []; },
    searchWeb: async () => { counts.web++; return { cards: [card('good')], truncated: failing }; },
  };
  const first = await runCrawl(options, deps);
  assert.equal(first.query_statuses.failed, options.plan.filter(task => task.channel === 'rss').length);
  assert.equal(first.query_statuses.limited, options.plan.filter(task => task.channel === 'web').length);
  assert.equal(first.processing_complete, false);
  failing = false;
  const second = await runCrawl(options, deps);
  assert.equal(second.coverage_checks_complete, true);
  assert.equal(second.accepted_articles, 1);
  assert.equal(counts.rss + counts.web, options.plan.length * 2);
});

test('missing dates are retryable, and new RSS dates unblock candidates within the same run', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  let query = 0;
  let fetched = 0;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    searchRss: async () => [{ ...card('missing-date'), rssPublishDate: ++query === 1 ? '' : 'Fri, 12 Jan 2024 02:00:00 GMT' }],
    fetchArticle: async (url, opts) => { fetched++; return article(url, { publishDate: opts.rssPublishDate ? '2024-01-12T02:00:00Z' : null }); },
  };
  const result = await runCrawl(options, deps);
  assert.equal(result.accepted_articles, 1);
  assert.equal(fetched, 2);
  assert.equal(result.unresolved_articles.length, 0);
  assert.equal(result.coverage_checks_complete, false); // RSS-only isn't a full check.
});

test('checkpoint locks prevent concurrent writers and recover only a partial final journal record', t => {
  const options = setup(t);
  const config = { version: 1 };
  const state = openState(options.statePath, config);
  assert.throws(() => openState(options.statePath, config), /already running/);
  state.close();
  fs.appendFileSync(options.statePath, '{"type":"unfinished');
  const recovered = openState(options.statePath, config);
  recovered.close();
  assert.ok(fs.readFileSync(options.statePath, 'utf8').endsWith('\n'));
  assert.throws(() => openState(options.statePath, { version: 2 }), /options differ/);
  assert.equal(fs.existsSync(options.statePath + '.lock'), false);
  fs.appendFileSync(options.statePath, 'malformed complete record\n');
  assert.throws(() => openState(options.statePath, config), /JSON/);
});

test('stopping leaves unstarted queries pending and resumes the same plan', async t => {
  const options = setup(t);
  let stopped = false;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    searchRss: async () => { stopped = true; return [card('good')]; },
    searchWeb: async () => ({ cards: [], truncated: false }), fetchArticle: async url => article(url),
  };
  const first = await runCrawl({ ...options, shouldStop: () => stopped }, deps);
  assert.equal(first.accepted_articles, 0);
  assert.equal(first.interrupted, true);
  assert.equal(first.unresolved_articles.length, 1);
  assert.ok(first.query_statuses.pending > 0);
  const second = await runCrawl(options, deps);
  assert.equal(second.accepted_articles, 1);
  assert.equal(second.processing_complete, true);
});

test('canonical/hreflang identity survives resume and refresh without duplicating an accepted article', async t => {
  const options = setup(t);
  let refreshing = false;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    searchRss: async () => [card('original')],
    searchWeb: async () => ({ cards: refreshing ? [card('english-version')] : [], truncated: false }),
    fetchArticle: async url => article(url, { alternateUrls: ['https://example.vn/english-version'] }),
  };
  const first = await runCrawl(options, deps);
  assert.equal(first.accepted_articles, 1);
  const saved = fs.readFileSync(options.outputPath, 'utf8');
  refreshing = true;
  const next = await runCrawl({ ...options, refresh: true, webMaxPages: 10 }, deps);
  assert.equal(next.accepted_articles, 1);
  assert.equal(next.candidate_statuses.duplicate, 1);
  assert.equal(fs.readFileSync(options.outputPath, 'utf8'), saved);
});

test('a partially failed browser startup closes resources and releases checkpoint locks', async t => {
  const options = setup(t);
  let closed = 0;
  await assert.rejects(runCrawl(options, {
    launchBrowser: async () => { throw new Error('Context initialization failed'); },
    closeBrowser: async () => { closed++; },
  }), /Context initialization failed/);
  assert.equal(closed, 1);
  assert.equal(fs.existsSync(options.statePath + '.lock'), false);
  assert.equal(JSON.parse(fs.readFileSync(options.reportPath)).processing_complete, false);
});

test('multi-brand articles are reported once as industry news, single-brand ones keep their brand', async t => {
  const options = setup(t);
  const aia = BRANDS.find(item => item.brand === 'AIA Viet Nam');
  options.brands = [prudential, aia];
  options.plan = buildSearchPlan([{ ...prudential, queries: ['"Prudential"'] }, { ...aia, queries: ['"AIA"'] }], range,
    { publishers: ['example.vn'], web: false }).filter(task => task.kind === 'whole-range');
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    searchRss: async () => [card('industry'), card('solo')],
    fetchArticle: async url => url.endsWith('/solo')
      ? article(url, { articleText: 'Prudential Việt Nam ra mắt sản phẩm bảo hiểm nhân thọ mới. ' + 'Nội dung chính của bài báo. '.repeat(10) })
      : article(url),
  };
  const result = await runCrawl(options, deps);
  assert.equal(result.accepted_articles, 2);
  assert.equal(result.candidate_statuses.duplicate, 1);
  const rows = fs.readFileSync(options.outputPath, 'utf8').trim().split('\n').slice(1);
  assert.equal(rows.filter(row => row.startsWith('Ngành bảo hiểm,FWD Viet Nam; AIA Viet Nam; Prudential Viet Nam,')).length, 1);
  assert.equal(rows.filter(row => row.startsWith('Prudential Viet Nam,Prudential Viet Nam,')).length, 1);
});

test('mention detection ignores foreign parents and same-name non-life businesses', () => {
  assert.deepEqual(findMentionedBrands({ title: 'Prudential Financial và Manulife Financial báo lãi',
    content: 'Bảo hiểm Bảo Việt tăng trưởng; AIA Việt Nam ra mắt sản phẩm mới.' }, BRANDS), ['AIA Viet Nam']);
  assert.deepEqual(findMentionedBrands({ title: 'Manulife và Sun Life chi trả quyền lợi bảo hiểm' }, BRANDS),
    ['Sun Life Viet Nam', 'Manulife Viet Nam']);
});

test('an article found by several brands is opened once and reused for the others', async t => {
  const options = setup(t);
  const aia = BRANDS.find(item => item.brand === 'AIA Viet Nam');
  const manulife = BRANDS.find(item => item.brand === 'Manulife Viet Nam');
  options.brands = [prudential, aia, manulife];
  options.plan = buildSearchPlan(options.brands.map(brand => ({ ...brand, queries: [brand.queries[0]] })), range,
    { publishers: ['example.vn'], web: false }).filter(task => task.kind === 'whole-range');
  options.concurrency = 1;
  const fetched = [];
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    searchRss: async () => [card('industry')],
    fetchArticle: async url => { fetched.push(url); return article(url); },
  };
  const result = await runCrawl(options, deps);
  assert.equal(fetched.length, 1);
  assert.equal(result.accepted_articles, 1);
  assert.equal(result.candidate_statuses.duplicate, 1); // AIA: same industry story.
  assert.equal(result.candidate_statuses.rejected, 1); // Manulife isn't named in it.
});

test('daily mode accumulates one CSV across moving windows, dedupes against a seed checkpoint and gives up on dead links', async t => {
  const options = setup(t);
  const seed = setup(t);
  // A historical checkpoint that already holds /seen.
  await runCrawl({ ...seed, plan: seed.plan.slice(0, 1) }, { launchBrowser: async () => {}, closeBrowser: async () => {},
    classifyArticle: classify, searchRss: async () => [card('seen')], fetchArticle: async url => article(url) });
  let fetches = 0;
  const day = (from, to, cards) => runCrawl({ ...options, daily: true, seedStatePaths: [seed.statePath], maxAttempts: 2,
    dateRange: { from, to },
    plan: buildSearchPlan([{ ...prudential, queries: ['"Prudential"'] }], { from, to }, { publishers: [], web: false }),
  }, { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    searchRss: async () => cards.map(card),
    fetchArticle: async url => { fetches++; if (url.endsWith('/listing')) return article(url, { articleText: 'Tin mới' });
      return url.endsWith('/dead') ? article(url, { error: 'HTTP 503', articleTitle: '' })
      : article(url, { publishDate: url.endsWith('/new') ? '2024-01-13T02:00:00Z' : '2024-01-12T02:00:00Z' }); },
  });
  const first = await day('2024-01-10', '2024-01-12', ['old', 'seen', 'dead', 'listing']);
  assert.equal(first.mode, 'daily');
  assert.equal(first.accepted_this_run, 1);
  assert.equal(first.candidate_statuses.duplicate, 1);
  assert.equal(first.candidate_statuses['not-article'], 1);
  const second = await day('2024-01-11', '2024-01-13', ['old', 'new', 'dead']);
  assert.equal(second.accepted_this_run, 1);
  assert.equal(second.accepted_articles, 2);
  assert.equal(second.abandoned_articles.length, 1);
  assert.equal(second.processing_complete, true);
  assert.equal(second.coverage_checks_complete, true);
  assert.equal(fetches, 6); // old, seen, dead, listing, then only new and the dead link's last attempt.
  const third = await day('2024-01-12', '2024-01-14', ['dead']);
  assert.equal(third.accepted_this_run, 0);
  assert.equal(fetches, 6);
  const rows = fs.readFileSync(options.outputPath, 'utf8').trim().split('\n');
  assert.equal(rows.length, 3);
});

test('RSS waits between planned and bisected requests, with a shorter delay than web search', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  const pauses = [];
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {}, classifyArticle: classify,
    fetchArticle: async url => article(url),
    searchRss: async (query, dateRange, opts) => { pauses.push(typeof opts.pause); await opts.pause(); return []; },
  };
  const started = Date.now();
  await runCrawl({ ...options, rssDelayMin: 20, rssDelayMax: 20, searchDelayMin: 5000, searchDelayMax: 5000 }, deps);
  assert.deepEqual(pauses, ['function', 'function']);
  assert.ok(Date.now() - started < 1000);
});

test('daily CLI uses a cumulative RSS-only plan for the last N days', () => {
  const parsed = parseArgs(['--daily', '--days', '2', '--dedupe-with', 'output/history.csv'], {});
  assert.equal(parsed.daily, true);
  assert.equal(parsed.web, false);
  assert.ok(parsed.outputPath.endsWith(path.join('output', 'daily_all_brands.csv')));
  assert.ok(parsed.seedStatePaths[0].endsWith(path.join('output', 'history.csv.state.jsonl')));
  assert.equal(new Date(`${parsed.dateRange.to}T00:00:00Z`) - new Date(`${parsed.dateRange.from}T00:00:00Z`), 86400000);
  assert.throws(() => parseArgs(['--daily', '--date-from', '2024-01-01', '--date-to', '2024-01-02'], {}), /--days/);
});

test('publisher searches use a quoted brand phrase when the first query is made of common words', () => {
  const baoViet = BRANDS.find(item => item.brand === 'Bao Viet Nhan Tho');
  const plan = buildSearchPlan([baoViet, prudential], range, { publishers: ['laodong.vn'], web: false });
  const site = plan.filter(task => task.kind === 'publisher-year').map(task => task.query);
  assert.deepEqual(site, ['"Bao Viet Nhan Tho" site:laodong.vn', '"Prudential" site:laodong.vn']);
});

test('browser is restarted between article batches, never while a tab or search uses it', async t => {
  const options = { ...setup(t), concurrency: 1, browserRecycleArticles: 2 };
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  let open = false;
  let launches = 0;
  const deps = {
    launchBrowser: async () => { open = true; launches++; },
    closeBrowser: async () => { open = false; },
    classifyArticle: classify,
    searchRss: async (query) => {
      assert.ok(open, 'search ran on a closed browser');
      // Deterministic, distinct cards per query.
      return Array.from({ length: 6 }, (_, i) => card(`${query.length}-${i}`));
    },
    searchWeb: async () => ({ cards: [], truncated: false }),
    fetchArticle: async url => {
      assert.ok(open, 'article opened on a closed browser');
      return article(url);
    },
  };
  const result = await runCrawl(options, deps);
  assert.ok(result.accepted_articles > 0);
  assert.ok(launches >= 2, `expected the browser to restart, launched ${launches} time(s)`);
  assert.equal(open, false);
});
