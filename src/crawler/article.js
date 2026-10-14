'use strict';

/**
 * Article page reader.
 *
 * Trích xuất dùng chung cho trang Playwright và trang HTML tĩnh (httpFetch.js
 * bọc linkedom thành page có evaluate/$eval/$$eval): tiêu đề, thân bài, ngày
 * đăng, liên kết định danh, tác giả, chuyên mục, tag, sapo, dấu hiệu PR.
 * fetchArticle() là nhánh trình duyệt, dùng khi tải HTTP không đủ.
 */

const { newArticlePage, closeArticlePage, verifyInPopup } = require('./browser');
const { isCaptchaPage } = require('./captcha');
const { extractPublishDate } = require('../parser/dateParser');
const { resolveGoogleRedirect } = require('../parser/urlParser');
const { cleanVietnameseText } = require('../parser/vnText');
const { detectPrSignals, extractSourceCredit } = require('../parser/articleSignals');
const log = require('../output/logger');

// Two CSV cells of at most 32,000 characters each hold the stored body.
const MAX_CONTENT_CHARS = 64000;

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

// Images/video/fonts and ad networks only slow page loads (and fill the shared
// browser context); title, body and dates are in the DOM.
const HEAVY_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
  'mp4', 'webm', 'm3u8', 'mp3', 'woff', 'woff2', 'ttf', 'otf', 'eot'];
const AD_DOMAINS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
  'adservice.google.com.vn', 'amazon-adsystem.com', 'mgid.com', 'adtimaserver.vn', 'adtima.vn', 'admicro.vn',
  'eclick.vn', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'pubmatic.com', 'adnxs.com',
  'rubiconproject.com', 'teads.tv', 'yomedia.vn'];
// Chromium Network.setBlockedURLs patterns ("*" is the only wildcard).
const BLOCKED_URL_PATTERNS = [
  ...HEAVY_EXTENSIONS.flatMap(ext => [`*.${ext}`, `*.${ext}?*`]),
  ...AD_DOMAINS.flatMap(domain => [`*://${domain}/*`, `*://*.${domain}/*`]),
];

function shouldBlockRequest(url) {
  const toRegex = pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
  return BLOCKED_URL_PATTERNS.some(pattern => toRegex(pattern).test(url));
}

// Blocked in the browser itself instead of with page.route(): Playwright keeps
// every route still pending when its page closes (and so the whole page, its
// frames and requests) in the context forever, which ran a long crawl out of memory.
async function blockHeavyResources(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URL_PATTERNS });
}

function isGoogleNewsWrapperUrl(url) {
  return /^https?:\/\/news\.google\.com\/(?:rss\/)?articles\//i.test(String(url || ''));
}

