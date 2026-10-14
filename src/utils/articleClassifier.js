'use strict';

/**
 * Hybrid article classifier for news listening.
 *
 * Flow:
 *   1. Rules layer rejects obvious noise / off-topic articles.
 *   2. LLM layer validates topic context, target-brand match,
 *      sentiment, and possible brand reassignment.
 *
 * The engine knows no brand or industry: every brand/topic rule comes from a
 * profile (profiles/*.js) through createClassifier(profile). The module-level
 * exports are bound to the default profile for backward compatibility.
 */

const { createHash } = require('crypto');
const log = require('../output/logger');
const { loadProfile } = require('../config/profile');
const { compileLexicon, isEmptyLexicon, scoreSentiment, topicStrength, phraseList, splitSentences, LEAD_CHARS } = require('./ruleSignals');

const ALLOWED_DECISIONS = new Set(['accept', 'reject', 'reassign']);
const ALLOWED_SENTIMENTS = new Set(['positive', 'negative', 'neutral']);

function getClassifierConfig(env = process.env) {
  return {
    mode: String(env.CLASSIFIER_MODE || 'rules').trim().toLowerCase(),
    reviewFallback: String(env.CLASSIFIER_REVIEW_FALLBACK || 'reject').trim().toLowerCase(),
    geminiApiKey: String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim(),
    geminiModel: String(env.GEMINI_MODEL || env.GOOGLE_AI_MODEL || 'gemini-2.5-flash').trim(),
    geminiTimeoutMs: parseInt(env.GEMINI_TIMEOUT_MS || '15000', 10),
    geminiMaxRetries: parseInt(env.GEMINI_MAX_RETRIES || '4', 10),
    // Đầu bài là phần cho biết bài nói về gì; gửi toàn văn chỉ làm tăng phí.
    geminiMaxContentChars: parseInt(env.GEMINI_MAX_CONTENT_CHARS || '6000', 10),
    // Classification needs no reasoning; thinking tokens are slow and billed as output.
    // Empty = the model's default. Pro models cannot turn thinking off.
    geminiThinkingBudget: String(env.GEMINI_THINKING_BUDGET ?? '0').trim(),
  };
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildAliasList(brandDef) {
  const rawAliases = [
    brandDef.brand,
    ...(Array.isArray(brandDef.aliases) ? brandDef.aliases : []),
  ];

  return [...new Set(rawAliases.map(normalizeText).filter(Boolean))];
}

function containsAlias(text, aliases) {
  const normalizedText = ` ${normalizeText(text)} `;
  if (!normalizedText.trim()) return false;

  return aliases.some((alias) => normalizedText.includes(` ${alias} `));
}

function buildArticleText(title, content = '') {
  return normalizeText(`${title || ''} ${content || ''}`);
}

function includesKeyword(text, keywords) {
  const padded = ` ${text} `;
  return keywords.some((keyword) => padded.includes(` ${keyword} `));
}

function buildCandidateTexts(article) {
  return [
    { field: 'title', text: article.title || '' },
    { field: 'content', text: article.content || '' },
    { field: 'url', text: article.url || '' },
    { field: 'publisherDomain', text: article.publisherDomain || '' },
  ];
}

function findMatchingBrands(article, brandDefs) {
  const candidates = buildCandidateTexts(article);

  return brandDefs
    .map((brandDef) => {
      const aliases = buildAliasList(brandDef);
      const matchedFields = candidates
        .filter(({ text }) => containsAlias(text, aliases))
        .map(({ field }) => field);

      return {
        brandDef,
        matchedFields,
      };
    })
    .filter(({ matchedFields }) => matchedFields.length > 0);
}

function findBrandByName(name, brandDefs) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  return brandDefs.find((brandDef) => brandDef.brand.toLowerCase() === target) || null;
}

