'use strict';

/**
 * Tải bài nhanh: link Google News → giải mã HTTP; bài → HTTP + linkedom.
 * Chỉ mở Chromium (fetchArticle trong article.js) khi HTTP không đủ: lỗi mạng
 * hoặc HTTP ≥ 400, trang CAPTCHA/anti-bot, thiếu tiêu đề, thân bài quá ngắn,
 * thiếu ngày đăng, hoặc link Google News không giải mã được.
 */

const pLimit = require('p-limit');
const { extractArticle, fetchArticle: fetchWithBrowser, isGoogleNewsWrapperUrl } = require('./article');
const { createStaticPage, fetchHtml } = require('./httpFetch');
const { createGoogleNewsDecoder } = require('./googleNewsDecode');
const { isCaptchaPage } = require('./captcha');
const { resolveGoogleRedirect, extractHostname } = require('../parser/urlParser');
const log = require('../output/logger');

const MIN_BODY_CHARS = 200;

function createArticleFetcher({
  httpPerDomain = 2,
  browserConcurrency = 3,
  decodeConcurrency = 2,
  timeoutMs = Number(process.env.PAGE_TIMEOUT || 30000),
  prSignals,
  ensureBrowser = async () => {},
  browserFetch = fetchWithBrowser,
  fetchImpl = fetch,
  decodeIntervalMs = 0,
  decodeCooldownMs,
  decodeStateFile = '',
  decoder = createGoogleNewsDecoder({ concurrency: decodeConcurrency, fetchImpl, minIntervalMs: decodeIntervalMs,
    cooldownMs: decodeCooldownMs, stateFile: decodeStateFile }),
} = {}) {
  const perDomain = new Map();
  const domainLimit = url => {
    const host = extractHostname(url) || 'unknown';
    if (!perDomain.has(host)) perDomain.set(host, pLimit(Math.max(1, httpPerDomain)));
    return perDomain.get(host);
  };
  // Browser tabs are far heavier than HTTP requests (ARTICLE_CONCURRENCY).
  const browserLimit = pLimit(Math.max(1, browserConcurrency));
  const stats = { http: 0, browser: 0, decoded: 0, decodeFallback: 0, deferred: 0 };

  async function fetchArticle(url, { rssPublishDate = '', ensureBrowser: ensure = ensureBrowser } = {}) {
    const viaBrowser = (target, date, why) => browserLimit(async () => {
      log.info(`[FETCH] Browser fallback (${why}): ${target}`);
      await ensure();
      stats.browser++;
      const result = await browserFetch(target, { rssPublishDate: date, prSignals });
      return { ...result, fetchMethod: 'browser' };
    });

    let target = resolveGoogleRedirect(url) || url;
    if (isGoogleNewsWrapperUrl(target)) {
      const decoded = await decoder.decode(target);
      // The browser page calls the same Google endpoint, so it fails too while Google throttles.
      if (!decoded && decoder.isThrottled?.()) {
        stats.deferred++;
        return { finalUrl: url, articleTitle: '', articleText: '', publishDate: null, deferred: true,
          error: 'Google News link decoding throttled (HTTP 429); read after the cooldown',
          canonicalUrl: '', ogUrl: '', alternateUrls: [] };
      }
      if (!decoded) {
        stats.decodeFallback++;
        return viaBrowser(url, rssPublishDate, 'Google News link');
      }
      stats.decoded++;
      target = resolveGoogleRedirect(decoded) || decoded;
    }
    const response = await domainLimit(target)(() => fetchHtml(target, { timeoutMs, fetchImpl }));
    // PDFs, images and other files are not articles; the browser cannot read them either.
    if (response.notHtml) {
      return { finalUrl: response.finalUrl, articleTitle: '', articleText: '', publishDate: null,
        notArticle: true, error: response.error, canonicalUrl: '', ogUrl: '', alternateUrls: [], fetchMethod: 'http' };
    }
    if (!response.ok) return viaBrowser(target, rssPublishDate, response.error);
    const page = createStaticPage(response.html, response.finalUrl);
    if (await isCaptchaPage(page)) return viaBrowser(target, rssPublishDate, 'anti-bot page');
    const result = await extractArticle(page, response.finalUrl, { rssPublishDate, prSignals });
    if (!result.articleTitle) return viaBrowser(target, rssPublishDate, 'no title in HTML');
    if (result.articleText.length < MIN_BODY_CHARS) return viaBrowser(target, rssPublishDate, 'body needs JavaScript');
    if (!result.publishDate) return viaBrowser(target, rssPublishDate, 'no publish date in HTML');
    stats.http++;
    return { ...result, fetchMethod: 'http' };
  }

  return { fetchArticle, stats, isDecodeThrottled: () => Boolean(decoder.isThrottled?.()) };
}

module.exports = { createArticleFetcher, MIN_BODY_CHARS };
