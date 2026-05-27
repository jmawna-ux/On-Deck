/**
 * On Deck — Scores & Leaderboard
 * Uses a dedicated 'on-deck-scores' Blobs store
 */

function monthKey() {
  const d = new Date();
  return `scores-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function gradeFor(r) {
  if (r===0) return 'Three up, three down';
  if (r<=2) return 'Bench Player';
  if (r<=4) return 'Starting Lineup';
  if (r<=6) return 'All-Star';
  if (r<=9) return 'MVP';
  return 'World Series Legend';
}

function topScores(scores) {
  const best = {};
  for (const e of scores) {
    const nick = e.nickname;
    if (!best[nick] || e.score > best[nick].score || (e.score === best[nick].score && e.ts < best[nick].ts)) {
      best[nick] = e;
    }
  }
  return Object.values(best)
    .sort((a, b) => b.score - a.score || a.ts - b.ts)
    .slice(0, 10)
    .map((e, i) => ({ rank: i+1, nickname: e.nickname, score: e.score, grade: gradeFor(e.score) }));
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: h, body: '' };

  console.log('scores called:', new Date().toISOString());

  // Get Blobs store — use dedicated store name for scores
  let store = null;
  try {
    const blobs = require('@netlify/blobs');
    console.log('blobs keys:', Object.keys(blobs).join(','));
    store = blobs.getStore('on-deck-scores');
    console.log('store created:', !!store);
  } catch(e) {
    console.error('Blobs init error:', e.message);
  }

  try {
    const { action, nickname, score, date } = JSON.parse(event.body || '{}');
    console.log('action:', action, 'nickname:', nickname, 'score:', score);

    const key = monthKey();
    console.log('month key:', key, 'store available:', !!store);

    let scores = [];
    if (store) {
      try {
        scores = await store.get(key, { type: 'json' }) || [];
        console.log('loaded scores:', scores.length);
      } catch(e) {
        console.log('get failed (first time is ok):', e.message);
      }
    }

    if (action === 'submit') {
      if (!nickname || score === undefined) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing fields' }) };
      }
      scores = scores.filter(e => !(e.nickname === nickname && e.date === date));
      scores.push({ nickname: nickname.substring(0, 20).trim(), score, date, ts: Date.now() });
      if (scores.length > 2000) scores = scores.slice(-2000);

      if (store) {
        try {
          await store.set(key, JSON.stringify(scores));
          console.log('saved scores:', scores.length);
        } catch(e) {
          console.error('save failed:', e.message);
        }
      }

      const lb = topScores(scores);
      const rank = lb.findIndex(e => e.nickname === nickname) + 1;
      console.log('leaderboard size:', lb.length, 'rank:', rank);
      return { statusCode: 200, headers: h, body: JSON.stringify({ leaderboard: lb, rank: rank || null }) };
    }

    if (action === 'get') {
      const lb = topScores(scores);
      console.log('get leaderboard size:', lb.length);
      return { statusCode: 200, headers: h, body: JSON.stringify({ leaderboard: lb }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (err) {
    console.error('Handler error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ leaderboard: [] }) };
  }
};
