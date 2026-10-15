'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BRANDS } = require('../src/config/brands');
const { DEFAULT_PUBLISHERS, windows, buildSearchPlan } = require('../src/crawler/plan');
const { openStore, acquireLock } = require('../src/store/db');
const { runCrawl, isBlocked } = require('../src/crawler/run');
const { runEnrich } = require('../src/enrich/enrich');
const { exportCsv } = require('../src/output/export');
const { readCsvFile } = require('../src/output/csvRead');
const { createClassifier, findMentionedBrands } = require('../src/utils/articleClassifier');
const { loadProfile } = require('../src/config/profile');
const { parseArgs, isPublishDateWithinRange } = require('../src/index');
const log = require('../src/output/logger');
const profile = loadProfile('insurance-vn');
const prudential = BRANDS.find(item => item.brand === 'Prudential Viet Nam');
const range = { from: '2024-01-01', to: '2024-02-29' };

function rulesClassifier(forProfile = profile) {
  const classifier = createClassifier(forProfile);
  const env = { CLASSIFIER_MODE: 'rules' };
  return { ...classifier, classifyArticle: (article, brand, brands) => classifier.classifyArticle(article, brand, brands, env),
    classifyTopic: article => classifier.classifyTopic(article, env) };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-resume-'));
  const store = openStore(path.join(dir, 'news.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const plan = buildSearchPlan([{ ...prudential, queries: ['"Prudential"'] }], range,
    { publishers: ['example.vn'], web: true });
  return { profileName: profile.name, dateRange: range, plan, store, dir,
    outputPath: path.join(dir, 'articles.csv'),
    searchDelayMin: 0, searchDelayMax: 0, rssDelayMin: 0, rssDelayMax: 0, concurrency: 2 };
}
// Phase 2 + CSV for the crawled store (rules only, no network).
async function enrichAndExport(options, extra = {}) {
  const stats = await runEnrich(options.store, { profile, classifier: rulesClassifier() });
  const exported = await exportCsv(options.store, { profile, dateRange: options.dateRange, withinRange: isPublishDateWithinRange,
    outputPath: options.outputPath, ...extra });
  return { stats, exported, rows: readCsvFile(exported.outputPath) };
}
const card = name => ({ title: 'Thị trường bảo hiểm nhân thọ', url: `https://example.vn/${name}`, publisherDomain: 'example.vn' });
const article = (url, extra = {}) => ({ finalUrl: url, articleTitle: 'Thị trường bảo hiểm nhân thọ',
  publishDate: '2024-01-12T02:00:00Z',
  articleText: 'AIA, FWD và Prudential Việt Nam cùng cung cấp bảo hiểm nhân thọ. ' + 'Nội dung chính của bài báo về thị trường và các sản phẩm. '.repeat(6),
  alternateUrls: [], fetchMethod: 'http', ...extra });
const count = (store, table) => store.sql(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

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
  // Industry phrases: RSS for the whole range and each month, never per publisher or web.
  const industry = buildSearchPlan([prudential], range, { industryQueries: ['"thị trường bảo hiểm"'] })
    .filter(task => task.kind === 'industry');
  assert.equal(industry.length, 3);
  assert.ok(industry.every(task => task.channel === 'rss' && task.brand === null));
});

test('CLI selects Prudential, parses commands and uses the shared store', () => {
  const parsed = parseArgs(['--brand', 'Prudential', '--date-from=2018-01-01', '--date-to', '2026-09-30'], {});
  assert.equal(parsed.command, 'all');
  assert.deepEqual(parsed.brands.map(def => def.brand), ['Prudential Viet Nam']);
  assert.equal(parsed.allBrands, false);
  assert.equal(parsed.web, true);
  assert.ok(parsed.storePath.endsWith(path.join('output', 'news.db')));
  assert.equal(parseArgs(['enrich', '--reclassify'], {}).command, 'enrich');
  assert.equal(parseArgs(['enrich', '--reclassify'], {}).reclassify, true);
  assert.deepEqual(parseArgs(['import', 'a.state.jsonl'], {}).files, [path.resolve('a.state.jsonl')]);
  assert.throws(() => parseArgs(['import'], {}), /needs a/);
  assert.throws(() => parseArgs(['publish'], {}), /Unknown command/);
  assert.throws(() => parseArgs(['--state', 'x.jsonl'], {}), /--store/);
  assert.throws(() => parseArgs(['--screenshots'], {}), /Unknown argument/);
  assert.throws(() => parseArgs(['--date-from', '2024-02-30', '--date-to', '2024-03-01'], {}), /valid/);
  assert.throws(() => parseArgs(['--brand', 'Unknown'], {}), /Unknown brand/);
  assert.throws(() => parseArgs(['--web-pages', '0'], {}), /1..100/);
  assert.throws(() => parseArgs(['--date-from', '2024-01-01'], {}), /both valid/);
});

