'use strict';

const { createHash } = require('crypto');

const DEFAULT_PUBLISHERS = [
  'vnexpress.net', 'tuoitre.vn', 'thanhnien.vn', 'dantri.com.vn', 'vietnamnet.vn',
  'tinnhanhchungkhoan.vn', 'baodautu.vn', 'cafef.vn', 'plo.vn', 'sggp.org.vn',
  'vneconomy.vn', 'nhandan.vn', 'bnews.vn', 'thoibaotaichinhvietnam.vn',
  'baotintuc.vn', 'laodong.vn',
];

function windows(range, period) {
  const result = [];
  let from = range.from;
  while (from <= range.to) {
    const date = new Date(`${from}T00:00:00Z`);
    const end = period === 'year'
      ? new Date(Date.UTC(date.getUTCFullYear() + 1, 0, 0))
      : new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    const to = [end.toISOString().slice(0, 10), range.to].sort()[0];
    result.push({ from, to });
    const next = new Date(`${to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    from = next.toISOString().slice(0, 10);
  }
  return result;
}

function buildSearchPlan(brands, range, { publishers = DEFAULT_PUBLISHERS, web = true } = {}) {
  const tasks = new Map();
  const add = (brand, query, dateRange, channel, kind) => {
    const key = JSON.stringify([brand, query, dateRange.from, dateRange.to, channel]);
    const id = createHash('sha256').update(key).digest('hex').slice(0, 20);
    tasks.set(id, { id, brand, query, dateRange, channel, kind });
  };
  for (const { brand, queries } of brands) {
    // Keep broad rankings as well as narrower windows. Coverage never depends
    // on a feed hitting 100: an unsaturated feed can still miss indexed stories.
    for (const query of queries) add(brand, query, range, 'rss', 'whole-range');
    for (const month of windows(range, 'month')) {
      for (const query of queries) add(brand, query, month, 'rss', 'monthly');
      if (web) add(brand, queries[0], month, 'web', 'monthly');
    }
    for (const year of windows(range, 'year')) {
      for (const domain of [...new Set(publishers)]) {
        const query = `${queries[0]} site:${domain}`;
        add(brand, query, year, 'rss', 'publisher-year');
        if (web) add(brand, query, year, 'web', 'publisher-year');
      }
    }
  }
  // RSS first. Web is a complementary stage even when RSS returned results.
  return [...tasks.values()].sort((a, b) => Number(a.channel === 'web') - Number(b.channel === 'web'));
}

module.exports = { DEFAULT_PUBLISHERS, windows, buildSearchPlan };
