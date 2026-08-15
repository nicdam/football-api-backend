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
  redis.on('error', () => console.log('Redis notice: connection issue, bypassing cache...'));
}

// --------------------------------------------------
// AI Prediction Algorithm Engine
// --------------------------------------------------
function calculateAIPrediction(homeOdd, drawOdd, awayOdd) {
  if (homeOdd === '-' || drawOdd === '-' || awayOdd === '-') {
    return { pick: 'N/A', pickLabel: 'Insufficient Odds', confidence: '0%', rating: 'LOW', probabilities: null };
  }

  const h = parseFloat(homeOdd);
  const d = parseFloat(drawOdd);
  const a = parseFloat(awayOdd);

  // 1. Calculate raw implied probabilities
  const rawHome = 1 / h;
  const rawDraw = 1 / d;
  const rawAway = 1 / a;

  // 2. Remove bookmaker overround/margin
  const marginSum = rawHome + rawDraw + rawAway;
  const probHome = Math.round((rawHome / marginSum) * 100);
  const probDraw = Math.round((rawDraw / marginSum) * 100);
  const probAway = Math.round((rawAway / marginSum) * 100);

  // 3. Determine AI Predicted Outcome
  let pick = 'X';
  let pickLabel = 'Draw';
  let highestProb = probDraw;

  if (probHome > probAway && probHome > probDraw) {
    pick = '1';
    pickLabel = 'Home Win';
    highestProb = probHome;
  } else if (probAway > probHome && probAway > probDraw) {
    pick = '2';
    pickLabel = 'Away Win';
    highestProb = probAway;
  }

  // 4. Rate Confidence Tier
  let confidenceRating = 'LOW';
  if (highestProb >= 60) confidenceRating = 'HIGH';
  else if (highestProb >= 45) confidenceRating = 'MEDIUM';

  return {
    pick,
    pickLabel,
    confidence: `${highestProb}%`,
    rating: confidenceRating,
    probabilities: { home: probHome, draw: probDraw, away: probAway }
  };
}

// --------------------------------------------------
// Aliased API Routes (Fixes 404 Errors)
// --------------------------------------------------
// Fallback Mock Data for Zero Downtime
const mockMatches = [
  {
    id: 'mock_1',
    sport_title: 'Premier League',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    commence_time: new Date().toISOString(),
    bookmaker: '1xBet',
    odds: { home: '2.10', draw: '3.40', away: '3.60' },
    aiPrediction: calculateAIPrediction('2.10', '3.40', '3.60')
  },
  {
    id: 'mock_2',
    sport_title: 'La Liga',
    home_team: 'Real Madrid',
    away_team: 'Barcelona',
    commence_time: new Date(Date.now() + 7200000).toISOString(),
    bookmaker: 'Bet365',
    odds: { home: '2.25', draw: '3.50', away: '3.10' },
    aiPrediction: calculateAIPrediction('2.25', '3.50', '3.10')
  }
];

app.get(['/api/matches', '/api/fixtures/upcoming', '/api/fixtures/live'], async (req, res) => {
  try {
    const cacheKey = 'sportsbook_ai_matches_v2';

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

    console.log('📡 Fetching odds from The Odds API...');

    // Fetching upcoming matches across major global sports
    const url = `https://api.the-odds-api.com/v4/sports/upcoming/odds/?apiKey=${ODDS_API_KEY}&regions=eu,uk&markets=h2h&dateFormat=iso`;
    const response = await axios.get(url);
    const rawMatches = response.data || [];

    // Filter down specifically to soccer matches
    const soccerMatches = rawMatches.filter(m => m.sport_key && m.sport_key.startsWith('soccer_'));

    let formattedMatches = [];

    if (soccerMatches.length > 0) {
      formattedMatches = soccerMatches.map(match => {
        const bookmaker = match.bookmakers?.find(b => b.key === '1xbet' || b.key === 'bet365') || match.bookmakers?.[0];
        
        let homeOdd = '-';
        let drawOdd = '-';
        let awayOdd = '-';

        if (bookmaker && bookmaker.markets?.[0]) {
          const h2h = bookmaker.markets[0].outcomes || [];
          const home = h2h.find(o => o.name === match.home_team);
          const draw = h2h.find(o => o.name === 'Draw');
          const away = h2h.find(o => o.name === match.away_team);

          if (home) homeOdd = home.price.toFixed(2);
          if (draw) drawOdd = draw.price.toFixed(2);
          if (away) awayOdd = away.price.toFixed(2);
        }

        return {
          id: match.id,
          sport_title: match.sport_title,
          home_team: match.home_team,
          away_team: match.away_team,
          commence_time: match.commence_time,
          bookmaker: bookmaker ? bookmaker.title : 'Market Avg',
          odds: { home: homeOdd, draw: drawOdd, away: awayOdd },
          aiPrediction: calculateAIPrediction(homeOdd, drawOdd, awayOdd)
        };
      });
    }

    // Fallback to sample predictions if API yields no active matches
    const finalData = formattedMatches.length > 0 ? formattedMatches : mockMatches;

    if (redis && finalData.length > 0) {
      try {
        await redis.set(cacheKey, JSON.stringify(finalData), 'EX', 3600);
      } catch (err) {
        console.log('Redis save failed');
      }
    }

    res.json(finalData);
  } catch (error) {
    console.error('Odds API Error:', error.response?.data || error.message);
    // Serve fallback matches on API failure or rate limiting
    res.json(mockMatches);
  }
});
