require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const Redis = require('ioredis');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

// Connect to Redis with strict connection limits to prevent app hangs
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false
  });
  redis.on('error', (err) => console.log('Redis notice:', err.message));
}

// ----------------------------------------------------
// Route 1: Live Matches
// ----------------------------------------------------
app.get('/api/fixtures/live', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/fixtures?live=all`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    res.json(response.data.response || []);
  } catch (error) {
    console.error('Live Matches Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch live matches' });
  }
});

// ----------------------------------------------------
// Route 2: Upcoming Matches & Bookmaker Odds
// ----------------------------------------------------
app.get('/api/fixtures/upcoming', async (req, res) => {
  try {
    const cacheKey = 'upcoming_matches_v7';

    // 1. Try Redis Cache
    if (redis) {
      try {
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
          console.log('⚡ Served instantly from Redis Cache!');
          return res.json(JSON.parse(cachedData));
        }
      } catch (cacheErr) {
        console.log('Cache read skipped, fetching fresh data...');
      }
    }

    console.log('📡 Fetching fresh fixture data from API-Football...');

    const today = new Date().toISOString().split('T')[0];
    const tomorrowObj = new Date();
    tomorrowObj.setDate(tomorrowObj.getDate() + 1);
    const tomorrow = tomorrowObj.toISOString().split('T')[0];

    // 2. Fetch Today's Fixtures
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures?date=${today}`, {
      headers: { 'x-apisports-key': API_KEY }
    });

    let fixtures = fixturesRes.data.response || [];

    // If today has very few matches, append tomorrow's matches
    if (fixtures.length < 5) {
      try {
        const tomorrowRes = await axios.get(`${BASE_URL}/fixtures?date=${tomorrow}`, {
          headers: { 'x-apisports-key': API_KEY }
        });
        const tomorrowFixtures = tomorrowRes.data.response || [];
        fixtures = [...fixtures, ...tomorrowFixtures];
      } catch (e) {
        console.log('Tomorrow fixtures fetch skipped');
      }
    }

    // 3. Fetch Today's Bookmaker Odds (Bookmaker 11 = 1xBet)
    let oddsData = [];
    try {
      const oddsRes = await axios.get(`${BASE_URL}/odds?date=${today}&bookmaker=11`, {
        headers: { 'x-apisports-key': API_KEY }
      });
      oddsData = oddsRes.data.response || [];
    } catch (oddsErr) {
      console.log('Odds fetch skipped or limit reached');
    }

    // 4. Combine Fixtures and Odds
    const combinedData = fixtures.map(fixture => {
      const matchOdds = oddsData.find(o => o.fixture.id === fixture.fixture.id);
      let betOdds = null;
      if (matchOdds && matchOdds.bookmakers && matchOdds.bookmakers[0]) {
        // Bet ID 1 = Match Winner (1X2)
        const mainBet = matchOdds.bookmakers[0].bets.find(b => b.id === 1); 
        if (mainBet) betOdds = mainBet.values;
      }
      return { ...fixture, odds: betOdds };
    });

    // 5. Store in Redis Cache for 12 hours (43,200 seconds)
    if (redis && combinedData.length > 0) {
      try {
        await redis.set(cacheKey, JSON.stringify(combinedData), 'EX', 43200);
        console.log(`💾 Successfully cached ${combinedData.length} matches in Upstash Redis!`);
      } catch (err) {
        console.log('Could not write to Redis cache:', err.message);
      }
    }

    res.json(combinedData);
  } catch (error) {
    console.error('Server Request Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch upcoming matches' });
  }
});

// ----------------------------------------------------
// Port Listener (0.0.0.0 binding required for Render)
// ----------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server successfully online on port ${PORT}`);
});