test('crawl keeps every readable article, runs complementary searches and resumes failures; enrich and export label them', async t => {
  const options = setup(t);
  let failing = true;
  const seenQueries = [];
  const seenArticles = [];
  let launches = 0;
  let closes = 0;
  const deps = {
    launchBrowser: async opts => { launches++; assert.equal(opts.headless, true); },
    closeBrowser: async () => { closes++; },
    searchRss: async query => { seenQueries.push(['rss', query]); return [card('good'), card('retry'), card('noise')]; },
    searchWeb: async (brand, query) => { seenQueries.push(['web', query]); return { cards: [card('good'), card('web-only')], truncated: false }; },
    fetchArticle: async url => {
      seenArticles.push(url);
      if (url.endsWith('/retry') && failing) return article(url, { error: 'HTTP 503', articleTitle: '', publishDate: null });
      if (url.endsWith('/noise')) return article(url, { articleText: 'Tin về doanh nghiệp khác và không liên quan. '.repeat(10) });
      return article(url);
    },
  };
  const first = await runCrawl(options, deps);
  assert.equal(seenQueries.length, options.plan.length);
  // Phase 1 stores the off-topic article too: classification happens in enrich.
  assert.equal(first.fetched_articles, 3);
  assert.equal(count(options.store, 'article_contents'), 3);
  assert.equal(first.unresolved_articles.length, 1);
  assert.equal(first.coverage_checks_complete, false);
  assert.equal(seenArticles.filter(url => url.endsWith('/good')).length, 1);
  const queryCount = seenQueries.length;
  failing = false;
  const second = await runCrawl(options, deps);
  assert.equal(second.fetched_articles, 4);
  assert.equal(second.coverage_checks_complete, true);
  assert.equal(seenQueries.length, queryCount);
  assert.equal(seenArticles.filter(url => url.endsWith('/retry')).length, 2);
  const { stats, rows } = await enrichAndExport(options);
  assert.equal(stats.accepted, 3);
  assert.equal(stats.rejected, 1);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.brand === 'Ngành bảo hiểm' && row.content.includes('Prudential Việt Nam')));
  const previousLaunches = launches;
  await runCrawl(options, deps);
  assert.equal(launches, previousLaunches);
  assert.equal(launches, closes);
  assert.deepEqual(options.store.sql('SELECT mode, status FROM crawl_runs ORDER BY id').all().map(run => run.status),
    ['done', 'done', 'done', 'done']);
});

test('failed searches and pagination limits remain unresolved and are retried on resume', async t => {
  const options = setup(t);
  let failing = true;
  const counts = { rss: 0, web: 0 };
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
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
  assert.equal(second.fetched_articles, 1);
  assert.equal(counts.rss + counts.web, options.plan.length * 2);
});

test('summary progress continues during slow work and its timer stops when the crawl finishes', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 1);
  options.progressIntervalMs = 5;
  const updates = [];
  t.mock.method(log, 'progress', (phase, message) => updates.push({ phase, message }));
  const result = await runCrawl(options, {
    launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return [card('progress')];
    },
    fetchArticle: async url => article(url),
  });
  assert.equal(result.fetched_this_run, 1);
  assert.ok(updates.length >= 3);
  assert.equal(updates[0].phase, 'Crawl');
  assert.match(updates[0].message, /queries 0\/1/);
  assert.match(updates.at(-1).message, /queries 1\/1; 1 new articles stored/);
  const finishedCount = updates.length;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(updates.length, finishedCount);
});

test('missing dates are retryable, and new RSS dates unblock URLs within the same run', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  let query = 0;
  let fetched = 0;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [{ ...card('missing-date'), rssPublishDate: ++query === 1 ? '' : 'Fri, 12 Jan 2024 02:00:00 GMT' }],
    fetchArticle: async (url, opts) => { fetched++; return article(url, { publishDate: opts.rssPublishDate ? '2024-01-12T02:00:00Z' : null }); },
  };
  const result = await runCrawl(options, deps);
  assert.equal(result.fetched_articles, 1);
  assert.equal(fetched, 2);
  assert.equal(result.unresolved_articles.length, 0);
  assert.equal(result.coverage_checks_complete, false); // RSS-only isn't a full check.
});

