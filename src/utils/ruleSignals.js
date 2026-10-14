'use strict';

/**
 * Tín hiệu rule cho sentiment và độ chắc của tin ngành, dùng từ điển trong
 * profile (profile.sentiment, topic.strongKeywords). Engine không chứa từ ngữ
 * của ngành nào.
 *
 * So khớp GIỮ DẤU tiếng Việt (chỉ chuyển chữ thường, NFC, bỏ dấu câu): bỏ dấu
 * làm "sữa giả" trùng "sữa giá", "lỗ" trùng "lò". Cụm từ khớp theo nguyên âm
 * tiết, nên tránh cụm một tiếng ("kiện" khớp cả "sự kiện").
 */

// Trọng số theo vị trí: tiêu đề quyết định giọng bài nhiều nhất, rồi đoạn mở đầu.
const TITLE_WEIGHT = 3;
const LEAD_WEIGHT = 2;
const BODY_WEIGHT = 1;
const LEAD_CHARS = 400;
// Từ phủ định chỉ tính khi nằm trong số tiếng này ngay trước cụm từ.
const NEGATION_WINDOW = 3;
// Một chiều cần ít nhất ngần này điểm (một lần ở tiêu đề, hoặc mở đầu + thân bài) và hơn gấp ba chiều kia (hoặc chiều kia
// bằng 0) mới được rules quyết; còn lại là lẫn lộn.
const MIN_SCORE = 3;
const DOMINANCE = 3;

function prepare(value) {
  return ` ${String(value || '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

function phraseList(values) {
  return [...new Set((values || []).map(value => prepare(value).trim()).filter(Boolean))];
}

/** Từ điển sentiment của profile, đã chuẩn hoá một lần. */
function compileLexicon(sentiment = {}) {
  return {
    positive: phraseList(sentiment.positive),
    negative: phraseList(sentiment.negative),
    critical: phraseList(sentiment.critical),
    negators: phraseList(sentiment.negators),
    nonNegators: phraseList(sentiment.nonNegators),
  };
}

function isEmptyLexicon(lexicon) {
  return !lexicon.positive.length && !lexicon.negative.length && !lexicon.critical.length;
}

/** Cụm từ bị phủ định: có từ phủ định trong vài tiếng ngay trước, trừ "không chỉ", "không ngừng"... */
function isNegated(prepared, index, lexicon) {
  const before = prepared.slice(0, index).trim().split(' ');
  const windowText = ` ${before.slice(-NEGATION_WINDOW).join(' ')} `;
  if (lexicon.nonNegators.some(phrase => windowText.includes(` ${phrase} `))) return false;
  return lexicon.negators.some(phrase => windowText.includes(` ${phrase} `));
}

function countHits(prepared, phrases, lexicon) {
  const hits = [];
  for (const phrase of phrases) {
    const needle = ` ${phrase} `;
    let index = prepared.indexOf(needle);
    while (index !== -1) {
      if (!isNegated(prepared, index + 1, lexicon)) {
        hits.push(phrase);
        break; // Một cụm từ tính một lần cho mỗi đoạn.
      }
      index = prepared.indexOf(needle, index + 1);
    }
  }
  return hits;
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[.!?…])\s+|\n+/u).map(sentence => sentence.trim()).filter(Boolean);
}

/**
 * Đoạn dùng để chấm sentiment: tiêu đề, đoạn mở đầu, và (khi có `focus`, hàm
 * nhận câu → true nếu câu nhắc brand) chỉ những câu thân bài nhắc brand, để
 * giọng của phần bài nói về chuyện khác không gán cho brand.
 */
function segmentsFor({ title = '', content = '' }, focus) {
  const segments = [{ text: title, weight: TITLE_WEIGHT }];
  let offset = 0;
  for (const sentence of splitSentences(content)) {
    const start = content.indexOf(sentence, offset);
    offset = start >= 0 ? start + sentence.length : offset;
    const inLead = start >= 0 && start < LEAD_CHARS;
    if (!inLead && focus && !focus(sentence)) continue;
    segments.push({ text: sentence, weight: inLead ? LEAD_WEIGHT : BODY_WEIGHT });
  }
  return segments;
}

/**
 * @returns {{sentiment:string, confident:boolean, positive:number, negative:number,
 *   hits:{positive:string[], negative:string[]}, snippets:string[]}}
 *   confident=false khi hai chiều lẫn lộn: cần Gemini (hybrid) hoặc lấy chiều trội (rules).
 */
function scoreSentiment(article, lexicon, { focus } = {}) {
  let positive = 0;
  let negative = 0;
  const hits = { positive: new Set(), negative: new Set() };
  const snippets = [];
  for (const segment of segmentsFor(article, focus)) {
    const prepared = prepare(segment.text);
    const pos = countHits(prepared, lexicon.positive, lexicon);
    const neg = countHits(prepared, lexicon.negative, lexicon);
    const crit = countHits(prepared, lexicon.critical, lexicon);
    positive += pos.length * segment.weight;
    negative += (neg.length + 2 * crit.length) * segment.weight;
    pos.forEach(hit => hits.positive.add(hit));
    [...neg, ...crit].forEach(hit => hits.negative.add(hit));
    if (segment.weight < TITLE_WEIGHT) snippets.push(segment.text);
  }
  const result = { positive, negative, hits: { positive: [...hits.positive], negative: [...hits.negative] }, snippets };
  if (Math.max(positive, negative) < MIN_SCORE) return { ...result, sentiment: 'neutral', confident: true };
  const dominates = (side, other) => side >= MIN_SCORE && (other === 0 || side > DOMINANCE * other);
  if (dominates(negative, positive)) return { ...result, sentiment: 'negative', confident: true };
  if (dominates(positive, negative)) return { ...result, sentiment: 'positive', confident: true };
  const leaning = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';
  return { ...result, sentiment: leaning, confident: false };
}

/** Số cụm từ ngành rõ nghĩa ở tiêu đề, đoạn mở đầu và cả bài. */
function topicStrength({ title = '', content = '' }, strongKeywords) {
  const count = text => {
    const prepared = prepare(text);
    return strongKeywords.reduce((total, phrase) => {
      let hits = 0;
      for (let index = prepared.indexOf(` ${phrase} `); index !== -1; index = prepared.indexOf(` ${phrase} `, index + 1)) hits++;
      return total + hits;
    }, 0);
  };
  return { title: count(title), lead: count(content.slice(0, LEAD_CHARS)), body: count(content) };
}

module.exports = { prepare, phraseList, compileLexicon, isEmptyLexicon, scoreSentiment, topicStrength, splitSentences, LEAD_CHARS };
