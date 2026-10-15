'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/output/logger');

function capture(level = 'summary') {
  const lines = [];
  const log = createLogger({ level, write: line => lines.push(line), now: () => 0 });
  return { log, lines };
}

test('summary logging keeps progress and results without individual URLs or classifications', () => {
  const { log, lines } = capture();
  for (let index = 0; index < 1000; index++) {
    const url = `https://example.vn/article-${index}`;
    log.start('Example', 'individual brand query');
    log.found(10, 'individual brand query');
    log.fetch(url);
    log.date('meta', '2026-10-01');
    log.dateFail(url);
    log.classify('accept', 'rules', 'Example', 'neutral', 1, 'Article title', url, 'decision reason');
    log.skip(url);
    log.skipSameArticle(url, url, 'same URL');
    log.skipBrand('Example', 'Article title', url);
    log.reassignBrand('Example', 'Other', 'Article title', url);
    log.debug(`HTTP fallback for ${url}`);
  }
  log.info('Profile: example');
  log.progress('Crawl', 'queries 20/100; 8 new articles stored');
  log.summary(8, 0, 'output/example.csv');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /\[PROGRESS\].*20\/100.*8 new articles/);
  assert.match(lines[2], /\[SUMMARY\].*8.*output\/example.csv/);
  assert.ok(!lines.join('\n').includes('https://'));
  assert.ok(!lines.join('\n').includes('individual brand query'));
});

test('repeated failures are grouped with accurate totals and no per-link detail', () => {
  const { log, lines } = capture();
  for (let index = 0; index < 100; index++) {
    log.issue('rss-503', 'RSS retries (HTTP 503)', `Query ${index}: https://example.vn/${index}`);
  }
  for (let index = 0; index < 3; index++) log.error(`https://example.vn/${index}`, 'Article HTTP 503');
  log.error('https://other.vn/a', 'Article HTTP 404');
  assert.equal(lines.length, 3);
  log.flush();
  assert.equal(lines.length, 4);
  assert.match(lines[3], /RSS retries \(HTTP 503\) \(100\)/);
  assert.match(lines[3], /HTTP 503 \(3\)/);
  assert.match(lines[3], /HTTP 404 \(1\)/);
  assert.ok(!lines.join('\n').includes('https://'));
  log.flush();
  assert.equal(lines.length, 4);
  log.issue('rss-503', 'RSS retries (HTTP 503)');
  assert.equal(lines.length, 5); // A new run can report the issue again.
});

test('debug logging exposes diagnostic details only when enabled', () => {
  const { log, lines } = capture('debug');
  log.fetch('https://example.vn/article');
  log.date('meta', '2026-10-01');
  log.classify('accept', 'rules', 'Example', 'neutral', 1, 'Article', 'https://example.vn/article', 'matched alias');
  log.issue('rss-503', 'RSS retries', 'First query failed');
  log.issue('rss-503', 'RSS retries', 'Second query failed');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /https:\/\/example.vn\/article/);
  assert.match(lines[2], /matched alias/);
  assert.match(lines[4], /Second query failed/);
});

test('runtime log configuration is read lazily and important actions stay visible', () => {
  let level = 'summary';
  const { log, lines } = capture(() => level);
  log.debug('hidden');
  assert.equal(lines.length, 0);
  level = 'debug';
  log.debug('enabled after configuration loads');
  assert.equal(lines.length, 1);
  level = 'summary';
  log.warn('Google decoding paused for 10 minutes');
  log.warn('Google decoding paused for 10 minutes');
  log.captcha(120000);
  log.captcha(120000);
  log.health('Coverage incomplete');
  log.fatal(new Error('Store could not be opened'));
  assert.equal(lines.filter(line => line.includes('[WARN]')).length, 1);
  assert.equal(lines.filter(line => line.includes('[CAPTCHA]')).length, 2);
  assert.match(lines.at(-1), /\[FATAL\] Store could not be opened$/);
  assert.ok(!lines.join('\n').includes('at TestContext'));
});
