const Anthropic = require('@anthropic-ai/sdk');

const DIFF_DESC = [
  'Easy: general knowledge most adults know — geography, famous people, basic science, common history',
  'Medium: requires broader knowledge — historical events, science concepts, literature, technology',
  'Hard: specific detailed facts — exact dates, scientific terms, precise historical details',
  'Expert: deep niche knowledge — etymology, obscure history, scientific nomenclature, rare facts'
];

exports.handler = async (event) => {
  const h = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  console.log('Function called:', new Date().toISOString());

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set');
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const difficulty = body.difficulty;

    console.log('Generating difficulty:', difficulty);

    if (difficulty === undefined || difficulty === null) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing difficulty' }) };
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Generate 10 trivia questions. Return ONLY a valid JSON array, no markdown or extra text:
[{"q":"question text","o":["A","B","C","D"],"a":0,"f":"one fun fact"}]
"a" is the 0-indexed correct answer.
Difficulty: ${DIFF_DESC[difficulty]}
Rules: 4 plausible options, one correct. Fun fact = 1 interesting sentence. Topics: history, science, geography, nature, language, arts, food, technology, mythology. NO sports questions. Return ONLY the JSON array.`
      }]
    });

    const text = msg.content.find(b => b.type === 'text')?.text ?? '[]';
    console.log('Raw response length:', text.length);

    const clean = text.replace(/```json?|```/g, '').trim();
    const questions = JSON.parse(clean);

    console.log('Generated', questions.length, 'questions for difficulty', difficulty);

    return { statusCode: 200, headers: h, body: JSON.stringify(questions) };

  } catch (err) {
    console.error('Error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: err.message }) };
  }
};
