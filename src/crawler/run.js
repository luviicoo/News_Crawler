'use strict';

/**
 * Phase 1 (crawl): chạy kế hoạch tìm kiếm, lưu URL tìm được vào store và tải
 * mỗi URL đúng một lần. Không phân loại ở bước này: mọi bài đọc được đều được
 * giữ (toàn văn + metadata); phân loại hãng/sentiment là việc của enrich.
 */

const pLimit = require('p-limit');
const { createArticleRegistry, normalizeTitle } = require('../parser/articleIdentity');
const { normalizeUrl, extractHostname } = require('../parser/urlParser');
const { RETRYABLE: RETRYABLE_STATUSES } = require('../store/db');
const { isBlocked, isListing } = require('./sources');
const { createBrowserSession } = require('./browserSession');
const { articleIdOf } = require('./googleNewsDecode');
const { createHash } = require('crypto');
const log = require('../output/logger');

const RETRYABLE = new Set(RETRYABLE_STATUSES);
const MIN_BODY_CHARS = 200;
const pause = (min, max) => max > 0
  ? new Promise(resolve => setTimeout(resolve, Math.max(0, min + Math.random() * (max - min)))) : Promise.resolve();
const contentHash = text => createHash('sha1').update(normalizeTitle(text)).digest('hex').slice(0, 16);

