'use strict';

/**
 * URL normalisation utilities.
 *
 * Two main jobs:
 *   1. Resolve Google / publisher tracking redirects → real URL
 *   2. Normalise URLs for deduplication (strip utm_*, fragments, trailing slash, etc.)
 */

const REDIRECT_PARAM_KEYS = [
  'q',
  'url',
  'u',
  'r',
  'to',
  'target',
  'dest',
  'destination',
  'redirect',
  'redirect_url',
  'redirect_uri',
  'redirectUrl',
  'redirectUri',
  'articleUrl',
  'article_url',
];

const log = require('../output/logger');
const seenUrls = new Set();

function decodeRepeatedly(value, maxRounds = 2) {
  let current = String(value || '').trim();
  if (!current) return '';

  for (let i = 0; i < maxRounds; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (!decoded || decoded === current) break;
      current = decoded.trim();
    } catch (_) {
      break;
    }
  }

  return current;
}

function toAbsoluteHttpUrl(candidate, baseUrl) {
  const raw = decodeRepeatedly(candidate);
  if (!raw) return '';

  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).toString();
    }

    if (raw.startsWith('//')) {
      return new URL(`${baseUrl.protocol}${raw}`).toString();
    }

    if (raw.startsWith('/')) {
      return new URL(raw, `${baseUrl.protocol}//${baseUrl.host}`).toString();
    }
  } catch (_) {
    return '';
  }

  return '';
}

function getRedirectTarget(url) {
  for (const key of REDIRECT_PARAM_KEYS) {
    const candidate = toAbsoluteHttpUrl(url.searchParams.get(key), url);
    if (candidate) return candidate;
  }

  const hash = String(url.hash || '').replace(/^#/, '');
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    for (const key of REDIRECT_PARAM_KEYS) {
      const candidate = toAbsoluteHttpUrl(hashParams.get(key), url);
      if (candidate) return candidate;
    }
  }

  return '';
}

/**
 * If the supplied href is a Google redirect link (/url?q=…) or a publisher-side
 * redirect wrapper such as /404?r=REAL_URL, extract and decode the real
 * destination URL. Otherwise return the href unchanged.
 *
 * Google uses at least two redirect formats:
 *   https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Farticle&sa=…
 *   /url?q=https%3A%2F%2Fexample.com%2Farticle&sa=…
 *
 * @param {string} href  Raw href attribute from Google search result
 * @returns {string}     The real destination URL
 */
function resolveGoogleRedirect(href) {
  if (!href) return '';

  try {
    const base = 'https://www.google.com';
    let resolved = /^https?:\/\//i.test(href) ? href : `${base}${href}`;

    // Some publishers wrap the real article URL inside another redirect URL.
    for (let i = 0; i < 3; i++) {
      const url = new URL(resolved);

      if (
        /(^|\.)google\./i.test(url.hostname) &&
        url.pathname === '/url'
      ) {
        const qParam = toAbsoluteHttpUrl(url.searchParams.get('q'), url);
        if (qParam) {
          resolved = qParam;
          continue;
        }
      }

      const redirectTarget = getRedirectTarget(url);
      if (redirectTarget && redirectTarget !== resolved) {
        resolved = redirectTarget;
        continue;
      }

      break;
    }

    return resolved;
  } catch (_) {
    // Malformed URL – return as-is
  }

  return href;
}

/**
 * Normalise a URL for deduplication purposes.
 *
 * Rules applied (in order):
 *   1. Parse the URL; if invalid return the original string lowercased.
 *   2. Lowercase the scheme and hostname.
 *   3. Remove all utm_* query parameters (and fbclid, gclid, etc.).
 *   4. Remove a trailing slash from the pathname (unless pathname is "/").
 *   5. Sort remaining query parameters so order doesn't matter.
 *
 * @param {string} url
 * @returns {string} Normalised URL string
 */
function normalizeUrl(url) {
  if (!url) return '';

  try {
    const u = new URL(resolveGoogleRedirect(url));

    // Lowercase scheme + host (URL constructor already does this, but be explicit)
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();

    // Strip tracking params
    const TRACKING_PARAMS = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'utm_id', 'fbclid', 'gclid', 'msclkid', 'ref', '_ga',
    ];
    TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p));

    // Sort remaining params for canonical ordering
    u.searchParams.sort();

    // Fragments do not change the underlying article URL
    u.hash = '';

    // Remove trailing slash on non-root paths
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    // Remove default ports (already handled by URL API)
    return u.toString();
  } catch (_) {
    // Fallback for malformed URLs
    return url.toLowerCase().trim();
  }
}

/**
 * Extract the hostname (publisher domain) from a URL string.
 * Returns empty string on failure.
 *
 * Example: "https://www.vnexpress.net/article" → "vnexpress.net"
 *
 * @param {string} url
 * @returns {string}
 */
function extractHostname(url) {
  if (!url) return '';
  const candidate = String(url).trim();

  // Accept pure hostname strings such as "vnexpress.net" or "congly.vn".
  if (!candidate.includes('://')) {
    const host = candidate.replace(/^www\./i, '');
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host)) {
      return host.toLowerCase();
    }
  }

  try {
    const u = new URL(candidate);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

/**
 * Build the homepage URL from a publisher domain string.
 *
 * Input có thể là hostname thuần (vd: "vnexpress.net") hoặc URL đầy đủ.
 * Output: "https://vnexpress.net"
 *
 * @param {string} domain  publisher_domain value
 * @returns {string}
 */
function buildHomepage(domain) {
  if (!domain) return '';
  // Nếu đã là URL đầy đủ, chỉ lấy scheme + hostname
  try {
    if (/^https?:\/\//i.test(domain)) {
      const u = new URL(domain);
      return `${u.protocol}//${u.hostname}`;
    }
  } catch (_) {}
  // Domain thuần: thêm https://
  const clean = domain.trim().replace(/\/+$/, ''); // bỏ trailing slash
  return `https://${clean}`;
}

function buildSeenKey(url, scope = '') {
  return `${String(scope || '').trim().toLowerCase()}\n${normalizeUrl(url)}`;
}

function isDuplicate(url, scope = '') {
  const key = buildSeenKey(url, scope);
  if (seenUrls.has(key)) {
    log.skip(url);
    return true;
  }
  return false;
}

function markSeen(url, scope = '') {
  seenUrls.add(buildSeenKey(url, scope));
}

function seenCount() {
  return seenUrls.size;
}

function resetSeenUrls() {
  seenUrls.clear();
}

module.exports = {
  resolveGoogleRedirect,
  normalizeUrl,
  extractHostname,
  buildHomepage,
  isDuplicate,
  markSeen,
  seenCount,
  resetSeenUrls,
};