async function waitForGoogleNewsWrapperRedirect(page, timeoutMs) {
  if (!isGoogleNewsWrapperUrl(page.url())) {
    return;
  }

  await page.waitForURL(
    (url) => !isGoogleNewsWrapperUrl(url.toString()),
    { timeout: timeoutMs, waitUntil: 'domcontentloaded' }
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

async function extractArticleContent(page) {
  return page.evaluate(max => {
    // Publisher body selectors precede generic itemprop containers: some sites
    // put articleBody on a wrapper containing the entire page and other stories.
    const selectors = ['[data-field="body"]', '.fck_detail', '.singular-content',
      '.article__body', '.article-body', '.article-content', '.detail-content', '.content-detail',
      '.detail__content', '.detail_content', '.detail_body', '#content_body', '.post-content',
      'article.article-detail', '[itemprop="articleBody"]', 'article', 'main'];
    const texts = selectors.map(selector => {
      const root = document.querySelector(selector);
      if (!root) return '';
      const content = root.cloneNode(true);
      content.querySelectorAll('nav, aside, header, footer, script, style, iframe, template, noscript, ' +
        '[hidden], [aria-hidden="true"], [class*="sidebar"], [class*="related"], ' +
        '[class*="recommend"], [class*="suggest"], [class*="banner"], [class*="advertisement"], ' +
        '[class*="lien-quan"], [class*="lienquan"], .tin-lien-quan, .box-tin-lien-quan')
        .forEach(element => element.remove());
      // Nested article elements are story cards, rather than the current body.
      if (root.matches('article')) content.querySelectorAll('article').forEach(element => element.remove());
      return (content.textContent || '').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    const text = texts.find(value => value.length >= 500) || texts.sort((a, b) => b.length - a.length)[0] ||
      document.querySelector('meta[name="description"]')?.content || '';
    return text.slice(0, max + 1);
  }, MAX_CONTENT_CHARS).catch(() => '');
}

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


/**
 * Tác giả, chuyên mục, tag, sapo, ngày sửa và các nhãn ngắn (breadcrumb, khung
 * "tài trợ") để nhận diện bài PR. JSON-LD trước, rồi meta, rồi selector phổ biến.
 */
async function extractArticleMeta(page) {
  return page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const meta = selector => clean(document.querySelector(selector)?.getAttribute('content'));
    const metas = selector => Array.from(document.querySelectorAll(selector))
      .map(element => clean(element.getAttribute('content'))).filter(Boolean);
    const texts = selector => Array.from(document.querySelectorAll(selector))
      .map(element => clean(element.textContent)).filter(text => text && text.length <= 60);
    const firstText = selectors => {
      for (const selector of selectors) {
        const text = clean(document.querySelector(selector)?.textContent);
        if (text) return text;
      }
      return '';
    };
    const items = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || 'null');
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (!item || typeof item !== 'object') continue;
          items.push(item);
          if (Array.isArray(item['@graph'])) items.push(...item['@graph'].filter(node => node && typeof node === 'object'));
        }
      } catch (_) {}
    }
    const stories = items.filter(item => /article|posting|report/i.test([].concat(item['@type'] || []).join(' ')));
    const names = value => [].concat(value || [])
      .map(entry => (typeof entry === 'string' ? entry : entry?.name)).map(clean).filter(Boolean);
    const keywordList = value => [].concat(value ?? []).filter(entry => entry != null)
      .flatMap(entry => String(entry).split(',')).map(clean).filter(Boolean);
    const notUrl = value => (/^https?:\/\//i.test(value) ? '' : value);

    const author = names(stories.flatMap(story => [].concat(story.author || []))).join(', ') ||
      notUrl(meta('meta[name="author"]')) || notUrl(meta('meta[property="article:author"]')) ||
      firstText(['[rel="author"]', '.author-name', '.article__author', '.detail-author', '.author', '.tacgia', 'p.author']);
    const breadcrumb = texts('.breadcrumb a, .breadcrumbs a, [class*="breadcrumb"] a, ' +
      'nav[aria-label*="readcrumb"] a, [itemtype*="BreadcrumbList"] [itemprop="name"]');
    const section = clean(stories.map(story => [].concat(story.articleSection || [])[0]).find(Boolean)) ||
      meta('meta[property="article:section"]') || breadcrumb[breadcrumb.length - 1] || '';
    const tags = [...new Set([
      ...metas('meta[property="article:tag"]'),
      ...keywordList(stories.map(story => story.keywords)),
      ...keywordList(meta('meta[name="news_keywords"]')),
      ...texts('.tags a, .tag-list a, .box-tag a, .article-tags a, .detail-tag a, [class*="tags"] a'),
    ])].slice(0, 30);
    const sapo = firstText(['.sapo', '.article__sapo', '.detail-sapo', '.singular-sapo', '.chapeau',
      '.article-summary', '.description', '.lead']) ||
      meta('meta[property="og:description"]') || meta('meta[name="description"]');
    const modifiedDate = clean(stories.map(story => story.dateModified).find(Boolean)) ||
      meta('meta[property="article:modified_time"]');
    const labels = [...breadcrumb, ...texts('[class*="sponsor"], [class*="advertorial"], [class*="tai-tro"], ' +
      '[class*="taitro"], [class*="brand-content"], [class*="pr-label"], [class*="label-pr"], [class*="tag-pr"]')];
    return { author, section, tags, sapo, modifiedDate, labels: [...new Set(labels)] };
  }).catch(() => ({ author: '', section: '', tags: [], sapo: '', modifiedDate: '', labels: [] }));
}

/**
 * Mọi dữ liệu của một trang bài đã mở (Playwright hoặc HTML tĩnh), đã chuẩn hoá
 * tiếng Việt. `prSignals` nhận thêm mẫu của profile.
 */
