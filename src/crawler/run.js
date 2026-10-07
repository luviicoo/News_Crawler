'use strict';

const fs = require('fs');
const { createHash } = require('crypto');
const pLimit = require('p-limit');
const { openState, atomicJson, readAcceptedIdentities } = require('./state');
const { createArticleRegistry } = require('../parser/articleIdentity');
const { normalizeUrl, extractHostname, buildHomepage, isHomepageUrl } = require('../parser/urlParser');
const { formatDateVN } = require('../parser/dateParser');
const { createCsvWriter } = require('../output/artifacts');
const defaultClassifier = require('../utils/articleClassifier');
const { INDUSTRY_LABEL } = require('../config/brands');
const log = require('../output/logger');

const RETRYABLE = new Set(['pending', 'failed', 'date-unverified', 'content-unverified']);
const BLOCKED = new Set(['facebook.com', 'arabsvoice.net', 'tin.skydoor.net', 'twaslnews.com']);
const isBlocked = url => BLOCKED.has(extractHostname(url).replace(/^m\./, ''));
const isListing = url => isHomepageUrl(url) || /\/(?:tags?|authors?|search|tim-kiem)(?:\/|\?|$)|\.pdf(?:\?|$)/i.test(url);
// A search whose hits are at least this many rejected articles and almost
// never accepted ones needs a narrower (e.g. quoted) query in the profile.
const NOISY_MIN_REJECTED = 20;
const NOISY_MAX_RATE = 0.05;
const pause = (min, max) => max > 0
  ? new Promise(resolve => setTimeout(resolve, Math.max(0, min + Math.random() * (max - min)))) : Promise.resolve();