test('Google News links wait out a decoding throttle while other URLs are read, then are read in the same run', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 1);
  const googleNews = { ...card('gn'), url: 'https://news.google.com/rss/articles/CBMiGN?oc=5', publisherDomain: 'news.google.com' };
  let throttled = true;
  const reads = [];
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => {
      setTimeout(() => { throttled = false; }, 50);
      return [googleNews, card('direct')];
    },
    isDecodeThrottled: () => throttled,
    fetchArticle: async url => {
      reads.push(url);
      if (url.includes('news.google.com')) {
        return throttled ? { deferred: true, error: 'throttled' } : article('https://example.vn/decoded-gn');
      }
      return article(url, { articleTitle: 'Bài khác về bảo hiểm nhân thọ' });
    },
  };
  const result = await runCrawl(options, deps);
  assert.equal(result.fetched_articles, 2);
  assert.equal(result.unresolved_articles.length, 0);
  assert.equal(reads.filter(url => url.includes('news.google.com')).length, 1); // Skipped, not read, while throttled.
});

test('an article of a publisher skipped after an unsolved CAPTCHA keeps its status and is not retried in the run', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  let reads = 0;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [card('guarded')],
    fetchArticle: async () => { reads++; return { deferred: 'captcha', error: 'Publisher CAPTCHA not solved this run' }; },
  };
  const result = await runCrawl(options, deps);
  assert.equal(reads, 1);
  const row = options.store.sql("SELECT status, attempts FROM discovered_urls WHERE url LIKE '%guarded%'").get();
  assert.deepEqual({ ...row }, { status: 'pending', attempts: 0 });
  assert.equal(result.unresolved_articles.length, 1);
});

test('direct URLs are read first, then Google News links whose RSS title looks relevant', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 1);
  options.concurrency = 1;
  const gn = (id, title) => ({ title, url: `https://news.google.com/rss/articles/CBMi${id}?oc=5`, publisherDomain: 'example.vn' });
  const reads = [];
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [gn('Other', 'Chợ Bình Tây sắp có thay đổi lớn'), gn('Match', 'Prudential ra mắt sản phẩm'), card('direct')],
    looksRelevant: title => /Prudential/.test(title),
    fetchArticle: async url => { reads.push(url); return article(url.includes('google') ? `https://example.vn/${url.slice(-12)}` : url,
      { articleTitle: `Bài ${reads.length} về bảo hiểm nhân thọ` }); },
  };
  await runCrawl(options, deps);
  assert.deepEqual(reads.map(url => (url.includes('CBMiMatch') ? 'match' : url.includes('CBMiOther') ? 'other' : 'direct')),
    ['direct', 'match', 'other']);
  // A URL that already failed goes after every untried one.
  options.store.sql("UPDATE discovered_urls SET status = 'failed', attempts = 1 WHERE url LIKE '%CBMiOther%'").run();
  options.store.sql("UPDATE discovered_urls SET status = 'pending', attempts = 0 WHERE url LIKE '%direct%'").run();
  reads.length = 0;
  await runCrawl(options, deps);
  assert.deepEqual(reads.map(url => (url.includes('CBMiOther') ? 'retry' : 'new')), ['new', 'retry']);
});

test('RSS titles of tracked brands or the topic look relevant, after the publisher suffix is removed', () => {
  const dairy = createClassifier(loadProfile('dairy-kids-vn'));
  assert.equal(dairy.looksRelevant('Vinamilk xuất khẩu tăng mạnh - Báo Tuổi Trẻ'), true);
  assert.equal(dairy.looksRelevant('Giá sữa bột trẻ em tăng - VnExpress'), true);
  assert.equal(dairy.looksRelevant('Chợ Bình Tây sắp có thay đổi lớn - Báo Người Lao Động'), false);
});