function buildRuleDecision(article, targetBrandDef, brandDefs) {
  const matches = findMatchingBrands(article, brandDefs);
  const targetMatch = matches.find(({ brandDef }) => brandDef.brand === targetBrandDef.brand);
  const titleMatches = findMatchingBrands(
    { title: article.title || '' },
    brandDefs
  );
  const matchedBrands = titleMatches.map(({ brandDef }) => brandDef.brand);

  if (targetMatch && targetMatch.matchedFields.some(field => field === 'title' || field === 'content')) {
    return {
      status: 'relevant',
      decision: 'accept',
      is_topic: true,
      is_target_brand: true,
      matched_brand: targetBrandDef.brand,
      matched_brands: matches.filter(match => match.matchedFields.some(field => field === 'title' || field === 'content'))
        .map(match => match.brandDef.brand),
      brand: targetBrandDef.brand,
      sentiment: 'neutral',
      confidence: 0.95,
      source: 'rules',
      reason: `Matched target brand in ${targetMatch.matchedFields.join(', ')}; retained for this brand even when other brands are mentioned`,
      needsModel: false,
    };
  }

  if (!targetMatch && matches.length === 1) {
    return {
      status: 'relevant',
      decision: 'reassign',
      is_topic: true,
      is_target_brand: false,
      matched_brand: matches[0].brandDef.brand,
      matched_brands: matchedBrands,
      brand: matches[0].brandDef.brand,
      sentiment: 'neutral',
      confidence: 0.95,
      source: 'rules',
      reason: `Matched other brand in ${matches[0].matchedFields.join(', ')}`,
      needsModel: false,
    };
  }

  if (titleMatches.length > 1 && targetMatch) {
    return {
      status: 'relevant',
      decision: 'accept',
      is_topic: true,
      is_target_brand: true,
      matched_brand: targetBrandDef.brand,
      matched_brands: matchedBrands,
      brand: targetBrandDef.brand,
      sentiment: 'neutral',
      confidence: 0.9,
      source: 'rules',
      reason: `Matched multiple brands in title (${matchedBrands.join(', ')}); accepted for target brand`,
      needsModel: false,
    };
  }

  if (matches.length > 1) {
    const firstMatch = titleMatches[0] || matches[0];
    return {
      status: 'relevant',
      decision: 'reassign',
      is_topic: true,
      is_target_brand: false,
      matched_brand: firstMatch.brandDef.brand,
      matched_brands: matchedBrands,
      brand: firstMatch.brandDef.brand,
      sentiment: 'neutral',
      confidence: 0.75,
      source: 'rules',
      reason: `Matched multiple brands (${matches.map(({ brandDef }) => brandDef.brand).join(', ')})`,
      needsModel: false,
    };
  }

  return {
    status: 'review',
    decision: 'reject',
    is_topic: true,
    is_target_brand: false,
    matched_brand: null,
    matched_brands: [],
    brand: null,
    sentiment: 'neutral',
    confidence: 0.35,
    source: 'rules',
    reason: 'No clear brand alias match after topic keyword pass',
    needsModel: true,
  };
}

