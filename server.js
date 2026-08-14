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
    const cacheKey = 'upcoming_matches_v3';

    // 1. Check Redis Cache
    if (redis) {
      try {
        const cachedData = await redis.get(cacheKey);
        if (cachedData) {
          console.log('Serving from Redis Cache!');
          return res.json(JSON.parse(cachedData));
        }
      } catch (e) {
        console.log('Redis error, bypassing...');
      }
    }

    console.log('Fetching next 50 fixtures from API-Football...');

    // 2. Fetch Next 50 Fixtures (Guaranteed to work on free tier)
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures?next=50&timezone=Africa/Lagos`, {
      headers: { 'x-apisports-key': API_KEY }
    });

    // Check if API-Football sent an internal error message
    if (fixturesRes.data.errors && Object.keys(fixturesRes.data.errors).length > 0) {
      console.log('API-Football Error:', fixturesRes.data.errors);
    }

    const fixtures = fixturesRes.data.response || [];

    // 3. Fetch Today's Odds
    const today = new Date().toISOString().split('T')[0];
    let oddsData = [];
    try {
      const oddsRes = await axios.get(`${BASE_URL}/odds?date=${today}&bookmaker=11`, {
        headers: { 'x-apisports-key': API_KEY }
      });
      oddsData = oddsRes.data.response || [];
    } catch (oddsErr) {
      console.log('Odds fetch skipped');
    }

    // 4. Combine Fixtures and Odds
    const combinedData = fixtures.map(fixture => {
      const matchOdds = oddsData.find(o => o.fixture.id === fixture.fixture.id);
      let betOdds = null;
      if (matchOdds && matchOdds.bookmakers && matchOdds.bookmakers[0]) {
        const mainBet = matchOdds.bookmakers[0].bets.find(b => b.id === 1); 
        if (mainBet) betOdds = mainBet.values;
      }
      return { ...fixture, odds: betOdds };
    });

    // 5. Save to Cache for 12 hours
    if (redis && combinedData.length > 0) {
      try {
        await redis.set(cacheKey, JSON.stringify(combinedData), 'EX', 43200);
      } catch (err) {
        console.log('Cache set failed');
      }
    }

    res.json(combinedData);
  } catch (error) {
    console.error('Server Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch upcoming matches' });
  }
});