async function runCrawl(options, deps) {
  const { brands, allBrands, dateRange, plan, outputPath, statePath, reportPath,
    screenshots = false, screenshotDir = '', concurrency = 3, refresh = false,
    webMaxPages = 5, searchDelayMin = 3000, searchDelayMax = 6000, rssDelayMin = 1000, rssDelayMax = 2000,
    daily = false, maxAttempts = 3, seedStatePaths = [], industryLabel = INDUSTRY_LABEL,
    withinRange, shouldStop = () => false } = options;
  const findMentionedBrands = deps.findMentionedBrands || defaultClassifier.findMentionedBrands;
  // A daily checkpoint accumulates across days, so its identity excludes the
  // moving date window and plan; a historical checkpoint is tied to both.
  const state = openState(statePath, daily
    ? { version: 1, mode: 'daily', brands: brands.map(brand => brand.brand), screenshots,
      classifier: deps.classifierConfig || {} }
    : { version: 1, dateRange, brands: brands.map(brand => brand.brand),
      plan: plan.map(task => task.id), screenshots, classifier: deps.classifierConfig || {} });
  // Daily runs give up on articles that keep failing instead of retrying them forever.
  const isRetryable = card => RETRYABLE.has(card.status) && !(daily && card.attempts >= maxAttempts);
  let csv;
  let launched = false;
  const registry = createArticleRegistry();
  const brandByName = new Map(brands.map(brand => [brand.brand, brand]));
  const limit = pLimit(concurrency);
  const processedThisRun = new Set();
  let acceptedThisRun = 0;
  // Candidate ids by search URL, so another brand's search hit for an article
  // already read can be decided without opening it again.
  const byUrl = new Map();
  const indexCard = card => {
    const key = normalizeUrl(card.url);
    if (!byUrl.has(key)) byUrl.set(key, new Set());
    byUrl.get(key).add(card.id);
  };
  for (const card of state.candidates.values()) indexCard(card);

  function reuseVerdict(card) {
    for (const id of byUrl.get(normalizeUrl(card.url)) || []) {
      const prior = state.candidates.get(id);
      if (!prior || prior.brand === card.brand) continue;
      const via = `same URL already read for ${prior.brand}`;
      if (prior.status === 'not-article') return { status: 'not-article', reason: `${prior.reason} (${via})` };
      if (prior.status === 'out-of-range' && !withinRange(prior.reason, dateRange)) {
        return { status: 'out-of-range', reason: prior.reason };
      }
      if (!Array.isArray(prior.textBrands)) continue;
      if (!prior.textBrands.includes(card.brand)) {
        return { status: 'rejected', reason: `No target mention in article title/body (${via})`, textBrands: prior.textBrands };
      }
      if ((prior.mentioned || []).length > 1 && prior.mentioned.includes(card.brand) &&
          (prior.status === 'accepted' || prior.status === 'duplicate')) {
        return { status: 'duplicate', reason: `Industry article (${via})`, textBrands: prior.textBrands, mentioned: prior.mentioned };
      }
    }
    return null;
  }

  // Precision per search phrase (all date windows of the same brand/kind/query
  // combined): which profile queries bring mostly rejected articles.
  function queryPrecision() {
    const taskById = new Map(plan.map(task => [task.id, task]));
    const groups = new Map();
    for (const candidate of state.candidates.values()) {
      const keys = new Set();
      for (const id of candidate.queryIds || []) {
        const task = taskById.get(id);
        if (!task) continue;
        const key = JSON.stringify([task.brand, task.kind, task.channel, task.query]);
        if (keys.has(key)) continue;
        keys.add(key);
        if (!groups.has(key)) groups.set(key, { brand: task.brand, kind: task.kind, channel: task.channel,
          query: task.query, results: 0, accepted: 0, rejected: 0, other: 0 });
        const group = groups.get(key);
        group.results++;
        if (candidate.status === 'accepted' || candidate.status === 'duplicate') group.accepted++;
        else if (candidate.status === 'rejected') group.rejected++;
        else group.other++;
      }
    }
    return [...groups.values()]
      .map(group => ({ ...group, accepted_rate: Number((group.accepted / group.results).toFixed(3)) }))
      .sort((a, b) => b.rejected - a.rejected || a.accepted_rate - b.accepted_rate);
  }

  function report() {
    const queryStatuses = {};
    const candidateStatuses = {};
    const perYear = {};
    let accepted = 0;
    for (const task of plan) {
      const status = state.queries.get(task.id)?.status || 'pending';
      queryStatuses[status] = (queryStatuses[status] || 0) + 1;
    }
    for (const candidate of state.candidates.values()) {
      candidateStatuses[candidate.status] = (candidateStatuses[candidate.status] || 0) + 1;
      if (candidate.row) {
        accepted++;
        const year = candidate.row.publish_date.slice(-4);
        perYear[year] = (perYear[year] || 0) + 1;
      }
    }
    const unresolvedQueries = plan.filter(task => state.queries.get(task.id)?.status !== 'done')
      .map(task => ({ ...task, ...(state.queries.get(task.id) || { status: 'pending' }) }));
    const summary = ({ id, brand, url, title, status, reason, attempts }) => ({ id, brand, url, title, status, reason, attempts });
    const unresolvedArticles = [...state.candidates.values()].filter(isRetryable).map(summary);
    const abandonedArticles = [...state.candidates.values()]
      .filter(card => RETRYABLE.has(card.status) && !isRetryable(card)).map(summary);
    const stats = deps.getSearchStats?.() || {};
    const saturatedDays = [...state.queries.values()].flatMap(query => query.saturatedDays || []);
    const webEnabled = plan.some(task => task.channel === 'web');
    const precision = queryPrecision();
    const value = {
      updated_at: new Date().toISOString(), mode: daily ? 'daily' : 'historical', dateRange, outputPath, statePath,
      planned_queries: plan.length, query_statuses: queryStatuses,
      candidate_statuses: candidateStatuses, accepted_articles: accepted, accepted_this_run: acceptedThisRun, per_year: perYear,
      interrupted: shouldStop(), web_enabled: webEnabled,
      processing_complete: !unresolvedQueries.length && !unresolvedArticles.length,
      // Daily runs are RSS-only by design; the historical backfill covers the web stage.
      coverage_checks_complete: (webEnabled || daily) && !unresolvedQueries.length && !unresolvedArticles.length && !saturatedDays.length,
      unresolved_queries: unresolvedQueries, unresolved_articles: unresolvedArticles, abandoned_articles: abandonedArticles,
      saturated_day_queries: saturatedDays, search_stats: stats,
      noisy_queries: precision.filter(group => group.rejected >= NOISY_MIN_REJECTED && group.accepted_rate < NOISY_MAX_RATE),
      query_precision: precision,
      queries: plan.map(task => ({ ...task, ...(state.queries.get(task.id) || { status: 'pending' }) })),
      limitation: 'Search indexes are not a complete publisher archive. Finished plans do not prove every published article was indexed. Web date filters are approximate; article dates are checked separately.',
    };
    atomicJson(reportPath, value);
    return value;
  }

  async function processCandidate(card) {
    if (shouldStop() || processedThisRun.has(card.id)) return;
    processedThisRun.add(card.id);
    let verdict;
    const target = brandByName.get(card.brand);
    const attempts = card.attempts + 1;
    const finish = value => state.record({ type: 'candidate', id: card.id,
      value: { reason: null, ...value, attempts, checkedAt: new Date().toISOString() } });
    if (isBlocked(card.url) || isBlocked(card.publisherDomain) || isListing(card.url)) {
      finish({ status: 'not-article', reason: 'Blocked source, listing page or PDF' });
      return;
    }
    const reused = reuseVerdict(card);
    if (reused) {
      finish(reused);
      return;
    }
    async function evaluate(info) {
      if (verdict) return verdict;
      if (info.error) return (verdict = { status: 'failed', reason: info.error });
      if (!/^https?:\/\//i.test(info.finalUrl || '') || isBlocked(info.finalUrl) || isListing(info.finalUrl)) {
        return (verdict = { status: 'not-article', reason: 'Not a publisher article destination' });
      }
      // A loaded page with a title but no body is a listing/profile page. Daily
      // runs drop it at once; historical runs keep retrying to never hide gaps.
      if (daily && info.articleTitle && (info.articleText || '').length < 200) {
        return (verdict = { status: 'not-article', reason: 'Page has a title but no article body (listing or profile page)' });
      }
      if (!info.articleTitle || (info.articleText || '').length < 200) {
        return (verdict = { status: 'content-unverified', reason: 'Article title/body could not be verified' });
      }
      if (!info.publishDate) return (verdict = { status: 'date-unverified', reason: 'Publication date missing' });
      if (!withinRange(info.publishDate, dateRange)) return (verdict = { status: 'out-of-range', reason: info.publishDate });
      const article = { title: info.articleTitle, content: info.articleText,
        url: info.finalUrl, publisherDomain: extractHostname(info.finalUrl) };
      // A URL, publisher label, search snippet or another story's sidebar must
      // never be the only evidence of a target brand in the current article.
      // All brands' text matches are kept for reuse by other brands' search hits.
      const textBrands = findMentionedBrands(article, allBrands);
      if (!textBrands.includes(target.brand)) {
        return (verdict = { status: 'rejected', reason: 'No target mention in article title/body', textBrands });
      }
      const classification = await deps.classifyArticle(article, target, allBrands);
      if (classification.decision !== 'accept' || classification.brand !== target.brand) {
        return (verdict = { status: 'rejected', reason: classification.reason, textBrands });
      }
      // A story naming several tracked brands is one industry article, not one row per
      // brand. The shared scope makes later brands' searches dedupe against it.
      const mentioned = textBrands;
      const label = mentioned.length > 1 ? industryLabel : target.brand;
      const identity = { scope: label, finalUrl: info.finalUrl, title: info.articleTitle,
        canonicalUrl: info.canonicalUrl, ogUrl: info.ogUrl, alternateUrls: info.alternateUrls };
      const claim = registry.claim(identity);
      if (claim.duplicate) {
        return (verdict = { status: 'duplicate', reason: claim.reason, articleId: claim.articleId, textBrands, mentioned });
      }
      return (verdict = { status: 'accepted', identity, textBrands, mentioned, row: {
        brand: label, mentioned_brands: mentioned.join('; '), article_title: info.articleTitle, article_url: info.finalUrl,
        publisher_domain: article.publisherDomain, publisher_homepage: buildHomepage(article.publisherDomain),
        publish_date: formatDateVN(info.publishDate), sentiment: classification.sentiment || 'neutral',
        classification_source: classification.source || 'rules', article_id: claim.articleId,
      } });
    }
    let result;
    try {
      result = await deps.fetchArticle(card.url, {
        brand: card.brand, publisherDomain: card.publisherDomain, rssPublishDate: card.rssPublishDate,
        includeContent: true, screenshotDir: screenshots ? screenshotDir : '',
        shouldCapture: async info => (await evaluate(info)).status === 'accepted',
      });
    } catch (err) {
      if (verdict?.row) {
        finish(verdict);
        acceptedThisRun++;
        await csv.writeRow(verdict.row);
        return;
      }
      finish({ status: 'failed', reason: err.message });
      return;
    }
    // Exceptions in persistence/CSV must fail the run, rather than turn an
    // accepted registry claim into a silent fetch failure.
    const decision = await evaluate(result);
    finish(decision);
    if (decision.row) {
      acceptedThisRun++;
      await csv.writeRow(decision.row);
    }
    if (decision.status === 'failed' && /Browser not launched|browser has been closed|browser has disconnected/i.test(decision.reason)) {
      throw new Error(`Browser unavailable; crawl stopped with checkpoint saved: ${decision.reason}`);
    }
  }

  async function drain() {
    const pending = [...state.candidates.values()].filter(card => isRetryable(card) && !processedThisRun.has(card.id));
    // Small batches bound queued work and ensure a stop doesn't launch more tabs.
    for (let index = 0; index < pending.length && !shouldStop(); index += concurrency * 4) {
      const results = await Promise.allSettled(pending.slice(index, index + concurrency * 4)
        .map(card => limit(() => processCandidate(card))));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      report();
    }
  }

  // RSS searches run ahead while articles from earlier searches are read.
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

  try {
    fs.mkdirSync(require('path').dirname(outputPath), { recursive: true });
    // Accepted journal records are authoritative after an interrupted CSV write.
    const restoredPath = `${outputPath}.${process.pid}.tmp`;
    const restored = createCsvWriter(restoredPath);
    // Daily runs also dedupe against earlier (e.g. historical) checkpoints.
    for (const seed of seedStatePaths) {
      for (const identity of readAcceptedIdentities(seed)) registry.claim(identity);
    }
    for (const card of state.candidates.values()) {
      if (!card.row) continue;
      registry.claim(card.identity);
      await restored.writeRow(card.row);
    }
    await restored.finalize();
    fs.renameSync(restoredPath, outputPath);
    // Existing writer supports append mode, avoiding duplicate headers on resume.
    csv = createCsvWriter(outputPath, { append: true });
    report();
    const needsWork = [...state.candidates.values()].some(isRetryable) ||
      plan.some(task => refresh || state.queries.get(task.id)?.status !== 'done');
    if (needsWork && !shouldStop()) {
      launched = true;
      await deps.launchBrowser({ headless: true, managedSignals: true });
      await drain();
    }
    for (const task of plan) {
      if (shouldStop()) break;
      const previous = state.queries.get(task.id);
      if (!refresh && previous?.status === 'done') continue;
      if (drainError) break;
      // Web search shares the browser with article tabs and is CAPTCHA-prone:
      // finish reading earlier results first and keep the longer delay.
      if (task.channel === 'web') await settleDrains();
      await (task.channel === 'rss' ? pause(rssDelayMin, rssDelayMax) : pause(searchDelayMin, searchDelayMax));
      if (shouldStop()) break;
      let response;
      const statsBefore = deps.getSearchStats?.().saturatedDayQueries?.length || 0;
      try {
        response = task.channel === 'rss'
          ? await deps.searchRss(task.query, task.dateRange, { shouldStop, pause: () => pause(rssDelayMin, rssDelayMax) })
          : await deps.searchWeb(task.brand, task.query, { dateRange: task.dateRange, maxPages: webMaxPages, shouldStop });
      } catch (err) {
        state.record({ type: 'query', id: task.id, value: { status: 'failed', reason: err.message,
          attempts: (previous?.attempts || 0) + 1, checkedAt: new Date().toISOString() } });
        report();
        log.warn(`[COVERAGE] ${task.query}: ${err.message}`);
        continue;
      }
      const cards = (Array.isArray(response) ? response : response.cards).map(card => ({
        ...card, brand: task.brand,
        id: createHash('sha256').update(`${task.brand}\n${normalizeUrl(card.url)}`).digest('hex').slice(0, 24),
      }));
      const saturatedDays = (deps.getSearchStats?.().saturatedDayQueries || []).slice(statsBefore);
      for (const card of cards) {
        const current = state.candidates.get(card.id);
        if (current?.status === 'date-unverified' && !current.rssPublishDate && card.rssPublishDate) {
          processedThisRun.delete(card.id);
        }
      }
      for (const card of cards) indexCard(card);
      state.record({ type: 'query', id: task.id, cards, value: {
        status: response.interrupted ? 'failed' : response.truncated ? 'limited' : 'done', results: cards.length,
        pages: response.pages, saturatedDays, attempts: (previous?.attempts || 0) + 1,
        checkedAt: new Date().toISOString(),
        reason: response.interrupted ? 'Search interrupted; resume from checkpoint'
          : response.truncated ? 'Web pagination limit reached; increase --web-pages and resume the same command' : undefined,
        webMaxPages: task.channel === 'web' ? webMaxPages : undefined,
      } });
      scheduleDrain();
      report();
    }
    await settleDrains();
    return report();
  } finally {
    // Let in-flight article reads finish and record before closing resources.
    await draining;
    try {
      try { report(); }
      finally { if (csv) await csv.finalize(); }
    } finally {
      try { if (launched) await deps.closeBrowser(); }
      finally { state.close(); }
    }
  }
}

module.exports = { runCrawl, RETRYABLE };
