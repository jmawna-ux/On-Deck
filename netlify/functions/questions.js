/**
 * On Deck — Question Generation API
 *
 * Always returns ALL 4 difficulty pools in one response.
 * First call of the day generates all 4 in one Claude call (no cross-difficulty duplicates).
 * Subsequent calls return all 4 from cache instantly.
 * Rolling 450-day history prevents question repeats.
 */

const Anthropic = require('@anthropic-ai/sdk');

const ALL_TOPICS = [
  'American history','European history','Asian history','African history',
  'ancient civilizations','medieval history','modern world history',
  'World War history','colonial history','Renaissance history',
  'natural sciences','chemistry','biology and ecology','physics',
  'astronomy and space','geology and earth science','medicine and health',
  'mathematics and logic','technology and inventions',
  'world geography','travel and exploration','natural wonders',
  'art and painting','music and composers','world literature',
  'architecture and design','film and theatre',
  'world religions','philosophy and ideas','mythology and folklore',
  'language and etymology','food and cuisine',
  'sports history and records','animals and wildlife',
  'pop culture and entertainment','politics and world leaders','sports rules and records',
];

const DIFF_DESC = [
  'Easy: well-known facts most educated adults know',
  'Medium: requires broader knowledge and education',
  'Hard: specific facts, exact dates, precise scientific or historical details',
  'Expert: deep niche knowledge, genuinely obscure but accurate facts',
];

