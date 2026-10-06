'use strict';

/**
 * Monthly RSS + publisher/year RSS + complementary web discovery.
 * Read article bodies before classification; checkpoint and resume by default.
 * Browser stays hidden and only CAPTCHA verification opens a separate window.
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Always load the env file from this project, even when the command is
// launched from a different working directory after the folder is moved.
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
// p-limit v3.x uses CommonJS exports
const { BRANDS } = require('./config/brands');
const { launchBrowser, closeBrowser } = require('./crawler/browser');
const { searchGoogleNewsRss, searchGoogleWeb, getSearchStats, resetSearchStats } = require('./crawler/google');
const { fetchArticle } = require('./crawler/article');
const { classifyArticle, normalizeText, getClassifierConfig } = require('./utils/articleClassifier');
const { slugify } = require('./output/artifacts');
const { DEFAULT_PUBLISHERS, buildSearchPlan } = require('./crawler/plan');
const { runCrawl } = require('./crawler/run');
const log = require('./output/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shiftDateKey(dateKey, offsetDays) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function getDefaultDateRange() {
  const today = toVietnamDateKey(new Date().toISOString());
  return { from: shiftDateKey(today, -6), to: today };
}

function parseArgs(args = process.argv.slice(2), env = process.env) {
  const values = {};
  const flags = new Set(['--headless', '--no-screenshots', '--screenshots', '--refresh', '--plan-only', '--rss-only']);
  const names = new Set(['date-from', 'date-to', 'brand', 'publishers', 'output', 'state', 'web-pages']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (flags.has(arg)) continue;
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !names.has(match[1])) throw new Error(`Unknown argument: ${arg}`);
    const value = match[2] === undefined ? args[++index] : match[2];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${match[1]}`);
    values[match[1]] = value;
  }
  const from = values['date-from'] || env.DATE_FROM || '';
  const to = values['date-to'] || env.DATE_TO || '';
  let dateRange = getDefaultDateRange();
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
  const selected = values.brand || env.BRAND || '';
  const brands = selected ? BRANDS.filter(def => [def.brand, ...(def.aliases || [])]
    .some(alias => normalizeText(alias) === normalizeText(selected))) : BRANDS;
  if (!brands.length) throw new Error(`Unknown brand: ${selected}`);
  const publishers = [...new Set((values.publishers || env.PUBLISHER_DOMAINS || DEFAULT_PUBLISHERS.join(','))
    .split(',').map(domain => domain.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean))];
  if (!publishers.length || publishers.some(domain => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))) {
    throw new Error('--publishers must be comma-separated publisher domains');
  }
  const webMaxPages = Number(values['web-pages'] || env.WEB_MAX_PAGES || 5);
  if (!Number.isInteger(webMaxPages) || webMaxPages < 1 || webMaxPages > 100) throw new Error('--web-pages must be 1..100');
  const root = path.resolve(PROJECT_ROOT, env.OUTPUT_DIR || 'output');
  const stem = `${brands.length === 1 ? slugify(brands[0].brand) : 'all_brands'}_${dateRange.from.replace(/-/g, '')}_${dateRange.to.replace(/-/g, '')}`;
  const outputPath = path.resolve(PROJECT_ROOT, values.output || path.join(root, `${stem}.csv`));
  const statePath = path.resolve(PROJECT_ROOT, values.state || `${outputPath}.state.jsonl`);
  if (outputPath === statePath) throw new Error('--output and --state must be different paths');
  return {
    headless: true, dateRange, brands, publishers,
    screenshots: !args.includes('--no-screenshots') && (args.includes('--screenshots') || env.SCREENSHOTS === 'true'),
    refresh: args.includes('--refresh'), planOnly: args.includes('--plan-only'), web: !args.includes('--rss-only'),
    webMaxPages, outputPath, statePath, reportPath: `${outputPath}.coverage.json`,
    screenshotDir: path.join(root, 'screenshots'),
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

async function main() {
  const options = parseArgs();
  const plan = buildSearchPlan(options.brands, options.dateRange, options);
  log.info(`Date range: ${describeDateRange(options.dateRange)} | brands: ${options.brands.map(def => def.brand).join(', ')}`);
  log.info(`Planned RSS queries: ${plan.filter(task => task.channel === 'rss').length}; complementary web queries: ${plan.filter(task => task.channel === 'web').length}`);
  log.info(`Screenshots: ${options.screenshots ? 'enabled' : 'disabled'} | ${options.refresh ? 'refresh searches' : 'resume unfinished work'}`);
  if (options.planOnly) {
    console.log(JSON.stringify({ ...options, plan }, null, 2));
    return;
  }
  let stopped = false;
  const onStop = () => { stopped = true; log.warn('Stopping: finish active articles and save checkpoint.'); };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  resetSearchStats();
  try {
    const config = getClassifierConfig();
    const concurrency = Number(process.env.ARTICLE_CONCURRENCY || 3);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error('ARTICLE_CONCURRENCY must be 1..20');
    const result = await runCrawl({
      ...options, plan, allBrands: BRANDS, concurrency,
      searchDelayMin: Number(process.env.SEARCH_DELAY_MIN || 3000),
      searchDelayMax: Number(process.env.SEARCH_DELAY_MAX || 6000),
      withinRange: isPublishDateWithinRange, shouldStop: () => stopped,
    }, {
      launchBrowser, closeBrowser, fetchArticle, classifyArticle,
      searchRss: searchGoogleNewsRss, searchWeb: searchGoogleWeb, getSearchStats,
      classifierConfig: { version: 3, mode: config.mode, reviewFallback: config.reviewFallback, model: config.geminiModel },
    });
    log.summary(result.accepted_articles, result.unresolved_queries.length + result.unresolved_articles.length, options.outputPath);
    log.health(`Coverage: ${result.coverage_checks_complete ? 'planned checks finished' : 'INCOMPLETE'}; ${result.unresolved_queries.length} unfinished/limited queries; ${result.unresolved_articles.length} unverified articles; ${result.saturated_day_queries.length} saturated RSS day queries.`);
    log.info(`Coverage report: ${options.reportPath}`);
    if (!result.coverage_checks_complete) process.exitCode = 2;
    if (stopped) process.exitCode = 130;
  } finally {
    process.removeListener('SIGINT', onStop);
    process.removeListener('SIGTERM', onStop);
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
