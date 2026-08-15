require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const Redis = require('ioredis');

const app = express();
app.use(cors());
app.use(express.json());

const ODDS_API_KEY = process.env.ODDS_API_KEY;

// Redis Setup
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false
  });
  redis.on('error', () => console.log('Redis issue, bypassing cache...'));
}

// --------------------------------------------------
// AI Prediction Algorithm Engine
// --------------------------------------------------
function calculateAIPrediction(homeOdd, drawOdd, awayOdd) {
  if (homeOdd === '-' || drawOdd === '-' || awayOdd === '-') {
    return { predictedWinner: 'N/A', confidence: '0%', valueBet: null };
  }

  const h = parseFloat(homeOdd);
  const d = parseFloat(drawOdd);
  const a = parseFloat(awayOdd);

  // 1. Calculate raw implied probabilities (1 / decimal odd)
  const rawHome = 1 / h;
  const rawDraw = 1 / d;
  const rawAway = 1 / a;

  // 2. Remove bookmaker overround/margin
  const marginSum = rawHome + rawDraw + rawAway;
  const probHome = Math.round((rawHome / marginSum) * 100);
  const probDraw = Math.round((rawDraw / marginSum) * 100);
  const probAway = Math.round((rawAway / marginSum) * 100);

  // 3. Determine AI Predicted Outcome & Confidence
  let pick = 'Draw';
  let highestProb = probDraw;
  let recommendedPick = 'X';

  if (probHome > probAway && probHome > probDraw) {
    pick = 'Home Win';
    highestProb = probHome;
    recommendedPick = '1';
  } else if (probAway > probHome && probAway > probDraw) {
    pick = 'Away Win';
    highestProb = probAway;
    recommendedPick = '2';
  }

  // 4. Rate Confidence Tier
  let confidenceRating = 'LOW';
  if (highestProb >= 60) confidenceRating = 'HIGH';
  else if (highestProb >= 45) confidenceRating = 'MEDIUM';

  return {
    pick: recommendedPick,
    pickLabel: pick,
    confidence: `${highestProb}%`,
    rating: confidenceRating,
    probabilities: { home: probHome, draw: probDraw, away: probAway }
  };
}

// --------------------------------------------------
// API Route
// --------------------------------------------------
app.get(['/api/matches', '/api/fixtures/upcoming', '/api/fixtures/live'], async (req, res) => { })
  try {
    const cacheKey = 'sportsbook_ai_matches_v1';

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          console.log('⚡ Served instantly from Redis Cache!');
          return res.json(JSON.parse(cached));
        }
      } catch (e) {
        console.log('Cache read skipped...');
      }
    }

    console.log('📡 Fetching odds and computing AI predictions...');

    const url = `https://api.the-odds-api.com/v4/sports/soccer/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h&dateFormat=iso`;
    const response = await axios.get(url);
    const rawMatches = response.data || [];

    const formattedMatches = rawMatches.map(match => {
      const bookmaker = match.bookmakers.find(b => b.key === '1xbet' || b.key === 'bet365') || match.bookmakers[0];
      
      let homeOdd = '-';
      let drawOdd = '-';
      let awayOdd = '-';

      if (bookmaker && bookmaker.markets[0]) {
        const h2h = bookmaker.markets[0].outcomes;
        const home = h2h.find(o => o.name === match.home_team);
        const draw = h2h.find(o => o.name === 'Draw');
        const away = h2h.find(o => o.name === match.away_team);

        if (home) homeOdd = home.price.toFixed(2);
        if (draw) drawOdd = draw.price.toFixed(2);
        if (away) awayOdd = away.price.toFixed(2);
      }

      // Compute AI Prediction
      const ai = calculateAIPrediction(homeOdd, drawOdd, awayOdd);

      return {
        id: match.id,
        sport_title: match.sport_title,
        home_team: match.home_team,
        away_team: match.away_team,
        commence_time: match.commence_time,
        bookmaker: bookmaker ? bookmaker.title : 'Market Avg',
        odds: { home: homeOdd, draw: drawOdd, away: awayOdd },
        aiPrediction: ai
      };
    });

    if (redis && formattedMatches.length > 0) {
      try {
        await redis.set(cacheKey, JSON.stringify(formattedMatches), 'EX', 10800);
        console.log(`💾 Cached ${formattedMatches.length} AI-analyzed matches in Redis!`);
      } catch (err) {
        console.log('Redis save failed');
      }
    }

    res.json(formattedMatches);
  } catch (error) {
    console.error('Server Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch AI matches' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
