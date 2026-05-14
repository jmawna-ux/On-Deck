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

    const cacheKey = `${date}-${difficulty}`;
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
};  return JSON.parse(clean);
}

/* ── Generate additional questions for one difficulty (overflow) ── */
async function generateMore(difficulty, count) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const names = ['easy', 'medium', 'hard', 'expert'];

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2500,
    messages: [{
      role: 'user',
      content: `Generate ${count} ${names[difficulty]} trivia questions. Return ONLY a valid JSON array:

[{"q":"question","o":["A","B","C","D"],"a":0,"f":"fun fact"}]

Difficulty: ${DIFF[difficulty]}

Rules:
- 4 plausible options, exactly one correct
- Fun fact: 1 interesting sentence about the correct answer
- Diverse topics: history, science, geography, nature, language, arts, food, tech, mythology
- NO sports questions
- No repeated topics within the batch

Return ONLY the JSON array.`
    }]
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '[]';
  const clean = text.replace(/```json?|```/g, '').trim();
  return JSON.parse(clean);
}

/* ── Netlify Blobs helper (gracefully absent in local dev) ── */
function getBlobs() {
  try {
    const { getStore } = require('@netlify/blobs');
    return getStore('on-deck');
  } catch (e) {
    return null; // not available locally — will skip caching
  }
}

/* ── Main handler ── */
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set. Add it in Netlify → Site configuration → Environment variables.' })
    };
  }

  const store = getBlobs();

  try {
    const body = JSON.parse(event.body || '{}');
    const { date, difficulty, offset } = body;

    if (!date) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date' }) };
    }

    /* ── OVERFLOW MODE: more questions for one difficulty ── */
    if (difficulty !== undefined && offset !== undefined) {
      const cacheKey = `overflow-${date}-${difficulty}`;
      let pool = [];

      if (store) {
        try {
          const cached = await store.get(cacheKey, { type: 'json' });
          if (cached) pool = cached;
        } catch (e) { /* cache miss */ }
      }

      // Already have enough cached from this offset
      if (pool.length > offset) {
        return {
          statusCode: 200, headers,
          body: JSON.stringify(pool.slice(offset))
        };
      }

      // Generate more and append to cache
      const more = await generateMore(difficulty, 12);
      pool = [...pool, ...more];

      if (store) {
        try { await store.set(cacheKey, JSON.stringify(pool)); } catch (e) { /* ignore */ }
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify(pool.slice(offset))
      };
    }

    /* ── DAILY MODE: all 4 pools for the day ── */
    const cacheKey = `daily-${date}`;

    if (store) {
      try {
        const cached = await store.get(cacheKey, { type: 'json' });
        if (cached) {
          console.log(`Cache hit for ${date}`);
          return { statusCode: 200, headers, body: JSON.stringify(cached) };
        }
      } catch (e) { /* cache miss — generate */ }
    }

    console.log(`Generating daily questions for ${date}...`);
    const pools = await generateDailyPools();

    // Cache daily pools AND seed per-difficulty overflow caches
    if (store) {
      try {
        await store.set(cacheKey, JSON.stringify(pools));
        await Promise.all([0, 1, 2, 3].map(d =>
          pools[String(d)]
            ? store.set(`overflow-${date}-${d}`, JSON.stringify(pools[String(d)]))
            : Promise.resolve()
        ));
      } catch (e) { /* cache write failed — ok, just won't serve cache next time */ }
    }

    return { statusCode: 200, headers, body: JSON.stringify(pools) };

  } catch (err) {
    console.error('Question generation error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message || 'Generation failed' })
    };
  }
};
