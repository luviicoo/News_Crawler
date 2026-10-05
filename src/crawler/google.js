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
 */

const { getGooglePage, saveGoogleSession, isHeadlessMode } = require('./browser');
const { resolveGoogleRedirect, extractHostname } = require('../parser/urlParser');
const log = require('../output/logger');

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
  if (!exclusiveEnd) {
    return baseQuery;
  }

  return `${baseQuery} after:${dateRange.from} before:${exclusiveEnd}`;
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

async function searchGoogleNewsRss(query, dateRange) {
  const rssQuery = buildRssQuery(query, dateRange);
  if (!rssQuery) {
    return [];
  }

  const rssUrl =
    `https://news.google.com/rss/search?q=${encodeURIComponent(rssQuery)}` +
    '&hl=vi&gl=VN&ceid=VN:vi';

  log.info(`Fetching Google News RSS (${describeNewsDateFilter(dateRange)}): ${rssUrl}`);

  const response = await fetch(rssUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  if (!response.ok) {
    throw new Error(`RSS HTTP ${response.status}`);
  }

  const xml = await response.text();
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
    });
  }

  return cards;
}

// ─── Consent dialog ───────────────────────────────────────────────────────────

async function acceptConsent(page) {
  const selectors = [
    '#L2AGLb',
    'button:has-text("Accept all")',
    'button:has-text("Chấp nhận tất cả")',
    'button:has-text("Agree")',
    'button:has-text("Đồng ý")',
    '[aria-label="Accept all"]',
    'form[action*="consent"] button',
  ];
  for (const sel of selectors) {
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

async function checkForCaptcha(page) {
  const PAUSE = parseInt(process.env.CAPTCHA_PAUSE_MS || '30000', 10);
  const text = await page
    .evaluate(() => (document.title + ' ' + (document.body?.innerText || '')).toLowerCase())
    .catch(() => '');

  if (/unusual traffic|captcha|i'm not a robot|xác minh bạn không phải robot/.test(text)) {
    if (isHeadlessMode()) {
      log.warn('[CAPTCHA] Detected in headless mode; aborting query without wait.');
      return true;
    }

    log.captcha(PAUSE);
    // Trong headful mode: dừng để user giải CAPTCHA tay
    await new Promise((r) => setTimeout(r, PAUSE));
    return true;
  }
  return false;
}

// ─── Card extraction ──────────────────────────────────────────────────────────

async function extractArticleCards(page) {
  await sleep(800, 1500);

  let results = [];

  // Strategy 1: đọc DOM trong page context
  try {
    const raw = await page.evaluate(() => {
      function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      }

      function findCardContainer(el, maxLevels = 8) {
        let node = el;
        for (let i = 0; i < maxLevels; i++) {
          if (!node.parentElement) break;
          node = node.parentElement;
          if (
            node.hasAttribute('data-hveid') ||
            node.hasAttribute('data-ved') ||
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
        const selectors = [
          'cite',
          '[data-ved] span',
          'span[class*="source"]',
          'span[class*="Source"]',
          '.NUnG9d', '.vr1PYe', '.VkSnBd', '.TbwUpd',
          '[data-n-tid]',
          'span[jsname]',
        ];
        for (const sel of selectors) {
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
        const selectors = [
          'div[role="heading"]',
          'h3',
          'h4',
          '[aria-level="3"]',
          '[aria-level="2"]',
        ];

        for (const sel of selectors) {
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
      const root = document.querySelector('#search') || document.body;

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
    });

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

  // Strategy 2: fallback
  if (results.length === 0) {
    log.warn('Strategy 1 got 0 results, trying fallback...');
    try {
      const links = await page.$$eval(
        '#search a[href]:not([href^="#"]):not([href^="javascript"])',
        (as) => as
          .filter((a) => a.href && !/google\.(com|vn)\/(?!url\?q=)/.test(a.href))
          .map((a) => ({ title: (a.textContent || '').trim(), href: a.href }))
      );
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

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Chạy một Google News query và trả về danh sách article cards.
 *
 * Dùng tab tái sử dụng (getGooglePage) nên cookies/session được giữ qua
 * mọi query → ít CAPTCHA hơn nhiều so với mở tab mới mỗi lần.
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

    // ── Bước 2: Xoá search box và gõ query (giống người dùng thật) ──────────
    const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();

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

    if (await checkForCaptcha(page)) {
      if (isHeadlessMode()) {
        log.warn(`Aborting query "${query}" — CAPTCHA detected in headless mode.`);
        return [];
      }
      if (await checkForCaptcha(page)) {
        log.warn(`Aborting query "${query}" — CAPTCHA không giải được.`);
        return [];
      }
    }

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

    if (await checkForCaptcha(page)) return [];

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
      if (await checkForCaptcha(page)) return [];
    } else {
      log.info(`Filter confirmed: News tab + ${newsDateFilterLabel} ✓`);
    }

    // ── Bước 4: Extract cards ─────────────────────────────────────────────────
    const cards = await extractArticleCards(page);

    log.found(cards.length, query);
    if (cards.length === 0) log.warn(`Query "${query}" returned 0 results.`);

    // Lưu cookies sau mỗi search thành công → giảm CAPTCHA lần sau
    await saveGoogleSession();

    return cards;

  } catch (err) {
    log.warn(`searchGoogleNews failed for "${query}": ${err.message}`);
    return [];
    // Không đóng page — tab dùng chung, chỉ đóng khi closeBrowser()
  }
}

module.exports = { searchGoogleNews };
