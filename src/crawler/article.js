'use strict';

/**
 * Article page scraper.
 *
 * Mở từng URL bài báo trong tab mới, lấy final URL sau redirect,
 * trích xuất publish_date, và chụp màn hình 800×800 px.
 *
 * Concurrency được kiểm soát ở index.js qua p-limit.
 */

const { newArticlePage, closeArticlePage } = require('./browser');
const { extractPublishDate } = require('../parser/dateParser');
const { resolveGoogleRedirect } = require('../parser/urlParser');
const { captureArticleScreenshot } = require('../output/artifacts');
const log = require('../output/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDelay(min, max) {
  return new Promise((r) => setTimeout(r, randInt(min, max)));
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanTitleCandidate(value) {
  return normalizeWhitespace(value)
    .replace(/^[|:;\-–—]+\s*/, '')
    .replace(/\s*[|:;\-–—]+\s*$/, '');
}

function isUsableArticleTitle(value) {
  const title = cleanTitleCandidate(value);
  if (!title || title.length < 12) return false;
  if (/^https?:\/\//i.test(title)) return false;
  if (/^(404|not found|page not found|access denied)$/i.test(title)) return false;
  return true;
}

function isGoogleNewsWrapperUrl(url) {
  return /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\//i.test(String(url || ''));
}

async function waitForGoogleNewsWrapperRedirect(page, timeoutMs) {
  if (!isGoogleNewsWrapperUrl(page.url())) {
    return;
  }

  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
  await page.waitForURL(
    (url) => !isGoogleNewsWrapperUrl(url.toString()),
    { timeout: timeoutMs }
  ).catch(() => {});

  if (!isGoogleNewsWrapperUrl(page.url())) {
    return;
  }

  const fallbackUrl = await page.evaluate(() => {
    const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    if (/^https?:\/\//i.test(canonicalHref) && !canonicalHref.includes('news.google.com/')) {
      return canonicalHref;
    }

    const anchor = Array.from(document.querySelectorAll('a[href]')).find((element) => {
      const href = element.getAttribute('href') || '';
      return /^https?:\/\//i.test(href) && !href.includes('news.google.com/');
    });
    return anchor ? anchor.href : '';
  }).catch(() => '');

  if (fallbackUrl) {
    await page.goto(fallbackUrl, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
  }
}

async function extractArticleTitle(page) {
  const rawCandidates = await page.evaluate(() => {
    const values = [];

    const push = (value) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (text) values.push(text);
    };

    const metaSelectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="parsely-title"]',
      'meta[name="title"]',
      'meta[property="title"]',
    ];

    for (const selector of metaSelectors) {
      const el = document.querySelector(selector);
      if (el) push(el.getAttribute('content'));
    }

    const h1 = document.querySelector('article h1, main h1, h1');
    if (h1) push(h1.textContent);

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || 'null');
        const queue = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of queue) {
          if (!item || typeof item !== 'object') continue;
          push(item.headline);
          push(item.name);

          if (Array.isArray(item['@graph'])) {
            for (const graphItem of item['@graph']) {
              if (!graphItem || typeof graphItem !== 'object') continue;
              push(graphItem.headline);
              push(graphItem.name);
            }
          }
        }
      } catch (_) {}
    }

    push(document.title);
    return values;
  }).catch(() => []);

  const candidates = [...new Set(rawCandidates.map(cleanTitleCandidate).filter(Boolean))];
  return candidates.find(isUsableArticleTitle) || '';
}

const EMPTY_IDENTITY = { canonicalUrl: '', ogUrl: '', alternateUrls: [] };

/**
 * Link định danh của trang: canonical, og:url, hreflang (bản ngôn ngữ khác).
 * Dùng để chống trùng bài ở index.js (src/parser/articleIdentity.js).
 */
