'use strict';

/**
 * Xuất CSV từ store: bài đã được enrich nhận cho profile, lọc theo khoảng
 * ngày (giờ Việt Nam) và hãng. Cột sản phẩm nằm ngay sau cột mentioned_brands.
 *
 * - Lịch sử: ghi lại cả file (qua file tạm rồi đổi tên).
 * - Daily: giữ các dòng đã có trong file (kể cả file 10 cột cũ), chỉ thêm bài
 *   chưa có trong file đó và trong các file `--dedupe-with`.
 */

const fs = require('fs');
const { COLUMNS, createCsvWriter } = require('./artifacts');
const { readCsvFile } = require('./csvRead');
const { buildHomepage } = require('../parser/urlParser');
const { formatDateVN } = require('../parser/dateParser');
const { isBlocked } = require('../crawler/sources');
const { findMentionedProducts } = require('../utils/articleClassifier');
const log = require('./logger');

const CELL_LIMIT = 32000;

/**
 * Tách toàn văn thành 2 ô CSV, mỗi ô tối đa `limit` ký tự. Cắt ở khoảng trắng
 * để không đứt chữ, miễn phần còn lại vẫn vừa ô thứ hai.
 * @returns {[string, string]}
 */
function splitContent(text, limit = CELL_LIMIT) {
  const value = String(text || '');
  if (value.length <= limit) return [value, ''];
  const lowest = Math.max(1, value.length - limit);
  let cut = value.lastIndexOf(' ', limit);
  if (cut < lowest) cut = limit;
  return [value.slice(0, cut).trimEnd(), value.slice(cut).trimStart().slice(0, limit)];
}

function readArticleIds(file) {
  if (!fs.existsSync(file)) throw new Error(`Dedupe file not found: ${file}`);
  if (file.endsWith('.csv')) return readCsvFile(file).map(row => row.article_id).filter(Boolean);
  // A legacy checkpoint (.state.jsonl): accepted candidates carry their CSV row.
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const id = JSON.parse(line).value?.row?.article_id;
      return id ? [id] : [];
    } catch (_) {
      return []; // A concurrently written final line may be incomplete.
    }
  });
}

/** Dòng CSV cho các bài được nhận của profile. */
function selectRows(store, { profile, brands, dateRange, withinRange }) {
  const selected = new Set(brands.map(def => def.brand));
  const allSelected = profile.brands.every(def => selected.has(def.brand));
  const records = store.sql(`SELECT a.*, l.label, l.mentioned_brands_json, l.sentiment, l.classification_source,
      c.body_text FROM article_labels l JOIN articles a ON a.article_id = l.article_id
      LEFT JOIN article_contents c ON c.article_id = a.article_id
      WHERE l.profile = ? AND l.relevance = 'accepted' ORDER BY a.publish_date, a.article_id`).all(profile.name);
  const rows = [];
  for (const record of records) {
    if (!record.publish_date || !withinRange(record.publish_date, dateRange)) continue;
    if (isBlocked(record.url) || isBlocked(record.publisher_domain)) continue;
    const mentioned = JSON.parse(record.mentioned_brands_json || '[]');
    // A single-brand export keeps that brand's rows and industry rows naming it.
    if (!allSelected && !selected.has(record.label) && !mentioned.some(brand => selected.has(brand))) continue;
    const [content, content2] = splitContent(record.body_text);
    // Computed from the stored text, so a profile's new products apply to old articles too.
    const productBrands = profile.brands.filter(def => mentioned.includes(def.brand) || def.brand === record.label);
    const products = findMentionedProducts({ title: record.title, content: record.body_text }, productBrands);
    rows.push({
      brand: record.label, mentioned_brands: mentioned.join('; '), article_title: record.title,
      article_url: record.url, publisher_domain: record.publisher_domain,
      publisher_homepage: buildHomepage(record.publisher_domain), publish_date: formatDateVN(record.publish_date),
      sentiment: record.sentiment || 'neutral', classification_source: record.classification_source || 'rules',
      article_id: record.article_id, mentioned_products: products.join('; '), author: record.author, section: record.section,
      tags: JSON.parse(record.tags_json || '[]').join('; '), sapo: record.sapo, is_pr: record.is_pr ? 'yes' : 'no',
      pr_signals: JSON.parse(record.pr_signals_json || '[]').join('; '), republished_of: record.republished_of,
      source_credit: record.source_credit, content, content_2: content2,
    });
  }
  return rows;
}

async function writeAtomically(outputPath, rows) {
  const temp = `${outputPath}.${process.pid}.tmp`;
  const writer = createCsvWriter(temp);
  try {
    for (const row of rows) await writer.writeRow(row);
  } finally {
    await writer.finalize();
  }
  fs.renameSync(temp, outputPath);
}

/**
 * @returns {Promise<{outputPath:string, rows:number, added:number}>}
 */
async function exportCsv(store, { profile, brands = profile.brands, dateRange, withinRange, outputPath,
  daily = false, dedupeWith = [] }) {
  const rows = selectRows(store, { profile, brands, dateRange, withinRange });
  if (!daily) {
    await writeAtomically(outputPath, rows);
    return { outputPath, rows: rows.length, added: rows.length };
  }
  const existing = fs.existsSync(outputPath) ? readCsvFile(outputPath) : [];
  const known = new Set(existing.map(row => row.article_id).filter(Boolean));
  for (const file of dedupeWith) for (const id of readArticleIds(file)) known.add(id);
  const added = rows.filter(row => !known.has(row.article_id));
  // Rows of an older (10-column) file keep their values; new columns stay empty.
  const kept = existing.map(row => Object.fromEntries(COLUMNS.map(column => [column, row[column] ?? ''])));
  await writeAtomically(outputPath, [...kept, ...added]);
  log.info(`Daily CSV: ${added.length} new articles, ${kept.length + added.length} rows in total.`);
  return { outputPath, rows: kept.length + added.length, added: added.length };
}

module.exports = { exportCsv, splitContent, selectRows, readArticleIds, CELL_LIMIT };
