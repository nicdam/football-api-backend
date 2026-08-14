require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';

// Route 1: Live Matches
app.get('/api/fixtures/live', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/fixtures?live=all`, {
      headers: { 'x-apisports-key': API_KEY }
    });
    res.json(response.data.response || []);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch live matches' });
  }
});

// Route 2: Upcoming Matches & Betting Odds
app.get('/api/fixtures/upcoming', async (req, res) => {
  try {
    // Calculate dates: Today to 7 days from now
    const today = new Date();
    const nextWeek = new Date();
    nextWeek.setDate(today.getDate() + 7);
    
    const fromDate = today.toISOString().split('T')[0];
    const toDate = nextWeek.toISOString().split('T')[0];

    // Fetch fixtures for the next 7 days
    const fixturesRes = await axios.get(`${BASE_URL}/fixtures?from=${fromDate}&to=${toDate}&timezone=Africa/Lagos`, {
      headers: { 'x-apisports-key': API_KEY }
    });

    // Fetch today's odds. Change bookmaker=11 to your SportyBet ID if needed!
    const oddsRes = await axios.get(`${BASE_URL}/odds?date=${fromDate}&bookmaker=11`, {
      headers: { 'x-apisports-key': API_KEY }
    });

    const oddsData = oddsRes.data.response || [];
    const fixtures = fixturesRes.data.response || [];

    // Match the odds to the correct game
    const combinedData = fixtures.map(fixture => {
      const matchOdds = oddsData.find(o => o.fixture.id === fixture.fixture.id);
      let betOdds = null;
      
      if (matchOdds && matchOdds.bookmakers[0]) {
        // Bet ID 1 is "Match Winner" (Home/Draw/Away)
        const mainBet = matchOdds.bookmakers[0].bets.find(b => b.id === 1); 
        if (mainBet) betOdds = mainBet.values;
      }
      return { ...fixture, odds: betOdds };
    });

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