function getDayTopics(date) {
  let seed = parseInt(date) >>> 0;
  const rng = () => { seed=(Math.imul(1664525,seed)+1013904223)>>>0; return seed/4294967296; };
  const arr = [...ALL_TOPICS];
  for (let i=arr.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr.slice(0, 8);
}

function getBlobs(event) {
  try {
    const { getStore } = require('@netlify/blobs');
    return getStore({
      name: 'on-deck',
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });
  } catch(e) { return null; }
}

async function getRecentHistory(store) {
  if (!store) return [];
  const all = [];
  await Promise.all([0,1,2,3].map(async d => {
    try {
      const h = await store.get(`history-d${d}`, {type:'json'}) || [];
      all.push(...h.slice(-20).flatMap(e => e.questions));
    } catch(e) {}
  }));
  return [...new Set(all)];
}

async function saveHistory(store, date, pools) {
  if (!store) return;
  await Promise.all([0,1,2,3].map(async d => {
    const pool = pools[d] || [];
    if (!pool.length) return;
    try {
      let hist = [];
      try { hist = await store.get(`history-d${d}`, {type:'json'}) || []; } catch(e) {}
      hist.push({date, questions: pool.map(q=>q.q)});
      if (hist.length > 450) hist = hist.slice(-450);
      await store.set(`history-d${d}`, JSON.stringify(hist));
    } catch(e) {}
  }));
}

exports.handler = async (event) => {
  const h = {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'};
  if (event.httpMethod==='OPTIONS') return {statusCode:200,headers:h,body:''};
  console.log('questions called:', new Date().toISOString());
  if (!process.env.ANTHROPIC_API_KEY) return {statusCode:500,headers:h,body:JSON.stringify({error:'API key not configured'})};

  const store = getBlobs(event);

  try {
    const body = JSON.parse(event.body||'{}');
    const {date, difficulty, overflow} = body;

    // OVERFLOW MODE: generate more questions for one difficulty
    if (overflow && date && difficulty !== undefined) {
      const ovfKey = `v8-ovf-${date}-${difficulty}-${Date.now()}`;
      console.log('Overflow request for difficulty', difficulty);
      const topics = getDayTopics(date);
      const recentQs = await getRecentHistory(store);
      const avoidStr = recentQs.length > 0
        ? '\nAvoid these already-used topics:\n' + recentQs.slice(0,30).map((q,i) => (i+1) + '. ' + q).join('\n')
        : '';
      const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
      const prompt = 'Generate 10 more trivia questions for ' + date + '. Return ONLY a JSON array:\n[{"q":"?","o":["A","B","C","D"],"a":0,"f":"fun fact"}]\nDifficulty: ' + DIFF_DESC[difficulty] + '\nTopics: ' + topics.join(', ') + '\nRules: unique subjects, genuinely interesting, not overused.' + avoidStr + '\nReturn ONLY the JSON array.';
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{role:'user', content: prompt}]
      });
      const text = msg.content.find(b=>b.type==='text')?.text ?? '[]';
      const questions = JSON.parse(text.replace(/```json?|```/g,'').trim());
      console.log('Overflow generated', questions.length, 'questions');
      await saveHistory(store, date, {0:[],1:[],2:[],3:[],...{[difficulty]:questions}});
      return {statusCode:200,headers:h,body:JSON.stringify(questions)};
    }

    if (!date) return {statusCode:400,headers:h,body:JSON.stringify({error:'Missing date'})};

    // Try to load all 4 pools from cache
    const pools = {};
    if (store) {
      await Promise.all([0,1,2,3].map(async d => {
        try {
          const c = await store.get(`v8-${date}-${d}`, {type:'json'});
          if (c?.length) pools[d] = c;
        } catch(e) {}
      }));
    }

    // If all 4 cached, return immediately
    if ([0,1,2,3].every(d => pools[d]?.length)) {
      console.log('All 4 pools from cache');
      return {statusCode:200,headers:h,body:JSON.stringify(pools)};
    }

    // Generate all 4 in one call (guarantees no cross-difficulty duplicates)
    const topics = getDayTopics(date);
    const recentQs = await getRecentHistory(store);
    const avoidStr = recentQs.length > 0
      ? `\n\nDO NOT repeat topics from these recently used questions:\n${recentQs.slice(0,40).map((q,i)=>`${i+1}. ${q}`).join('\n')}`
      : '';

    console.log('Generating all 4 pools for', date, '- topics:', topics.join(', '));

    const client = new Anthropic({apiKey: process.env.ANTHROPIC_API_KEY});
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 7000,
      messages: [{
        role: 'user',
        content: `Generate trivia questions for ${date}. Return ONLY this JSON object, no markdown:
{"0":[15 easy],"1":[10 medium],"2":[10 hard],"3":[10 expert]}

Each question: {"q":"?","o":["A","B","C","D"],"a":0,"f":"fun fact"}
"a" = 0-indexed correct answer.

Difficulty levels:
0 (Easy): ${DIFF_DESC[0]}
1 (Medium): ${DIFF_DESC[1]}
2 (Hard): ${DIFF_DESC[2]}
3 (Expert): ${DIFF_DESC[3]}

Today's topics: ${topics.join(', ')}

STRICT RULES:
- 45 questions total — every question on a UNIQUE subject (no topic repeats across all difficulty levels)
- Spread questions across all 8 topic areas
- Fun fact = 1 genuinely interesting sentence
- 4 plausible options, exactly one correct
- NO overused questions — especially for easy: no country capitals, no solar system planets, no Harry Potter, no "fastest animal", no "largest ocean", no "who painted the Mona Lisa", no "what year did X happen" for famous events everyone knows
- For easy questions specifically: find genuinely interesting facts that most people know but don't get asked about often — food origins, animal behaviors, historical firsts, word origins, geography surprises
- Difficulty must be real — Easy widely known, Expert genuinely obscure${avoidStr}

Return ONLY the JSON object.`
      }]
    });

    const text = msg.content.find(b=>b.type==='text')?.text ?? '{}';
    const newPools = JSON.parse(text.replace(/```json?|```/g,'').trim());
    console.log('Generated:', Object.keys(newPools).map(k=>`${k}:${newPools[k]?.length}`).join(', '));

    // Normalise keys to numbers and cache
    for (const d of [0,1,2,3]) {
      const pool = newPools[String(d)] || newPools[d] || [];
      if (pool.length) {
        pools[d] = pool;
        if (store) { try { await store.set(`v8-${date}-${d}`, JSON.stringify(pool)); } catch(e) {} }
      }
    }

    // Save to rolling history
    await saveHistory(store, date, pools);

    console.log('Done. Returning all pools.');
    return {statusCode:200,headers:h,body:JSON.stringify(pools)};

  } catch(err) {
    console.error('Error:', err.message);
    return {statusCode:500,headers:h,body:JSON.stringify({error:err.message})};
  }
};
