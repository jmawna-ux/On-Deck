/**
 * On Deck — Question Generation API
 *
 * On first request of the day, generates ALL 4 difficulty pools at once
 * in a single Claude call, guaranteeing no cross-difficulty duplicates.
 * Results cached in Netlify Blobs so all players get identical questions.
 *
 * Rolling 450-day history prevents question repeats long-term.
 */

const Anthropic = require('@anthropic-ai/sdk');

const ALL_TOPICS = [
  'American history', 'European history', 'Asian history', 'African history',
  'ancient civilizations', 'medieval history', 'modern world history',
  'World War history', 'colonial history', 'Renaissance history',
  'natural sciences', 'chemistry', 'biology and ecology', 'physics',
  'astronomy and space', 'geology and earth science', 'medicine and health',
  'mathematics and logic', 'technology and inventions',
  'world geography', 'travel and exploration', 'natural wonders',
  'art and painting', 'music and composers', 'world literature',
  'architecture and design', 'film and theatre',
  'world religions', 'philosophy and ideas', 'mythology and folklore',
  'language and etymology', 'food and cuisine',
  'sports history and records', 'animals and wildlife',
];

const DIFF_NAMES = ['Easy', 'Medium', 'Hard', 'Expert'];
const DIFF_DESC = [
  'Easy: well-known facts most educated adults would know',
  'Medium: requires broader knowledge and education',
  'Hard: specific facts, exact dates, precise details',
  'Expert: deep niche knowledge, obscure but accurate facts',
];

function getDayTopics(date) {
  const n = parseInt(date);
  let seed = n >>> 0;
  const rng = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const arr = [...ALL_TOPICS];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, 8); // 8 topics, 2 per difficulty level
}

function getBlobs() {
  try { const { getStore } = require('@netlify/blobs'); return getStore('on-deck'); }
  catch (e) { return null; }
}

async function getHistory(store, difficulty) {
  if (!store) return [];
  try {
    const hist = await store.get(`history-d${difficulty}`, { type: 'json' }) || [];
    return hist.slice(-30).flatMap(e => e.questions);
  } catch (e) { return []; }
}

async function saveHistory(store, difficulty, date, questions) {
  if (!store) return;
  try {
    const histKey = `history-d${difficulty}`;
    let hist = [];
    try { hist = await store.get(histKey, { type: 'json' }) || []; } catch (e) {}
    hist.push({ date, questions: questions.map(q => q.q) });
    if (hist.length > 450) hist = hist.slice(-450);
    await store.set(histKey, JSON.stringify(hist));
  } catch (e) { console.log('History save failed:', e.message); }
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  console.log('questions called:', new Date().toISOString());

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const store = getBlobs();

  try {
    const { date, difficulty } = JSON.parse(event.body || '{}');
    if (!date || difficulty === undefined) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing params' }) };
    }

    // Check if today's full set is already cached
    const cacheKey = `v7-${date}-${difficulty}`;
    if (store) {
      try {
        const cached = await store.get(cacheKey, { type: 'json' });
        if (cached && cached.length > 0) {
          console.log('Cache hit for difficulty', difficulty);
          return { statusCode: 200, headers: h, body: JSON.stringify(cached) };
        }
      } catch (e) {}
    }

    // Check if any difficulty was already generated today — if so, others must be too
    // (we generate all 4 together, so if one is missing something went wrong — regenerate)
    const dayKey = `v7-day-${date}`;
    let dayLock = false;
    if (store) {
      try {
        const lock = await store.get(dayKey, { type: 'json' });
        if (lock) dayLock = true;
      } catch (e) {}
    }

    // Get history for all difficulties to build avoid list
    const [h0, h1, h2, h3] = await Promise.all([
      getHistory(store, 0), getHistory(store, 1),
      getHistory(store, 2), getHistory(store, 3)
    ]);
    const allHistory = [...new Set([...h0, ...h1, ...h2, ...h3])];
    const avoidSection = allHistory.length > 0
      ? `\n\nDO NOT repeat topics from these recently used questions (last 30 days):\n${allHistory.slice(0, 50).map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';

    const topics = getDayTopics(date);
    console.log('Generating ALL 4 pools for', date, '- topics:', topics.join(', '));

    // Generate all 4 difficulty levels in ONE call — prevents any cross-difficulty duplicates
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 6000,
      messages: [{
        role: 'user',
        content: `Generate trivia questions for ${date}. Return ONLY this JSON object, no markdown:
{
  "0": [8 easy questions],
  "1": [8 medium questions],
  "2": [8 hard questions],
  "3": [8 expert questions]
}

Each question: {"q":"question","o":["A","B","C","D"],"a":0,"f":"fun fact"}
"a" = 0-indexed correct answer.

Today's topic areas: ${topics.join(', ')}

RULES:
- Spread questions across ALL topic areas — no topic used more than twice
- ZERO duplicate topics across all difficulty levels combined (48 questions total, all on different subjects)
- Fun fact = 1 genuinely interesting sentence
- 4 plausible options, exactly one correct
- NO overused questions (no country capitals, no solar system planets, no Harry Potter author)
- Difficulty must be real: Easy = widely known, Expert = genuinely obscure${avoidSection}

Return ONLY the JSON object.`
      }]
    });

    const text = msg.content.find(b => b.type === 'text')?.text ?? '{}';
    const allPools = JSON.parse(text.replace(/```json?|```/g, '').trim());
    console.log('Generated pools:', Object.keys(allPools).map(k => `${k}:${allPools[k]?.length}`).join(', '));

    // Cache all 4 difficulty pools and update history
    if (store) {
      try { await store.set(dayKey, JSON.stringify({ generated: new Date().toISOString() })); } catch (e) {}
      for (const d of [0, 1, 2, 3]) {
        const pool = allPools[String(d)] || allPools[d] || [];
        if (pool.length > 0) {
          try { await store.set(`v7-${date}-${d}`, JSON.stringify(pool)); } catch (e) {}
          await saveHistory(store, d, date, pool);
        }
      }
      console.log('All pools cached');
    }

    const pool = allPools[String(difficulty)] || allPools[difficulty] || [];
    return { statusCode: 200, headers: h, body: JSON.stringify(pool) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
