'use strict';

/**
 * Entry point for the insurance news crawler.
 *
 * Execution flow:
 *   1. Parse CLI flags (--headless)
 *   2. Load env vars
 *   3. Launch browser
 *   4. For each brand → for each query:
 *        a. Run Google News search → get article cards
 *        b. Deduplicate against global set
 *        c. Fetch each article page (with p-limit concurrency) → get publish_date
 *        d. Write each row to CSV immediately
 *   5. Print final summary
 *   6. Close browser
 *
 * CLI:
 *   node src/index.js              # headful (visible browser)
 *   node src/index.js --headless   # headless
 */

const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Always load the env file from this project, even when the command is
// launched from a different working directory after the folder is moved.
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
// p-limit v3.x uses CommonJS exports
const pLimit = require('p-limit');

const { BRANDS } = require('./config/brands');
const { launchBrowser, closeBrowser } = require('./crawler/browser');
const { searchGoogleNews } = require('./crawler/google');
const { fetchArticle } = require('./crawler/article');
const { classifyArticle } = require('./utils/articleClassifier');
const { createCsvWriter, buildOutputPath } = require('./output/artifacts');
const {
  extractHostname,
  buildHomepage,
  isDuplicate,
  markSeen,
} = require('./parser/urlParser');
const { formatDateVN } = require('./parser/dateParser');
const log = require('./output/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BLOCKED_PUBLISHER_DOMAINS = new Set([
  'facebook.com',
  'arabsvoice.net',
  'm.facebook.com',
  'tin.skydoor.net',
  'twaslnews.com',
  'www.facebook.com',
]);

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(min, max) {
  return new Promise((r) => setTimeout(r, randInt(min, max)));
}

function cleanTitleText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isBlockedPublisherDomain(domain) {
  const hostname = extractHostname(domain);
  return Boolean(hostname) && BLOCKED_PUBLISHER_DOMAINS.has(hostname);
}

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

