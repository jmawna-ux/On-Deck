/**
 * On Deck — Question Generation API
 * - 34 topic categories rotating daily (seeded shuffle ensures same topics for all players)
 * - Rolling 30-day question history stored in Blobs so recent questions are explicitly avoided
 * - Cross-difficulty deduplication within a day
 * - Target: no question repeats for 450+ days
 */

const Anthropic = require('@anthropic-ai/sdk');

// 34 diverse topic categories including user-requested additions
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

const DIFF_DESC = [
  'Easy: well-known facts most educated adults would know',
  'Medium: requires broader knowledge and education',
  'Hard: specific facts, exact dates, precise details',
  'Expert: deep niche knowledge, obscure but accurate facts',
];

// Deterministic daily topic selection — same for all players, changes every day
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
  return arr.slice(0, 6); // 6 topics per day for variety
}

function getBlobs() {
  try { const { getStore } = require('@netlify/blobs'); return getStore('on-deck'); }
  catch (e) { return null; }
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  console.log('questions called:', new Date().toISOString());

  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  const store = getBlobs();

  try {
    const { date, difficulty } = JSON.parse(event.body || '{}');
    if (!date || difficulty === undefined) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing date or difficulty' }) };
    }

    const cacheKey = `v6-${date}-${difficulty}`;

    // Serve from cache if available (ensures all players get same questions today)
    if (store) {
      try {
        const cached = await store.get(cacheKey, { type: 'json' });
        if (cached && cached.length > 0) {
          console.log('Cache hit:', cached.length, 'questions');
          return { statusCode: 200, headers: h, body: JSON.stringify(cached) };
        }
      } catch (e) { console.log('Cache miss'); }
    }

    // Get today's topic rotation
    const todayTopics = getDayTopics(date);
    console.log('Topics for', date, ':', todayTopics.join(', '));

    // Load recent question history to avoid repeats (last 30 days)
    let recentQuestions = [];
    if (store) {
      try {
        const histKey = `history-d${difficulty}`;
        const hist = await store.get(histKey, { type: 'json' }) || [];
        // Get questions from last 30 days (excluding today)
        recentQuestions = hist
          .filter(e => e.date !== date)
          .slice(-30)
          .flatMap(e => e.questions);
        console.log('Avoiding', recentQuestions.length, 'recent questions');
      } catch (e) { console.log('No history yet'); }
    }

    // Load questions from other difficulties today to avoid cross-difficulty repeats
    const crossDiffQuestions = [];
    if (store) {
      for (const d of [0, 1, 2, 3]) {
        if (d === difficulty) continue;
        try {
          const other = await store.get(`v6-${date}-${d}`, { type: 'json' });
          if (other) crossDiffQuestions.push(...other.map(q => q.q));
        } catch (e) {}
      }
    }

    // Build the avoid list for the prompt
    const allAvoid = [...recentQuestions, ...crossDiffQuestions];
    const avoidSection = allAvoid.length > 0
      ? `\n\nDO NOT use questions on the same topic as any of these recently used questions:\n${allAvoid.slice(0, 40).map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : '';

    console.log('Generating questions...');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Generate 12 trivia questions for ${date}. Return ONLY a valid JSON array, no markdown:
[{"q":"question text","o":["A","B","C","D"],"a":0,"f":"one fun fact"}]
"a" = 0-indexed correct answer.

Difficulty: ${DIFF_DESC[difficulty]}
Today's topic areas: ${todayTopics.join(', ')}

RULES:
- Cover all of today's topic areas — 2 questions per topic area
- All questions on different specific subjects within those topics
- Fun fact = 1 genuinely interesting sentence about the correct answer
- 4 plausible options, exactly one correct
- NO simple, generic, or overused trivia — be specific and interesting
- Questions at harder levels must be genuinely harder (not just obscure phrasing of easy facts)${avoidSection}

Return ONLY the JSON array.`
      }]
    });

    const text = msg.content.find(b => b.type === 'text')?.text ?? '[]';
    const questions = JSON.parse(text.replace(/```json?|```/g, '').trim());
    console.log('Generated', questions.length, 'questions');

    // Cache today's questions for all players
    if (store) {
      try {
        await store.set(cacheKey, JSON.stringify(questions));

        // Update rolling history for this difficulty
        const histKey = `history-d${difficulty}`;
        let hist = [];
        try { hist = await store.get(histKey, { type: 'json' }) || []; } catch (e) {}
        hist.push({ date, questions: questions.map(q => q.q) });
        if (hist.length > 450) hist = hist.slice(-450); // keep 450 days
        await store.set(histKey, JSON.stringify(hist));
        console.log('Cached and history updated');
      } catch (e) { console.log('Cache write failed:', e.message); }
    }

    return { statusCode: 200, headers: h, body: JSON.stringify(questions) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
