'use strict';

/**
 * Nhập dữ liệu của bản cũ (checkpoint .state.jsonl hoặc CSV) vào store để
 * không phải kéo lại:
 *  - truy vấn đã chạy → search_queries (id giống kế hoạch hiện tại, nên crawl
 *    lịch sử cùng khoảng ngày không tìm lại);
 *  - URL tìm được → discovered_urls + query_hits; URL đã bị bản cũ loại không
 *    được tải lại (bản cũ không lưu nội dung của chúng);
 *  - bài đã nhận → articles + article_labels (giữ nhãn/sentiment cũ, export
 *    được ngay). Toàn văn trống; enrich tải lại dần.
 */

const fs = require('fs');
const { normalizeUrl, buildArticleKey, buildArticleId, extractHostname } = require('../parser/urlParser');
const { normalizeTitle } = require('../parser/articleIdentity');
const { buildSearchPlan } = require('../crawler/plan');
const { readCsvFile } = require('../output/csvRead');
const { LEGACY_VERSION } = require('../enrich/enrich');

const STATUS_MAP = {
  rejected: 'legacy-rejected',
  'out-of-range': 'legacy-out-of-range',
  'not-article': 'not-article',
  failed: 'failed',
  'content-unverified': 'content-unverified',
  'date-unverified': 'date-unverified',
  pending: 'pending',
};
// Best status wins when several brand candidates share one URL.
const STATUS_RANK = ['fetched', 'not-article', 'legacy-rejected', 'legacy-out-of-range',
  'date-unverified', 'content-unverified', 'failed', 'pending'];

/** "HH:mm:ss DD/MM/YYYY" giờ Việt Nam → ISO UTC. */
function parseDateVN(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2}):(\d{2}) (\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, hh, mm, ss, dd, mo, yyyy] = match.map(Number);
  return new Date(Date.UTC(yyyy, mo - 1, dd, hh - 7, mm, ss)).toISOString();
}

function readJournal(file) {
  let config = null;
  const queries = new Map();
  const candidates = new Map();
  const bytes = fs.readFileSync(file, 'utf8');
  for (const line of bytes.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      continue; // An interrupted final record.
    }
    if (event.type === 'config') config = event.value;
    if (event.type === 'query') {
      queries.set(event.id, event.value);
      for (const card of event.cards || []) {
        if (!candidates.has(card.id)) candidates.set(card.id, { ...card, status: 'pending', attempts: 0, queryIds: new Set() });
        const candidate = candidates.get(card.id);
        candidate.queryIds.add(event.id);
        if (!candidate.rssPublishDate && card.rssPublishDate) candidate.rssPublishDate = card.rssPublishDate;
      }
    }
    if (event.type === 'candidate' && candidates.has(event.id)) Object.assign(candidates.get(event.id), event.value);
  }
  return { config, queries, candidates };
}

function createImporter(store, profile) {
  const counts = { queries: 0, urls: 0, articles: 0, labels: 0 };
  const now = new Date().toISOString();

  function addArticle(row, identity = {}) {
    const url = row.article_url || identity.finalUrl;
    const articleId = row.article_id || buildArticleId(buildArticleKey(url));
    if (!url || !articleId) return '';
    if (!store.getArticle(articleId)) {
      store.saveArticle({
        articleId, url, canonicalUrl: identity.canonicalUrl, ogUrl: identity.ogUrl, alternateUrls: identity.alternateUrls,
        publisherDomain: row.publisher_domain || extractHostname(url), title: row.article_title || identity.title,
        titleNorm: normalizeTitle(row.article_title || identity.title), publishDate: parseDateVN(row.publish_date),
        contentStatus: 'missing', fetchMethod: 'legacy', fetchedAt: null,
      });
      counts.articles++;
    }
    if (!store.getLabel(articleId, profile.name)) {
      store.saveLabel(articleId, profile.name, {
        relevance: 'accepted', label: row.brand, enrichVersion: LEGACY_VERSION,
        mentionedBrands: String(row.mentioned_brands || row.brand || '').split(';').map(name => name.trim()).filter(Boolean),
        sentiment: row.sentiment || 'neutral', source: row.classification_source || 'rules', reason: 'Imported from legacy output',
      });
      counts.labels++;
    }
    return articleId;
  }

  function importJournal(file) {
    const { config, queries, candidates } = readJournal(file);
    // Historical checkpoints name their plan; rebuilding it restores query details.
    const tasks = new Map();
    if (config?.dateRange && Array.isArray(config.plan)) {
      const brands = profile.brands.filter(def => (config.brands || []).includes(def.brand));
      for (const web of [true, false]) {
        for (const task of buildSearchPlan(brands, config.dateRange, { publishers: profile.publishers, web })) {
          tasks.set(task.id, task);
        }
      }
    }
    store.transaction(() => {
      for (const [id, value] of queries) {
        if (store.getQuery(id)) continue;
        store.upsertQuery(tasks.get(id) || { id, kind: 'legacy' }, profile.name, value);
        counts.queries++;
      }
      const byUrl = new Map();
      for (const candidate of candidates.values()) {
        const urlKey = normalizeUrl(candidate.url);
        if (!urlKey) continue;
        let articleId = '';
        if (candidate.row) articleId = addArticle(candidate.row, candidate.identity);
        else if (candidate.status === 'duplicate' && candidate.articleId) articleId = candidate.articleId;
        const status = articleId ? 'fetched' : STATUS_MAP[candidate.status] || 'pending';
        const current = byUrl.get(urlKey);
        const better = !current || STATUS_RANK.indexOf(status) < STATUS_RANK.indexOf(current.status);
        const merged = better ? { ...candidate, urlKey, status, articleId } : current;
        merged.queryIds = new Set([...(current?.queryIds || []), ...candidate.queryIds]);
        byUrl.set(urlKey, merged);
      }
      for (const entry of byUrl.values()) {
        const existing = store.sql('SELECT status FROM discovered_urls WHERE url_key = ?').get(entry.urlKey);
        if (!existing) {
          store.sql(`INSERT INTO discovered_urls (url_key, url, rss_title, publisher_domain, rss_publish_date, status,
              attempts, last_error, article_id, fetch_method, first_seen_at, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?)`).run(entry.urlKey, entry.url, entry.title || null,
            entry.publisherDomain || null, entry.rssPublishDate || null, entry.status, entry.attempts || 0,
            entry.reason || null, entry.articleId || null, now, entry.checkedAt || null);
          counts.urls++;
        }
        for (const queryId of entry.queryIds) {
          store.sql('INSERT OR IGNORE INTO query_hits (query_id, url_key) VALUES (?, ?)').run(queryId, entry.urlKey);
        }
      }
    });
  }

  function importCsv(file) {
    store.transaction(() => {
      for (const row of readCsvFile(file)) if (row.article_url) addArticle(row);
    });
  }

  return { importJournal, importCsv, counts };
}

/**
 * @returns {{queries:number, urls:number, articles:number, labels:number}}
 */
function importLegacy(store, profile, file) {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const importer = createImporter(store, profile);
  const runId = store.startRun({ profile: profile.name, mode: 'import', args: { file } });
  try {
    if (file.endsWith('.jsonl')) importer.importJournal(file);
    else if (file.endsWith('.csv')) importer.importCsv(file);
    else throw new Error('Import expects a .state.jsonl checkpoint or a .csv file');
    store.finishRun(runId, 'done', importer.counts);
    return importer.counts;
  } catch (err) {
    store.finishRun(runId, 'failed', { error: err.message });
    throw err;
  }
}

module.exports = { importLegacy, parseDateVN, readJournal };
