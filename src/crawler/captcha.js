'use strict';

const { captchaPatterns } = require('../config/googleSelectors.json');

async function isCaptchaPage(page) {
  if (page.isClosed()) return true;
  try {
    return await page.evaluate((patterns) => {
      const text = (location.href + ' ' + document.title + ' ' + (document.body?.innerText || '')).toLowerCase();
      return patterns.some(pattern => pattern === 'captcha'
        ? /captcha/i.test(location.href + ' ' + document.title)
        : text.includes(pattern.toLowerCase())) ||
        Boolean(document.querySelector('#challenge-running, #challenge-stage, form#challenge-form')) ||
        /^(just a moment|attention required)/i.test(document.title);
    }, captchaPatterns);
  } catch (_) {
    // A navigation or closed page must not be mistaken for solved verification.
    return true;
  }
}

module.exports = { isCaptchaPage };
