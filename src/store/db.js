'use strict';

/**
 * Store chung (SQLite, node:sqlite) cho mọi profile:
 *   crawl_runs        mỗi lượt crawl/enrich/import
 *   search_queries    truy vấn của kế hoạch và trạng thái (để chạy tiếp)
 *   discovered_urls   URL tìm được, trạng thái tải; mỗi URL chỉ tải một lần
 *   query_hits        truy vấn nào tìm thấy URL nào (→ hãng / tin ngành)
 *   articles          bài đã đọc: link thật, metadata, dấu hiệu PR, đăng lại
 *   article_contents  toàn văn
 *   article_labels    kết quả enrich theo profile (nhãn, sentiment, hãng được nhắc)
 *   article_brands    kết quả phân loại theo từng hãng
 * Tìm kiếm và kết quả tìm kiếm ghi trong cùng transaction trước khi truy vấn
 * được đánh dấu xong, nên dừng giữa chừng không mất URL đã tìm thấy.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile TEXT,
  mode TEXT NOT NULL,
  date_from TEXT,
  date_to TEXT,
  args_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  stats_json TEXT
);
CREATE TABLE IF NOT EXISTS search_queries (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  brand TEXT,
  kind TEXT,
  channel TEXT,
  query TEXT,
  date_from TEXT,
  date_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  results INTEGER,
  pages INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  saturated_days_json TEXT,
  web_max_pages INTEGER,
  checked_at TEXT,
  run_id INTEGER
);
CREATE INDEX IF NOT EXISTS search_queries_profile ON search_queries(profile, kind);
CREATE TABLE IF NOT EXISTS discovered_urls (
  url_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  rss_title TEXT,
  publisher_domain TEXT,
  rss_publish_date TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  article_id TEXT,
  fetch_method TEXT,
  first_seen_at TEXT NOT NULL,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS discovered_urls_status ON discovered_urls(status);
CREATE INDEX IF NOT EXISTS discovered_urls_article ON discovered_urls(article_id);
CREATE TABLE IF NOT EXISTS query_hits (
  query_id TEXT NOT NULL,
  url_key TEXT NOT NULL,
  PRIMARY KEY (query_id, url_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS query_hits_url ON query_hits(url_key);
CREATE TABLE IF NOT EXISTS articles (
  article_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  canonical_url TEXT,
  og_url TEXT,
  alternate_urls_json TEXT,
  publisher_domain TEXT,
  title TEXT,
  title_norm TEXT,
  sapo TEXT,
  author TEXT,
  section TEXT,
  tags_json TEXT,
  publish_date TEXT,
  modified_date TEXT,
  page_labels_json TEXT,
  pr_signals_json TEXT,
  is_pr INTEGER NOT NULL DEFAULT 0,
  source_credit TEXT,
  republished_of TEXT,
  content_hash TEXT,
  content_status TEXT NOT NULL DEFAULT 'ok',
  fetch_method TEXT,
  first_seen_at TEXT NOT NULL,
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS articles_publish ON articles(publish_date);
CREATE INDEX IF NOT EXISTS articles_title_norm ON articles(title_norm);
CREATE INDEX IF NOT EXISTS articles_content_hash ON articles(content_hash);
CREATE TABLE IF NOT EXISTS article_contents (
  article_id TEXT PRIMARY KEY REFERENCES articles(article_id) ON DELETE CASCADE,
  body_text TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  word_count INTEGER,
  extracted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_labels (
  article_id TEXT NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  relevance TEXT NOT NULL,
  label TEXT,
  mentioned_brands_json TEXT,
  sentiment TEXT,
  classification_source TEXT,
  reason TEXT,
  enrich_version TEXT NOT NULL,
  enriched_at TEXT NOT NULL,
  PRIMARY KEY (article_id, profile)
);
CREATE INDEX IF NOT EXISTS article_labels_profile ON article_labels(profile, relevance);
CREATE TABLE IF NOT EXISTS article_brands (
  article_id TEXT NOT NULL REFERENCES articles(article_id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  brand TEXT NOT NULL,
  decision TEXT NOT NULL,
  sentiment TEXT,
  source TEXT,
  reason TEXT,
  classified_at TEXT NOT NULL,
  PRIMARY KEY (article_id, profile, brand)
);
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const RETRYABLE = ['pending', 'failed', 'date-unverified', 'content-unverified'];
const now = () => new Date().toISOString();
const json = value => (value === undefined || value === null ? null : JSON.stringify(value));
const parse = value => (value ? JSON.parse(value) : null);

// One lock per store and profile: two crawls of the same profile would work
// on the same pending URLs and queries. Stale locks of dead processes are removed.
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid crawl lock: ${file}`);
    let alive = true;
    try { process.kill(pid, 0); } catch (check) { if (check.code === 'ESRCH') alive = false; }
    if (alive) throw new Error(`Crawl already running (PID ${pid}): ${file}`);
    fs.unlinkSync(file);
    fd = fs.openSync(file, 'wx');
  }
  fs.writeFileSync(fd, String(process.pid));
  fs.closeSync(fd);
  return () => { try { fs.unlinkSync(file); } catch (_) { /* already removed */ } };
}

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > SCHEMA_VERSION) throw new Error(`Store ${file} has a newer schema (${version}); update the crawler.`);
  if (version < SCHEMA_VERSION) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  const statements = new Map();
  const sql = text => {
    if (!statements.has(text)) statements.set(text, db.prepare(text));
    return statements.get(text);
  };
  let depth = 0;
  function transaction(fn) {
    // Nested calls join the outer transaction.
    if (depth) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth--;
    }
  }

  // ─── Runs ─────────────────────────────────────────────────────────────────
  function startRun({ profile = null, mode, dateRange = null, args = null }) {
    return Number(sql(`INSERT INTO crawl_runs (profile, mode, date_from, date_to, args_json, started_at, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')`).run(profile, mode, dateRange?.from ?? null, dateRange?.to ?? null,
      json(args), now()).lastInsertRowid);
  }
  function finishRun(id, status, stats = null) {
    sql('UPDATE crawl_runs SET finished_at = ?, status = ?, stats_json = ? WHERE id = ?').run(now(), status, json(stats), id);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────
  function getQuery(id) {
    const row = sql('SELECT * FROM search_queries WHERE id = ?').get(id);
    return row ? { ...row, saturatedDays: parse(row.saturated_days_json) || [] } : null;
  }
  function upsertQuery(task, profile, value, runId = null) {
    sql(`INSERT INTO search_queries (id, profile, brand, kind, channel, query, date_from, date_to, status, results, pages,
        attempts, reason, saturated_days_json, web_max_pages, checked_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, results = excluded.results, pages = excluded.pages,
        attempts = excluded.attempts, reason = excluded.reason, saturated_days_json = excluded.saturated_days_json,
        web_max_pages = excluded.web_max_pages, checked_at = excluded.checked_at, run_id = excluded.run_id,
        brand = COALESCE(excluded.brand, search_queries.brand), kind = COALESCE(excluded.kind, search_queries.kind),
        channel = COALESCE(excluded.channel, search_queries.channel), query = COALESCE(excluded.query, search_queries.query),
        date_from = COALESCE(excluded.date_from, search_queries.date_from), date_to = COALESCE(excluded.date_to, search_queries.date_to)`)
      .run(task.id, profile, task.brand ?? null, task.kind ?? null, task.channel ?? null, task.query ?? null,
        task.dateRange?.from ?? null, task.dateRange?.to ?? null, value.status, value.results ?? null, value.pages ?? null,
        value.attempts ?? 0, value.reason ?? null, json(value.saturatedDays || []), value.webMaxPages ?? null,
        value.checkedAt ?? now(), runId);
  }

  /**
   * Lưu URL tìm được và trạng thái truy vấn trong một transaction.
   * @returns {string[]} url_key được đưa lại hàng chờ nhờ có ngày RSS mới
   */
  function recordQueryResult(task, profile, value, cards, runId = null) {
    return transaction(() => {
      const reset = [];
      for (const card of cards) {
        const existing = sql('SELECT status, rss_publish_date FROM discovered_urls WHERE url_key = ?').get(card.urlKey);
        if (!existing) {
          sql(`INSERT INTO discovered_urls (url_key, url, rss_title, publisher_domain, rss_publish_date, first_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(card.urlKey, card.url, card.title || null, card.publisherDomain || null,
            card.rssPublishDate || null, now());
        } else if (!existing.rss_publish_date && card.rssPublishDate) {
          // A later feed can supply a missing publication date.
          const status = existing.status === 'date-unverified' ? 'pending' : existing.status;
          sql('UPDATE discovered_urls SET rss_publish_date = ?, status = ? WHERE url_key = ?')
            .run(card.rssPublishDate, status, card.urlKey);
          if (existing.status === 'date-unverified') reset.push(card.urlKey);
        }
        sql('INSERT OR IGNORE INTO query_hits (query_id, url_key) VALUES (?, ?)').run(task.id, card.urlKey);
      }
      upsertQuery(task, profile, value, runId);
      return reset;
    });
  }

  // ─── URLs ─────────────────────────────────────────────────────────────────
  // The plan of the current run, so pending work is limited to its own queries.
  db.exec('CREATE TEMP TABLE IF NOT EXISTS run_plan (id TEXT PRIMARY KEY) WITHOUT ROWID');
  function setRunPlan(ids) {
    transaction(() => {
      db.exec('DELETE FROM temp.run_plan');
      const insert = sql('INSERT OR IGNORE INTO temp.run_plan (id) VALUES (?)');
      for (const id of ids) insert.run(id);
    });
  }
  function planUrls({ statuses = RETRYABLE, maxAttempts = 0 } = {}) {
    const marks = statuses.map(() => '?').join(', ');
    return sql(`SELECT DISTINCT d.* FROM discovered_urls d
      JOIN query_hits h ON h.url_key = d.url_key JOIN temp.run_plan p ON p.id = h.query_id
      WHERE d.status IN (${marks}) AND (? = 0 OR d.attempts < ?)
      ORDER BY d.first_seen_at`).all(...statuses, maxAttempts, maxAttempts);
  }
  function planUrlStatuses() {
    return sql(`SELECT d.status, COUNT(DISTINCT d.url_key) AS n FROM discovered_urls d
      JOIN query_hits h ON h.url_key = d.url_key JOIN temp.run_plan p ON p.id = h.query_id GROUP BY d.status`).all();
  }
  function updateUrl(urlKey, { status, error = null, articleId = null, fetchMethod = null }) {
    sql(`UPDATE discovered_urls SET status = ?, last_error = ?, article_id = COALESCE(?, article_id),
      fetch_method = COALESCE(?, fetch_method), attempts = attempts + 1, checked_at = ? WHERE url_key = ?`)
      .run(status, error, articleId, fetchMethod, now(), urlKey);
  }

  // ─── Articles ─────────────────────────────────────────────────────────────
  function getArticle(articleId) {
    const row = sql('SELECT * FROM articles WHERE article_id = ?').get(articleId);
    return row ? hydrateArticle(row) : null;
  }
  function hydrateArticle(row) {
    return { ...row, alternateUrls: parse(row.alternate_urls_json) || [], tags: parse(row.tags_json) || [],
      prSignals: parse(row.pr_signals_json) || [], labels: parse(row.page_labels_json) || [] };
  }
  /** Ghi (hoặc ghi đè) bài và toàn văn. */
  function saveArticle(article) {
    transaction(() => {
      sql(`INSERT INTO articles (article_id, url, canonical_url, og_url, alternate_urls_json, publisher_domain, title,
          title_norm, sapo, author, section, tags_json, publish_date, modified_date, page_labels_json, pr_signals_json,
          is_pr, source_credit, content_hash, content_status, fetch_method, first_seen_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(article_id) DO UPDATE SET url = excluded.url, canonical_url = excluded.canonical_url,
          og_url = excluded.og_url, alternate_urls_json = excluded.alternate_urls_json,
          publisher_domain = excluded.publisher_domain, title = excluded.title, title_norm = excluded.title_norm,
          sapo = excluded.sapo, author = excluded.author, section = excluded.section, tags_json = excluded.tags_json,
          publish_date = COALESCE(excluded.publish_date, articles.publish_date), modified_date = excluded.modified_date,
          page_labels_json = excluded.page_labels_json, pr_signals_json = excluded.pr_signals_json, is_pr = excluded.is_pr,
          source_credit = excluded.source_credit, content_hash = excluded.content_hash,
          content_status = excluded.content_status, fetch_method = excluded.fetch_method, fetched_at = excluded.fetched_at`)
        .run(article.articleId, article.url, article.canonicalUrl || null, article.ogUrl || null,
          json(article.alternateUrls || []), article.publisherDomain || null, article.title || null, article.titleNorm || null,
          article.sapo || null, article.author || null, article.section || null, json(article.tags || []),
          article.publishDate || null, article.modifiedDate || null, json(article.labels || []),
          json(article.prSignals || []), article.prSignals?.length ? 1 : 0, article.sourceCredit || null,
          article.contentHash || null, article.contentStatus || 'ok', article.fetchMethod || null,
          article.firstSeenAt || now(), article.fetchedAt === undefined ? now() : article.fetchedAt);
      if (article.body !== undefined) {
        sql(`INSERT INTO article_contents (article_id, body_text, truncated, word_count, extracted_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(article_id) DO UPDATE SET body_text = excluded.body_text, truncated = excluded.truncated,
            word_count = excluded.word_count, extracted_at = excluded.extracted_at`)
          .run(article.articleId, article.body, article.truncated ? 1 : 0,
            article.body ? article.body.split(/\s+/).filter(Boolean).length : 0, now());
      }
    });
  }
  function getContent(articleId) {
    return sql('SELECT * FROM article_contents WHERE article_id = ?').get(articleId) || null;
  }
  /** Định danh của mọi bài đã lưu, để nạp lại bộ chống trùng khi chạy tiếp. */
  function* articleIdentities() {
    for (const row of sql('SELECT article_id, url, title, canonical_url, og_url, alternate_urls_json FROM articles').iterate()) {
      yield { articleId: row.article_id, finalUrl: row.url, title: row.title || '', canonicalUrl: row.canonical_url || '',
        ogUrl: row.og_url || '', alternateUrls: parse(row.alternate_urls_json) || [] };
    }
  }

  // ─── Enrichment ───────────────────────────────────────────────────────────
  /** Bài thuộc profile: do truy vấn của profile tìm thấy, hoặc đã có nhãn (import). */
  function profileArticleIds(profile) {
    return sql(`SELECT DISTINCT d.article_id AS id FROM discovered_urls d
        JOIN query_hits h ON h.url_key = d.url_key JOIN search_queries q ON q.id = h.query_id
        WHERE q.profile = ? AND d.article_id IS NOT NULL
      UNION SELECT article_id AS id FROM article_labels WHERE profile = ?`).all(profile, profile).map(row => row.id);
  }
  function foundByKinds(articleId, profile) {
    return sql(`SELECT DISTINCT q.kind FROM discovered_urls d JOIN query_hits h ON h.url_key = d.url_key
      JOIN search_queries q ON q.id = h.query_id WHERE d.article_id = ? AND q.profile = ?`).all(articleId, profile)
      .map(row => row.kind);
  }
  function getLabel(articleId, profile) {
    const row = sql('SELECT * FROM article_labels WHERE article_id = ? AND profile = ?').get(articleId, profile);
    return row ? { ...row, mentionedBrands: parse(row.mentioned_brands_json) || [] } : null;
  }
  function saveLabel(articleId, profile, label, brandResults = null) {
    transaction(() => {
      sql(`INSERT INTO article_labels (article_id, profile, relevance, label, mentioned_brands_json, sentiment,
          classification_source, reason, enrich_version, enriched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(article_id, profile) DO UPDATE SET relevance = excluded.relevance, label = excluded.label,
          mentioned_brands_json = excluded.mentioned_brands_json, sentiment = excluded.sentiment,
          classification_source = excluded.classification_source, reason = excluded.reason,
          enrich_version = excluded.enrich_version, enriched_at = excluded.enriched_at`)
        .run(articleId, profile, label.relevance, label.label ?? null, json(label.mentionedBrands || []),
          label.sentiment ?? null, label.source ?? null, label.reason ?? null, label.enrichVersion, now());
      if (brandResults) {
        sql('DELETE FROM article_brands WHERE article_id = ? AND profile = ?').run(articleId, profile);
        for (const result of brandResults) {
          sql(`INSERT INTO article_brands (article_id, profile, brand, decision, sentiment, source, reason, classified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(articleId, profile, result.brand, result.decision,
            result.sentiment ?? null, result.source ?? null, result.reason ?? null, now());
        }
      }
    });
  }

  // ─── Gemini answers, keyed by model + prompt ─────────────────────────────
  function getLlmCache(key) {
    return sql('SELECT response FROM llm_cache WHERE cache_key = ?').get(key)?.response || null;
  }
  function setLlmCache(key, model, response) {
    sql('INSERT OR REPLACE INTO llm_cache (cache_key, model, response, created_at) VALUES (?, ?, ?, ?)').run(key, model, response, now());
  }

  return {
    db, file, sql, transaction, close: () => db.close(),
    getLlmCache, setLlmCache,
    startRun, finishRun,
    getQuery, upsertQuery, recordQueryResult,
    setRunPlan, planUrls, planUrlStatuses, updateUrl,
    getArticle, hydrateArticle, saveArticle, getContent, articleIdentities,
    profileArticleIds, foundByKinds, getLabel, saveLabel,
  };
}

module.exports = { openStore, acquireLock, RETRYABLE, SCHEMA_VERSION };
