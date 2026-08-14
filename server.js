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

// Connect to Redis (will fail gracefully if no URL is set)
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

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

// Route 2: Upcoming Matches & 7 Days of Odds with Caching
app.get('/api/fixtures/upcoming', async (req, res) => {
  try {
    const cacheKey = 'upcoming_matches_odds';

    // 1. Check Redis Cache First
    if (redis) {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        console.log('Serving instantly from Redis Cache!');
        return res.json(JSON.parse(cachedData));
      }
    }

    console.log('Cache empty. Fetching 7 days of data from API-Football...');
    
    const today = new Date();
    const datesArray = [];
    
    // Generate the next 7 dates (YYYY-MM-DD)
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(today.getDate() + i);
      datesArray.push(d.toISOString().split('T')[0]);
    }

    const fromDate = datesArray[0];
    const toDate = datesArray[6];

    // 2. Fetch 7 days of fixtures (1 API Request)
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures?from=${fromDate}&to=${toDate}&timezone=Africa/Lagos`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    const fixtures = fixturesRes.data.response || [];

    // 3. Fetch 7 days of Odds concurrently (7 API Requests)
    // Bookmaker 11 is 1xBet. Change to your SportyBet ID if needed!
    const oddsPromises = datesArray.map(date => 
      axios.get(`${BASE_URL}/odds?date=${date}&bookmaker=11`, {
        headers: { 'x-apisports-key': API_KEY }
      })
    );
    
    const oddsResponses = await Promise.all(oddsPromises);
    const oddsData = oddsResponses.flatMap(res => res.data.response || []);

    // 4. Combine fixtures and odds
    const combinedData = fixtures.map(fixture => {
      const matchOdds = oddsData.find(o => o.fixture.id === fixture.fixture.id);
      let betOdds = null;
      if (matchOdds && matchOdds.bookmakers[0]) {
        const mainBet = matchOdds.bookmakers[0].bets.find(b => b.id === 1); 
        if (mainBet) betOdds = mainBet.values;
      }
      return { ...fixture, odds: betOdds };
    });

    // 5. Save to Redis Cache for 12 hours (43200 seconds)
    if (redis) {
      await redis.set(cacheKey, JSON.stringify(combinedData), 'EX', 43200);
    }

    res.json(combinedData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch upcoming matches' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