function stripMarkdownFences(rawText) {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return '';

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function buildLLMPrompt(targetBrandDef, article, brandDefs, topic = {}) {
  const description = topic.description || 'chu de dang theo doi';
  const systemPrompt = [
    topic.llmRole || 'Ban la chuyen gia phan tich du lieu social listening.',
    `Muc tieu la loai bo bai bao nhieu khong thuoc ngu canh ${description}.`,
    '',
    'Quy tac bat buoc:',
    '1. Chi tra ve DUNG MOT object JSON hop le.',
    '2. Khong them markdown, khong them van ban ngoai JSON.',
    `3. "is_topic" = false neu bai khong thuoc ngu canh ${description}` +
      (topic.llmExclusions ? `, hoac la ${topic.llmExclusions}.` : '.'),
    '4. "matched_brand" phai la mot trong danh sach thuong hieu cung cap hoac null.',
    '5. "sentiment" chi duoc la positive, negative, neutral.',
    '6. "confidence" phai la so tu 0 den 1.',
    '',
    'JSON schema:',
    '{',
    '  "is_topic": true,',
    '  "is_target_brand": false,',
    '  "matched_brand": "string | null",',
    '  "sentiment": "positive | negative | neutral",',
    '  "confidence": 0.0,',
    '  "reason": "string"',
    '}',
  ].join('\n');

  const userPrompt = [
    `Target brand: "${targetBrandDef.brand}"`,
    `Tracked brands: ${brandDefs.map((brandDef) => brandDef.brand).join(', ')}`,
    '',
    `Article title: "${article.title || ''}"`,
    `Article content: "${article.content || ''}"`,
    `Article URL: "${article.url || ''}"`,
    `Publisher domain: "${article.publisherDomain || ''}"`,
  ].join('\n');

  return `${systemPrompt}\n\n${userPrompt}`;
}

function parseLLMResult(rawText, targetBrandDef, brandDefs) {
  const jsonText = stripMarkdownFences(rawText);
  const parsed = JSON.parse(jsonText);

  const isTopic = Boolean(parsed.is_topic ?? parsed.is_insurance_topic);
  const isTargetBrand = Boolean(parsed.is_target_brand);
  const sentiment = String(parsed.sentiment || '').trim().toLowerCase();
  const confidence = clampConfidence(parsed.confidence);

  if (!ALLOWED_SENTIMENTS.has(sentiment)) {
    throw new Error(`Unsupported sentiment: ${parsed.sentiment}`);
  }
  if (confidence == null) {
    throw new Error(`Invalid confidence: ${parsed.confidence}`);
  }

  let matchedBrand = null;
  if (parsed.matched_brand != null) {
    const resolvedBrand = findBrandByName(parsed.matched_brand, brandDefs);
    if (!resolvedBrand) {
      throw new Error(`Unknown matched_brand: ${parsed.matched_brand}`);
    }
    matchedBrand = resolvedBrand.brand;
  }

  // Convert the requested schema into crawler-friendly status/decision fields.
  let status = 'relevant';
  let decision = 'accept';
  let brand = targetBrandDef.brand;

  if (!isTopic) {
    status = 'irrelevant';
    decision = 'reject';
    brand = null;
  } else if (isTargetBrand) {
    status = 'relevant';
    decision = 'accept';
    brand = targetBrandDef.brand;
  } else if (matchedBrand) {
    status = 'relevant';
    decision = matchedBrand === targetBrandDef.brand ? 'accept' : 'reassign';
    brand = matchedBrand;
  } else {
    status = 'irrelevant';
    decision = 'reject';
    brand = null;
  }

  if (!ALLOWED_DECISIONS.has(decision)) {
    throw new Error(`Unsupported decision mapping: ${decision}`);
  }

  return {
    status,
    decision,
    is_topic: isTopic,
    is_target_brand: isTargetBrand,
    matched_brand: matchedBrand,
    brand,
    sentiment,
    confidence,
    source: 'gemini',
    reason: String(parsed.reason || 'Gemini decision').trim() || 'Gemini decision',
  };
}

const RETRYABLE_GEMINI_STATUS = new Set([429, 500, 503]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Seconds Gemini asks to wait: Retry-After header or RetryInfo in the error body. */
function geminiRetryDelayMs(response, bodyText) {
  const header = Number(response.headers?.get?.('retry-after'));
  if (header > 0) return header * 1000;
  const match = String(bodyText || '').match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Number(match[1]) * 1000 : 0;
}

/** Rate limits (429) and overloads (500/503) wait and retry instead of becoming a fallback decision. */
async function requestGemini(prompt, config) {
  if (!config.geminiApiKey) {
    throw new Error('Missing Gemini API key (GEMINI_API_KEY or GOOGLE_API_KEY)');
  }
  const maxRetries = Number.isInteger(config.geminiMaxRetries) ? Math.max(0, config.geminiMaxRetries) : 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestGeminiOnce(prompt, config);
    } catch (err) {
      if (!err.retryable || attempt >= maxRetries) throw err;
      const delay = Math.min(60000, Math.max(err.retryDelayMs || 0, 2000 * 2 ** attempt)) * (0.8 + Math.random() * 0.4);
      log.warn(`${err.message}; retrying Gemini in ${Math.round(delay / 1000)} s (${attempt + 1}/${maxRetries}).`);
      await sleep(delay);
    }
  }
}

