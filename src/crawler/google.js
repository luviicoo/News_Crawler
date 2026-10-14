'use strict';

/**
 * Google Search → News (Past week) → article card extraction.
 *
 * Chiến lược chống CAPTCHA:
 *   1. Dùng 1 tab Google DUY NHẤT (getGooglePage) tái sử dụng qua mọi query
 *      → cookies/session được giữ → Google không thấy "người lạ" mỗi lần
 *   2. Gõ query vào search box thay vì navigate thẳng URL
 *      → hành vi giống người dùng thật hơn
 *   3. Filter Past week qua URL param tbs=qdr:w (sau khi đã ở trang kết quả)
 *      → chắc chắn hơn click UI
 *   4. Random delay giữa các thao tác
 *
 * Selector Google nằm trong src/config/googleSelectors.json.
 */

const fs = require('fs');
const path = require('path');
const { getGooglePage, saveGoogleSession, verifyInPopup } = require('./browser');
const { isCaptchaPage } = require('./captcha');
const { resolveGoogleRedirect, extractHostname } = require('../parser/urlParser');
const { slugify } = require('../output/artifacts');
const log = require('../output/logger');
const SELECTORS = require('../config/googleSelectors.json');

const SELECTOR_DEBUG_DIR = path.join(__dirname, '..', '..', 'logs', 'selector-debug');

// ─── Timing ───────────────────────────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(min = 800, max = 2000) {
  return new Promise((r) => setTimeout(r, randInt(min, max)));
}

function formatGoogleDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const [year, month, day] = text.split('-');
  return `${month}/${day}/${year}`;
}

function buildNewsDateFilter(dateRange) {
  if (!dateRange || !dateRange.from || !dateRange.to) {
    return 'qdr:w';
  }

  const formattedFrom = formatGoogleDate(dateRange.from);
  const formattedTo = formatGoogleDate(dateRange.to);
  if (!formattedFrom || !formattedTo) {
    return 'qdr:w';
  }

  return `cdr:1,cd_min:${formattedFrom},cd_max:${formattedTo}`;
}

function describeNewsDateFilter(dateRange) {
  if (!dateRange || !dateRange.from || !dateRange.to) {
    return 'Past week';
  }
  return `${dateRange.from} -> ${dateRange.to}`;
}