test('Gemini rate limits are retried after the requested delay instead of failing the article', async t => {
  const { getClassifierConfig } = require('../src/utils/articleClassifier');
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response('{"error":{"details":[{"retryDelay":"0.01s"}]}}', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"is_topic":true,"sentiment":"positive","confidence":0.9}' }] } }] }));
  };
  const classifier = createClassifier(loadProfile('dairy-kids-vn'));
  const env = { CLASSIFIER_MODE: 'gemini', GEMINI_API_KEY: 'test-key', GEMINI_MAX_RETRIES: '2' };
  assert.equal(getClassifierConfig(env).geminiMaxRetries, 2);
  const result = await classifier.classifyTopic({ title: 'Thị trường sữa bột trẻ em', content: 'Giá sữa bột trẻ em tăng. '.repeat(20) }, env);
  assert.equal(calls, 2);
  assert.equal(result.decision, 'accept');
});

test('store locks prevent concurrent crawls and query results are saved atomically', t => {
  const options = setup(t);
  const lock = path.join(options.dir, 'news.db.insurance-vn.lock');
  const release = acquireLock(lock);
  assert.throws(() => acquireLock(lock), /already running/);
  release();
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, '999999999'); // A process that no longer exists.
  acquireLock(lock)();
  const task = options.plan[0];
  // A card that cannot be stored rolls back the whole search result.
  assert.throws(() => options.store.recordQueryResult(task, profile.name, { status: 'done' },
    [{ ...card('ok'), urlKey: 'example.vn/ok' }, { urlKey: 'example.vn/broken', url: null }]));
  assert.equal(options.store.getQuery(task.id), null);
  assert.equal(count(options.store, 'discovered_urls'), 0);
});

test('stopping leaves unstarted queries pending and resumes the same plan', async t => {
  const options = setup(t);
  let stopped = false;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => { stopped = true; return [card('good')]; },
    searchWeb: async () => ({ cards: [], truncated: false }), fetchArticle: async url => article(url),
  };
  const first = await runCrawl({ ...options, shouldStop: () => stopped }, deps);
  assert.equal(first.fetched_articles, 0);
  assert.equal(first.interrupted, true);
  assert.equal(first.unresolved_articles.length, 1);
  assert.ok(first.query_statuses.pending > 0);
  assert.equal(options.store.sql('SELECT status FROM crawl_runs').get().status, 'interrupted');
  const second = await runCrawl(options, deps);
  assert.equal(second.fetched_articles, 1);
  assert.equal(second.processing_complete, true);
});

test('canonical/hreflang identity survives resume and refresh without duplicating an article', async t => {
  const options = setup(t);
  let refreshing = false;
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [card('original')],
    searchWeb: async () => ({ cards: refreshing ? [card('english-version')] : [], truncated: false }),
    fetchArticle: async url => article(url, { alternateUrls: ['https://example.vn/english-version'] }),
  };
  await runCrawl(options, deps);
  assert.equal(count(options.store, 'articles'), 1);
  refreshing = true;
  const next = await runCrawl({ ...options, refresh: true, webMaxPages: 10 }, deps);
  assert.equal(next.fetched_this_run, 0);
  assert.equal(count(options.store, 'articles'), 1);
  const ids = options.store.sql('SELECT DISTINCT article_id FROM discovered_urls').all();
  assert.equal(ids.length, 1);
});

test('a partially failed browser startup closes resources and marks the run failed', async t => {
  const options = setup(t);
  let closed = 0;
  await assert.rejects(runCrawl(options, {
    launchBrowser: async () => { throw new Error('Context initialization failed'); },
    closeBrowser: async () => { closed++; },
    searchRss: async () => [], fetchArticle: async url => article(url),
  }), /Context initialization failed/);
  assert.equal(closed, 1);
  assert.equal(options.store.sql('SELECT status FROM crawl_runs').get().status, 'failed');
});

