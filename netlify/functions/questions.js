/**
 * On Deck — Question Generation API
 *
 * POST /.netlify/functions/questions
 * Body: { date: "20260514", difficulty: 0-3, offset: 0 }
 *
 * Generates 10 questions for one difficulty level at a time.
 * Cached in Netlify Blobs — all players on the same day get the same questions.
 * Requires env var: ANTHROPIC_API_KEY
 */

const Anthropic = require('@anthropic-ai/sdk');

const DIFF_DESC = [
  'Easy: general knowledge most educated adults know — geography, famous people, basic science, common history',
  'Medium: requires broader knowledge — specific historical events, science concepts, literature, technology',
  'Hard: specific detailed facts — exact dates, scientific terminology, precise historical details, cultural specifics',
  'Expert: deep niche knowledge — etymology, obscure history, scientific nomenclature, rare geography, very specific facts'
];

async function generateQuestions(difficulty, count) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Generate ${count} trivia questions. Return ONLY a valid JSON array, no markdown:
[{"q":"question","o":["A","B","C","D"],"a":0,"f":"one interesting fun fact"}]
"a" = 0-indexed correct answer. Difficulty: ${DIFF_DESC[difficulty]}
Rules: 4 plausible options, one correct. Fun fact = 1 interesting sentence. Topics: history, science, geography, nature, language, arts, food, technology, mythology. NO sports questions. Vary topics. Return ONLY the JSON array.`
    }]
  });
  const text = msg.content.find(b => b.type === 'text')?.text ?? '[]';
  return JSON.parse(text.replace(/```json?|```/g, '').trim());
}

function getBlobs() {
  try { const { getStore } = require('@netlify/blobs'); return getStore('on-deck'); }
  catch (e) { return null; }
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };
  if (!process.env.ANTHROPIC_API_KEY) return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set.' }) };

  const store = getBlobs();
  try {
    const { date, difficulty, offset = 0 } = JSON.parse(event.body || '{}');
    if (!date || difficulty === undefined) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing date or difficulty' }) };

    const cacheKey = `v2-${date}-${difficulty}`;
    let pool = [];

    if (store) {
      try { const c = await store.get(cacheKey, { type: 'json' }); if (c) pool = c; } catch (e) {}
    }

    if (pool.length > offset) {
      return { statusCode: 200, headers: h, body: JSON.stringify(pool.slice(offset)) };
    }

    const newQs = await generateQuestions(difficulty, 10);
    pool = [...pool, ...newQs];

    if (store) { try { await store.set(cacheKey, JSON.stringify(pool)); } catch (e) {} }

    return { statusCode: 200, headers: h, body: JSON.stringify(pool.slice(offset)) };
  } catch (err) {
    console.error('Error:', err);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
