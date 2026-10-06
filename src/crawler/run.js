'use strict';

const fs = require('fs');
const { createHash } = require('crypto');
const pLimit = require('p-limit');
const { openState, atomicJson } = require('./state');
const { createArticleRegistry } = require('../parser/articleIdentity');
const { normalizeUrl, extractHostname, buildHomepage, isHomepageUrl } = require('../parser/urlParser');
const { formatDateVN } = require('../parser/dateParser');
const { createCsvWriter } = require('../output/artifacts');
const { findMatchingBrands, findMentionedBrands } = require('../utils/articleClassifier');
const { INDUSTRY_LABEL } = require('../config/brands');
const log = require('../output/logger');

const RETRYABLE = new Set(['pending', 'failed', 'date-unverified', 'content-unverified']);
const BLOCKED = new Set(['facebook.com', 'arabsvoice.net', 'tin.skydoor.net', 'twaslnews.com']);
const isBlocked = url => BLOCKED.has(extractHostname(url).replace(/^m\./, ''));
const isListing = url => isHomepageUrl(url) || /\/(?:tags?|authors?|search|tim-kiem)(?:\/|\?|$)|\.pdf(?:\?|$)/i.test(url);

async function runCrawl(options, deps) {
  const { brands, allBrands, dateRange, plan, outputPath, statePath, reportPath,
    screenshots = false, screenshotDir = '', concurrency = 3, refresh = false,
    webMaxPages = 5, searchDelayMin = 3000, searchDelayMax = 6000,
    withinRange, shouldStop = () => false } = options;
  const state = openState(statePath, {
    version: 1, dateRange, brands: brands.map(brand => brand.brand),
    plan: plan.map(task => task.id), screenshots,
    classifier: deps.classifierConfig || {},
  });
  let csv;
  let launched = false;
  const registry = createArticleRegistry();
  const brandByName = new Map(brands.map(brand => [brand.brand, brand]));
  const limit = pLimit(concurrency);
  const processedThisRun = new Set();

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
    const unresolvedArticles = [...state.candidates.values()].filter(card => RETRYABLE.has(card.status))
      .map(({ id, brand, url, title, status, reason, attempts }) => ({ id, brand, url, title, status, reason, attempts }));
    const stats = deps.getSearchStats?.() || {};
    const saturatedDays = [...state.queries.values()].flatMap(query => query.saturatedDays || []);
    const webEnabled = plan.some(task => task.channel === 'web');
    const value = {
      updated_at: new Date().toISOString(), dateRange, outputPath, statePath,
      planned_queries: plan.length, query_statuses: queryStatuses,
      candidate_statuses: candidateStatuses, accepted_articles: accepted, per_year: perYear,
      interrupted: shouldStop(), web_enabled: webEnabled,
      processing_complete: !unresolvedQueries.length && !unresolvedArticles.length,
      coverage_checks_complete: webEnabled && !unresolvedQueries.length && !unresolvedArticles.length && !saturatedDays.length,
      unresolved_queries: unresolvedQueries, unresolved_articles: unresolvedArticles,
      saturated_day_queries: saturatedDays, search_stats: stats,
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
    async function evaluate(info) {
      if (verdict) return verdict;
      if (info.error) return (verdict = { status: 'failed', reason: info.error });
      if (!/^https?:\/\//i.test(info.finalUrl || '') || isBlocked(info.finalUrl) || isListing(info.finalUrl)) {
        return (verdict = { status: 'not-article', reason: 'Not a publisher article destination' });
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
      const textMatches = findMatchingBrands({ title: article.title, content: article.content }, [target]);
      if (!textMatches.length) return (verdict = { status: 'rejected', reason: 'No target mention in article title/body' });
      const classification = await deps.classifyArticle(article, target, allBrands);
      if (classification.decision !== 'accept' || classification.brand !== target.brand) {
        return (verdict = { status: 'rejected', reason: classification.reason });
      }
      // A story naming several insurers is one industry article, not one row per
      // brand. The shared scope makes later brands' searches dedupe against it.
      const found = new Set([target.brand, ...findMentionedBrands(article, allBrands)]);
      const mentioned = allBrands.map(brand => brand.brand).filter(brand => found.has(brand));
      const label = mentioned.length > 1 ? INDUSTRY_LABEL : target.brand;
      const identity = { scope: label, finalUrl: info.finalUrl, title: info.articleTitle,
        canonicalUrl: info.canonicalUrl, ogUrl: info.ogUrl, alternateUrls: info.alternateUrls };
      const claim = registry.claim(identity);
      if (claim.duplicate) return (verdict = { status: 'duplicate', reason: claim.reason, articleId: claim.articleId });
      return (verdict = { status: 'accepted', identity, row: {
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
    if (decision.row) await csv.writeRow(decision.row);
    if (decision.status === 'failed' && /Browser not launched|browser has been closed|browser has disconnected/i.test(decision.reason)) {
      throw new Error(`Browser unavailable; crawl stopped with checkpoint saved: ${decision.reason}`);
    }
  }

  async function drain() {
    const pending = [...state.candidates.values()].filter(card => RETRYABLE.has(card.status) && !processedThisRun.has(card.id));
    // Small batches bound queued work and ensure a stop doesn't launch more tabs.
    for (let index = 0; index < pending.length && !shouldStop(); index += concurrency * 4) {
      const results = await Promise.allSettled(pending.slice(index, index + concurrency * 4)
        .map(card => limit(() => processCandidate(card))));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      report();
    }
  }

  try {
    fs.mkdirSync(require('path').dirname(outputPath), { recursive: true });
    // Accepted journal records are authoritative after an interrupted CSV write.
    const restoredPath = `${outputPath}.${process.pid}.tmp`;
    const restored = createCsvWriter(restoredPath);
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
    const needsWork = [...state.candidates.values()].some(card => RETRYABLE.has(card.status)) ||
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
      if (searchDelayMax > 0) await new Promise(resolve => setTimeout(resolve,
        Math.max(0, searchDelayMin + Math.random() * (searchDelayMax - searchDelayMin))));
      if (shouldStop()) break;
      let response;
      const statsBefore = deps.getSearchStats?.().saturatedDayQueries?.length || 0;
      try {
        response = task.channel === 'rss'
          ? await deps.searchRss(task.query, task.dateRange, { shouldStop })
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
      state.record({ type: 'query', id: task.id, cards, value: {
        status: response.interrupted ? 'failed' : response.truncated ? 'limited' : 'done', results: cards.length,
        pages: response.pages, saturatedDays, attempts: (previous?.attempts || 0) + 1,
        checkedAt: new Date().toISOString(),
        reason: response.interrupted ? 'Search interrupted; resume from checkpoint'
          : response.truncated ? 'Web pagination limit reached; increase --web-pages and resume the same command' : undefined,
        webMaxPages: task.channel === 'web' ? webMaxPages : undefined,
      } });
      await drain();
      report();
    }
    return report();
  } finally {
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