async function extractArticle(page, finalUrl, { rssPublishDate = '', prSignals } = {}) {
  const articleTitle = cleanVietnameseText(await extractArticleTitle(page));
  const identity = await extractIdentityLinks(page);
  const rawText = cleanVietnameseText(await extractArticleContent(page));
  const contentTruncated = rawText.length > MAX_CONTENT_CHARS;
  const articleText = rawText.slice(0, MAX_CONTENT_CHARS);
  const publishDate = await extractPublishDate(page, finalUrl, { rssPublishDate });
  const raw = await extractArticleMeta(page);
  const meta = {
    author: cleanVietnameseText(raw.author).slice(0, 200),
    section: cleanVietnameseText(raw.section),
    tags: raw.tags.map(tag => cleanVietnameseText(tag)).filter(Boolean),
    sapo: cleanVietnameseText(raw.sapo).slice(0, 2000),
    modifiedDate: raw.modifiedDate,
    labels: raw.labels.map(label => cleanVietnameseText(label)),
  };
  meta.prSignals = detectPrSignals({ url: finalUrl, labels: meta.labels, section: meta.section,
    tags: meta.tags, author: meta.author, body: articleText }, prSignals);
  meta.sourceCredit = extractSourceCredit(articleText);
  return { finalUrl, articleTitle, articleText, contentTruncated, publishDate, ...identity, meta };
}

// ─── Browser fetch ───────────────────────────────────────────────────────────

/**
 * Mở bài trong tab ẩn (sau redirect Google News), trích xuất toàn bộ dữ liệu.
 * Thử lại 1 lần nếu điều hướng lỗi.
 *
 * @returns {Promise<{finalUrl:string, articleTitle:string, articleText:string, publishDate:string|null,
 *   canonicalUrl:string, ogUrl:string, alternateUrls:string[], meta?:object, error?:string}>}
 */
async function fetchArticle(url, { rssPublishDate = '', prSignals } = {}) {
  const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || '30000', 10);
  const ARTICLE_DELAY_MIN = parseInt(process.env.ARTICLE_DELAY_MIN || '500', 10);
  const ARTICLE_DELAY_MAX = parseInt(process.env.ARTICLE_DELAY_MAX || '1500', 10);
  const failure = (finalUrl, error) => ({ finalUrl, publishDate: null, articleTitle: '', articleText: '', error, ...EMPTY_IDENTITY });

  log.fetch(url);
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let page;
    try {
      page = await newArticlePage();
      page.setDefaultTimeout(PAGE_TIMEOUT);
      await blockHeavyResources(page);
      let navigationResponse;
      page.on('response', response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) navigationResponse = response;
      });

      const targetUrl = resolveGoogleRedirect(url) || url;
      if (targetUrl !== url) log.info(`[URL] Unwrapped article URL: ${url} -> ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      if (await isCaptchaPage(page) && !(await verifyInPopup(page, isCaptchaPage))) {
        // Skip unresolved challenges without reopening the same popup on retry.
        return failure(page.url(), 'CAPTCHA unresolved');
      }
      await waitForGoogleNewsWrapperRedirect(page, PAGE_TIMEOUT);

      let finalUrl = page.url();
      const unwrappedFinalUrl = resolveGoogleRedirect(finalUrl);
      if (unwrappedFinalUrl && unwrappedFinalUrl !== finalUrl) {
        log.info(`[URL] Reopening final redirect target: ${finalUrl} -> ${unwrappedFinalUrl}`);
        await page.goto(unwrappedFinalUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        finalUrl = page.url();
      }
      if (await isCaptchaPage(page)) {
        if (!(await verifyInPopup(page, isCaptchaPage))) return failure(page.url(), 'CAPTCHA unresolved');
        finalUrl = page.url();
      }
      const canonicalFinalUrl = resolveGoogleRedirect(finalUrl) || finalUrl;
      if (!/^https?:\/\//i.test(canonicalFinalUrl) || isGoogleNewsWrapperUrl(canonicalFinalUrl)) {
        throw new Error(`Article destination unresolved: ${canonicalFinalUrl}`);
      }
      if (navigationResponse && navigationResponse.status() >= 400) {
        throw new Error(`Article HTTP ${navigationResponse.status()}: ${canonicalFinalUrl}`);
      }
      const result = await extractArticle(page, canonicalFinalUrl, { rssPublishDate, prSignals });
      await randomDelay(ARTICLE_DELAY_MIN, ARTICLE_DELAY_MAX);
      return result;
    } catch (err) {
      if (attempt < maxAttempts) {
        log.warn(`Retrying article (attempt ${attempt + 1}): ${url} — ${err.message}`);
        await randomDelay(1000, 2000);
      } else {
        log.error(url, err.message);
        return failure(resolveGoogleRedirect(url) || url, err.message);
      }
    } finally {
      if (page) await closeArticlePage(page);
    }
  }
  return failure(resolveGoogleRedirect(url) || url, 'Article fetch did not run');
}

module.exports = {
  MAX_CONTENT_CHARS, fetchArticle, extractArticle, extractArticleContent, extractArticleMeta,
  isGoogleNewsWrapperUrl, shouldBlockRequest, blockHeavyResources,
};