async function requestGeminiOnce(prompt, config) {

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.geminiTimeoutMs);

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A header keeps the key out of URLs that may be logged.
        'x-goog-api-key': config.geminiApiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          ...(config.geminiThinkingBudget !== '' && !/-pro\b/.test(config.geminiModel)
            ? { thinkingConfig: { thinkingBudget: Number(config.geminiThinkingBudget) } } : {}),
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`Gemini HTTP ${response.status}`);
      if (RETRYABLE_GEMINI_STATUS.has(response.status)) {
        error.retryable = true;
        error.retryDelayMs = geminiRetryDelayMs(response, await response.text().catch(() => ''));
      }
      throw error;
    }

    const payload = await response.json();
    const rawText =
      payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('')
        .trim() || '';

    if (!rawText) {
      throw new Error('Gemini returned empty content');
    }
    return rawText;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error(`Gemini timeout after ${config.geminiTimeoutMs}ms`);
      timeout.retryable = true;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

const callGemini = (prompt, config) => (config.call || requestGemini)(prompt, config);
const clip = (content, config) => String(content || '').slice(0, config.geminiMaxContentChars > 0 ? config.geminiMaxContentChars : undefined);

async function analyzeWithLLM(targetBrandDef, title, content = '', article = {}, brandDefs, config, topic = {}) {
  const prompt = buildLLMPrompt(targetBrandDef, { ...article, title, content: clip(content, config) }, brandDefs, topic);
  return parseLLMResult(await callGemini(prompt, config), targetBrandDef, brandDefs);
}

// Rules already accepted the article; the model only settles a mixed tone, from the relevant passages.
function buildSentimentPrompt(subject, title, snippets, topic = {}) {
  return [
    topic.llmRole || 'Ban la chuyen gia phan tich du lieu social listening.',
    `Danh gia sac thai cua bai bao doi voi ${subject}.`,
    '',
    'Quy tac bat buoc:',
    '1. Chi tra ve DUNG MOT object JSON hop le, khong markdown.',
    '2. "sentiment" chi duoc la positive, negative, neutral.',
    '3. "confidence" phai la so tu 0 den 1.',
    '',
    '{ "sentiment": "neutral", "confidence": 0.0, "reason": "string" }',
    '',
    `Article title: "${title || ''}"`,
    `Relevant passages: "${snippets.join(' ').slice(0, 2000)}"`,
  ].join('\n');
}

function parseSentimentResult(rawText) {
  const parsed = JSON.parse(stripMarkdownFences(rawText));
  const sentiment = String(parsed.sentiment || '').trim().toLowerCase();
  if (!ALLOWED_SENTIMENTS.has(sentiment)) throw new Error(`Unsupported sentiment: ${parsed.sentiment}`);
  const confidence = clampConfidence(parsed.confidence);
  if (confidence == null) throw new Error(`Invalid confidence: ${parsed.confidence}`);
  return { sentiment, confidence, reason: String(parsed.reason || '').trim() };
}

// Industry news names no tracked brand: the model only judges the topic.
function buildTopicPrompt(article, topic = {}) {
  const description = topic.description || 'chu de dang theo doi';
  return [
    topic.llmRole || 'Ban la chuyen gia phan tich du lieu social listening.',
    `Danh gia bai bao co phai tin nganh thuoc ngu canh ${description} hay khong.`,
    '',
    'Quy tac bat buoc:',
    '1. Chi tra ve DUNG MOT object JSON hop le, khong markdown.',
    `2. "is_topic" = false neu bai khong thuoc ngu canh ${description}` +
      (topic.llmExclusions ? `, hoac la ${topic.llmExclusions}.` : '.'),
    '3. "sentiment" chi duoc la positive, negative, neutral.',
    '4. "confidence" phai la so tu 0 den 1.',
    '',
    '{ "is_topic": true, "sentiment": "neutral", "confidence": 0.0, "reason": "string" }',
    '',
    `Article title: "${article.title || ''}"`,
    `Article content: "${article.content || ''}"`,
    `Article URL: "${article.url || ''}"`,
  ].join('\n');
}