function addDays(dateKey, offsetDays) {
  const text = String(dateKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = new Date(`${text}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return '';

  parsed.setUTCDate(parsed.getUTCDate() + offsetDays);
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildRssQuery(query, dateRange) {
  const baseQuery = String(query || '').trim();
  if (!baseQuery) return '';
  if (!dateRange || !dateRange.from || !dateRange.to) {
    return baseQuery;
  }

  const exclusiveEnd = addDays(dateRange.to, 1);
  const exclusiveStart = addDays(dateRange.from, -1);
  if (!exclusiveEnd) {
    return baseQuery;
  }

  return `${baseQuery} after:${exclusiveStart || dateRange.from} before:${exclusiveEnd}`;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractXmlTagContent(xml, tagName) {
  const match = String(xml || '').match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  return decodeXmlEntities(match ? match[1] : '');
}

function extractRssSource(xml) {
  const match = String(xml || '').match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
  if (!match) {
    return { name: '', url: '' };
  }

  const attrs = match[1] || '';
  const urlMatch = attrs.match(/\burl="([^"]+)"/i);
  return {
    name: decodeXmlEntities(match[2] || ''),
    url: decodeXmlEntities(urlMatch ? urlMatch[1] : ''),
  };
}

function cleanRssTitle(title, sourceName) {
  const rawTitle = decodeXmlEntities(title);
  const rawSource = decodeXmlEntities(sourceName);
  if (!rawTitle) return '';
  if (!rawSource) return rawTitle;

  const suffix = ` - ${rawSource}`;
  return rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length).trim() : rawTitle;
}

/**
 * Tải RSS, retry khi 429/5xx/lỗi mạng (backoff 5s, 15s). Trả lỗi ngay với
 * 4xx khác và khi Google trả trang HTML chặn thay vì XML, để không nhận nhầm
 * trang chặn thành "0 kết quả".
 */
async function fetchRssWithRetry(rssUrl, shouldStop = () => false) {
  const backoffs = [5000, 15000];
  for (let attempt = 0; ; attempt++) {
    if (shouldStop()) throw new Error('RSS search interrupted; resume from checkpoint');
    let retryable = true;
    try {
      const response = await fetch(rssUrl, {
        signal: AbortSignal.timeout(Number(process.env.RSS_TIMEOUT_MS || 30000)),
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });
      if (!response.ok) {
        retryable = response.status === 429 || response.status >= 500;
        throw new Error(`RSS HTTP ${response.status}`);
      }

      const xml = await response.text();
      if (!/<rss[\s>]/i.test(xml.slice(0, 2000))) {
        retryable = false;
        const blocked = SELECTORS.captchaPatterns.some((pattern) => xml.toLowerCase().includes(pattern.toLowerCase()));
        throw new Error(blocked ? 'RSS blocked by Google challenge page' : 'RSS response is not RSS XML');
      }
      return xml;
    } catch (err) {
      if (shouldStop() || !retryable || attempt >= backoffs.length) throw err;
      log.warn(`${err.message}; retrying RSS in ${backoffs[attempt] / 1000}s`);
      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }
  }
}

async function searchGoogleNewsRss(query, dateRange, { shouldStop = () => false, pause = async () => {} } = {}) {
  if (shouldStop()) throw new Error('RSS search interrupted; resume from checkpoint');
  const rssQuery = buildRssQuery(query, dateRange);
  if (!rssQuery) {
    return [];
  }
  searchStats.rssQueries++;

  const rssUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(rssQuery)}` +
    '&hl=vi&gl=VN&ceid=VN:vi';

  log.info(`Fetching Google News RSS (${describeNewsDateFilter(dateRange)}): ${rssUrl}`);

  const xml = await fetchRssWithRetry(rssUrl, shouldStop);
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  const cards = [];
  const seen = new Set();

  for (const match of itemMatches) {
    const itemXml = match[1] || '';
    const source = extractRssSource(itemXml);
    const url = extractXmlTagContent(itemXml, 'link');
    const title = cleanRssTitle(extractXmlTagContent(itemXml, 'title'), source.name);
    const publisherDomain = extractHostname(source.url) || source.name || extractHostname(url);

    if (!url || !title || seen.has(url)) {
      continue;
    }
    seen.add(url);

    cards.push({
      title,
      url,
      publisherDomain,
      rssPublishDate: extractXmlTagContent(itemXml, 'pubDate'),
    });
  }

  // A saturated feed can hide older results. Bisect long date windows and
  // retain the parent results as well, since rankings can differ by window.
  const span = dateRange && (Date.parse(dateRange.to) - Date.parse(dateRange.from)) / 86400000;
  if (cards.length >= 100 && span > 0) {
    const midpoint = addDays(dateRange.from, Math.floor(span / 2));
    log.warn(`[RSS_LIMIT] ${query}: ${cards.length} results; splitting ${dateRange.from} -> ${dateRange.to}`);
    // Split requests are paced like planned queries to avoid bursts that trigger 429s.
    await pause();
    const left = await searchGoogleNewsRss(query, { from: dateRange.from, to: midpoint }, { shouldStop, pause });
    await pause();
    const right = await searchGoogleNewsRss(query, { from: addDays(midpoint, 1), to: dateRange.to }, { shouldStop, pause });
    const merged = new Map([...cards, ...left, ...right].map(card => [card.url, card]));
    return [...merged.values()];
  }
  if (cards.length >= 100) {
    searchStats.saturatedDayQueries.push({ query, dateRange, results: cards.length });
    log.warn(`[RSS_LIMIT] ${query}: a single day still returned ${cards.length} results.`);
  }
  return cards;
}

// ─── Run stats (đọc ở cuối run để cảnh báo) ───────────────────────────────────

const searchStats = {
  saturatedDayQueries: [],
  rssQueries: 0,
  browserQueries: 0,
  browserZeroQueries: [],     // query fallback trình duyệt trả 0 bài
  selectorSuspectQueries: [], // trang có kết quả nhưng selector không bắt được bài
  captchaSolved: 0,
  captchaBlockedQueries: [],  // query bị bỏ vì CAPTCHA không được giải
  browserSkippedQueries: [],  // query bỏ qua vì fallback đã bị tắt sau nhiều CAPTCHA
};
let browserSearchDisabled = false;

function getSearchStats() {
  return {
    ...searchStats,
    browserSearchDisabled,
  };
}

function resetSearchStats() {
  searchStats.saturatedDayQueries = [];
  searchStats.rssQueries = 0;
  searchStats.browserQueries = 0;
  searchStats.browserZeroQueries = [];
  searchStats.selectorSuspectQueries = [];
  searchStats.captchaSolved = 0;
  searchStats.captchaBlockedQueries = [];
  searchStats.browserSkippedQueries = [];
  browserSearchDisabled = false;
}

// ─── Consent dialog ───────────────────────────────────────────────────────────

async function acceptConsent(page) {
  for (const sel of SELECTORS.consentButtons) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        log.info('Consent dialog accepted.');
        return;
      }
    } catch (_) {}
  }
}