test('multi-brand articles are reported once as industry news, single-brand ones keep their brand', async t => {
  const options = setup(t);
  const aia = BRANDS.find(item => item.brand === 'AIA Viet Nam');
  options.plan = buildSearchPlan([{ ...prudential, queries: ['"Prudential"'] }, { ...aia, queries: ['"AIA"'] }], range,
    { publishers: ['example.vn'], web: false }).filter(task => task.kind === 'whole-range');
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [card('industry'), card('solo')],
    fetchArticle: async url => url.endsWith('/solo')
      ? article(url, { articleText: 'Prudential Việt Nam ra mắt sản phẩm bảo hiểm nhân thọ mới. ' + 'Nội dung chính của bài báo. '.repeat(10) })
      : article(url),
  };
  const result = await runCrawl(options, deps);
  assert.equal(result.fetched_articles, 2);
  const { rows } = await enrichAndExport(options);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.brand === 'Ngành bảo hiểm' &&
    row.mentioned_brands === 'FWD Viet Nam; AIA Viet Nam; Prudential Viet Nam').length, 1);
  assert.equal(rows.filter(row => row.brand === 'Prudential Viet Nam' && row.mentioned_brands === 'Prudential Viet Nam').length, 1);
  // A single-brand export keeps the industry row that names the brand.
  const aiaOnly = await exportCsv(options.store, { profile, brands: [aia], dateRange: range, withinRange: isPublishDateWithinRange,
    outputPath: path.join(options.dir, 'aia.csv') });
  assert.equal(aiaOnly.rows, 1);
});

test('mention detection ignores foreign parents and same-name non-life businesses', () => {
  assert.deepEqual(findMentionedBrands({ title: 'Prudential Financial và Manulife Financial báo lãi',
    content: 'Bảo hiểm Bảo Việt tăng trưởng; AIA Việt Nam ra mắt sản phẩm mới.' }, BRANDS), ['AIA Viet Nam']);
  assert.deepEqual(findMentionedBrands({ title: 'Manulife và Sun Life chi trả quyền lợi bảo hiểm' }, BRANDS),
    ['Sun Life Viet Nam', 'Manulife Viet Nam']);
});

test('an article found by several brands is fetched once and labelled once', async t => {
  const options = setup(t);
  const aia = BRANDS.find(item => item.brand === 'AIA Viet Nam');
  const manulife = BRANDS.find(item => item.brand === 'Manulife Viet Nam');
  const brands = [prudential, aia, manulife];
  options.plan = buildSearchPlan(brands.map(brand => ({ ...brand, queries: [brand.queries[0]] })), range,
    { publishers: ['example.vn'], web: false }).filter(task => task.kind === 'whole-range');
  options.concurrency = 1;
  const fetched = [];
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [card('industry')],
    fetchArticle: async url => { fetched.push(url); return article(url); },
  };
  await runCrawl(options, deps);
  assert.equal(fetched.length, 1);
  assert.equal(count(options.store, 'query_hits'), 3);
  const { rows } = await enrichAndExport(options);
  assert.equal(rows.length, 1);
  const verdicts = options.store.sql('SELECT brand, decision FROM article_brands ORDER BY brand').all();
  assert.deepEqual(verdicts.map(row => row.brand), ['AIA Viet Nam', 'FWD Viet Nam', 'Prudential Viet Nam']); // Manulife isn't named.
});

test('daily mode accumulates one CSV across moving windows, dedupes against a historical CSV and gives up on dead links', async t => {
  const options = setup(t);
  const seed = setup(t);
  const seedCsv = path.join(seed.dir, 'history.csv');
  // A historical export that already holds /seen.
  await runCrawl({ ...seed, plan: seed.plan.slice(0, 1) }, { launchBrowser: async () => {}, closeBrowser: async () => {},
    searchRss: async () => [card('seen')], fetchArticle: async url => article(url) });
  await enrichAndExport({ ...seed, outputPath: seedCsv });
  let fetches = 0;
  const day = async (from, to, cards) => {
    const dateRange = { from, to };
    const crawl = await runCrawl({ ...options, daily: true, maxAttempts: 2, dateRange,
      plan: buildSearchPlan([{ ...prudential, queries: ['"Prudential"'] }], dateRange, { publishers: [], web: false }),
    }, { launchBrowser: async () => {}, closeBrowser: async () => {},
      searchRss: async () => cards.map(card),
      fetchArticle: async url => { fetches++; if (url.endsWith('/listing')) return article(url, { articleText: 'Tin mới' });
        return url.endsWith('/dead') ? article(url, { error: 'HTTP 503', articleTitle: '' })
        : article(url, { publishDate: url.endsWith('/new') ? '2024-01-13T02:00:00Z' : '2024-01-12T02:00:00Z' }); },
    });
    const { exported } = await enrichAndExport({ ...options, dateRange }, { daily: true, dedupeWith: [seedCsv] });
    return { crawl, exported };
  };
  const first = await day('2024-01-10', '2024-01-12', ['old', 'seen', 'dead', 'listing']);
  assert.equal(first.crawl.mode, 'daily');
  assert.equal(first.crawl.url_statuses['not-article'], 1);
  assert.equal(first.exported.added, 1); // /seen is already in the historical CSV.
  const second = await day('2024-01-11', '2024-01-13', ['old', 'new', 'dead']);
  assert.equal(second.exported.added, 1);
  assert.equal(second.exported.rows, 2);
  assert.equal(second.crawl.abandoned_articles.length, 1);
  assert.equal(second.crawl.processing_complete, true);
  assert.equal(second.crawl.coverage_checks_complete, true);
  assert.equal(fetches, 6); // old, seen, dead, listing, then only new and the dead link's last attempt.
  const third = await day('2024-01-12', '2024-01-14', ['dead']);
  assert.equal(third.exported.added, 0);
  assert.equal(fetches, 6);
  assert.equal(readCsvFile(options.outputPath).length, 2);
});