function parseTopicResult(rawText) {
  const parsed = JSON.parse(stripMarkdownFences(rawText));
  const sentiment = String(parsed.sentiment || '').trim().toLowerCase();
  if (!ALLOWED_SENTIMENTS.has(sentiment)) throw new Error(`Unsupported sentiment: ${parsed.sentiment}`);
  const confidence = clampConfidence(parsed.confidence);
  if (confidence == null) throw new Error(`Invalid confidence: ${parsed.confidence}`);
  const isTopic = Boolean(parsed.is_topic);
  return {
    decision: isTopic ? 'accept' : 'reject',
    is_topic: isTopic,
    sentiment,
    confidence,
    source: 'gemini',
    reason: String(parsed.reason || 'Gemini topic decision').trim() || 'Gemini topic decision',
  };
}

function buildIrrelevantResult(reason, source = 'rules') {
  return {
    status: 'irrelevant',
    decision: 'reject',
    is_topic: false,
    is_target_brand: false,
    matched_brand: null,
    brand: null,
    sentiment: 'neutral',
    confidence: source === 'rules' ? 0.98 : 0.2,
    source,
    reason,
  };
}

function applyFallback(ruleDecision, targetBrandDef, config) {
  const hasTargetSignal = ruleDecision.matched_brand === targetBrandDef.brand || ruleDecision.is_target_brand;

  if (config.reviewFallback === 'accept') {
    if (!hasTargetSignal) {
      return {
        ...buildIrrelevantResult(`Fallback reject: no reliable target-brand signal. ${ruleDecision.reason}`, 'fallback'),
        is_topic: true,
      };
    }

    return {
      ...ruleDecision,
      status: 'relevant',
      decision: 'accept',
      is_target_brand: true,
      matched_brand: targetBrandDef.brand,
      brand: targetBrandDef.brand,
      source: 'fallback',
      confidence: 0.2,
      reason: `Fallback accept target: ${ruleDecision.reason}`,
    };
  }

  return {
    ...buildIrrelevantResult(`Fallback reject: ${ruleDecision.reason}`, 'fallback'),
    is_topic: true,
  };
}

function findKeyword(text, keywords) {
  const padded = ` ${text} `;
  return keywords.find((keyword) => padded.includes(` ${keyword} `)) || null;
}

const normalizeList = (values) => [...new Set((values || []).map(normalizeText).filter(Boolean))];
const MATCHER_HELPERS = { normalizeText };

/**
 * Build a classifier from a profile's topic and brand rules.
 *
 * Brand-level rules are read from the brand definitions passed to each call
 * (profile.brands, or a subset/variant of them):
 *   - lookalikes:     raw patterns removed before matching (e.g. "FWD/AWD")
 *   - excludePhrases: same-name entities removed before matching; in the
 *                     title they reject the article for that target brand
 *   - requirePattern: raw (diacritic/case-sensitive) evidence also required
 *   - mentionMatcher: (rawText, { normalizeText }) => bool, replaces the
 *                     alias check for brands too ambiguous for aliases alone
 */
