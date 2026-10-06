'use strict';

const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { chromium } = require('playwright-extra');
const { launchBrowser, verifyInPopup } = require('../src/crawler/browser');
const { parseArgs } = require('../src/index');

function fixture({ closed = false, transferred = true } = {}) {
  const events = [];
  const state = { cookies: [{ name: 'verified', value: 'yes' }], origins: [] };
  const hidden = {
    challenge: true,
    isClosed: () => false,
    url: () => 'https://example.test/challenge',
    context: () => ({
      storageState: async () => ({ cookies: [], origins: [] }),
      addCookies: async cookies => { events.push(['cookies', cookies]); },
    }),
    addInitScript: async () => events.push(['localStorage']),
    goto: async url => { events.push(['resume', url]); hidden.challenge = !transferred; },
  };
  const popup = {
    isClosed: () => closed,
    url: () => 'https://example.test/article',
    goto: async url => events.push(['open', url]),
    bringToFront: async () => events.push(['front']),
    challenge: false,
  };
  const popupBrowser = {
    newContext: async options => {
      events.push(['context', options]);
      return { newPage: async () => popup, storageState: async () => state };
    },
    close: async () => events.push(['close']),
  };
  return { hidden, popupBrowser, events, state };
}

test('crawler stays hidden even with legacy HEADLESS=false', async () => {
  const previous = process.env.HEADLESS;
  process.env.HEADLESS = 'false';
  const stub = mock.method(chromium, 'launch', async options => {
    assert.equal(options.headless, true);
    throw new Error('test stops before creating context');
  });
  try {
    assert.equal(parseArgs().headless, true);
    await assert.rejects(launchBrowser({ headless: false }), /test stops/);
  } finally {
    stub.mock.restore();
    if (previous === undefined) delete process.env.HEADLESS;
    else process.env.HEADLESS = previous;
  }
});

test('manual verification opens only on challenge and transfers session before closing', async () => {
  const f = fixture();
  const stub = mock.method(chromium, 'launch', async options => {
    assert.equal(options.headless, false);
    return f.popupBrowser;
  });
  try {
    assert.equal(await verifyInPopup(f.hidden, async () => false), true);
    assert.equal(stub.mock.callCount(), 0);
    assert.equal(await verifyInPopup(f.hidden, async page => page.challenge), true);
    assert.equal(stub.mock.callCount(), 1);
    assert.deepEqual(f.events.find(event => event[0] === 'cookies')[1], f.state.cookies);
    assert.ok(f.events.findIndex(event => event[0] === 'cookies') <
      f.events.findIndex(event => event[0] === 'resume'));
    assert.equal(f.events.at(-1)[0], 'close');
  } finally { stub.mock.restore(); }
});

test('closing popup skips verification and closes the popup browser', async () => {
  const f = fixture({ closed: true });
  const stub = mock.method(chromium, 'launch', async () => f.popupBrowser);
  try {
    assert.equal(await verifyInPopup(f.hidden, async page => page.challenge), false);
    assert.equal(f.events.some(event => event[0] === 'resume'), false);
    assert.equal(f.events.at(-1)[0], 'close');
  } finally { stub.mock.restore(); }
});

test('zero timeout skips popup; expired verification does not report success', async () => {
  const previous = process.env.CAPTCHA_PAUSE_MS;
  const f = fixture({ transferred: false });
  const stub = mock.method(chromium, 'launch', async () => f.popupBrowser);
  try {
    process.env.CAPTCHA_PAUSE_MS = '0';
    assert.equal(await verifyInPopup(f.hidden, async page => page.challenge), false);
    assert.equal(stub.mock.callCount(), 0);
    process.env.CAPTCHA_PAUSE_MS = '1';
    assert.equal(await verifyInPopup(f.hidden, async page => page.challenge), false);
    assert.equal(f.events.at(-1)[0], 'close');
  } finally {
    stub.mock.restore();
    if (previous === undefined) delete process.env.CAPTCHA_PAUSE_MS;
    else process.env.CAPTCHA_PAUSE_MS = previous;
  }
});

test('concurrent challenges share one popup after session verification', async () => {
  const first = fixture();
  const second = fixture();
  second.hidden.reload = async () => { second.hidden.challenge = false; };
  let release;
  let entered;
  const launched = new Promise(resolve => { entered = resolve; });
  const ready = new Promise(resolve => { release = resolve; });
  const stub = mock.method(chromium, 'launch', async () => {
    entered();
    await ready;
    return first.popupBrowser;
  });
  try {
    const one = verifyInPopup(first.hidden, async page => page.challenge);
    await launched;
    const two = verifyInPopup(second.hidden, async page => page.challenge);
    release();
    assert.deepEqual(await Promise.all([one, two]), [true, true]);
    assert.equal(stub.mock.callCount(), 1);
  } finally { release(); stub.mock.restore(); }
});