function parseArgs() {
  const args = process.argv.slice(2);
  let dateFrom = process.env.DATE_FROM || '';
  let dateTo = process.env.DATE_TO || '';

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--date-from' && args[index + 1]) {
      dateFrom = args[index + 1];
      index++;
      continue;
    }
    if (arg === '--date-to' && args[index + 1]) {
      dateTo = args[index + 1];
      index++;
      continue;
    }
    if (arg.startsWith('--date-from=')) {
      dateFrom = arg.slice('--date-from='.length);
      continue;
    }
    if (arg.startsWith('--date-to=')) {
      dateTo = arg.slice('--date-to='.length);
    }
  }

  const normalizeDateKey = (value) => {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const parsed = new Date(`${text}T00:00:00Z`);
    if (isNaN(parsed.getTime())) return '';
    return text;
  };

  const normalizedDateFrom = normalizeDateKey(dateFrom);
  const normalizedDateTo = normalizeDateKey(dateTo);
  let dateRange = getDefaultDateRange();
  if (normalizedDateFrom && normalizedDateTo) {
    const sorted = [normalizedDateFrom, normalizedDateTo].sort();
    dateRange = { from: sorted[0], to: sorted[1] };
  }

  return {
    headless:
      args.includes('--headless') ||
      process.env.HEADLESS === 'true',
    dateRange,
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
  const { headless, dateRange } = parseArgs();

  const ARTICLE_CONCURRENCY = parseInt(process.env.ARTICLE_CONCURRENCY || '3', 10);
  const SEARCH_DELAY_MIN    = parseInt(process.env.SEARCH_DELAY_MIN    || '3000', 10);
  const SEARCH_DELAY_MAX    = parseInt(process.env.SEARCH_DELAY_MAX    || '6000', 10);
  const OUTPUT_DIR          = process.env.OUTPUT_DIR || 'output';

  // Build output path relative to the project root (one level up from src/)
  const outputPath    = buildOutputPath(path.resolve(PROJECT_ROOT, OUTPUT_DIR));
  // Thư mục lưu ảnh chụp màn hình bài báo
  const screenshotDir = path.resolve(PROJECT_ROOT, OUTPUT_DIR, 'screenshots');

  // Initialise incremental CSV writer (creates file + header immediately)
  const csv = createCsvWriter(outputPath);

  let totalArticles = 0;
  let totalErrors   = 0;

  log.info(`PR article timeline: ${describeDateRange(dateRange)}`);

  // ── Launch browser (shared across all brands) ──────────────────────────────
  await launchBrowser({ headless });

  // ── Brand loop (sequential) ────────────────────────────────────────────────
  for (const brandDef of BRANDS) {
    const { brand, queries } = brandDef;
    let brandArticles = 0;
    let brandErrors   = 0;

    // ── Query loop (sequential within each brand) ──────────────────────────
    for (const query of queries) {
      // RSS is the primary search path, so we only delay when it is configured.
      if (SEARCH_DELAY_MAX > 0) {
        await delay(SEARCH_DELAY_MIN, SEARCH_DELAY_MAX);
      }

      // ── Google News search ───────────────────────────────────────────────
      let cards;
      try {
        cards = await searchGoogleNews(brand, query, { dateRange });
      } catch (err) {
        log.warn(`Search failed for "${query}": ${err.message}`);
        brandErrors++;
        continue;
      }

      // ── Classify cards before dedupe/write ──────────────────────────────
      const resolvedCards = [];
      for (const card of cards) {
        if (isBlockedPublisherDomain(card.publisherDomain) || isBlockedPublisherDomain(card.url)) {
          log.skipBrand(brand, card.title, card.url);
          continue;
        }

        const classification = await classifyArticle(card, brandDef, BRANDS);

        log.classify(
          classification.decision,
          classification.source,
          classification.brand,
          classification.sentiment,
          classification.confidence,
          card.title,
          card.url,
          classification.reason
        );

        if (classification.decision === 'reject') {
          log.skipBrand(brand, card.title, card.url);
          continue;
        }

        if (classification.decision === 'reassign' && classification.brand !== brand) {
          log.reassignBrand(brand, classification.brand, card.title, card.url);
        }

        resolvedCards.push({
          ...card,
          resolvedBrand: classification.brand || brand,
          classificationSentiment: classification.sentiment || 'neutral',
          classificationSource: classification.source || 'unknown',
        });
      }

      const freshCards = resolvedCards.filter((c) => {
        const brandScope = c.resolvedBrand || brand;
        if (isDuplicate(c.url, brandScope)) return false;
        markSeen(c.url, brandScope);
        return true;
      });

      if (freshCards.length === 0) continue;

      // ── Fetch article details concurrently (bounded by p-limit) ──────────
      const limit = pLimit(ARTICLE_CONCURRENCY);

      const fetchTasks = freshCards.map((card) =>
        limit(async () => {
          try {
            const { finalUrl, publishDate, articleTitle } = await fetchArticle(card.url, {
              brand: card.resolvedBrand || brand,
              publisherDomain: card.publisherDomain || '',
              screenshotDir,
              shouldCapture: ({ finalUrl: resolvedUrl, publishDate: resolvedDate }) => {
                const resolvedDomain = extractHostname(resolvedUrl);
                return !isBlockedPublisherDomain(resolvedDomain) &&
                  !isBlockedPublisherDomain(resolvedUrl) &&
                  isPublishDateWithinRange(resolvedDate, dateRange);
              },
            });

            // publisherDomain: ưu tiên dùng domain từ card nếu trông như domain
            // (có dấu chấm), fallback về hostname của finalUrl
            const rawDomain = card.publisherDomain || '';
            const publisherDomain = /\.[a-z]{2,}$/i.test(rawDomain)
              ? rawDomain.replace(/^www\./i, '').toLowerCase()
              : extractHostname(finalUrl);

            if (isBlockedPublisherDomain(publisherDomain) || isBlockedPublisherDomain(finalUrl)) {
              log.skipBrand(card.resolvedBrand || brand, card.title, finalUrl);
              return false;
            }

            if (!isPublishDateWithinRange(publishDate, dateRange)) {
              log.info(`Skip out-of-range article (${describeDateRange(dateRange)}): ${finalUrl}`);
              return false;
            }

            const row = {
              brand: card.resolvedBrand,
              article_title:      articleTitle || cleanTitleText(card.title),
              article_url:        finalUrl,
              publisher_domain:   publisherDomain,
              publisher_homepage: buildHomepage(publisherDomain),
              publish_date:       formatDateVN(publishDate),
              sentiment:          card.classificationSentiment,
              classification_source: card.classificationSource,
            };

            await csv.writeRow(row);
            brandArticles++;
            totalArticles++;
            return true;
          } catch (err) {
            log.error(card.url, err.message);
            brandErrors++; // totalErrors sẽ cộng qua brandErrors ở cuối vòng brand
            return false;
          }
        })
      );

      await Promise.all(fetchTasks);
    }

    log.done(brand, queries.length, brandArticles, brandErrors);
    totalErrors += brandErrors;
  }

  // ── Finalise CSV ───────────────────────────────────────────────────────────
  await csv.finalize();

  // ── Close browser ──────────────────────────────────────────────────────────
  await closeBrowser();

  // ── Final summary ──────────────────────────────────────────────────────────
  log.summary(totalArticles, totalErrors, outputPath);
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
  getDefaultDateRange,
  isPublishDateWithinRange,
  parseArgs,
  toVietnamDateKey,
};
