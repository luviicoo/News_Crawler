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

const crypto = require('crypto');
const log = require('../output/logger');
const {
  LANGUAGE_SEGMENTS,
  STRIPPED_SUBDOMAINS,
  IGNORED_QUERY_PARAMS,
  SLUG_NUMERIC_SUFFIX_DOMAINS,
} = require('../config/urlIdentity');

const LANGUAGE_SEGMENT_SET = new Set(LANGUAGE_SEGMENTS);
const STRIPPED_SUBDOMAIN_SET = new Set(STRIPPED_SUBDOMAINS);
const IGNORED_QUERY_PARAM_SET = new Set(IGNORED_QUERY_PARAMS);
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

function stripVariantSubdomains(hostname) {
  const labels = hostname.split('.');
  while (labels.length > 2 && STRIPPED_SUBDOMAIN_SET.has(labels[0])) {
    labels.shift();
  }
  return labels.join('.');
}

function domainMatches(hostname, domains) {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

/**
 * Build the identity key of an article URL: two URLs with the same key are
 * treated as the same article.
 *
 * On top of normalizeUrl() it ignores (rules in src/config/urlIdentity.js):
 *   - scheme, www/m/amp/language subdomains
 *   - language path segments: /vn/a and /en/a → same key
 *   - AMP path segments and language/AMP query params
 *   - "-<5+ digit id>" slug suffix on domains configured for it
 *
 * @param {string} url
 * @returns {string} Key such as "example.com/tin-tuc/bai-viet", or '' if invalid
 */
function buildArticleKey(url) {
  if (!url) return '';

  let u;
  try {
    u = new URL(normalizeUrl(url));
  } catch (_) {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';

  const hostname = stripVariantSubdomains(u.hostname);

  let segments = u.pathname
    .split('/')
    .filter(Boolean)
    .filter((segment) => {
      const lower = segment.toLowerCase();
      return !LANGUAGE_SEGMENT_SET.has(lower) && lower !== 'amp';
    });

  if (segments.length > 0) {
    const last = segments.length - 1;
    segments[last] = segments[last].replace(/[.-]amp(\.html?)?$/i, '$1');
    if (domainMatches(hostname, SLUG_NUMERIC_SUFFIX_DOMAINS)) {
      segments[last] = segments[last].replace(/-\d{5,}$/, '');
    }
  }

  const params = new URLSearchParams();
  for (const [key, value] of u.searchParams) {
    if (!IGNORED_QUERY_PARAM_SET.has(key.toLowerCase())) params.append(key, value);
  }
  params.sort();
  const query = params.toString();

  return `${hostname}/${segments.join('/')}${query ? `?${query}` : ''}`;
}

/**
 * True when the URL is a site homepage (after language segments are ignored).
 * Used to reject canonical/hreflang links that point to the homepage.
 */
function isHomepageUrl(url) {
  const key = buildArticleKey(url);
  if (!key) return false;
  const path = key.slice(key.indexOf('/') + 1).split('?')[0];
  return path === '' || /^(index|home|default)(\.\w+)?$/i.test(path);
}

/**
 * True when both URLs belong to the same site (subdomain variants ignored).
 */
function isSameSite(urlA, urlB) {
  const keyA = buildArticleKey(urlA);
  const keyB = buildArticleKey(urlB);
  if (!keyA || !keyB) return false;
  return keyA.split('/')[0] === keyB.split('/')[0];
}

/**
 * Stable article ID derived from the article key: the same article gets the
 * same ID across runs as long as its key does not change.
 */
function buildArticleId(articleKey) {
  if (!articleKey) return '';
  return `art_${crypto.createHash('sha1').update(articleKey).digest('hex').slice(0, 12)}`;
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
  return `${String(scope || '').trim().toLowerCase()}\n${buildArticleKey(url) || normalizeUrl(url)}`;
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
  buildArticleKey,
  buildArticleId,
  isHomepageUrl,
  isSameSite,
  extractHostname,
  buildHomepage,
  isDuplicate,
  markSeen,
  seenCount,
  resetSeenUrls,
};
