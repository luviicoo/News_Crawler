'use strict';

/**
 * Phase 2 (enrich): phân loại bài đã lưu trong store cho một profile.
 *
 * 1. Bài import chưa có toàn văn được tải lại.
 * 2. Tìm hãng được nhắc trong tiêu đề/thân bài (rule của profile), rồi phân
 *    loại từng hãng bằng rules + Gemini (CLASSIFIER_MODE).
 * 3. Nhãn: từ 2 hãng → nhãn ngành; 1 hãng → hãng đó; không hãng nào nhưng do
 *    truy vấn ngành tìm thấy và đúng chủ đề → nhãn ngành; còn lại bị loại
 *    (vẫn giữ trong store).
 * 4. Đánh dấu bài đăng lại (cùng tiêu đề hoặc cùng nội dung ở báo khác).
 * 5. Báo truy vấn nhiễu (đa số bài tìm được bị loại).
 */

const { createHash } = require('crypto');
const pLimit = require('p-limit');
const { normalizeTitle } = require('../parser/articleIdentity');
const { extractHostname } = require('../parser/urlParser');
const { createBrowserSession } = require('../crawler/browserSession');
const log = require('../output/logger');

// Bump when classification logic changes, so stored labels are recomputed.
const ENRICH_VERSION = 'v2';
const LEGACY_VERSION = 'legacy';
const MIN_REPUBLISH_TITLE = 30;
// A search whose hits are at least this many rejected articles and almost
// never accepted ones needs a narrower (e.g. quoted) query in the profile.
const NOISY_MIN_REJECTED = 20;
const NOISY_MAX_RATE = 0.05;

async function classifyStored(article, body, { profile, classifier, foundByIndustry }) {
  const input = { title: article.title || '', content: body, url: article.url, publisherDomain: article.publisher_domain };
  const textBrands = classifier.findMentionedBrands(input, profile.brands);
  const results = [];
  for (const brand of textBrands) {
    const definition = profile.brands.find(def => def.brand === brand);
    const result = await classifier.classifyArticle(input, definition, profile.brands);
    results.push({ brand, decision: result.decision === 'accept' && result.brand === brand ? 'accept' : 'reject',
      sentiment: result.sentiment || 'neutral', source: result.source || 'rules', reason: result.reason });
  }
  const accepted = results.filter(result => result.decision === 'accept');
  if (accepted.length) {
    // A story naming several tracked brands is one industry article, not one row per brand.
    return { results, label: {
      relevance: 'accepted', label: textBrands.length > 1 ? profile.industryLabel : accepted[0].brand,
      mentionedBrands: textBrands, sentiment: accepted[0].sentiment,
      source: [...new Set(accepted.flatMap(result => result.source.split('+')))].join('+'),
      reason: accepted.map(result => `${result.brand}: ${result.reason}`).join(' | '),
    } };
  }
  if (!textBrands.length && foundByIndustry) {
    const topic = await classifier.classifyTopic(input);
    return { results, label: {
      relevance: topic.decision === 'accept' ? 'accepted' : 'rejected',
      label: topic.decision === 'accept' ? profile.industryLabel : null, mentionedBrands: [],
      sentiment: topic.sentiment || 'neutral', source: topic.source, reason: `Industry news: ${topic.reason}`,
    } };
  }
  return { results, label: {
    relevance: 'rejected', label: null, mentionedBrands: textBrands, sentiment: null,
    source: results[0]?.source || 'rules',
    reason: results.length ? results.map(result => `${result.brand}: ${result.reason}`).join(' | ')
      : 'No tracked brand in article title/body',
  } };
}

/**
 * Bài cùng tiêu đề (đủ dài) hoặc cùng nội dung ở báo khác: bài sau trỏ về bài
 * đăng sớm nhất. Vẫn là hai lần xuất hiện, chỉ được đánh dấu.
 * @returns {number} số bài được đánh dấu là đăng lại
 */
function markRepublished(store) {
  const rows = store.sql(`SELECT article_id, title_norm, content_hash, content_status, publisher_domain, publish_date
    FROM articles WHERE publish_date IS NOT NULL ORDER BY publish_date, article_id`).all();
  const parent = new Map(rows.map(row => [row.article_id, row.article_id]));
  const find = id => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (a, b) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent.set(right, left);
  };
  const firstBy = new Map();
  for (const row of rows) {
    const keys = [];
    if ((row.title_norm || '').length >= MIN_REPUBLISH_TITLE) keys.push(`t:${row.title_norm}`);
    if (row.content_hash && row.content_status === 'ok') keys.push(`c:${row.content_hash}`);
    for (const key of keys) {
      if (firstBy.has(key)) union(firstBy.get(key), row.article_id);
      else firstBy.set(key, row.article_id);
    }
  }
  const groups = new Map();
  for (const row of rows) {
    const root = find(row.article_id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  }
  let marked = 0;
  store.transaction(() => {
    store.sql('UPDATE articles SET republished_of = NULL WHERE republished_of IS NOT NULL').run();
    const update = store.sql('UPDATE articles SET republished_of = ? WHERE article_id = ?');
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      // Rows are ordered by publish date, so the first member is the original.
      const [original, ...later] = members;
      for (const row of later) {
        if (row.publisher_domain === original.publisher_domain) continue;
        update.run(original.article_id, row.article_id);
        marked++;
      }
    }
  });
  return marked;
}

