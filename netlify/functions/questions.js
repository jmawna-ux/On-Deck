const Anthropic = require('@anthropic-ai/sdk');

const DIFF_DESC = [
  'Easy: general knowledge most adults know — history, science, nature, language, arts, food',
  'Medium: requires broader knowledge — historical events, science concepts, literature, technology',
  'Hard: specific detailed facts — exact dates, scientific terms, precise historical details',
  'Expert: deep niche knowledge — etymology, obscure history, scientific nomenclature, rare facts'
];

// Topics to rotate through so questions vary day to day
const TOPIC_SETS = [
  ['ancient history','chemistry','South American geography','classical music','cooking techniques'],
  ['medieval history','biology','African geography','architecture','world languages'],
  ['modern history','physics','Asian geography','literature','mythology'],
  ['American history','astronomy','European geography','visual arts','famous inventions'],
  ['world war history','geology','oceanic geography','film history','mathematics'],
  ['Renaissance history','botany','polar geography','philosophy','famous explorers'],
  ['industrial revolution','zoology','island geography','theatre','medical history'],
];

function getBlobs() {
  try { const { getStore } = require('@netlify/blobs'); return getStore('on-deck'); }
  catch (e) { return null; }
}

function monthKey() {
  const d = new Date();
  return `scores-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  console.log('questions.js called:', new Date().toISOString());

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const store = getBlobs();

  try {
    const { date, difficulty } = JSON.parse(event.body || '{}');

    if (!date || difficulty === undefined) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing date or difficulty' }) };
    }

    const cacheKey = `v5-${date}-${difficulty}`;
    console.log('Cache key:', cacheKey);

    // Return cached questions if available (ensures all players get same questions)
    if (store) {
      try {
        const cached = await store.get(cacheKey, { type: 'json' });
        if (cached && cached.length > 0) {
          console.log('Cache hit:', cached.length, 'questions');
          return { statusCode: 200, headers: h, body: JSON.stringify(cached) };
        }
      } catch (e) { console.log('Cache miss, generating...'); }
    }

    // Pick a topic set based on date so questions vary each day
    const dayNum = parseInt(date) % TOPIC_SETS.length;
    const topics = TOPIC_SETS[dayNum].join(', ');

    console.log('Generating for date:', date, 'difficulty:', difficulty, 'topics:', topics);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      messages: [{
        role: 'user',
        content: `Generate 12 trivia questions for ${date}. Return ONLY a valid JSON array, no markdown:
[{"q":"question text","o":["A","B","C","D"],"a":0,"f":"one interesting fun fact"}]
"a" = 0-indexed correct answer.

Difficulty: ${DIFF_DESC[difficulty]}
Focus topics for today: ${topics}

STRICT RULES:
- All 12 questions must be on DIFFERENT topics
- Fun fact = 1 genuinely interesting sentence about the correct answer
- 4 plausible options, exactly one correct
- NO sports questions
- AVOID these overused questions: capitals of Australia/Canada/Brazil, planets of solar system, who wrote Harry Potter, largest ocean, fastest animal, Mona Lisa painter
- Each question must be clearly different from the others
- Make questions interesting and specific, not generic

Return ONLY the JSON array, nothing else.`
      }]
    });

    const text = msg.content.find(b => b.type === 'text')?.text ?? '[]';
    const questions = JSON.parse(text.replace(/```json?|```/g, '').trim());
    console.log('Generated', questions.length, 'questions');

    // Cache so all players today get same questions
    if (store) {
      try {
        await store.set(cacheKey, JSON.stringify(questions));
        console.log('Cached successfully');
      } catch (e) { console.log('Cache write failed:', e.message); }
    }

    return { statusCode: 200, headers: h, body: JSON.stringify(questions) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