// ─── CAPTCHA detection ────────────────────────────────────────────────────────

/**
 * Trả về true nếu trang đang sạch (không CAPTCHA, hoặc CAPTCHA đã được giải).
 *
 * Mở cửa sổ riêng khi cần xác thực, sau đó tiếp tục chạy ẩn.
 * Sau CAPTCHA_MAX_PER_RUN lần không giải được, tắt fallback trình duyệt cho
 * phần còn lại của run (RSS vẫn chạy) để không gửi thêm request bị chặn.
 */
async function ensureNoCaptcha(page, query) {
  if (!(await isCaptchaPage(page))) return true;

  const MAX_PER_RUN = parseInt(process.env.CAPTCHA_MAX_PER_RUN || '2', 10);

  if (await verifyInPopup(page, isCaptchaPage)) {
    searchStats.captchaSolved++;
    return true;
  }

  searchStats.captchaBlockedQueries.push(query);
  log.warn(`[CAPTCHA] Not solved; skipping query "${query}".`);

  if (searchStats.captchaBlockedQueries.length >= MAX_PER_RUN && !browserSearchDisabled) {
    browserSearchDisabled = true;
    log.warn(
      `[CAPTCHA] ${searchStats.captchaBlockedQueries.length} unsolved CAPTCHA(s); ` +
      'disabling Google Search browser fallback for the rest of this run (RSS still used).'
    );
  }
  return false;
}

// ─── Card extraction ──────────────────────────────────────────────────────────

async function extractArticleCards(page) {
  await sleep(800, 1500);

  let results = [];

  // Strategy 1: đọc DOM trong page context, selector lấy từ config/googleSelectors.json
  try {
    const raw = await page.evaluate((selectors) => {
      function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      }

      function findCardContainer(el, maxLevels = 8) {
        let node = el;
        for (let i = 0; i < maxLevels; i++) {
          if (!node.parentElement) break;
          node = node.parentElement;
          if (
            selectors.cardContainerAttributes.some((attr) => node.hasAttribute(attr)) ||
            node.getAttribute('role') === 'article' ||
            node.tagName === 'ARTICLE'
          ) return node;
        }
        // fallback: 5 cấp cha
        node = el;
        for (let i = 0; i < 5; i++) {
          if (!node.parentElement) break;
          node = node.parentElement;
        }
        return node;
      }

      function findPublisher(container) {
        for (const sel of selectors.publisher) {
          try {
            const el = container.querySelector(sel);
            if (el) {
              const text = el.textContent?.trim().split('·')[0].trim();
              if (text && text.length > 0 && text.length < 80) return text;
            }
          } catch (_) {}
        }
        return '';
      }

      function findHeadline(container, anchor) {
        for (const sel of selectors.headline) {
          try {
            const el = container.querySelector(sel);
            const text = cleanText(el?.textContent);
            if (text.length >= 12) return text;
          } catch (_) {}
        }

        const ariaLabel = cleanText(anchor.getAttribute('aria-label'));
        if (ariaLabel.length >= 12) return ariaLabel;

        return cleanText(anchor.textContent);
      }

      const seen = new Set();
      const items = [];
      const root = selectors.resultsRoot
        .map((sel) => document.querySelector(sel))
        .find(Boolean) || document.body;

      for (const a of root.querySelectorAll('a[href]')) {
        const href = a.href || '';
        if (
          !href ||
          href.startsWith('#') ||
          href.startsWith('javascript:') ||
          /google\.(com|com\.vn|vn)\/(?!url\?q=)/.test(href) ||
          seen.has(href)
        ) continue;

        const container = findCardContainer(a);
        const title = findHeadline(container, a);
        if (!title || title.length < 15) continue;

        seen.add(href);
        items.push({ title, href, publisher: findPublisher(container) });
      }
      return items;
    }, SELECTORS);

    for (const { title, href, publisher } of raw) {
      const url = resolveGoogleRedirect(href);
      if (!url || url.startsWith('https://www.google.com')) continue;
      const publisherDomain = publisher
        ? publisher.split('·')[0].trim()
        : extractHostname(url);
      results.push({ title, url, publisherDomain });
    }
  } catch (err) {
    log.warn(`Card extraction strategy 1 failed: ${err.message}`);
  }

  // Strategy 2: fallback, không phụ thuộc selector card
  if (results.length === 0) {
    log.warn('Strategy 1 got 0 results, trying fallback...');
    try {
      const links = await page.evaluate((rootSelectors) => {
        const root = rootSelectors.map((sel) => document.querySelector(sel)).find(Boolean) || document.body;
        return Array.from(root.querySelectorAll('a[href]:not([href^="#"]):not([href^="javascript"])'))
          .filter((a) => a.href && !/google\.(com|vn)\/(?!url\?q=)/.test(a.href))
          .map((a) => ({ title: (a.textContent || '').trim(), href: a.href }));
      }, SELECTORS.resultsRoot);
      const seen = new Set();
      for (const { title, href } of links) {
        if (!title || title.length < 20) continue;
        const url = resolveGoogleRedirect(href);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push({ title, url, publisherDomain: extractHostname(url) });
      }
    } catch (err) {
      log.warn(`Card extraction strategy 2 failed: ${err.message}`);
    }
  }

  return results;
}

