const Anthropic = require('@anthropic-ai/sdk');

const DIFF_DESC = [
  'Easy: general knowledge most adults know — geography, famous people, basic science, common history',
  'Medium: requires broader knowledge — historical events, science concepts, literature, technology',
  'Hard: specific detailed facts — exact dates, scientific terms, precise historical details',
  'Expert: deep niche knowledge — etymology, obscure history, scientific nomenclature, rare facts'
];

function getBlobs() {
  try { const { getStore } = require('@netlify/blobs'); return getStore('on-deck'); }
  catch (e) { return null; }
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  console.log('Function called:', new Date().toISOString());

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const store = getBlobs();

  try {
    const body = JSON.parse(event.body || '{}');
    const { date, difficulty } = body;

    if (difficulty === undefined || !date) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing date or difficulty' }) };
    }

    const cacheKey = `v4-${date}-${difficulty}`;
    console.log('Cache key:', cacheKey);

    // Return cached questions if available
    if (store) {
      try {
        const cached = await store.get(cacheKey, { type: 'json' });
        if (cached && cached.length > 0) {
          console.log('Returning', cached.length, 'cached questions');
          return { statusCode: 200, headers: h, body: JSON.stringify(cached) };
        }
      } catch (e) { console.log('Cache miss'); }
    }

    // Generate fresh questions, using date in prompt for daily variety
    console.log('Generating fresh questions for date:', date, 'difficulty:', difficulty);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Today is ${date}. Generate 10 fresh trivia questions for today. Return ONLY a valid JSON array, no markdown:
[{"q":"question text","o":["A","B","C","D"],"a":0,"f":"one fun fact"}]
"a" is the 0-indexed correct answer.
Difficulty: ${DIFF_DESC[difficulty]}
Rules: 4 plausible options, one correct. Fun fact = 1 interesting sentence. Topics: history, science, geography, nature, language, arts, food, technology, mythology. NO sports questions. Vary the topics — avoid common overused questions like capitals of Australia, planets, etc. Return ONLY the JSON array.`
      }]
    });

    const text = msg.content.find(b => b.type === 'text')?.text ?? '[]';
    const questions = JSON.parse(text.replace(/```json?|```/g, '').trim());
    console.log('Generated', questions.length, 'questions');

    // Cache for all players today
    if (store) {
      try { await store.set(cacheKey, JSON.stringify(questions)); console.log('Cached successfully'); }
      catch (e) { console.log('Cache write failed:', e.message); }
    }

    return { statusCode: 200, headers: h, body: JSON.stringify(questions) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
