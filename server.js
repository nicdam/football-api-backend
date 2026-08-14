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

// Connect to Redis with a 3-second connection timeout so it NEVER freezes the app
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false
  });
  redis.on('error', (err) => console.log('Redis connection issue, bypassing cache...'));
}

// Route 1: Live Matches
app.get('/api/fixtures/live', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/fixtures?live=all`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    res.json(response.data.response || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch live matches' });
  }
});

// Route 2: Upcoming Matches & Odds
app.get('/api/fixtures/upcoming', async (req, res) => {
  try {
    const cacheKey = 'upcoming_matches_odds_v2';

    // 1. Try Redis Cache
    if (redis) {
      try {
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
          console.log('Serving from Redis!');
          return res.json(JSON.parse(cachedData));
        }
      } catch (cacheErr) {
        console.log('Cache read error, fetching directly from API...');
      }
    }

    console.log('Fetching fresh data from API-Football...');
    
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);

    const fromDate = today.toISOString().split('T')[0];
    const toDate = nextWeek.toISOString().split('T')[0];

    // 2. Fetch Fixtures
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures?from=${fromDate}&to=${toDate}&timezone=Africa/Lagos`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    const fixtures = fixturesRes.data.response || [];

    // 3. Fetch Today's Odds safely
    let oddsData = [];
    try {
      const oddsRes = await axios.get(`${BASE_URL}/odds?date=${fromDate}&bookmaker=11`, {
        headers: { 'x-apisports-key': API_KEY }
      });
      oddsData = oddsRes.data.response || [];
    } catch (oddsErr) {
      console.log('Odds fetch skipped due to rate limit/error');
    }

    // 4. Combine Fixtures and Odds
    const combinedData = fixtures.map(fixture => {
      const matchOdds = oddsData.find(o => o.fixture.id === fixture.fixture.id);
      let betOdds = null;
      if (matchOdds && matchOdds.bookmakers[0]) {
        const mainBet = matchOdds.bookmakers[0].bets.find(b => b.id === 1); 
        if (mainBet) betOdds = mainBet.values;
      }
      return { ...fixture, odds: betOdds };
    });

    // 5. Save to Redis Cache (12 hours)
    if (redis) {
      try {
        await redis.set(cacheKey, JSON.stringify(combinedData), 'EX', 43200);
      } catch (err) {
        console.log('Could not save to cache');
      }
    }

    res.json(combinedData);
  } catch (error) {
    console.error('Server Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch upcoming matches' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