// ─── Selector health ──────────────────────────────────────────────────────────

/**
 * Gọi khi trang kết quả cho 0 bài. Phân biệt "Google thật sự không có kết quả"
 * với "trang có kết quả nhưng selector không bắt được" (selector hỏng).
 * Trường hợp sau: log [SELECTOR] và lưu HTML để sửa config/googleSelectors.json.
 */
async function diagnoseZeroResults(page, query) {
  const info = await page.evaluate((selectors) => {
    const text = (document.body?.innerText || '').toLowerCase();
    const root = selectors.resultsRoot.map((sel) => document.querySelector(sel)).find(Boolean);
    const externalLinks = Array.from((root || document.body).querySelectorAll('a[href^="http"]'))
      .filter((a) => !/google\./.test(new URL(a.href).hostname)).length;
    return {
      hasRoot: Boolean(root),
      externalLinks,
      noResults: selectors.noResultsPatterns.some((pattern) => text.includes(pattern.toLowerCase())),
    };
  }, SELECTORS).catch(() => null);

  if (!info || info.noResults) return;
  if (info.hasRoot && info.externalLinks < 3) return;

  searchStats.selectorSuspectQueries.push(query);
  const reason = info.hasRoot
    ? `${info.externalLinks} external links on page but 0 cards extracted`
    : `none of resultsRoot selectors matched (${SELECTORS.resultsRoot.join(', ')})`;

  let snapshot = '';
  try {
    fs.mkdirSync(SELECTOR_DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    snapshot = path.join(SELECTOR_DEBUG_DIR, `${stamp}_${slugify(query)}.html`);
    fs.writeFileSync(snapshot, await page.content(), 'utf8');
  } catch (err) {
    log.warn(`[SELECTOR] Could not save debug HTML: ${err.message}`);
  }

  log.warn(
    `[SELECTOR] Google selectors may be outdated for "${query}": ${reason}. ` +
    `Update src/config/googleSelectors.json${snapshot ? `; page saved to ${snapshot}` : ''}.`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Chạy một Google News query và trả về danh sách article cards.
 *
 * Ưu tiên Google News RSS (không CAPTCHA, không selector). Chỉ khi RSS lỗi hoặc
 * trả 0 bài mới dùng Google Search trên trình duyệt (tab tái sử dụng).
 */
async function searchGoogleNews(brand, query, options = {}) {
  const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT || '30000', 10);
  const dateRange = options.dateRange || null;
  const newsDateFilter = buildNewsDateFilter(dateRange);
  const newsDateFilterLabel = describeNewsDateFilter(dateRange);

  log.start(brand, query);

  try {
    const rssCards = await searchGoogleNewsRss(query, dateRange);
    if (rssCards.length > 0) {
      log.found(rssCards.length, query);
      log.info(`Using RSS results for "${query}"`);
      return rssCards;
    }
    log.warn(`RSS returned 0 results for "${query}", falling back to browser search.`);
  } catch (err) {
    log.warn(`RSS search failed for "${query}": ${err.message}`);
  }

  if (browserSearchDisabled) {
    searchStats.browserSkippedQueries.push(query);
    log.warn(`Browser fallback disabled after repeated CAPTCHA; skipping "${query}".`);
    return [];
  }

  searchStats.browserQueries++;

  // Lấy tab Google dùng chung (tạo mới nếu lần đầu, tái dùng nếu đã có)
  const page = await getGooglePage();
  page.setDefaultTimeout(PAGE_TIMEOUT);

  try {
    // ── Bước 1: Đảm bảo đang ở google.com, accept consent nếu cần ──────────
    const currentUrl = page.url();
    if (!currentUrl.includes('google.com')) {
      await page.goto('https://www.google.com', {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT,
      });
      await acceptConsent(page);
      await sleep(800, 1500);
    }
    if (!(await ensureNoCaptcha(page, query))) return [];

    // ── Bước 2: Xoá search box và gõ query (giống người dùng thật) ──────────
    const searchBox = page.locator(SELECTORS.searchBox).first();

    // Nếu đang ở trang kết quả trước → click vào search box để focus
    try {
      await searchBox.click({ timeout: 3000 });
    } catch (_) {
      // Nếu không có search box (trang chủ ẩn) → navigate về trang chủ
      await page.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await acceptConsent(page);
      await sleep(500, 1000);
    }

    await searchBox.fill(''); // xoá query cũ
    await sleep(200, 500);

    // Gõ từng ký tự với delay ngẫu nhiên → trông như người thật gõ
    await searchBox.pressSequentially(query, { delay: randInt(50, 120) });
    await sleep(400, 800);
    await searchBox.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT });
    await sleep(1000, 2000);

    if (!(await ensureNoCaptcha(page, query))) return [];

    // ── Bước 3: Chuyển sang tab News + filter Past week qua URL param ────────
    // Lấy URL hiện tại sau khi search → inject tbm=nws (News) + tbs=qdr:w (Past week)
    let searchResultUrl;
    try {
      searchResultUrl = new URL(page.url());
    } catch (_) {
      // Nếu URL không hợp lệ vì lý do nào đó, build lại từ query
      searchResultUrl = new URL('https://www.google.com/search');
      searchResultUrl.searchParams.set('q', query);
    }
    searchResultUrl.searchParams.set('tbm', 'nws');
    searchResultUrl.searchParams.set('tbs', newsDateFilter);

    const newsUrl = searchResultUrl.toString();
    log.info(`Navigating to News (${newsDateFilterLabel}): ${newsUrl}`);

    await page.goto(newsUrl, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT,
    });
    await sleep(1000, 2000);

    if (!(await ensureNoCaptcha(page, query))) return [];

    // Xác nhận đã vào đúng News tab + Past week filter
    const finalUrl = page.url();
    const decodedFinalUrl = decodeURIComponent(finalUrl);
    const hasNewsTab   = finalUrl.includes('tbm=nws');
    const hasExpectedDateFilter = decodedFinalUrl.includes(`tbs=${newsDateFilter}`);
    if (!hasNewsTab || !hasExpectedDateFilter) {
      log.warn(`Filter not applied correctly (url=${finalUrl}). Retrying…`);
      // Thử lần 2 bằng cách navigate trực tiếp
      const retryUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=nws&tbs=${encodeURIComponent(newsDateFilter)}&hl=vi&gl=vn`;
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
      await sleep(1000, 2000);
      if (!(await ensureNoCaptcha(page, query))) return [];
    } else {
      log.info(`Filter confirmed: News tab + ${newsDateFilterLabel} ✓`);
    }

    // ── Bước 4: Extract cards ─────────────────────────────────────────────────
    const cards = await extractArticleCards(page);

    log.found(cards.length, query);
    if (cards.length === 0) {
      searchStats.browserZeroQueries.push(query);
      log.warn(`Query "${query}" returned 0 results.`);
      await diagnoseZeroResults(page, query);
    }

    // Lưu cookies sau mỗi search thành công → giảm CAPTCHA lần sau
    await saveGoogleSession();

    return cards;

  } catch (err) {
    log.warn(`searchGoogleNews failed for "${query}": ${err.message}`);
    return [];
    // Không đóng page — tab dùng chung, chỉ đóng khi closeBrowser()
  }
}

// Newer Google result pages link to /goto?url=<opaque token> instead of the
// article; the destination is only available from the redirect's Location.
function isGoogleGotoUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/goto';
  } catch (_) {
    return false;
  }
}

async function followGoogleGoto(page, gotoUrl) {
  try {
    const response = await page.request.get(gotoUrl, { maxRedirects: 0, timeout: 15000 });
    const location = response.headers().location || '';
    return location ? resolveGoogleRedirect(new URL(location, gotoUrl).href) : '';
  } catch (err) {
    log.warn(`[WEB] Could not resolve Google result link: ${err.message}`);
    return '';
  }
}

async function extractWebCards(page) {
  const raw = await page.evaluate(selectors => {
    const root = selectors.resultsRoot.map(selector => document.querySelector(selector)).find(Boolean);
    if (!root) return [];
    return Array.from(root.querySelectorAll(selectors.webHeadlines)).map(heading => {
      const anchor = heading.closest('a[href]') || heading.parentElement?.querySelector('a[href]');
      return { title: heading.textContent?.replace(/\s+/g, ' ').trim() || '', url: anchor?.href || '' };
    });
  }, SELECTORS);
  const cards = new Map();
  for (const card of raw) {
    let url = resolveGoogleRedirect(card.url);
    if (isGoogleGotoUrl(url)) url = await followGoogleGoto(page, url);
    const domain = extractHostname(url);
    if (!/^https?:\/\//i.test(url) || !card.title || /(^|\.)google\.[a-z.]+$/.test(domain)) continue;
    cards.set(url, { ...card, url, publisherDomain: domain });
  }
  return [...cards.values()];
}

// Ordinary web search complements News RSS. Source/year plans run regardless
// of how many RSS results were returned; Google News is not the whole web index.
async function searchGoogleWeb(brand, query, { dateRange, maxPages = 5, shouldStop = () => false } = {}) {
  if (browserSearchDisabled) throw new Error('Google web search disabled after unsolved CAPTCHA; resume later.');
  const page = await getGooglePage();
  const timeout = Number(process.env.PAGE_TIMEOUT || 30000);
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', buildRssQuery(query, dateRange));
  url.searchParams.set('hl', 'vi');
  url.searchParams.set('gl', 'vn');
  const cards = new Map();
  let next = url.toString();
  let pages = 0;
  while (next && pages < maxPages) {
    if (shouldStop()) return { cards: [...cards.values()], interrupted: true, pages };
    searchStats.browserQueries++;
    await page.goto(next, { waitUntil: 'domcontentloaded', timeout });
    await acceptConsent(page);
    if (!(await ensureNoCaptcha(page, query))) throw new Error('Google web CAPTCHA unresolved');
    await sleep(800, 1500);
    const found = await extractWebCards(page);
    if (!found.length) {
      const noResults = await page.evaluate(patterns => patterns.some(pattern =>
        (document.body?.innerText || '').toLowerCase().includes(pattern.toLowerCase())), SELECTORS.noResultsPatterns);
      if (!noResults) {
        await diagnoseZeroResults(page, query);
        throw new Error('Google web returned no article headings without an explicit no-results message');
      }
    }
    for (const card of found) cards.set(card.url, card);
    pages++;
    next = await page.evaluate(selector => document.querySelector(selector)?.href || '', SELECTORS.webNextPage);
    if (next && new URL(next).hostname !== new URL(url).hostname) throw new Error('Unexpected web pagination destination');
    if (next && pages < maxPages) await sleep(1500, 3000);
  }
  await saveGoogleSession();
  log.info(`[WEB] ${brand}: ${query}, ${pages} page(s), ${cards.size} candidates${next ? ' (page limit reached)' : ''}`);
  return { cards: [...cards.values()], truncated: Boolean(next), pages };
}

module.exports = { searchGoogleNews, searchGoogleNewsRss, searchGoogleWeb, extractWebCards,
  buildRssQuery, getSearchStats, resetSearchStats };
