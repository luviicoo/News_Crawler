'use strict';

/** Summary by default; LOG_LEVEL=debug enables individual URLs and decisions. */
function createLogger({ level = () => process.env.LOG_LEVEL || 'summary',
  write = line => console.log(line), now = Date.now } = {}) {
  const issues = new Map();
  const isDebug = () => (typeof level === 'function' ? level() : level) === 'debug';
  const print = (tag, message) => write(`${new Date(now()).toISOString()} [${tag}] ${message}`);
  const debug = message => { if (isDebug()) print('DEBUG', message); };

  // Report a problem when it first appears, then count repetitions until flush.
  function issue(key, summary, detail = summary, severity = 'WARN') {
    const entry = issues.get(key) || { summary, count: 0 };
    entry.count++;
    issues.set(key, entry);
    if (isDebug()) print(severity, detail);
    else if (entry.count === 1) print(severity, summary);
  }

  function flush() {
    if (!issues.size) return;
    print('ISSUES', [...issues.values()].map(entry => `${entry.summary} (${entry.count})`).join(' | '));
    issues.clear();
  }

  return {
    isDebug, debug, issue, flush,
    info: message => print('INFO', message),
    warn: message => issue(message, message),
    health: message => print('HEALTH', message),
    progress: (phase, message) => print('PROGRESS', `${phase}: ${message}`),
    fatal(error) {
      print('FATAL', error?.message || String(error));
      debug(error?.stack || String(error));
    },
    captcha: pauseMs => print('CAPTCHA', `Manual verification required; waiting up to ${pauseMs / 1000}s.`),
    done: (brand, queries, articlesFound, errors) => print('DONE',
      `Brand: ${brand} | Queries: ${queries} | Articles found: ${articlesFound} | Errors: ${errors}`),
    summary: (total, errors, filepath) => print('SUMMARY',
      `Total articles: ${total}${errors ? ` | Errors: ${errors}` : ''} | Output: ${filepath}`),

    // Individual article/search events are intentionally silent in summary mode.
    start: (brand, query) => debug(`Search ${brand}: ${query}`),
    found: (n, query) => debug(`${n} results for ${query}`),
    skip: url => debug(`Duplicate: ${url}`),
    skipSameArticle: (url, matchedUrl, reason) => debug(`Same article: ${url} = ${matchedUrl} (${reason})`),
    skipBrand: (brand, title, url) => debug(`Brand mismatch ${brand}: ${title} | ${url}`),
    reassignBrand: (from, to, title, url) => debug(`Reassign ${from} -> ${to}: ${title} | ${url}`),
    classify: (decision, source, brand, sentiment, confidence, title, url, reason) =>
      debug(`${decision} via ${source} => ${brand} | sentiment=${sentiment} | confidence=${confidence}: ${title} | ${url} | ${reason}`),
    fetch: url => debug(`Opening article: ${url}`),
    date: (method, date) => debug(`Publication date via ${method}: ${date}`),
    dateFail: url => debug(`Publication date not verified: ${url}`),
    error(url, message) {
      const status = /\b(?:HTTP\s*)?([45]\d{2})\b/i.exec(message)?.[1];
      issue(status ? `article-http-${status}` : 'article-read-failed',
        status ? `Article reads failed with HTTP ${status}` : 'Some articles could not be read',
        `${url}: ${message}`, 'ERROR');
    },
  };
}

module.exports = { ...createLogger(), createLogger };
