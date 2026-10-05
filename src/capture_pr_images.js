'use strict';

const fs = require('fs');
const path = require('path');
const PROJECT_ROOT = path.resolve(__dirname, '..');

require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

const { launchBrowser, closeBrowser } = require('./crawler/browser');
const { fetchArticle } = require('./crawler/article');
const log = require('./output/logger');

function parseInputPath() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    throw new Error('Missing JSON input path.');
  }
  return path.resolve(jsonPath);
}

function getCaptureConcurrency(itemCount) {
  const rawValue = parseInt(process.env.PR_IMAGE_CAPTURE_CONCURRENCY || '3', 10);
  const normalizedValue = Number.isFinite(rawValue) ? rawValue : 3;
  const boundedValue = Math.min(Math.max(normalizedValue, 1), 6);
  return Math.min(boundedValue, Math.max(itemCount, 1));
}

async function main() {
  const inputPath = parseInputPath();
  const rawPayload = fs.readFileSync(inputPath, 'utf8');
  const items = JSON.parse(rawPayload);
  if (!Array.isArray(items) || items.length === 0) {
    log.info('No PR image items to capture.');
    return;
  }

  let successCount = 0;
  let failureCount = 0;
  let nextIndex = 0;
  const concurrency = getCaptureConcurrency(items.length);
  await launchBrowser({ headless: true });
  log.info(`PR image capture concurrency=${concurrency}`);

  try {
    async function runWorker() {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) {
          return;
        }

        const item = items[currentIndex];
        const articleUrl = String(item.link || '').trim();
        if (!articleUrl) {
          failureCount++;
          continue;
        }

        const result = await fetchArticle(articleUrl, {
          brand: String(item.player || '').trim(),
          publisherDomain: String(item.publisherDomain || '').trim(),
          screenshotDir: String(item.screenshotDir || '').trim(),
        });

        if (result && result.screenshotPath) {
          successCount++;
        } else {
          failureCount++;
        }
      }
    }

    await Promise.all(
      Array.from({ length: concurrency }, () => runWorker())
    );
  } finally {
    await closeBrowser();
  }

  log.summary(successCount, failureCount, 'capture_pr_images');
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[FATAL]', error);
  process.exit(1);
});
