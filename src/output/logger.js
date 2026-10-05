'use strict';

/**
 * Structured console logger.
 *
 * All messages are prefixed with an ISO timestamp and a bracketed tag so logs
 * can be grepped by event type (e.g. grep '\[ERROR\]' run.log).
 *
 * Usage:
 *   const log = require('./logger');
 *   log.start('Prudential Việt Nam', 'Prudential VN');
 *   log.found(5, 'Prudential VN');
 */

function _ts() {
  return new Date().toISOString();
}

function _print(tag, msg) {
  // eslint-disable-next-line no-console
  console.log(`${_ts()} ${tag} ${msg}`);
}

module.exports = {
  /** Brand + query search starting */
  start(brand, query) {
    _print('[START]', `Brand: ${brand}, Query: "${query}"`);
  },

  /** N articles found on the Google News results page */
  found(n, query) {
    _print('[FOUND]', `${n} articles for query "${query}"`);
  },

  /** Article skipped because its normalised URL was seen before */
  skip(url) {
    _print('[SKIP]', `Duplicate: ${url}`);
  },

  /** Article skipped because it does not mention the target brand */
  skipBrand(brand, title, url) {
    _print('[SKIP_BRAND]', `Brand mismatch for ${brand}: "${title}" | ${url}`);
  },

  /** Article was found under one brand query but mapped to another brand */
  reassignBrand(fromBrand, toBrand, title, url) {
    _print('[REASSIGN_BRAND]', `${fromBrand} -> ${toBrand}: "${title}" | ${url}`);
  },

  /** Article classification result */
  classify(decision, source, brand, sentiment, confidence, title, url, reason) {
    _print(
      '[CLASSIFY]',
      `${decision.toUpperCase()} via ${source}${brand ? ` => ${brand}` : ''} | sentiment=${sentiment} | confidence=${confidence}: "${title}" | ${url} | ${reason}`
    );
  },

  /** About to open an article page */
  fetch(url) {
    _print('[FETCH]', `Opening article: ${url}`);
  },

  /** publish_date successfully extracted */
  date(method, date) {
    _print('[DATE]', `Found publish_date via ${method}: ${date}`);
  },

  /** publish_date could not be found after all fallbacks */
  dateFail(url) {
    _print('[DATE_FAIL]', `Could not find publish_date for: ${url}`);
  },

  /** Non-fatal per-article error */
  error(url, errMsg) {
    _print('[ERROR]', `Failed to fetch article ${url}: ${errMsg}`);
  },

  /** CAPTCHA detected */
  captcha(pauseMs) {
    _print('[CAPTCHA]', `CAPTCHA detected, pausing ${pauseMs / 1000}s`);
  },

  /** Per-brand completion summary */
  done(brand, queries, articlesFound, errors) {
    _print(
      '[DONE]',
      `Brand: ${brand} | Queries: ${queries} | Articles found: ${articlesFound} | Errors: ${errors}`
    );
  },

  /** Final run summary */
  summary(total, errors, filepath) {
    _print(
      '[SUMMARY]',
      `Total articles: ${total} | Total errors: ${errors} | Output: ${filepath}`
    );
  },

  /** Generic informational message */
  info(msg) {
    _print('[INFO]', msg);
  },

  /** Warning message */
  warn(msg) {
    _print('[WARN]', msg);
  },
};
