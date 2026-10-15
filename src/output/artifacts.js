'use strict';

/**
 * Output artifact utilities: incremental CSV writing.
 *
 * Produces a UTF-8 BOM-encoded CSV so Vietnamese text displays correctly when
 * opened in Microsoft Excel on Windows.
 *
 * Column order (fixed; the first ten columns are read by downstream pipelines):
 *   brand | mentioned_brands | article_title | article_url | publisher_domain | publisher_homepage | publish_date |
 *   sentiment | classification_source | article_id | author | section | tags | sapo | is_pr | pr_signals |
 *   republished_of | source_credit | content | content_2
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
  'brand',                // tên hãng, hoặc "Ngành bảo hiểm" khi bài nhắc từ 2 hãng
  'mentioned_brands',     // các hãng được nhắc trong tiêu đề/thân bài, phân cách bằng "; "
  'article_title',
  'article_url',
  'publisher_domain',
  'publisher_homepage',   // trang chủ của báo, vd: https://vnexpress.net
  'publish_date',
  'sentiment',
  'classification_source',
  'article_id',           // ID ổn định theo URL đã chuẩn hoá (bỏ ngôn ngữ/AMP/tracking)
  'author',
  'section',              // chuyên mục của báo
  'tags',                 // phân cách bằng "; "
  'sapo',
  'is_pr',                // "yes" khi trang có dấu hiệu bài PR/tài trợ
  'pr_signals',           // dấu hiệu tìm thấy, ví dụ "label:thong tin doanh nghiep; url:/tai-tro/"
  'republished_of',       // article_id của bài đăng sớm nhất ở báo khác (bài đăng lại)
  'source_credit',        // dòng ghi nguồn cuối bài ("Theo …")
  'content',              // toàn văn, tối đa 32.000 ký tự mỗi ô (giới hạn ô Excel 32.767)
  'content_2',            // phần còn lại của toàn văn khi bài dài hơn một ô
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
function createCsvWriter(filePath, { append = false } = {}) {
  // Ensure the output directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Open write stream and emit BOM + header immediately
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8', flags: append ? 'a' : 'w' });
  let streamError;
  stream.on('error', err => { streamError = err; });
  if (!append) {
    stream.write(BOM);
    stream.write(COLUMNS.join(',') + '\n');
  }

  log.debug(`CSV writer initialised: ${filePath}`);

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
      if (streamError) return reject(streamError);
      const line = rowToCsvLine(row) + '\n';

      // Back-pressure: nếu write() trả về false (buffer đầy), đợi 'drain'
      // rồi mới resolve — tránh gọi resolve() 2 lần.
      stream.write(line, 'utf8', err => {
        if (err) reject(err);
        else { rowsWritten++; resolve(); }
      });
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
      if (streamError) { stream.destroy(); reject(streamError); return; }
      stream.end(() => {
        streamClosed = true;
        log.debug(`CSV finalised. ${rowsWritten} rows written to ${filePath}`);
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

module.exports = {
  COLUMNS,
  rowToCsvLine,
  createCsvWriter,
  buildOutputPath,
  slugify,
};
