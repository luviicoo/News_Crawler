'use strict';

/**
 * Hybrid article classifier for Vietnam insurance listening.
 *
 * Flow:
 *   1. Rules layer rejects obvious noise / off-topic articles.
 *   2. LLM layer validates insurance context, target-brand match,
 *      sentiment, and possible brand reassignment.
 *
 * The exported classifyArticle() keeps compatibility with the current crawler
 * by returning decision/brand/source/sentiment/confidence/reason fields, while
 * also exposing classification status fields for crawler output and callers.
 */

const log = require('../output/logger');

const ALLOWED_DECISIONS = new Set(['accept', 'reject', 'reassign']);
const ALLOWED_SENTIMENTS = new Set(['positive', 'negative', 'neutral']);

// Keywords that usually indicate irrelevant content for commercial insurance listening.
const NEGATIVE_KEYWORDS = [
  'bao hiem xa hoi',
  'bhxh',
  'bao hiem that nghiep',
  'bao hiem y te',
  'bhyt',
  'an sinh xa hoi',
  'tro cap that nghiep',
  'huong dan vien',
  'ca si',
  'am nhac',
  'liveshow',
  'concert',
  'giai tri',
  'phim',
  'bong da',
  'trong tai',
  'arbritale',
  'serie a',
  'fotmob',
];

// Parent-company, regional, and foreign-market coverage is outside the
// Vietnam competitor scope even when a Vietnamese publisher translates it.
const NON_VIETNAM_BRAND_PHRASES = [
  'chubb life hong kong',
  'co phieu generali',
  'generali tokenized',
  'jefferies generali',
  'manulife financial',
  'prudential financial',
  'prudential plc',
  'sun life asia',
  'sun life financial',
];

// These businesses share the Bao Viet name but are not Bao Viet Life.
const BAO_VIET_NON_LIFE_PHRASES = [
  'bao hiem bao viet',
  'bao viet insurance',
  'bao viet securities',
  'chung khoan bao viet',
  'cong ty co phan chung khoan bao viet',
];

const PRUDENTIAL_FINANCE_PHRASES = ['prudential finance', 'prudential vietnam finance', 'tai chinh prudential'];

// Keywords that usually indicate the article is about insurance business.
const INSURANCE_KEYWORDS = [
  'bao hiem',
  'nhan tho',
  'phi nhan tho',
  'boi thuong',
  'hop dong',
  'chi tra',
  'quyen loi bao hiem',
  'tu van bao hiem',
  'dai ly bao hiem',
  'doanh nghiep bao hiem',
  'thi truong bao hiem',
  'san pham bao hiem',
  'insurtech',
  'sun life',
  'prudential',
  'manulife',
  'generali',
  'aia viet nam',
  'chubb life',
  'dai ichi life',
  'bao viet nhan tho',
  'fwd',
];

