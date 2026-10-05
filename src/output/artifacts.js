'use strict';

/**
 * Output artifact utilities: incremental CSV writing and article screenshots.
 *
 * Produces a UTF-8 BOM-encoded CSV so Vietnamese text displays correctly when
 * opened in Microsoft Excel on Windows.
 *
 * Column order (fixed):
 *   brand | article_title | article_url | publisher_domain | publisher_homepage | publish_date | sentiment | classification_source | article_id
 *
 * Usage:
 *   const writer = createCsvWriter(filePath);
 *   await writer.writeRow({ brand, article_title, article_url, publisher_domain, publisher_homepage, publish_date, sentiment, classification_source });
 *   // …repeat for each article…
 *   await writer.finalize(); // flushes and closes the stream
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

// UTF-8 BOM – required for Excel to recognise the encoding
const BOM = '\uFEFF';

// Column definitions in output order
const COLUMNS = [
  'brand',
  'article_title',
  'article_url',
  'publisher_domain',
  'publisher_homepage',   // trang chủ của báo, vd: https://vnexpress.net
  'publish_date',
  'sentiment',
  'classification_source',
  'article_id',           // ID ổn định theo URL đã chuẩn hoá (bỏ ngôn ngữ/AMP/tracking)
];

/**
 * Escape a single CSV field value:
 *   - Wrap in double-quotes if the value contains commas, quotes, or newlines
 *   - Escape existing double-quotes by doubling them
 *
 * @param {string|null|undefined} val
 * @returns {string}
 */
function escapeCsvField(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Format a row object as a CSV line (no trailing newline).
 *
 * @param {Record<string,string|null>} row
 * @returns {string}
 */
function rowToCsvLine(row) {
  return COLUMNS.map((col) => escapeCsvField(row[col])).join(',');
}

/**
 * Create an incremental CSV writer for the given file path.
 *
 * The file is created immediately (with BOM + header row) so that partial
 * results are saved even if the run is interrupted.
 *
 * @param {string} filePath  Absolute or relative path to the output CSV
 * @returns {{ writeRow: Function, finalize: Function }}
 */
function createCsvWriter(filePath) {
  // Ensure the output directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open write stream and emit BOM + header immediately
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  stream.write(BOM);
  stream.write(COLUMNS.join(',') + '\n');

  log.info(`CSV writer initialised: ${filePath}`);

  let rowsWritten = 0;
  let streamClosed = false;

  /**
   * Append a single article row to the CSV.
   *
   * @param {object} row
   * @param {string}      row.brand
   * @param {string}      row.article_title
   * @param {string}      row.article_url
   * @param {string}      row.publisher_domain
   * @param {string|null} row.publish_date
   * @param {string|null} row.sentiment
   * @param {string|null} row.classification_source
   * @returns {Promise<void>}
   */
  function writeRow(row) {
    return new Promise((resolve, reject) => {
      if (streamClosed) {
        reject(new Error('CSV stream is already closed'));
        return;
      }
      const line = rowToCsvLine(row) + '\n';

      // Back-pressure: nếu write() trả về false (buffer đầy), đợi 'drain'
      // rồi mới resolve — tránh gọi resolve() 2 lần.
      const flushed = stream.write(line, 'utf8', (err) => {
        if (err) reject(err);
      });

      if (flushed) {
        // Buffer chưa đầy: ghi xong ngay
        rowsWritten++;
        resolve();
      } else {
        // Buffer đầy: chờ drain rồi mới tiếp
        stream.once('drain', () => {
          rowsWritten++;
          resolve();
        });
        stream.once('error', reject);
      }
    });
  }

  /**
   * Flush and close the CSV write stream.
   * Must be called once at the end of the run.
   *
   * @returns {Promise<void>}
   */
  function finalize() {
    return new Promise((resolve, reject) => {
      if (streamClosed) {
        resolve();
        return;
      }
      stream.end(() => {
        streamClosed = true;
        log.info(`CSV finalised. ${rowsWritten} rows written to ${filePath}`);
        resolve();
      });
      stream.once('error', reject);
    });
  }

  return { writeRow, finalize };
}

/**
 * Build a timestamped output file path.
 * Example: output/articles_20240315_143022.csv
 *
 * @param {string} [outputDir='output']
 * @returns {string}
 */
function buildOutputPath(outputDir = 'output') {
  const now = new Date();
  const pad = (n, d = 2) => String(n).padStart(d, '0');
  const timestamp =
    `${now.getFullYear()}` +
    `${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}_` +
    `${pad(now.getHours())}` +
    `${pad(now.getMinutes())}` +
    `${pad(now.getSeconds())}`;
  return path.join(outputDir, `articles_${timestamp}.csv`);
}

function slugify(str) {
  if (!str) return 'unknown';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-z0-9.\-]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function isoToDateSlug(isoString) {
  if (!isoString) return 'nodate';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return 'nodate';

  const vietnamTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${vietnamTime.getUTCFullYear()}` +
    `${pad(vietnamTime.getUTCMonth() + 1)}` +
    `${pad(vietnamTime.getUTCDate())}`
  );
}

function shortHash(url) {
  let hash = 5381;
  for (let index = 0; index < url.length; index++) {
    hash = ((hash << 5) + hash) ^ url.charCodeAt(index);
    hash >>>= 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

async function captureArticleScreenshot(page, {
  brand,
  publisherDomain,
  publishDate,
  articleUrl,
  screenshotDir,
}) {
  try {
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    await page.setViewportSize({ width: 800, height: 800 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 5000 }),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]).catch(() => {});

    const filename = [
      slugify(brand),
      slugify(publisherDomain),
      isoToDateSlug(publishDate),
      shortHash(articleUrl),
    ].join('_') + '.png';
    const filePath = path.join(screenshotDir, filename);

    await page.screenshot({
      path: filePath,
      type: 'png',
      fullPage: false,
    });

    log.info(`[SCREENSHOT] Saved: ${filename}`);
    return filePath;
  } catch (err) {
    log.warn(`[SCREENSHOT] Failed for ${articleUrl}: ${err.message}`);
    return null;
  }
}

module.exports = {
  createCsvWriter,
  buildOutputPath,
  captureArticleScreenshot,
  slugify,
  isoToDateSlug,
};
