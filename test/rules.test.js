'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileLexicon, scoreSentiment, topicStrength, phraseList } = require('../src/utils/ruleSignals');
const { createClassifier } = require('../src/utils/articleClassifier');
const { loadProfile } = require('../src/config/profile');

const lexicon = compileLexicon({
  positive: ['tăng trưởng', 'giải thưởng'],
  negative: ['vi phạm', 'khiếu nại'],
  critical: ['sữa giả'],
  negators: ['không', 'chống'],
  nonNegators: ['không ngừng', 'không ít'],
});

test('sentiment rules keep Vietnamese diacritics, weigh the title and handle negation', () => {
  // "giá sữa" must not match "sữa giả".
  assert.equal(scoreSentiment({ title: 'Giá sữa tăng nhẹ' }, lexicon).sentiment, 'neutral');
  assert.equal(scoreSentiment({ title: 'Phát hiện sữa giả tại Hà Nội' }, lexicon).sentiment, 'negative');
  assert.equal(scoreSentiment({ title: 'Công ty không vi phạm quy định' }, lexicon).sentiment, 'neutral');
  assert.equal(scoreSentiment({ title: 'Chiến dịch chống sữa giả' }, lexicon).sentiment, 'neutral');
  assert.equal(scoreSentiment({ title: 'Doanh nghiệp không ngừng tăng trưởng' }, lexicon).sentiment, 'positive');
  assert.equal(scoreSentiment({ title: 'Không ít khiếu nại về sản phẩm' }, lexicon).sentiment, 'negative');
  const mixed = scoreSentiment({ title: 'Đạt giải thưởng nhưng bị khiếu nại', content: '' }, lexicon);
  assert.equal(mixed.confident, false);
});

test('brand sentiment counts the title, the lead and only body sentences naming the brand', () => {
  const lead = 'Bài viết tổng hợp tin trong tuần về thị trường tiêu dùng và các sự kiện nổi bật trong ngành. '.repeat(5);
  const content = `${lead} Hãng B bị khiếu nại vì vi phạm quy định. Hãng A tăng trưởng mạnh và nhận giải thưởng.`;
  const focusA = sentence => sentence.includes('Hãng A');
  const scored = scoreSentiment({ title: 'Tin tiêu dùng trong tuần', content }, lexicon, { focus: focusA });
  assert.equal(scored.sentiment, 'neutral'); // 2 body hits for A = 2 points, under the minimum.
  assert.deepEqual(scored.hits.negative, []);
  assert.equal(scoreSentiment({ title: 'Hãng A tăng trưởng', content }, lexicon, { focus: focusA }).sentiment, 'positive');
});

test('strong topic phrases are counted in the title, the lead and the body', () => {
  const strong = phraseList(['sữa công thức', 'ngành sữa']);
  assert.deepEqual(topicStrength({ title: 'Giá sữa công thức giảm', content: 'Ngành sữa ổn định. Ngành sữa tăng.' }, strong),
    { title: 1, lead: 2, body: 2 });
});

test('hybrid sends Gemini only the articles rules cannot settle, and reuses cached answers', async () => {
  const profile = loadProfile('dairy-kids-vn');
  const cache = new Map();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"is_topic":true,"sentiment":"neutral","confidence":0.8,"reason":"ok"}' }] } }] }));
  };
  try {
    const classifier = createClassifier(profile, { cache: { get: key => cache.get(key), set: (key, model, value) => cache.set(key, value) } });
    const env = { CLASSIFIER_MODE: 'hybrid', GEMINI_API_KEY: 'test-key' };
    const vinamilk = profile.brands.find(def => def.brand === 'Vinamilk');
    const body = 'Vinamilk công bố thông tin về hoạt động của công ty trong quý ba năm nay tại Thành phố Hồ Chí Minh. '.repeat(4);

    // Clear tone: rules decide brand, relevance and sentiment.
    const clear = await classifier.classifyArticle({ title: 'Vinamilk tăng trưởng, đạt giải thưởng', content: body }, vinamilk, profile.brands, env);
    assert.equal(clear.decision, 'accept');
    assert.equal(clear.sentiment, 'positive');
    assert.equal(clear.source, 'rules');

    // Strong topic phrase in the title: industry news accepted without Gemini.
    const topicOk = await classifier.classifyTopic({ title: 'Thị trường sữa công thức năm 2025', content: 'Giá sữa công thức ổn định. '.repeat(10) }, env);
    assert.equal(topicOk.decision, 'accept');
    assert.equal(topicOk.source, 'rules');
    // Only generic keywords: rejected by rules.
    const generic = await classifier.classifyTopic({ title: 'Chăm sóc trẻ em mùa hè', content: 'Dinh dưỡng và vận động cho trẻ em. '.repeat(10) }, env);
    assert.equal(generic.decision, 'reject');
    assert.equal(calls, 0);

    // Mixed tone: Gemini settles the sentiment once; the same article again comes from the cache.
    const mixedArticle = { title: 'Vinamilk đạt giải thưởng nhưng bị khiếu nại', content: body };
    const mixed = await classifier.classifyArticle(mixedArticle, vinamilk, profile.brands, env);
    assert.equal(mixed.source, 'rules+gemini');
    await classifier.classifyArticle(mixedArticle, vinamilk, profile.brands, env);
    assert.equal(calls, 1);
    assert.deepEqual(classifier.usage, { calls: 1, cacheHits: 1, failures: 0 });

    // Rules mode never calls Gemini, and keeps the leaning side of a mixed tone.
    const rulesOnly = await classifier.classifyArticle(mixedArticle, vinamilk, profile.brands, { CLASSIFIER_MODE: 'rules' });
    assert.equal(rulesOnly.source, 'rules');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('profiles reject malformed sentiment and strong keyword lists', () => {
  const { validateProfile } = require('../src/config/profile');
  const base = loadProfile('dairy-kids-vn');
  assert.throws(() => validateProfile({ ...base, sentiment: { positive: 'tốt' } }, 'x.js'), /sentiment.positive/);
  assert.throws(() => validateProfile({ ...base, topic: { ...base.topic, strongKeywords: [1] } }, 'x.js'), /strongKeywords/);
});