function getClassifierConfig(env = process.env) {
  return {
    mode: String(env.CLASSIFIER_MODE || 'rules').trim().toLowerCase(),
    reviewFallback: String(env.CLASSIFIER_REVIEW_FALLBACK || 'reject').trim().toLowerCase(),
    geminiApiKey: String(env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '').trim(),
    geminiModel: String(env.GEMINI_MODEL || env.GOOGLE_AI_MODEL || 'gemini-2.5-flash').trim(),
    geminiTimeoutMs: parseInt(env.GEMINI_TIMEOUT_MS || '15000', 10),
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

/**
 * Rules layer:
 * - reject if the article matches known negative/noise keywords
 * - otherwise require at least one insurance-business keyword
 */
function isInsuranceRelated(title, content = '') {
  const text = buildArticleText(title, content);
  if (!text) return false;
  const normalizedTitle = normalizeText(title);
  if (includesKeyword(normalizedTitle, NON_VIETNAM_BRAND_PHRASES)) return false;
  // An explicitly branded campaign (e.g. "An Concert by Prudential") is
  // company communication, unlike unrelated entertainment search results.
  const brandedPrudentialCampaign = /\bby prudential\b/.test(text) ||
    /\bprudential (?:viet nam|vietnam)\b|\bbao hiem nhan tho prudential\b/.test(normalizeText(content));
  if (includesKeyword(normalizedTitle, NEGATIVE_KEYWORDS) && !brandedPrudentialCampaign) return false;
  return includesKeyword(text, INSURANCE_KEYWORDS);
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

// Lookalikes that only collide with a brand once diacritics/case are removed:
// "bảo Việt Nam" (said Vietnam), "báo Việt" (Vietnamese press) and
// drivetrain labels such as "Cầu trước (FWD)" or "FWD/AWD".
const RAW_LOOKALIKES = [
  /(?:cầu trước|dẫn động(?: cầu trước)?)\s*\(?\s*FWD\s*\)?/giu,
  /\b(?:FWD|AWD|RWD|4WD)(?:\s*\/\s*(?:FWD|AWD|RWD|4WD))+\b/gu,
];
const RAW_BRAND_GUARDS = {
  'Bao Viet Nhan Tho': /(?:Bảo Việt|BẢO VIỆT|Bao Viet|BAO VIET|Baoviet|BaoViet|BAOVIET)(?![ \t]+(?:Nam|NAM)\b)/u,
  'FWD Viet Nam': /\bFWD\b/u,
};

// Brands genuinely named in the article's title/body. Foreign parents, Bao Viet
// non-life units, other Prudential entities and lookalikes don't count.
function findMentionedBrands(article, brandDefs) {
  let raw = `${article.title || ''} ${article.content || ''}`.normalize('NFC');
  for (const pattern of RAW_LOOKALIKES) raw = raw.replace(pattern, ' ');
  let text = ` ${normalizeText(raw)} `;
  for (const phrase of [...NON_VIETNAM_BRAND_PHRASES, ...BAO_VIET_NON_LIFE_PHRASES, ...PRUDENTIAL_FINANCE_PHRASES]) {
    text = text.split(` ${phrase} `).join(' ');
  }
  return brandDefs
    .filter(brandDef => {
      if (brandDef.brand === 'Prudential Viet Nam') return hasPrudentialVietnamMention(raw);
      const guard = RAW_BRAND_GUARDS[brandDef.brand];
      return containsAlias(text, buildAliasList(brandDef)) && (!guard || guard.test(raw));
    })
    .map(brandDef => brandDef.brand);
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
      is_insurance_topic: true,
      is_target_brand: true,
      matched_brand: targetBrandDef.brand,
      matched_brands: matches.filter(match => match.matchedFields.some(field => field === 'title' || field === 'content'))
        .map(match => match.brandDef.brand),
      brand: targetBrandDef.brand,
      sentiment: 'neutral',
      confidence: 0.95,
      source: 'rules',
      reason: `Matched target brand in ${targetMatch.matchedFields.join(', ')}; retained for this brand even when other insurers are mentioned`,
      needsModel: false,
    };
  }

  if (!targetMatch && matches.length === 1) {
    return {
      status: 'relevant',
      decision: 'reassign',
      is_insurance_topic: true,
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
      is_insurance_topic: true,
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
      is_insurance_topic: true,
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
    is_insurance_topic: true,
    is_target_brand: false,
    matched_brand: null,
    matched_brands: [],
    brand: null,
    sentiment: 'neutral',
    confidence: 0.35,
    source: 'rules',
    reason: 'No clear brand alias match after insurance keyword pass',
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

function buildLLMPrompt(targetBrandDef, article, brandDefs) {
  const systemPrompt = [
    'Ban la chuyen gia phan tich du lieu social listening cho nganh bao hiem tai Viet Nam.',
    'Muc tieu la loai bo bai bao nhieu khong thuoc ngu canh kinh doanh bao hiem.',
    '',
    'Quy tac bat buoc:',
    '1. Chi tra ve DUNG MOT object JSON hop le.',
    '2. Khong them markdown, khong them van ban ngoai JSON.',
    '3. "is_insurance_topic" = false neu bai la tin giai tri, the thao, y te cong, bao hiem xa hoi, bao hiem y te nha nuoc, tro cap that nghiep, hoac noise.',
    '4. "matched_brand" phai la mot trong danh sach thuong hieu cung cap hoac null.',
    '5. "sentiment" chi duoc la positive, negative, neutral.',
    '6. "confidence" phai la so tu 0 den 1.',
    '',
    'JSON schema:',
    '{',
    '  "is_insurance_topic": true,',
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

  const isInsuranceTopic = Boolean(parsed.is_insurance_topic);
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

  if (!isInsuranceTopic) {
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
    is_insurance_topic: isInsuranceTopic,
    is_target_brand: isTargetBrand,
    matched_brand: matchedBrand,
    brand,
    sentiment,
    confidence,
    source: 'gemini',
    reason: String(parsed.reason || 'Gemini decision').trim() || 'Gemini decision',
  };
}

async function analyzeWithLLM(targetBrandDef, title, content = '', article = {}, brandDefs, config) {
  if (!config.geminiApiKey) {
    throw new Error('Missing Gemini API key (GEMINI_API_KEY or GOOGLE_API_KEY)');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.geminiTimeoutMs);

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}` +
      `:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    const prompt = buildLLMPrompt(
      targetBrandDef,
      {
        ...article,
        title,
        content,
      },
      brandDefs
    );

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini HTTP ${response.status}`);
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

    return parseLLMResult(rawText, targetBrandDef, brandDefs);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Gemini timeout after ${config.geminiTimeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildIrrelevantResult(reason, source = 'rules') {
  return {
    status: 'irrelevant',
    decision: 'reject',
    is_insurance_topic: false,
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
        is_insurance_topic: true,
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
    is_insurance_topic: true,
  };
}

/**
 * Hybrid flow:
 *   - rules layer first
 *   - if rules fail => irrelevant immediately
 *   - else LLM validates topic/brand/sentiment
 *   - if LLM says non-insurance => irrelevant
 */
async function classifyArticle(article, targetBrandDef, brandDefs, env = process.env) {
  const config = getClassifierConfig(env);
  const title = article.title || '';
  const content = article.content || '';
  const hasNegativeSignal = includesKeyword(normalizeText(title), NEGATIVE_KEYWORDS);
  const brandMatches = findMatchingBrands(article, brandDefs);

  if (includesKeyword(normalizeText(title), NON_VIETNAM_BRAND_PHRASES)) {
    return buildIrrelevantResult('Rejected foreign or parent-company brand phrase in title', 'rules');
  }
  if (targetBrandDef.brand === 'Prudential Viet Nam' &&
      includesKeyword(normalizeText(title), PRUDENTIAL_FINANCE_PHRASES)) {
    return buildIrrelevantResult('Rejected Prudential consumer finance business in title', 'rules');
  }
  if (targetBrandDef.brand === 'Prudential Viet Nam' && !hasPrudentialVietnamMention(`${title} ${content}`)) {
    return buildIrrelevantResult('No target insurer mention after excluding other Prudential entities', 'rules');
  }

  if (
    targetBrandDef.brand === 'Bao Viet Nhan Tho' &&
    includesKeyword(normalizeText(title), BAO_VIET_NON_LIFE_PHRASES)
  ) {
    return buildIrrelevantResult('Rejected non-life Bao Viet business in title', 'rules');
  }

  if (!isInsuranceRelated(title, content) && (hasNegativeSignal || brandMatches.length === 0)) {
    return buildIrrelevantResult('Failed rules layer: not in commercial insurance context', 'rules');
  }

  const ruleDecision = buildRuleDecision(article, targetBrandDef, brandDefs);

  if (config.mode === 'rules') {
    return ruleDecision.needsModel ? applyFallback(ruleDecision, targetBrandDef, config) : ruleDecision;
  }

  if (config.mode === 'hybrid' && !ruleDecision.needsModel) {
    return ruleDecision;
  }

  if (config.mode === 'hybrid' || config.mode === 'gemini') {
    try {
      const llmResult = await analyzeWithLLM(targetBrandDef, title, content, article, brandDefs, config);
      if (!llmResult.is_insurance_topic) {
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
      return applyFallback(ruleDecision, targetBrandDef, config);
    }
  }

  log.warn(`Unknown CLASSIFIER_MODE="${config.mode}", falling back to rules.`);
  return ruleDecision.needsModel ? applyFallback(ruleDecision, targetBrandDef, config) : ruleDecision;
}

function hasPrudentialVietnamMention(value) {
  const text = normalizeText(value);
  const otherEntities = /\bprudential\s+(?:finance|financial|plc|holborn life|tower|center|hong kong|hongkong|malaysia|singapore|indonesia|thailand|india|assessment|regulation|regulatory|authority|supervision)\b|\bmacro\s+prudential\b/g;
  const consumerFinance = /\btai chinh\s+(?:(?:tnhh|mot thanh vien|mtv)\s+)*prudential\b/g;
  const containsOtherEntity = otherEntities.test(text) || consumerFinance.test(text);
  const cleaned = text.replace(otherEntities, '').replace(consumerFinance, '').replace(/\bprudential plc\b/g, '');
  const localParent = /\bprudential plc\b.{0,350}\b(?:viet nam|vietnam)\b|\b(?:viet nam|vietnam)\b.{0,200}\bprudential plc\b/.test(text);
  const localInsurer = /\bprudential (?:viet nam|vietnam)\b|\b(?:bao hiem nhan tho|bhnt)\b.{0,60}\bprudential\b|\bprudential\b.{0,120}\b(?:bao hiem nhan tho|bhnt)\b|\bby prudential\b/.test(cleaned);
  // Once another entity is named, bare shorthand such as "Prudential" later
  // in that story cannot by itself establish a Vietnam-insurer mention.
  if (containsOtherEntity) return localInsurer || localParent;
  return /\bprudential\b/.test(cleaned) || localParent;
}

module.exports = {
  BAO_VIET_NON_LIFE_PHRASES,
  NEGATIVE_KEYWORDS,
  NON_VIETNAM_BRAND_PHRASES,
  INSURANCE_KEYWORDS,
  normalizeText,
  hasPrudentialVietnamMention,
  buildRuleDecision,
  getClassifierConfig,
  isInsuranceRelated,
  findMatchingBrands,
  findMentionedBrands,
  analyzeWithLLM,
  classifyArticle,
};
