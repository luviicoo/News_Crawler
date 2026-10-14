'use strict';

/**
 * crawl-news: tìm bài (Google News RSS + Google Web), tải toàn văn vào store
 * SQLite (Phase 1), phân loại hãng/sentiment/tin ngành (Phase 2 enrich), xuất CSV.
 *
 *   node src/index.js [all|crawl|enrich|export|import|status] [options]
 *
 * Không có lệnh = all (crawl → enrich → export). Trình duyệt luôn chạy ẩn và chỉ
 * mở cửa sổ khi cần xác thực CAPTCHA.
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Always load the env file from this project, even when the command is
// launched from a different working directory after the folder is moved.
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
const { loadProfile, profileWarnings } = require('./config/profile');
const { launchBrowser, closeBrowser } = require('./crawler/browser');
const { searchGoogleNewsRss, searchGoogleWeb, getSearchStats, resetSearchStats } = require('./crawler/google');
const { createArticleFetcher } = require('./crawler/fetcher');
const { createClassifier, normalizeText } = require('./utils/articleClassifier');
const { slugify } = require('./output/artifacts');
const { buildSearchPlan } = require('./crawler/plan');
const { runCrawl } = require('./crawler/run');
const { runEnrich } = require('./enrich/enrich');
const { exportCsv } = require('./output/export');
const { openStore, acquireLock } = require('./store/db');
const { importLegacy } = require('./store/importLegacy');
const log = require('./output/logger');

const COMMANDS = new Set(['all', 'crawl', 'enrich', 'export', 'import', 'status']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shiftDateKey(dateKey, offsetDays) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function getDefaultDateRange(days = 7) {
  const today = toVietnamDateKey(new Date().toISOString());
  return { from: shiftDateKey(today, 1 - days), to: today };
}

function positiveInt(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}..${max}`);
  return number;
}

function parseArgs(args = process.argv.slice(2), env = process.env) {
  args = [...args];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'all';
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command} (use ${[...COMMANDS].join(', ')})`);
  const values = {};
  const positionals = [];
  const flags = new Set(['--headless', '--refresh', '--plan-only', '--rss-only', '--daily', '--reclassify']);
  const names = new Set(['date-from', 'date-to', 'brand', 'publishers', 'output', 'web-pages', 'days', 'dedupe-with', 'profile', 'store']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.has(arg)) continue;
    if (/^--state(=|$)/.test(arg)) throw new Error('--state was replaced by the shared store; use --store <file.db> (default output/news.db)');
    if (!arg.startsWith('--') && command === 'import') { positionals.push(arg); continue; }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !names.has(match[1])) throw new Error(`Unknown argument: ${arg}`);
    const value = match[2] === undefined ? args[++index] : match[2];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
    values[match[1]] = value;
  }
  const daily = args.includes('--daily');
  const days = positiveInt(values.days || env.DAILY_DAYS || 3, '--days', 1, 30);
  if (daily && (values['date-from'] || values['date-to'])) throw new Error('--daily uses --days instead of --date-from/--date-to');
  const from = daily ? '' : values['date-from'] || env.DATE_FROM || '';
  const to = daily ? '' : values['date-to'] || env.DATE_TO || '';
  let dateRange = daily ? getDefaultDateRange(days) : getDefaultDateRange();
  if (from || to) {
    for (const date of [from, to]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
          new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        throw new Error('Provide both valid --date-from and --date-to dates as YYYY-MM-DD');
      }
    }
    const sorted = [from, to].sort();
    dateRange = { from: sorted[0], to: sorted[1] };
  }
  const profile = loadProfile(values.profile || env.PROFILE);
  const selected = values.brand || env.BRAND || '';
  const brands = selected ? profile.brands.filter(def => [def.brand, ...(def.aliases || [])]
    .some(alias => normalizeText(alias) === normalizeText(selected))) : profile.brands;
  if (!brands.length) throw new Error(`Unknown brand: ${selected}`);
  const publishers = [...new Set((values.publishers || env.PUBLISHER_DOMAINS || (profile.publishers || []).join(','))
    .split(',').map(domain => domain.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean))];
  if (!publishers.length || publishers.some(domain => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))) {
    throw new Error('--publishers must be comma-separated publisher domains');
  }
  const webMaxPages = positiveInt(values['web-pages'] || env.WEB_MAX_PAGES || 5, '--web-pages', 1, 100);
  const maxAttempts = positiveInt(env.ARTICLE_MAX_ATTEMPTS || 3, 'ARTICLE_MAX_ATTEMPTS', 1, 1000);
  const root = path.resolve(PROJECT_ROOT, env.OUTPUT_DIR || 'output');
  const brandSlug = brands.length === 1 ? slugify(brands[0].brand) : 'all_brands';
  // Daily output is one cumulative file; historical output is per date range.
  // The profile prefix keeps different monitoring projects in separate files.
  const prefix = profile.outputPrefix ?? profile.name;
  const stem = [prefix && slugify(prefix), daily ? `daily_${brandSlug}`
    : `${brandSlug}_${dateRange.from.replace(/-/g, '')}_${dateRange.to.replace(/-/g, '')}`].filter(Boolean).join('_');
  const outputPath = path.resolve(PROJECT_ROOT, values.output || path.join(root, `${stem}.csv`));
  const storePath = path.resolve(PROJECT_ROOT, values.store || env.STORE_PATH || path.join(root, 'news.db'));
  const dedupeWith = (values['dedupe-with'] || env.DEDUPE_WITH || '').split(',').map(file => file.trim()).filter(Boolean)
    .map(file => path.resolve(PROJECT_ROOT, file));
  if (dedupeWith.includes(outputPath)) throw new Error('--dedupe-with must name a different file than --output');
  if (command === 'import' && !positionals.length) throw new Error('import needs a .state.jsonl or .csv file');
  return {
    command, files: positionals.map(file => path.resolve(process.cwd(), file)),
    headless: true, profile, dateRange, brands, publishers,
    allBrands: brands.length === profile.brands.length,
    refresh: args.includes('--refresh'), planOnly: args.includes('--plan-only'),
    reclassify: args.includes('--reclassify'),
    web: !daily && !args.includes('--rss-only'), daily, dedupeWith, maxAttempts,
    webMaxPages, outputPath, storePath,
  };
}

function describeDateRange(dateRange) {
  if (!dateRange) return 'Past week';
  return `${dateRange.from} -> ${dateRange.to}`;
}

function toVietnamDateKey(isoString) {
  if (!isoString) return '';
  const parsed = new Date(isoString);
  if (isNaN(parsed.getTime())) return '';

  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const local = new Date(parsed.getTime() + VN_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, '0');
  const year = local.getUTCFullYear();
  const month = pad(local.getUTCMonth() + 1);
  const day = pad(local.getUTCDate());
  return `${year}-${month}-${day}`;
}

function isPublishDateWithinRange(isoString, dateRange) {
  if (!dateRange) return true;
  const dateKey = toVietnamDateKey(isoString);
  return Boolean(dateKey) && dateKey >= dateRange.from && dateKey <= dateRange.to;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function envInt(name, fallback, min, max) {
  return positiveInt(process.env[name] ?? fallback, name, min, max);
}

function storeStatus(store) {
  const count = sql => store.sql(sql).get().n;
  return {
    store: store.file,
    articles: count('SELECT COUNT(*) AS n FROM articles'),
    articles_with_content: count('SELECT COUNT(*) AS n FROM article_contents'),
    articles_missing_content: count("SELECT COUNT(*) AS n FROM articles WHERE content_status = 'missing'"),
    pr_articles: count('SELECT COUNT(*) AS n FROM articles WHERE is_pr = 1'),
    republished_articles: count('SELECT COUNT(*) AS n FROM articles WHERE republished_of IS NOT NULL'),
    urls: store.sql('SELECT status, COUNT(*) AS n FROM discovered_urls GROUP BY status').all(),
    labels: store.sql('SELECT profile, relevance, COUNT(*) AS n FROM article_labels GROUP BY profile, relevance').all(),
    queries: store.sql('SELECT profile, status, COUNT(*) AS n FROM search_queries GROUP BY profile, status').all(),
    last_runs: store.sql('SELECT id, profile, mode, date_from, date_to, started_at, finished_at, status, stats_json FROM crawl_runs ORDER BY id DESC LIMIT 5')
      .all().map(run => ({ ...run, stats_json: undefined, stats: run.stats_json ? JSON.parse(run.stats_json) : null })),
  };
}

async function main() {
  const options = parseArgs();
  const { profile, command } = options;
  for (const warning of profileWarnings({ ...profile, brands: options.brands })) log.warn(warning);
  // Industry phrases name no brand, so a single-brand run leaves them out.
  const industryQueries = options.allBrands ? profile.topic?.queries || [] : [];
  const plan = buildSearchPlan(options.brands, options.dateRange, { ...options, industryQueries });
  log.info(`Profile: ${profile.name} | command: ${command} | store: ${options.storePath}`);
  if (command === 'all' || command === 'crawl') {
    log.info(`Date range: ${describeDateRange(options.dateRange)} | brands: ${options.brands.map(def => def.brand).join(', ')}`);
    log.info(`Planned RSS queries: ${plan.filter(task => task.channel === 'rss').length} ` +
      `(industry: ${plan.filter(task => task.kind === 'industry').length}); complementary web queries: ${plan.filter(task => task.channel === 'web').length}`);
  }
  if (options.planOnly) {
    console.log(JSON.stringify({ ...options, profile: profile.name, brands: options.brands.map(def => def.brand), plan }, null, 2));
    return;
  }

  const store = openStore(options.storePath);
  if (command === 'status') {
    console.log(JSON.stringify(storeStatus(store), null, 2));
    store.close();
    return;
  }
  // One crawl/enrich/import per profile and store at a time.
  const unlock = acquireLock(`${options.storePath}.${slugify(profile.name)}.lock`);
  let stopped = false;
  const onStop = () => { stopped = true; log.warn('Stopping: finish active articles and save progress.'); };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  try {
    if (command === 'import') {
      for (const file of options.files) {
        const counts = importLegacy(store, profile, file);
        log.info(`Imported ${file}: ${counts.articles} articles, ${counts.labels} labels, ${counts.urls} URLs, ${counts.queries} queries.`);
      }
      return;
    }
    const fetcher = createArticleFetcher({
      httpPerDomain: envInt('HTTP_PER_DOMAIN', 2, 1, 20),
      browserConcurrency: envInt('ARTICLE_CONCURRENCY', 3, 1, 20),
      decodeConcurrency: envInt('GN_DECODE_CONCURRENCY', 2, 1, 10),
      decodeIntervalMs: envInt('GN_DECODE_DELAY_MS', 1000, 0, 60000),
      decodeCooldownMs: envInt('GN_DECODE_COOLDOWN_MS', 600000, 60000, 3600000),
      decodeStateFile: `${options.storePath}.gn-decode.json`,
      prSignals: profile.prSignals,
    });
    const browserRecycleArticles = envInt('BROWSER_RECYCLE_ARTICLES', 300, 0, 100000);
    let incomplete = false;

    if (command === 'all' || command === 'crawl') {
      resetSearchStats();
      const result = await runCrawl({
        ...options, profileName: profile.name, plan, store, browserRecycleArticles,
        concurrency: envInt('HTTP_CONCURRENCY', 8, 1, 50),
        searchDelayMin: Number(process.env.SEARCH_DELAY_MIN || 3000),
        searchDelayMax: Number(process.env.SEARCH_DELAY_MAX || 6000),
        rssDelayMin: Number(process.env.RSS_DELAY_MIN || 1000),
        rssDelayMax: Number(process.env.RSS_DELAY_MAX || 2000),
        runArgs: process.argv.slice(2), shouldStop: () => stopped,
      }, {
        launchBrowser, closeBrowser, fetchArticle: fetcher.fetchArticle, isDecodeThrottled: fetcher.isDecodeThrottled,
        looksRelevant: createClassifier(profile).looksRelevant,
        searchRss: searchGoogleNewsRss, searchWeb: searchGoogleWeb, getSearchStats,
      });
      log.info(`Crawl: ${result.fetched_this_run} new articles stored; page reads: ${result.fetch_methods.http || 0} over HTTP, ` +
        `${result.fetch_methods.browser || 0} in the browser; ${result.fetched_articles} articles in this plan.`);
      log.health(`Coverage: ${result.coverage_checks_complete ? 'planned checks finished' : 'INCOMPLETE'}; ${result.unresolved_queries.length} unfinished/limited queries; ${result.unresolved_articles.length} unverified articles; ${result.saturated_day_queries.length} saturated RSS day queries.`);
      if (options.daily) log.info(`Daily: ${result.abandoned_articles.length} articles given up after ${options.maxAttempts} attempts.`);
      incomplete = !result.coverage_checks_complete;
    }

    if ((command === 'all' || command === 'enrich') && !stopped) {
      const stats = await runEnrich(store, {
        profile, classifier: createClassifier(profile, { cache: { get: store.getLlmCache, set: store.setLlmCache } }),
        fetchArticle: fetcher.fetchArticle,
        launchBrowser, closeBrowser, browserRecycleArticles,
        concurrency: envInt('ENRICH_CONCURRENCY', 4, 1, 50), reclassify: options.reclassify, shouldStop: () => stopped,
      });
      log.info(`Enrich: ${stats.classified} classified (${stats.accepted} accepted, ${stats.rejected} rejected); ` +
        `${stats.refetched} imported articles re-read, ${stats.refetch_failed} unavailable; ${stats.republished} republished.`);
      if (stats.gemini) {
        log.info(`Gemini: ${stats.gemini.calls} paid calls, ${stats.gemini.cacheHits} answers reused from the store, ` +
          `${stats.gemini.failures} failed; every other decision came from the profile rules.`);
      }
      if (stats.waiting_for_content) log.health(`WARN ${stats.waiting_for_content} articles have no body yet and were not classified.`);
      for (const group of stats.noisy_queries) {
        log.health(`WARN noisy query for ${group.brand || 'industry'} (${group.kind}): "${group.query}" — ${group.rejected} rejected, ` +
          `${group.accepted} accepted. Narrow it in profile ${profile.name}.`);
      }
    }

    if ((command === 'all' || command === 'export') && !stopped) {
      const result = await exportCsv(store, {
        profile, brands: options.brands, dateRange: options.dateRange, withinRange: isPublishDateWithinRange,
        outputPath: options.outputPath, daily: options.daily, dedupeWith: options.dedupeWith,
      });
      log.summary(result.added, 0, result.outputPath);
    }
    if (incomplete) process.exitCode = 2;
    if (stopped) process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
    store.close();
    unlock();
  }
}

// ─── Top-level error handler ──────────────────────────────────────────────────

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[FATAL]', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  getDefaultDateRange,
  isPublishDateWithinRange,
  parseArgs,
  toVietnamDateKey,
};