function createClassifier(profile, { cache = null } = {}) {
  const topic = profile.topic || {};
  const topicKeywords = normalizeList(topic.keywords);
  const lexicon = compileLexicon(profile.sentiment);
  const strongKeywords = phraseList(topic.strongKeywords);
  const minBodyStrongHits = topic.minBodyStrongHits || 3;
  // Gemini calls made, answers reused from the cache and calls that failed.
  const usage = { calls: 0, cacheHits: 0, failures: 0 };

  // Same prompt and model → same answer: re-running enrich or a republished copy costs nothing.
  async function cachedGemini(prompt, config) {
    const key = createHash('sha1').update(`${config.geminiModel}\n${prompt}`).digest('hex');
    const hit = cache?.get(key);
    if (hit) {
      usage.cacheHits++;
      return hit;
    }
    usage.calls++;
    try {
      const response = await requestGemini(prompt, config);
      cache?.set(key, config.geminiModel, response);
      return response;
    } catch (err) {
      usage.failures++;
      throw err;
    }
  }
  const configFor = env => ({ ...getClassifierConfig(env), call: cachedGemini });

  /**
   * Sentiment by the profile's lexicon. Gemini (hybrid, with a key) only
   * settles a mixed tone; otherwise the leaning side is kept.
   */
  async function attachSentiment(decision, { title, content, aliases = null, subject }, config) {
    if (decision.decision === 'reject' || isEmptyLexicon(lexicon)) return decision;
    const focus = aliases ? sentence => containsAlias(sentence, aliases) : undefined;
    const scored = scoreSentiment({ title, content }, lexicon, { focus });
    const detail = `sentiment rules +${scored.positive}/-${scored.negative}`;
    const fromRules = note => ({ ...decision, sentiment: scored.sentiment, reason: `${decision.reason}; ${detail}${note}` });
    if (scored.confident) return fromRules('');
    if (config.mode !== 'hybrid' || !config.geminiApiKey) return fromRules(' (mixed, leaning side)');
    try {
      const result = parseSentimentResult(await config.call(buildSentimentPrompt(subject, title, scored.snippets, topic), config));
      return { ...decision, sentiment: result.sentiment, source: `${decision.source || 'rules'}+gemini`,
        reason: `${decision.reason}; ${detail} mixed; Gemini sentiment: ${result.reason}` };
    } catch (err) {
      log.warn(`Gemini sentiment failed for ${title}: ${err.message}`);
      return fromRules(' (mixed, Gemini failed)');
    }
  }
  const negativeKeywords = normalizeList(topic.negativeTitleKeywords);
  const globalExcludes = normalizeList(profile.excludePhrases);
  const topicLabel = topic.description || 'tracked topic';

  /**
   * Rules layer:
   * - reject if the title names an excluded entity or a negative keyword
   *   (unless the profile's negativeOverride accepts it)
   * - otherwise require at least one topic keyword (if any are configured)
   */
  function isTopicRelated(title, content = '') {
    const text = buildArticleText(title, content);
    if (!text) return false;
    const normalizedTitle = normalizeText(title);
    if (includesKeyword(normalizedTitle, globalExcludes)) return false;
    const override = Boolean(topic.negativeOverride?.({ text, title: normalizedTitle, content: normalizeText(content) }));
    if (includesKeyword(normalizedTitle, negativeKeywords) && !override) return false;
    return topicKeywords.length ? includesKeyword(text, topicKeywords) : true;
  }

  // Brands genuinely named in the article's title/body. Excluded entities,
  // lookalikes and brand-specific matchers come from the profile.
  function findMentionedBrands(article, brandDefs) {
    let raw = `${article.title || ''} ${article.content || ''}`.normalize('NFC');
    for (const brandDef of brandDefs) {
      for (const pattern of brandDef.lookalikes || []) raw = raw.replace(pattern, ' ');
    }
    let text = ` ${normalizeText(raw)} `;
    const phrases = [...globalExcludes, ...brandDefs.flatMap(brandDef => normalizeList(brandDef.excludePhrases))];
    for (const phrase of phrases) text = text.split(` ${phrase} `).join(' ');
    return brandDefs
      .filter(brandDef => {
        if (brandDef.mentionMatcher) return Boolean(brandDef.mentionMatcher(raw, MATCHER_HELPERS));
        return containsAlias(text, buildAliasList(brandDef)) &&
          (!brandDef.requirePattern || brandDef.requirePattern.test(raw));
      })
      .map(brandDef => brandDef.brand);
  }

  /**
   * Hybrid flow:
   *   - rules layer first
   *   - if rules fail => irrelevant immediately
   *   - else LLM validates topic/brand/sentiment
   *   - if LLM says off-topic => irrelevant
   */
  async function classifyArticle(article, targetBrandDef, brandDefs, env = process.env) {
    const config = configFor(env);
    const title = article.title || '';
    const content = article.content || '';
    const normalizedTitle = normalizeText(title);
    const hasNegativeSignal = includesKeyword(normalizedTitle, negativeKeywords);
    const brandMatches = findMatchingBrands(article, brandDefs);

    const excluded = findKeyword(normalizedTitle, globalExcludes);
    if (excluded) {
      return buildIrrelevantResult(`Rejected excluded entity phrase "${excluded}" in title`, 'rules');
    }
    const sameName = findKeyword(normalizedTitle, normalizeList(targetBrandDef.excludePhrases));
    if (sameName) {
      return buildIrrelevantResult(`Rejected same-name entity "${sameName}" for ${targetBrandDef.brand} in title`, 'rules');
    }
    if (targetBrandDef.mentionMatcher && !targetBrandDef.mentionMatcher(`${title} ${content}`, MATCHER_HELPERS)) {
      return buildIrrelevantResult(`No ${targetBrandDef.brand} mention after excluding same-name entities`, 'rules');
    }

    if (!isTopicRelated(title, content) && (hasNegativeSignal || brandMatches.length === 0)) {
      return buildIrrelevantResult(`Failed rules layer: not in ${topicLabel} context`, 'rules');
    }

    const ruleDecision = buildRuleDecision(article, targetBrandDef, brandDefs);
    const withSentiment = decision => {
      const brandDef = brandDefs.find(def => def.brand === decision.brand) || targetBrandDef;
      return attachSentiment(decision, { title, content, aliases: buildAliasList(brandDef), subject: `thuong hieu "${brandDef.brand}"` }, config);
    };

    if (config.mode === 'rules') {
      return withSentiment(ruleDecision.needsModel ? applyFallback(ruleDecision, targetBrandDef, config) : ruleDecision);
    }

    // A brand named once, deep in an article with no strong topic phrase (a link
    // list, a roundup of unrelated news) is the one case rules cannot settle.
    const weak = config.mode === 'hybrid' && ruleDecision.decision !== 'reject' && config.geminiApiKey &&
      isWeakMention(title, content, buildAliasList(brandDefs.find(def => def.brand === ruleDecision.brand) || targetBrandDef));
    if (config.mode === 'hybrid' && !ruleDecision.needsModel && !weak) {
      return withSentiment(ruleDecision);
    }

    if (config.mode === 'hybrid' || config.mode === 'gemini') {
      try {
        const llmResult = await analyzeWithLLM(targetBrandDef, title, content, article, brandDefs, config, topic);
        if (!llmResult.is_topic) {
          return {
            ...llmResult,
            status: 'irrelevant',
            decision: 'reject',
            brand: null,
          };
        }
        return llmResult;
      } catch (err) {
        log.warn(`Gemini classification failed for ${article.url || title}: ${err.message}`);
        return withSentiment(applyFallback(ruleDecision, targetBrandDef, config));
      }
    }

    log.warn(`Unknown CLASSIFIER_MODE="${config.mode}", falling back to rules.`);
    return withSentiment(ruleDecision.needsModel ? applyFallback(ruleDecision, targetBrandDef, config) : ruleDecision);
  }

  /**
   * Tin ngành không nhắc hãng nào: quy tắc chủ đề của profile, rồi Gemini
   * xác nhận ở chế độ hybrid/gemini (từ khoá ngành xuất hiện cả trong bài lạc đề).
   */
  async function classifyTopic(article, env = process.env) {
    const config = configFor(env);
    const title = article.title || '';
    const content = article.content || '';
    if (!isTopicRelated(title, content)) {
      return { ...buildIrrelevantResult(`Failed rules layer: not in ${topicLabel} context`, 'rules') };
    }
    const decided = topicRuleDecision(title, content);
    const accept = reason => ({ decision: 'accept', is_topic: true, sentiment: 'neutral', confidence: 0.5, source: 'rules', reason });
    const sentimentOf = decision => attachSentiment(decision, { title, content, subject: `nganh (${topicLabel})` }, config);
    if (config.mode !== 'hybrid' && config.mode !== 'gemini') {
      return sentimentOf(decided || accept(`Topic keywords of ${topicLabel} in title/body`));
    }
    // Hybrid: the model only sees articles the topic rules cannot settle.
    if (config.mode === 'hybrid' && decided) return sentimentOf(decided);
    try {
      return parseTopicResult(await config.call(buildTopicPrompt({ ...article, content: clip(content, config) }, topic), config));
    } catch (err) {
      log.warn(`Gemini topic check failed for ${article.url || title}: ${err.message}`);
      return config.reviewFallback === 'accept'
        ? { decision: 'accept', is_topic: true, sentiment: 'neutral', confidence: 0.2, source: 'fallback',
          reason: `Fallback accept: ${err.message}` }
        : { ...buildIrrelevantResult(`Fallback reject: ${err.message}`, 'fallback'), is_topic: true };
    }
  }

  /**
   * Ước lượng từ tiêu đề RSS (chưa có thân bài) để tải trước link dễ được nhận.
   * Chỉ dùng để xếp thứ tự: bài nhắc hãng ở thân bài vẫn được tải sau.
   */
  function looksRelevant(title) {
    // Google News thêm " - Tên báo" vào cuối tiêu đề.
    const clean = String(title || '').replace(/\s+-\s+[^-]+$/, '');
    return findMentionedBrands({ title: clean }, profile.brands || []).length > 0 || isTopicRelated(clean, '');
  }

  function isWeakMention(title, content, aliases) {
    if (!strongKeywords.length || containsAlias(title, aliases) || containsAlias(content.slice(0, LEAD_CHARS), aliases)) return false;
    if (splitSentences(content).filter(sentence => containsAlias(sentence, aliases)).length > 1) return false;
    return topicStrength({ title, content }, strongKeywords).body === 0;
  }

  /**
   * Tin ngành theo topic.strongKeywords: cụm rõ nghĩa ở tiêu đề → nhận; nhiều
   * lần ở thân bài và có ở đoạn mở đầu → nhận; không có cụm nào (chỉ từ chung
   * như "dinh dưỡng") → loại. Còn lại trả null: cần Gemini (hybrid).
   */
  function topicRuleDecision(title, content) {
    if (!strongKeywords.length) return null;
    const strength = topicStrength({ title, content }, strongKeywords);
    const accept = reason => ({ decision: 'accept', is_topic: true, sentiment: 'neutral', confidence: 0.85, source: 'rules', reason });
    if (strength.title > 0) return accept(`Strong ${topicLabel} phrase in title`);
    if (strength.body >= minBodyStrongHits && strength.lead > 0) {
      return accept(`${strength.body} strong ${topicLabel} phrases, including the lead`);
    }
    if (strength.body === 0) return buildIrrelevantResult(`Only generic ${topicLabel} keywords, no strong phrase`, 'rules');
    return null;
  }

  return { profile, isTopicRelated, findMentionedBrands, looksRelevant, classifyArticle, classifyTopic, usage };
}

const defaultClassifier = createClassifier(loadProfile());

module.exports = {
  normalizeText,
  buildRuleDecision,
  getClassifierConfig,
  findMatchingBrands,
  analyzeWithLLM,
  createClassifier,
  isTopicRelated: defaultClassifier.isTopicRelated,
  findMentionedBrands: defaultClassifier.findMentionedBrands,
  classifyArticle: defaultClassifier.classifyArticle,
};