test('RSS waits between planned and bisected requests, with a shorter delay than web search', async t => {
  const options = setup(t);
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  const pauses = [];
  const deps = { launchBrowser: async () => {}, closeBrowser: async () => {},
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
  assert.ok(parsed.dedupeWith[0].endsWith(path.join('output', 'history.csv')));
  assert.equal(new Date(`${parsed.dateRange.to}T00:00:00Z`) - new Date(`${parsed.dateRange.from}T00:00:00Z`), 86400000);
  assert.throws(() => parseArgs(['--daily', '--date-from', '2024-01-01', '--date-to', '2024-01-02'], {}), /--days/);
});

test('publisher searches use a quoted brand phrase when the first query is made of common words', () => {
  const baoViet = BRANDS.find(item => item.brand === 'Bao Viet Nhan Tho');
  const plan = buildSearchPlan([baoViet, prudential], range, { publishers: ['laodong.vn'], web: false });
  const site = plan.filter(task => task.kind === 'publisher-year').map(task => task.query);
  assert.deepEqual(site, ['"Bao Viet Nhan Tho" site:laodong.vn', '"Prudential" site:laodong.vn']);
});

test('the browser starts only for fallback reads and restarts between batches, never while a tab uses it', async t => {
  const options = { ...setup(t), concurrency: 1, browserRecycleArticles: 2 };
  options.plan = options.plan.filter(task => task.channel === 'rss').slice(0, 2);
  let open = false;
  let tabs = 0;
  let launches = 0;
  const deps = {
    launchBrowser: async () => { open = true; launches++; },
    closeBrowser: async () => { assert.equal(tabs, 0, 'browser closed while a tab was open'); open = false; },
    searchRss: async query => Array.from({ length: 6 }, (_, i) => card(`${query.length}-${i}`)),
    searchWeb: async () => ({ cards: [], truncated: false }),
    fetchArticle: async (url, opts) => {
      // Odd articles need the browser; the rest are read over HTTP.
      if (Number(url.slice(-1)) % 2 === 0) return article(url);
      await opts.ensureBrowser();
      tabs++;
      assert.ok(open, 'article opened on a closed browser');
      await new Promise(resolve => setImmediate(resolve));
      tabs--;
      return article(url, { fetchMethod: 'browser' });
    },
  };
  const result = await runCrawl(options, deps);
  assert.ok(result.fetched_articles > 0);
  assert.equal(result.fetch_methods.http, result.fetch_methods.browser);
  assert.ok(launches >= 2, `expected the browser to restart, launched ${launches} time(s)`);
  assert.equal(open, false);
});

test('social networks and job boards are not press sources', () => {
  for (const url of ['https://www.instagram.com/reel/abc/', 'https://web.facebook.com/x/posts/1', 'https://vn.linkedin.com/jobs/view/1',
    'https://www.tiktok.com/@a/video/1', 'https://youtu.be/abc', 'https://x.com/a/status/1', 'https://www.topcv.vn/viec-lam/a.html',
    'https://www.vietnamworks.com/a', 'https://careers.manulife.com.vn/job/1', 'https://tuyendung.fwd.com.vn/a', 'vieclam24h.vn']) {
    assert.equal(isBlocked(url), true, url);
  }
  for (const url of ['https://vnexpress.net/a.html', 'https://dantri.com.vn/viec-lam/a.htm', 'https://box.com/a', 'https://xyz.com.vn/a', 'cafef.vn']) {
    assert.equal(isBlocked(url), false, url);
  }
});
