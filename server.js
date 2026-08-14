require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = 'https://v3.football.api-sports.io';
const headers = {
    'x-apisports-key': API_KEY,
    'x-apisports-host': 'v3.football.api-sports.io'
};

app.get('/api/livescores', async (req, res) => {
    try {
        const response = await axios.get(`${BASE_URL}/fixtures?live=all`, { headers });
        res.json(response.data.response);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching live scores' });
    }
});

app.get('/api/hybrid-prediction/:fixtureId', async (req, res) => {
    try {
        const { fixtureId } = req.params;
        
        // 1. Fetch Built-in API AI Prediction
        const predRes = await axios.get(`${BASE_URL}/predictions?fixture=${fixtureId}`, { headers });
        const apiPrediction = predRes.data.response[0];
        
        // Get Team IDs to query H2H data
        const homeTeamId = apiPrediction.teams.home.id;
        const awayTeamId = apiPrediction.teams.away.id;

        // 2. Fetch Live Match Statistics
        const statsRes = await axios.get(`${BASE_URL}/fixtures/statistics?fixture=${fixtureId}`, { headers });
        const liveStats = statsRes.data.response;

        // 3. Fetch Historical Head-to-Head Data
        const h2hRes = await axios.get(`${BASE_URL}/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}`, { headers });
        const h2hMatches = h2hRes.data.response;

        // --- ALGORITHM STEP A: H2H Calculation ---
        let homeH2HWins = 0;
        let awayH2HWins = 0;
        const totalH2H = h2hMatches.length;

        if (totalH2H > 0) {
            h2hMatches.forEach(match => {
                if (match.teams.home.id === homeTeamId && match.goals.home > match.goals.away) homeH2HWins++;
                else if (match.teams.away.id === homeTeamId && match.goals.away > match.goals.home) homeH2HWins++;
                
                if (match.teams.home.id === awayTeamId && match.goals.home > match.goals.away) awayH2HWins++;
                else if (match.teams.away.id === awayTeamId && match.goals.away > match.goals.home) awayH2HWins++;
            });
        }
        
        const homeH2HRate = totalH2H > 0 ? (homeH2HWins / totalH2H) * 100 : 50;
        const awayH2HRate = totalH2H > 0 ? (awayH2HWins / totalH2H) * 100 : 50;

        // --- ALGORITHM STEP B: Live Momentum Calculation ---
        let liveHome = 50;
        let liveAway = 50;

        if (liveStats && liveStats.length === 2) {
            const getStat = (stats, type) => parseInt(stats.find(s => s.type === type)?.value || 0);
            
            const homePossession = getStat(liveStats[0].statistics, "Ball Possession") || 50;
            const awayPossession = getStat(liveStats[1].statistics, "Ball Possession") || 50;
            const homeShots = getStat(liveStats[0].statistics, "Shots on Goal");
            const awayShots = getStat(liveStats[1].statistics, "Shots on Goal");

            liveHome = (homePossession * 0.6) + (homeShots * 3);
            liveAway = (awayPossession * 0.6) + (awayShots * 3);
            
            const totalLive = liveHome + liveAway;
            liveHome = (liveHome / totalLive) * 100;
            liveAway = (liveAway / totalLive) * 100;
        }

        // --- ALGORITHM STEP C: Blending the Data ---
        const finalHomeProb = ((liveHome * 0.7) + (homeH2HRate * 0.3)).toFixed(1);
        const finalAwayProb = ((liveAway * 0.7) + (awayH2HRate * 0.3)).toFixed(1);

        let momentum = "Balanced";
        if (finalHomeProb > 65) momentum = "Heavy Home Dominance";
        else if (finalAwayProb > 65) momentum = "Heavy Away Dominance";

        // 4. Send Unified Response
        res.json({
            apiAI: {
                winner: apiPrediction?.predictions?.winner?.name || "N/A",
                advice: apiPrediction?.predictions?.advice || "No advice available",
                percent: apiPrediction?.predictions?.percent || { home: "33%", draw: "33%", away: "33%" }
            },
            customLiveEngine: {
                homeWinProb: finalHomeProb,
                awayWinProb: finalAwayProb,
                matchMomentum: momentum,
                h2hData: {
                    matchesPlayed: totalH2H,
                    homeH2HWinRate: homeH2HRate.toFixed(1),
                    awayH2HWinRate: awayH2HRate.toFixed(1)
                }
            }
        });

    } catch (error) {
        console.error("Hybrid Engine Error:", error);
        res.status(500).json({ message: 'Error processing dual engine' });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Dual-Engine Server running on port ${PORT}`));
