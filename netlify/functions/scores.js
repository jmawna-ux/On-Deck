/**
 * On Deck — Scores & Leaderboard API
 *
 * POST { action: 'submit', nickname, score, date }  → save score, return leaderboard
 * POST { action: 'get' }                             → return current month leaderboard
 */

function getBlobs() {
  try { const { getStore } = require('@netlify/blobs'); return getStore('on-deck'); }
  catch (e) { return null; }
}

function monthKey() {
  const d = new Date();
  return `scores-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function gradeFor(r) {
  return r===0?'Three up, three down':r<=2?'Bench Player':r<=4?'Starting Lineup':r<=6?'All-Star':r<=9?'MVP':'World Series Legend';
}

function topScores(scores) {
  // Best score per nickname for the month
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

  const store = getBlobs();
  if (!store) return { statusCode: 200, headers: h, body: JSON.stringify({ leaderboard: [] }) };

  try {
    const { action, nickname, score, date } = JSON.parse(event.body || '{}');
    const key = monthKey();
    let scores = [];
    try { scores = await store.get(key, { type: 'json' }) || []; } catch(e) {}

    if (action === 'submit') {
      if (!nickname || score === undefined) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Missing fields' }) };
      }
      // Replace any previous score from this player today (keep only best per day)
      scores = scores.filter(e => !(e.nickname === nickname && e.date === date));
      scores.push({ nickname: nickname.substring(0, 20).trim(), score, date, ts: Date.now() });
      if (scores.length > 2000) scores = scores.slice(-2000);
      await store.set(key, JSON.stringify(scores));
      const lb = topScores(scores);
      const rank = lb.findIndex(e => e.nickname === nickname) + 1;
      return { statusCode: 200, headers: h, body: JSON.stringify({ leaderboard: lb, rank: rank || null }) };
    }

    if (action === 'get') {
      return { statusCode: 200, headers: h, body: JSON.stringify({ leaderboard: topScores(scores) }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (err) {
    console.error('Scores error:', err.message);
    return { statusCode: 500, headers: h, body: JSON.stringify({ leaderboard: [] }) };
  }
};
