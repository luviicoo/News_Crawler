'use strict';

/**
 * Chống trùng bài SAU khi đã mở trang (có URL thật, canonical, hreflang).
 *
 * Bước chống trùng trước khi mở bài (isDuplicate trong urlParser) chỉ thấy URL
 * từ Google News, thường là link trung gian news.google.com/rss/articles/...
 * Hai link trung gian khác nhau có thể dẫn về cùng 1 bài, nên cần kiểm tra lại
 * ở đây trước khi chụp ảnh và ghi CSV.
 *
 * Quy tắc gộp (theo từng brand):
 *   1. URL cuối trùng key với URL cuối của bài đã nhận → trùng.
 *      Key đã bỏ ngôn ngữ (/vn/ ↔ /en/), AMP, mobile... (buildArticleKey).
 *   2. URL cuối hoặc hreflang khớp với hreflang / URL cuối của bài đã nhận →
 *      trùng (bản ngôn ngữ khác, slug khác nhau). Không cần so tiêu đề vì
 *      tiêu đề khác ngôn ngữ.
 *   3. Khớp qua canonical/og:url → chỉ gộp khi tiêu đề giống nhau. Có báo đặt
 *      canonical sai (nhiều bài cùng 1 canonical), nên canonical một mình
 *      không đủ làm bằng chứng.
 * Canonical/hreflang trỏ sang site khác hoặc về trang chủ bị bỏ qua.
 */

const {
  buildArticleKey,
  buildArticleId,
  isHomepageUrl,
  isSameSite,
} = require('./urlParser');

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titlesMatch(a, b) {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  return left.length >= 12 && left === right;
}

function collectRelatedKeys(finalUrl, urls, primaryKey) {
  const keys = new Set();
  for (const url of urls || []) {
    if (!url || !isSameSite(url, finalUrl) || isHomepageUrl(url)) continue;
    const key = buildArticleKey(url);
    if (key && key !== primaryKey) keys.add(key);
  }
  return [...keys];
}

function createArticleRegistry() {
  // scope → Map(key → { articleId, kind: 'primary'|'alternate'|'canonical', title, url })
  const scopes = new Map();

  function getScope(scope) {
    const name = String(scope || '').trim().toLowerCase();
    if (!scopes.has(name)) scopes.set(name, new Map());
    return scopes.get(name);
  }

  /**
   * Kiểm tra bài đã có chưa; nếu chưa thì đăng ký luôn (atomic trong event loop).
   *
   * @returns {{ duplicate: boolean, articleId: string, matchedUrl?: string, reason?: string }}
   */
  function claim({
    scope = '',
    finalUrl,
    title = '',
    canonicalUrl = '',
    ogUrl = '',
    alternateUrls = [],
  }) {
    const entries = getScope(scope);
    const primaryKey = buildArticleKey(finalUrl);
    if (!primaryKey) return { duplicate: false, articleId: '' };

    const alternateKeys = collectRelatedKeys(finalUrl, alternateUrls, primaryKey);
    const canonicalKeys = collectRelatedKeys(finalUrl, [canonicalUrl, ogUrl], primaryKey)
      .filter((key) => !alternateKeys.includes(key));

    const duplicateOf = (entry, reason) => ({
      duplicate: true,
      articleId: entry.articleId,
      matchedUrl: entry.url,
      reason,
    });

    const existing = entries.get(primaryKey);
    if (existing) {
      if (existing.kind === 'primary') return duplicateOf(existing, 'same-url');
      if (existing.kind === 'alternate') return duplicateOf(existing, 'language-alternate');
      if (titlesMatch(existing.title, title)) return duplicateOf(existing, 'canonical+title');
    }

    for (const key of alternateKeys) {
      const entry = entries.get(key);
      if (entry && entry.kind === 'primary') return duplicateOf(entry, 'language-alternate');
    }

    for (const key of canonicalKeys) {
      const entry = entries.get(key);
      if (entry && titlesMatch(entry.title, title)) return duplicateOf(entry, 'canonical+title');
    }

    const articleId = buildArticleId(primaryKey);
    const record = (kind) => ({ articleId, kind, title, url: finalUrl });

    entries.set(primaryKey, record('primary'));
    for (const key of alternateKeys) {
      if (!entries.has(key)) entries.set(key, record('alternate'));
    }
    for (const key of canonicalKeys) {
      if (!entries.has(key)) entries.set(key, record('canonical'));
    }

    return { duplicate: false, articleId };
  }

  return { claim };
}

module.exports = { createArticleRegistry, normalizeTitle, titlesMatch };