async function extractIdentityLinks(page) {
  return page.evaluate(() => {
    const absolute = (value) => {
      try {
        const url = new URL(String(value || '').trim(), document.baseURI);
        return /^https?:$/.test(url.protocol) ? url.toString() : '';
      } catch (_) {
        return '';
      }
    };

    return {
      canonicalUrl: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href')),
      ogUrl: absolute(document.querySelector('meta[property="og:url"]')?.getAttribute('content')),
      alternateUrls: Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))
        .map((link) => absolute(link.getAttribute('href')))
        .filter(Boolean),
    };
  }).catch(() => ({ ...EMPTY_IDENTITY }));
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch một article page, trích xuất publish_date, và chụp màn hình.
 * Retry 1 lần nếu navigation thất bại.
 *
 * @param {string} url   URL bài báo
 * @param {object} opts
 * @param {string}      opts.brand           Tên brand (để đặt tên ảnh)
 * @param {string}      opts.publisherDomain Domain trang báo (để đặt tên ảnh)
 * @param {string}      opts.screenshotDir   Thư mục lưu ảnh PNG
 * @param {Function}    opts.shouldCapture   Chỉ chụp sau khi URL/ngày đã được kiểm tra
 *
 * @returns {Promise<{finalUrl:string, publishDate:string|null, screenshotPath:string|null, articleTitle:string,
 *   canonicalUrl:string, ogUrl:string, alternateUrls:string[]}>}
 */
async function fetchArticle(url, {
  brand = '',
  publisherDomain = '',
  screenshotDir = '',
  shouldCapture = () => true,
} = {}) {
  const PAGE_TIMEOUT     = parseInt(process.env.PAGE_TIMEOUT      || '30000', 10);
  const ARTICLE_DELAY_MIN = parseInt(process.env.ARTICLE_DELAY_MIN || '500',   10);
  const ARTICLE_DELAY_MAX = parseInt(process.env.ARTICLE_DELAY_MAX || '1500',  10);

  log.fetch(url);

  let attempt = 0;
  const maxAttempts = 2;

  while (attempt < maxAttempts) {
    let page;
    try {
      page = await newArticlePage();
      page.setDefaultTimeout(PAGE_TIMEOUT);

      const targetUrl = resolveGoogleRedirect(url) || url;
      if (targetUrl !== url) {
        log.info(`[URL] Unwrapped article URL: ${url} -> ${targetUrl}`);
      }

      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT,
      });
      await waitForGoogleNewsWrapperRedirect(page, PAGE_TIMEOUT);

      // URL thật sau redirect
      let finalUrl = page.url();
      const unwrappedFinalUrl = resolveGoogleRedirect(finalUrl);
      if (unwrappedFinalUrl && unwrappedFinalUrl !== finalUrl) {
        log.info(`[URL] Reopening final redirect target: ${finalUrl} -> ${unwrappedFinalUrl}`);
        await page.goto(unwrappedFinalUrl, {
          waitUntil: 'domcontentloaded',
          timeout: PAGE_TIMEOUT,
        });
        finalUrl = page.url();
      }

      const canonicalFinalUrl = resolveGoogleRedirect(finalUrl) || finalUrl;
      const articleTitle = await extractArticleTitle(page);
      const identity = await extractIdentityLinks(page);

      // Trích xuất ngày đăng (7 fallback strategies)
      const publishDate = await extractPublishDate(page, canonicalFinalUrl);

      // Chụp màn hình 800×800 (thấy tiêu đề, tỷ lệ 1:1)
      let screenshotPath = null;
      const captureAllowed = screenshotDir && await shouldCapture({
        finalUrl: canonicalFinalUrl,
        publishDate,
        articleTitle,
        ...identity,
      });
      if (captureAllowed) {
        screenshotPath = await captureArticleScreenshot(page, {
          brand,
          publisherDomain,
          publishDate,
          articleUrl: canonicalFinalUrl,
          screenshotDir,
        });
      }

      await randomDelay(ARTICLE_DELAY_MIN, ARTICLE_DELAY_MAX);

      return {
        finalUrl: canonicalFinalUrl,
        publishDate,
        screenshotPath,
        articleTitle,
        ...identity,
      };

    } catch (err) {
      attempt++;
      if (attempt < maxAttempts) {
        log.warn(`Retrying article (attempt ${attempt + 1}): ${url} — ${err.message}`);
        await randomDelay(1000, 2000);
      } else {
        log.error(url, err.message);
        return {
          finalUrl: resolveGoogleRedirect(url) || url,
          publishDate: null,
          screenshotPath: null,
          articleTitle: '',
          ...EMPTY_IDENTITY,
        };
      }
    } finally {
      if (page) await closeArticlePage(page);
    }
  }

  return {
    finalUrl: resolveGoogleRedirect(url) || url,
    publishDate: null,
    screenshotPath: null,
    articleTitle: '',
    ...EMPTY_IDENTITY,
  };
}

module.exports = { fetchArticle };
