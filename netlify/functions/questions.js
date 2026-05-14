/**
 * On Deck — Question Generation API
 *
 * POST /.netlify/functions/questions
 *
 * Two modes:
 *   Daily load:  { date: "20260513" }
 *     → returns { "0":[...], "1":[...], "2":[...], "3":[...] }
 *     → generates once, caches in Netlify Blobs for all subsequent players
 *
 *   Overflow:   { date: "20260513", difficulty: 2, offset: 12 }
 *     → returns more questions for that difficulty starting at offset
 *     → also cached so all players get the same overflow questions
 *
 * Requires env var: ANTHROPIC_API_KEY
 */

const Anthropic = require('@anthropic-ai/sdk');

/* ── Difficulty descriptions for the prompt ── */
const DIFF = [
  'Easy: general knowledge most educated adults know — geography capitals, famous historical figures, basic science, common cultural facts',
  'Medium: requires broader education — specific historical events, science concepts, world literature, notable world records, technology',
  'Hard: specific detailed knowledge — exact historical dates, scientific terminology, cultural specifics, precise facts',
  'Expert: deep niche knowledge — etymology, obscure history, scientific nomenclature, rare geography, very specific facts'
];

/* ── Generate all 4 difficulty pools in one Claude call ── */
async function generateDailyPools() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 7000,
    messages: [{
      role: 'user',
      content: `Generate a complete daily trivia question set. Return ONLY a valid JSON object with no markdown:

{
  "0": [ 15 easy questions ],
  "1": [ 15 medium questions ],
  "2": [ 12 hard questions ],
  "3": [ 10 expert questions ]
}

Each question format:
{"q":"question text","o":["Option A","Option B","Option C","Option D"],"a":0,"f":"One genuinely interesting fun fact about the correct answer"}

"a" = 0-indexed position of the correct answer.

Difficulty levels:
- 0 (Easy): ${DIFF[0]}
- 1 (Medium): ${DIFF[1]}
- 2 (Hard): ${DIFF[2]}
- 3 (Expert): ${DIFF[3]}

Rules:
- All 4 options must be plausible — only one is definitively correct
- Fun fact must be a single interesting sentence about the correct answer
- Cover diverse topics across all levels: world history, science, geography, nature, language & etymology, arts & music, food & drink, technology, mythology, architecture
- IMPORTANT: Do NOT write sports trivia questions (the game has a sports theme — sports content would be redundant)
- Within each difficulty level, vary topics — no two consecutive questions on the same subject
- Questions at harder levels should be genuinely harder, not just obscure phrasing of easy facts

Return ONLY the raw JSON object. No markdown fences, no explanation.`
    }]
  });

  const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
  const clean = text.replace(/```json?|```/g, '').trim();
  return JSON.parse(clean);
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
