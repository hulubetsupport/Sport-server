// ==========================================
// HULU BET V2.1 - API-FOOTBALL 30-MIN CACHE ENGINE
// ==========================================
let sportsCache = {
  timestamp: 0,
  fixtures: []
};

app.get('/api/sports/fixtures', async (req, res) => {
  const now = Date.now();
  const CACHE_DURATION = 30 * 60 * 1000; // 30 ደቂቃ

  // 1. በ 30 ደቂቃ ውስጥ የተጠራ ከሆነ ከሜሞሪ ወዲያውኑ ይሰጣል (API ጥሪ አያባክንም)
  if (sportsCache.fixtures.length > 0 && (now - sportsCache.timestamp < CACHE_DURATION) && !req.query.force) {
    return res.json({ success: true, source: 'cache', fixtures: sportsCache.fixtures });
  }

  // 2. 30 ደቂቃ ካለፈው ከ API-Sports ያመጣል
  try {
    const apiKey = process.env.API_SPORTS_KEY || '9201e851db753c937fd...'; // ያንተ API KEY
    // የፕሪሚየር ሊግ (League 39) ቀጣይ 10 ጨዋታዎችን ይጠራል
    const response = await fetch('https://v3.football.api-sports.io/fixtures?league=39&next=10', {
      headers: {
        'x-apisports-key': apiKey
      }
    });
    const data = await response.json();

    if (data.response && data.response.length > 0) {
      const formatted = data.response.map(item => ({
        id: 'api-' + item.fixture.id,
        league: item.league.name,
        home: item.teams.home.name,
        away: item.teams.away.name,
        homeLogo: item.teams.home.logo,
        awayLogo: item.teams.away.logo,
        time: new Date(item.fixture.date).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
        odds: {
          '1': Number((1.60 + Math.random() * 1.5).toFixed(2)),
          'X': Number((3.10 + Math.random() * 0.8).toFixed(2)),
          '2': Number((2.10 + Math.random() * 2.2).toFixed(2))
        }
      }));

      sportsCache = {
        timestamp: now,
        fixtures: formatted
      };

      return res.json({ success: true, source: 'api-sports', fixtures: formatted });
    }
    
    // APIው ላይ ችግር ቢፈጠር ያለውን Cache ይሰጣል
    return res.json({ success: true, source: 'fallback', fixtures: sportsCache.fixtures });
  } catch (error) {
    return res.json({ success: true, source: 'fallback', fixtures: sportsCache.fixtures });
  }
});