async function runCrawl(options, deps) {
  const { profileName, dateRange, plan, store, concurrency = 8, refresh = false,
    webMaxPages = 5, searchDelayMin = 3000, searchDelayMax = 6000, rssDelayMin = 1000, rssDelayMax = 2000,
    daily = false, maxAttempts = 3, browserRecycleArticles = 300, runArgs = null, shouldStop = () => false } = options;
  const limit = pLimit(concurrency);
  const processedThisRun = new Set();
  let fetchedThisRun = 0;
  const methods = { http: 0, browser: 0 };

  // Same-article detection across URLs (AMP/mobile/language/canonical) covers
  // every article already in the store, so a URL found again is never re-added.
  const registry = createArticleRegistry();
  for (const identity of store.articleIdentities()) registry.claim({ scope: 'all', ...identity });

  store.setRunPlan(plan.map(task => task.id));
  const queryState = new Map();
  for (const task of plan) {
    const saved = store.getQuery(task.id);
    if (saved) queryState.set(task.id, saved);
  }
  const runId = store.startRun({ profile: profileName, mode: daily ? 'daily' : 'historical', dateRange, args: runArgs });

  const browser = createBrowserSession({ launchBrowser: deps.launchBrowser, closeBrowser: deps.closeBrowser,
    recycleAfter: browserRecycleArticles });
  const ensureBrowser = browser.ensure;
  let searching = false;

  function report() {
    const queryStatuses = {};
    const unresolvedQueries = [];
    for (const task of plan) {
      const saved = queryState.get(task.id) || { status: 'pending' };
      queryStatuses[saved.status] = (queryStatuses[saved.status] || 0) + 1;
      if (saved.status !== 'done') unresolvedQueries.push({ ...task, status: saved.status, reason: saved.reason || undefined });
    }
    const urlStatuses = Object.fromEntries(store.planUrlStatuses().map(row => [row.status, row.n]));
    const summary = row => ({ url: row.url, status: row.status, reason: row.last_error, attempts: row.attempts });
    const retryable = store.planUrls({ statuses: [...RETRYABLE] });
    const isRetryable = row => !(daily && row.attempts >= maxAttempts);
    const unresolvedArticles = retryable.filter(isRetryable).map(summary);
    const abandonedArticles = retryable.filter(row => !isRetryable(row)).map(summary);
    const saturatedDays = [...queryState.values()].flatMap(query => query.saturatedDays || []);
    const webEnabled = plan.some(task => task.channel === 'web');
    return {
      updated_at: new Date().toISOString(), run_id: runId, mode: daily ? 'daily' : 'historical', dateRange,
      planned_queries: plan.length, query_statuses: queryStatuses, url_statuses: urlStatuses,
      fetched_articles: urlStatuses.fetched || 0, fetched_this_run: fetchedThisRun, fetch_methods: { ...methods },
      interrupted: shouldStop(), web_enabled: webEnabled,
      processing_complete: !unresolvedQueries.length && !unresolvedArticles.length,
      // Daily runs are RSS-only by design; the historical backfill covers the web stage.
      coverage_checks_complete: (webEnabled || daily) && !unresolvedQueries.length && !unresolvedArticles.length && !saturatedDays.length,
      unresolved_queries: unresolvedQueries, unresolved_articles: unresolvedArticles, abandoned_articles: abandonedArticles,
      saturated_day_queries: saturatedDays, search_stats: deps.getSearchStats?.() || {},
      limitation: 'Search indexes are not a complete publisher archive. Finished plans do not prove every published article was indexed.',
    };
  }

  async function processUrl(row) {
    if (shouldStop() || processedThisRun.has(row.url_key)) return;
    processedThisRun.add(row.url_key);
    const finish = (status, { error = null, articleId = null, fetchMethod = null } = {}) =>
      store.updateUrl(row.url_key, { status, error, articleId, fetchMethod });
    if (isBlocked(row.url) || isBlocked(row.publisher_domain) || isListing(row.url)) {
      finish('not-article', { error: 'Blocked source, listing page or PDF' });
      return;
    }
    let info;
    try {
      info = await deps.fetchArticle(row.url, { rssPublishDate: row.rss_publish_date || '', ensureBrowser });
    } catch (err) {
      finish('failed', { error: err.message });
      return;
    }
    // Left as it was in the store: read again once Google lifts the throttle.
    if (info.deferred) {
      processedThisRun.delete(row.url_key);
      return;
    }
    const fetchMethod = info.fetchMethod || null;
    if (fetchMethod === 'browser') browser.countFetch();
    if (fetchMethod) methods[fetchMethod] = (methods[fetchMethod] || 0) + 1;
    const text = info.articleText || '';
    if (info.notArticle) return finish('not-article', { error: info.error, fetchMethod });
    if (info.error) {
      finish('failed', { error: info.error, fetchMethod });
      if (/Browser not launched|browser has been closed|browser has disconnected/i.test(info.error)) {
        throw new Error(`Browser unavailable; crawl stopped with progress saved: ${info.error}`);
      }
      return;
    }
    if (!/^https?:\/\//i.test(info.finalUrl || '') || isBlocked(info.finalUrl) || isListing(info.finalUrl)) {
      return finish('not-article', { error: 'Not a publisher article destination', fetchMethod });
    }
    // A loaded page with a title but no body is a listing/profile page. Daily
    // runs drop it at once; historical runs keep retrying to never hide gaps.
    if (daily && info.articleTitle && text.length < MIN_BODY_CHARS) {
      return finish('not-article', { error: 'Page has a title but no article body (listing or profile page)', fetchMethod });
    }
    if (!info.articleTitle || text.length < MIN_BODY_CHARS) {
      return finish('content-unverified', { error: 'Article title/body could not be verified', fetchMethod });
    }
    if (!info.publishDate) return finish('date-unverified', { error: 'Publication date missing', fetchMethod });

    const claim = registry.claim({ scope: 'all', finalUrl: info.finalUrl, title: info.articleTitle,
      canonicalUrl: info.canonicalUrl, ogUrl: info.ogUrl, alternateUrls: info.alternateUrls });
    const articleId = claim.articleId;
    // An imported article without its body takes the body read for another of its URLs.
    const existing = claim.duplicate ? store.getArticle(articleId) : null;
    if (!claim.duplicate || existing?.content_status === 'missing') {
      const meta = info.meta || {};
      store.saveArticle({
        articleId, url: claim.duplicate ? existing.url : info.finalUrl,
        canonicalUrl: info.canonicalUrl, ogUrl: info.ogUrl, alternateUrls: info.alternateUrls,
        publisherDomain: extractHostname(claim.duplicate ? existing.url : info.finalUrl),
        title: info.articleTitle, titleNorm: normalizeTitle(info.articleTitle),
        sapo: meta.sapo, author: meta.author, section: meta.section, tags: meta.tags,
        publishDate: info.publishDate, modifiedDate: meta.modifiedDate, labels: meta.labels,
        prSignals: meta.prSignals, sourceCredit: meta.sourceCredit,
        contentHash: contentHash(text), fetchMethod, body: text, truncated: info.contentTruncated,
        firstSeenAt: existing?.first_seen_at,
      });
      fetchedThisRun++;
    }
    finish('fetched', { articleId, fetchMethod, error: claim.duplicate ? `Same article as ${articleId} (${claim.reason})` : null });
  }

  const unprocessed = () => store.planUrls({ statuses: [...RETRYABLE], maxAttempts: daily ? maxAttempts : 0 })
    .filter(row => !processedThisRun.has(row.url_key));

  // Order: URLs needing no Google News decoding, then links whose RSS title looks
  // relevant, then the rest, so a throttle or stop costs the least useful links.
  const priority = row => (!articleIdOf(row.url) ? 0 : deps.looksRelevant?.(row.rss_title) ? 1 : 2);

  async function drain() {
    const pending = unprocessed()
      .map(row => ({ row, rank: priority(row) }))
      .sort((a, b) => a.rank - b.rank)
      .map(item => item.row);
    // Small batches bound queued work and ensure a stop doesn't start more fetches.
    for (let index = 0; index < pending.length && !shouldStop(); index += concurrency * 4) {
      let batch = pending.slice(index, index + concurrency * 4);
      // While Google throttles decoding, Google News links wait and other URLs are still read.
      if (deps.isDecodeThrottled?.()) batch = batch.filter(row => !articleIdOf(row.url));
      const results = await Promise.allSettled(batch.map(row => limit(() => processUrl(row))));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      // Between batches no article tab is open; an in-flight search defers it.
      if (!searching) await browser.recycleIfDue();
    }
  }

  // Searches run ahead while articles from earlier searches are read.
  // Drains are chained so only one batch loop runs at a time.
  let draining = Promise.resolve();
  let drainError;
  const scheduleDrain = () => {
    draining = draining.then(() => (drainError ? undefined : drain())).catch(err => { drainError = drainError || err; });
  };
  const settleDrains = async () => {
    await draining;
    if (drainError) throw drainError;
  };

  let status = 'failed';
  try {
    if (!shouldStop()) await drain();
    for (const task of plan) {
      if (shouldStop()) break;
      const previous = queryState.get(task.id);
      if (!refresh && previous?.status === 'done') continue;
      if (drainError) break;
      // Web search shares the browser with article tabs and is CAPTCHA-prone:
      // finish reading earlier results first and keep the longer delay.
      if (task.channel === 'web') {
        await settleDrains();
        await ensureBrowser();
      }
      await (task.channel === 'rss' ? pause(rssDelayMin, rssDelayMax) : pause(searchDelayMin, searchDelayMax));
      if (shouldStop()) break;
      await browser.waitForRecycle();
      let response;
      const statsBefore = deps.getSearchStats?.().saturatedDayQueries?.length || 0;
      const attempts = (previous?.attempts || 0) + 1;
      searching = true;
      try {
        response = task.channel === 'rss'
          ? await deps.searchRss(task.query, task.dateRange, { shouldStop, pause: () => pause(rssDelayMin, rssDelayMax) })
          : await deps.searchWeb(task.brand, task.query, { dateRange: task.dateRange, maxPages: webMaxPages, shouldStop });
      } catch (err) {
        const value = { status: 'failed', reason: err.message, attempts, checkedAt: new Date().toISOString() };
        store.upsertQuery(task, profileName, value, runId);
        queryState.set(task.id, value);
        log.warn(`[COVERAGE] ${task.query}: ${err.message}`);
        continue;
      } finally {
        searching = false;
      }
      const cards = (Array.isArray(response) ? response : response.cards)
        .map(card => ({ ...card, urlKey: normalizeUrl(card.url) }))
        .filter(card => card.urlKey);
      const saturatedDays = (deps.getSearchStats?.().saturatedDayQueries || []).slice(statsBefore);
      const value = {
        status: response.interrupted ? 'failed' : response.truncated ? 'limited' : 'done', results: cards.length,
        pages: response.pages, saturatedDays, attempts, checkedAt: new Date().toISOString(),
        reason: response.interrupted ? 'Search interrupted; resume from the store'
          : response.truncated ? 'Web pagination limit reached; increase --web-pages and resume the same command' : undefined,
        webMaxPages: task.channel === 'web' ? webMaxPages : undefined,
      };
      for (const key of store.recordQueryResult(task, profileName, value, cards, runId)) processedThisRun.delete(key);
      queryState.set(task.id, value);
      scheduleDrain();
    }
    await settleDrains();
    // Google News links skipped during a throttle are read once its cooldown ends.
    while (!shouldStop() && deps.isDecodeThrottled && unprocessed().length) {
      if (deps.isDecodeThrottled()) {
        log.info(`[URL] ${unprocessed().length} URLs wait for the Google News cooldown; searches are finished.`);
        while (!shouldStop() && deps.isDecodeThrottled()) await pause(1000, 1000);
      }
      if (shouldStop()) break;
      scheduleDrain();
      await settleDrains();
    }
    status = shouldStop() ? 'interrupted' : 'done';
    return report();
  } finally {
    // Let in-flight article reads finish and record before closing resources.
    await draining;
    try {
      store.finishRun(runId, status, { fetched_this_run: fetchedThisRun, fetch_methods: methods,
        search_stats: deps.getSearchStats?.() || {} });
    } finally {
      await browser.close();
    }
  }
}

module.exports = { runCrawl, RETRYABLE, isBlocked, isListing };