function queryPrecision(store, profileName) {
  return store.sql(`SELECT q.brand, q.kind, q.channel, q.query, COUNT(DISTINCT d.url_key) AS results,
      COUNT(DISTINCT CASE WHEN l.relevance = 'accepted' THEN d.url_key END) AS accepted,
      COUNT(DISTINCT CASE WHEN l.relevance = 'rejected' THEN d.url_key END) AS rejected
    FROM search_queries q JOIN query_hits h ON h.query_id = q.id JOIN discovered_urls d ON d.url_key = h.url_key
    LEFT JOIN article_labels l ON l.article_id = d.article_id AND l.profile = q.profile
    WHERE q.profile = ? GROUP BY q.brand, q.kind, q.channel, q.query`).all(profileName)
    .map(group => ({ ...group, accepted_rate: Number((group.accepted / Math.max(1, group.results)).toFixed(3)) }))
    .sort((a, b) => b.rejected - a.rejected || a.accepted_rate - b.accepted_rate);
}

/**
 * @param {object} store
 * @param {object} options
 * @param {object} options.profile
 * @param {object} options.classifier       createClassifier(profile)
 * @param {Function} [options.fetchArticle] (url, {ensureBrowser}) → bài; tải lại bài import chưa có toàn văn
 */
async function runEnrich(store, { profile, classifier, fetchArticle, launchBrowser, closeBrowser,
  concurrency = 4, reclassify = false, browserRecycleArticles = 300, shouldStop = () => false }) {
  const runId = store.startRun({ profile: profile.name, mode: 'enrich', args: { reclassify } });
  const browser = launchBrowser
    ? createBrowserSession({ launchBrowser, closeBrowser, recycleAfter: browserRecycleArticles }) : null;
  const stats = { articles: 0, refetched: 0, refetch_failed: 0, classified: 0, accepted: 0, rejected: 0,
    waiting_for_content: 0, republished: 0 };
  const limit = pLimit(Math.max(1, concurrency));

  async function refetch(article) {
    if (!fetchArticle) return false;
    const info = await fetchArticle(article.url, { ensureBrowser: browser ? browser.ensure : async () => {} });
    if (info.fetchMethod === 'browser') browser?.countFetch();
    // Throttled Google News link: left as missing so a later enrich tries again.
    if (info.deferred) return false;
    const text = info.articleText || '';
    if (info.error || info.notArticle || !info.articleTitle || text.length < 200) {
      // Not retried by later runs; the imported row and its label stay as they were.
      store.sql("UPDATE articles SET content_status = 'unavailable' WHERE article_id = ?").run(article.article_id);
      stats.refetch_failed++;
      return false;
    }
    const meta = info.meta || {};
    store.saveArticle({
      articleId: article.article_id, url: article.url, canonicalUrl: info.canonicalUrl, ogUrl: info.ogUrl,
      alternateUrls: info.alternateUrls, publisherDomain: article.publisher_domain || extractHostname(article.url),
      title: info.articleTitle, titleNorm: normalizeTitle(info.articleTitle), sapo: meta.sapo, author: meta.author,
      section: meta.section, tags: meta.tags, publishDate: article.publish_date || info.publishDate,
      modifiedDate: meta.modifiedDate, labels: meta.labels, prSignals: meta.prSignals, sourceCredit: meta.sourceCredit,
      contentHash: createHash('sha1').update(normalizeTitle(text)).digest('hex').slice(0, 16),
      fetchMethod: info.fetchMethod, body: text, truncated: info.contentTruncated, firstSeenAt: article.first_seen_at,
    });
    stats.refetched++;
    return true;
  }

  async function enrichOne(articleId) {
    if (shouldStop()) return;
    let article = store.getArticle(articleId);
    if (!article) return;
    stats.articles++;
    if (article.content_status === 'missing' && await refetch(article)) article = store.getArticle(articleId);
    const existing = store.getLabel(articleId, profile.name);
    const due = reclassify || !existing || (existing.enrich_version !== ENRICH_VERSION && existing.enrich_version !== LEGACY_VERSION);
    if (!due) return;
    const body = store.getContent(articleId)?.body_text || '';
    if (!body) {
      stats.waiting_for_content++;
      return;
    }
    const foundByIndustry = store.foundByKinds(articleId, profile.name).includes('industry');
    const { results, label } = await classifyStored(article, body, { profile, classifier, foundByIndustry });
    store.saveLabel(articleId, profile.name, { ...label, enrichVersion: ENRICH_VERSION }, results);
    stats.classified++;
    stats[label.relevance]++;
  }

  let status = 'failed';
  try {
    const ids = store.profileArticleIds(profile.name);
    log.info(`[ENRICH] ${ids.length} articles in profile ${profile.name}`);
    for (let index = 0; index < ids.length && !shouldStop(); index += concurrency * 4) {
      const results = await Promise.allSettled(ids.slice(index, index + concurrency * 4).map(id => limit(() => enrichOne(id))));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      if (browser) await browser.recycleIfDue();
      if ((index / (concurrency * 4)) % 25 === 24) log.info(`[ENRICH] ${Math.min(index + concurrency * 4, ids.length)}/${ids.length} articles checked`);
    }
    stats.republished = markRepublished(store);
    if (classifier.usage) stats.gemini = { ...classifier.usage };
    const precision = queryPrecision(store, profile.name);
    stats.noisy_queries = precision.filter(group => group.rejected >= NOISY_MIN_REJECTED && group.accepted_rate < NOISY_MAX_RATE);
    status = shouldStop() ? 'interrupted' : 'done';
    return stats;
  } finally {
    store.finishRun(runId, status, stats);
    if (browser) await browser.close();
  }
}

module.exports = { runEnrich, classifyStored, markRepublished, queryPrecision, ENRICH_VERSION, LEGACY_VERSION };
