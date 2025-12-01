const puppeteer = require('puppeteer-core');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// =============================================
// FLIFF BOT WITH LIVE DASHBOARD
// =============================================

class FliffBot {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.messageCount = 0;
    this.liveGames = new Map();
    this.upcomingGames = new Map();
    this.odds = new Map();
    this.settings = this.loadSettings();
    this.wsClients = new Set();
    
    this.setupServer();
  }

  loadSettings() {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, 'profiles', 'ray', 'settings.json'), 'utf8'));
    } catch {
      return { proxy: 'Yd0IwkF5:wWXhE4@156.228.210.149:6666', name: 'Default' };
    }
  }

  parseProxy(proxyString) {
    const match = proxyString?.match(/(.+):(.+)@(.+):(\d+)/);
    if (match) return { username: match[1], password: match[2], host: match[3], port: match[4] };
    return null;
  }

  decode(base64Data) {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      return JSON.parse(zlib.inflateSync(buffer).toString('utf8'));
    } catch {
      try {
        return JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8'));
      } catch {
        return null;
      }
    }
  }

  setupServer() {
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // Dashboard HTML
    app.get('/', (req, res) => {
      res.send(this.getDashboardHTML());
    });

    // API endpoints
    app.get('/api/live', (req, res) => {
      res.json(Array.from(this.liveGames.values()));
    });

    app.get('/api/odds', (req, res) => {
      res.json(Array.from(this.odds.values()).filter(o => o.event));
    });

    app.get('/api/status', (req, res) => {
      res.json({
        connected: !!this.browser,
        messages: this.messageCount,
        liveGames: this.liveGames.size,
        odds: this.odds.size,
        user: this.settings.name
      });
    });

    // Place bet endpoint
    app.post('/api/bet', async (req, res) => {
      const { selection, odds, amount } = req.body;
      try {
        const result = await this.placeBet(selection, odds, amount);
        res.json(result);
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // WebSocket for real-time updates
    wss.on('connection', (ws) => {
      this.wsClients.add(ws);
      // Send current state
      ws.send(JSON.stringify({
        type: 'init',
        liveGames: Array.from(this.liveGames.values()),
        odds: Array.from(this.odds.values()).filter(o => o.event)
      }));
      
      ws.on('close', () => this.wsClients.delete(ws));
    });

    const PORT = 3000;
    server.listen(PORT, () => {
      console.log(`\n🌐 Dashboard: http://localhost:${PORT}`);
    });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    this.wsClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  }

  async placeBet(selection, odds, amount) {
    if (!this.page) throw new Error('Browser not connected');
    
    console.log(`\n💰 Placing bet: ${selection} @ ${odds} - $${amount}`);
    
    // This will click on the bet in the browser
    // You'll need to adjust selectors based on Fliff's actual UI
    try {
      // Search for the selection and click it
      await this.page.evaluate((sel) => {
        const elements = document.querySelectorAll('[class*="proposal"], [class*="odd"], [class*="bet"]');
        for (const el of elements) {
          if (el.textContent.includes(sel)) {
            el.click();
            return true;
          }
        }
        return false;
      }, selection);
      
      return { success: true, message: `Bet slip opened for ${selection}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  getDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Fliff Live Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
    }
    
    .header {
      background: rgba(0,0,0,0.3);
      padding: 15px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    
    .header h1 {
      font-size: 24px;
      background: linear-gradient(90deg, #00d4ff, #00ff88);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    
    .status {
      display: flex;
      gap: 20px;
      font-size: 14px;
    }
    
    .status-item {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #00ff88;
      animation: pulse 2s infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .container {
      padding: 20px;
      max-width: 1400px;
      margin: 0 auto;
    }
    
    .section-title {
      font-size: 18px;
      margin-bottom: 15px;
      color: #00d4ff;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    
    .games-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 15px;
      margin-bottom: 30px;
    }
    
    .game-card {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 15px;
      border: 2px solid rgba(255,255,255,0.1);
      cursor: pointer;
      transition: all 0.3s;
    }
    
    .game-card:hover {
      border-color: #00d4ff;
      transform: translateY(-2px);
      box-shadow: 0 5px 20px rgba(0,212,255,0.3);
    }
    
    .game-card.selected {
      border-color: #00ff88;
      background: rgba(0,255,136,0.1);
    }
    
    .game-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    
    .game-status {
      background: #ff4444;
      color: white;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
      animation: blink 1s infinite;
    }
    
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    
    .teams {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .team {
      text-align: center;
      flex: 1;
    }
    
    .team-name {
      font-size: 13px;
      margin-bottom: 5px;
      color: #ccc;
    }
    
    .team-score {
      font-size: 32px;
      font-weight: bold;
      color: #fff;
    }
    
    .vs {
      color: #666;
      font-size: 14px;
      padding: 0 15px;
    }
    
    .selected-game-panel {
      background: rgba(0,0,0,0.3);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
      border: 1px solid rgba(0,255,136,0.3);
    }
    
    .selected-game-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    
    .selected-game-title {
      font-size: 20px;
      color: #00ff88;
    }
    
    .close-btn {
      background: transparent;
      border: 1px solid #ff4444;
      color: #ff4444;
      padding: 5px 15px;
      border-radius: 5px;
      cursor: pointer;
    }
    
    .close-btn:hover {
      background: #ff4444;
      color: #fff;
    }
    
    .odds-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
    }
    
    .odd-card {
      background: rgba(0,212,255,0.1);
      border: 1px solid rgba(0,212,255,0.3);
      border-radius: 8px;
      padding: 12px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
    }
    
    .odd-card:hover {
      background: rgba(0,212,255,0.3);
      border-color: #00d4ff;
    }
    
    .odd-card.up { border-color: #00ff88; background: rgba(0,255,136,0.1); }
    .odd-card.down { border-color: #ff4444; background: rgba(255,68,68,0.1); }
    
    .odd-market {
      font-size: 11px;
      color: #888;
      margin-bottom: 4px;
    }
    
    .odd-selection {
      font-size: 13px;
      color: #fff;
      margin-bottom: 6px;
    }
    
    .odd-value {
      font-size: 20px;
      font-weight: bold;
    }
    
    .odd-value.positive { color: #00ff88; }
    .odd-value.negative { color: #ff4444; }
    
    .odd-change {
      font-size: 11px;
      margin-top: 4px;
    }
    
    .no-data {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    
    .change-up { color: #00ff88; }
    .change-down { color: #ff4444; }
    
    .instructions {
      text-align: center;
      padding: 30px;
      color: #666;
      font-size: 16px;
    }
    
    .instructions span {
      color: #00d4ff;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>⚡ Fliff Live Dashboard</h1>
    <div class="status">
      <div class="status-item">
        <div class="status-dot"></div>
        <span id="connection-status">Connected</span>
      </div>
      <div class="status-item">
        <span>🎮 <span id="games-count">0</span> live</span>
      </div>
      <div class="status-item">
        <span>📨 <span id="msg-count">0</span> msgs</span>
      </div>
    </div>
  </div>
  
  <div class="container">
    <h2 class="section-title">🔴 LIVE GAMES - Click to view odds</h2>
    <div id="live-games" class="games-grid">
      <div class="no-data">Waiting for live games...</div>
    </div>
    
    <div id="selected-panel" style="display: none;">
      <div class="selected-game-panel">
        <div class="selected-game-header">
          <div class="selected-game-title" id="selected-title">Game Odds</div>
          <button class="close-btn" onclick="clearSelection()">✕ Close</button>
        </div>
        <div id="game-odds" class="odds-grid">
          <div class="no-data">Loading odds...</div>
        </div>
      </div>
    </div>
    
    <div id="instructions" class="instructions">
      👆 Click on a <span>LIVE GAME</span> above to see its betting lines
    </div>
  </div>
  
  <script>
    let ws;
    let liveGames = {};
    let allOdds = {};
    let selectedGame = null;
    let msgCount = 0;
    
    function connect() {
      ws = new WebSocket('ws://localhost:3000');
      
      ws.onopen = () => {
        document.getElementById('connection-status').textContent = 'Connected';
      };
      
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        
        if (data.type === 'init') {
          data.liveGames.forEach(g => liveGames[g.id] = g);
          data.odds.forEach(o => { if(o.event) allOdds[o.id] = o; });
          renderGames();
          if (selectedGame) renderSelectedGameOdds();
        }
        
        if (data.type === 'games') {
          data.games.forEach(g => liveGames[g.id] = g);
          renderGames();
        }
        
        if (data.type === 'odds') {
          data.updates.forEach(o => { if(o.event) allOdds[o.id] = o; });
          if (selectedGame) renderSelectedGameOdds();
        }
        
        if (data.type === 'stats') {
          msgCount = data.messages;
          document.getElementById('msg-count').textContent = msgCount;
        }
      };
      
      ws.onclose = () => {
        document.getElementById('connection-status').textContent = 'Disconnected';
        setTimeout(connect, 3000);
      };
    }
    
    function selectGame(gameId) {
      selectedGame = liveGames[gameId];
      document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
      document.querySelector('[data-game-id="' + gameId + '"]')?.classList.add('selected');
      document.getElementById('selected-panel').style.display = 'block';
      document.getElementById('instructions').style.display = 'none';
      document.getElementById('selected-title').textContent = selectedGame.home + ' vs ' + selectedGame.away;
      renderSelectedGameOdds();
    }
    
    function clearSelection() {
      selectedGame = null;
      document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
      document.getElementById('selected-panel').style.display = 'none';
      document.getElementById('instructions').style.display = 'block';
    }
    
    function renderGames() {
      const container = document.getElementById('live-games');
      const games = Object.values(liveGames);
      
      document.getElementById('games-count').textContent = games.length;
      
      if (games.length === 0) {
        container.innerHTML = '<div class="no-data">No live games right now</div>';
        return;
      }
      
      container.innerHTML = games.map(g => \`
        <div class="game-card \${selectedGame?.id === g.id ? 'selected' : ''}" 
             data-game-id="\${g.id}" 
             onclick="selectGame(\${g.id})">
          <div class="game-header">
            <span>\${g.status || 'LIVE'}</span>
            <span class="game-status">🔴 LIVE</span>
          </div>
          <div class="teams">
            <div class="team">
              <div class="team-name">\${g.home}</div>
              <div class="team-score">\${g.homeScore}</div>
            </div>
            <div class="vs">VS</div>
            <div class="team">
              <div class="team-name">\${g.away}</div>
              <div class="team-score">\${g.awayScore}</div>
            </div>
          </div>
        </div>
      \`).join('');
    }
    
    function renderSelectedGameOdds() {
      if (!selectedGame) return;
      
      const container = document.getElementById('game-odds');
      const gameName = selectedGame.home + ' vs ' + selectedGame.away;
      
      // Filter odds for this game only
      const gameOdds = Object.values(allOdds)
        .filter(o => o.event && o.event.includes(selectedGame.home.split(' ')[0]) || 
                     o.event && o.event.includes(selectedGame.away.split(' ')[0]) ||
                     o.selection && o.selection.includes(selectedGame.home.split(' ')[0]) ||
                     o.selection && o.selection.includes(selectedGame.away.split(' ')[0]))
        .sort((a, b) => (a.market || '').localeCompare(b.market || ''));
      
      if (gameOdds.length === 0) {
        container.innerHTML = '<div class="no-data">No odds available for this game yet</div>';
        return;
      }
      
      container.innerHTML = gameOdds.map(o => {
        const change = o.prevOdds ? o.odds - o.prevOdds : 0;
        const changeClass = change > 0 ? 'up' : change < 0 ? 'down' : '';
        const changeText = change !== 0 ? (change > 0 ? '↑' + change : '↓' + Math.abs(change)) : '';
        
        return \`
          <div class="odd-card \${changeClass}" onclick="placeBet('\${o.selection}', \${o.odds})">
            <div class="odd-market">\${o.market || 'Line'}</div>
            <div class="odd-selection">\${o.selection || '-'}</div>
            <div class="odd-value \${o.odds > 0 ? 'positive' : 'negative'}">\${o.odds > 0 ? '+' : ''}\${o.odds}</div>
            \${changeText ? '<div class="odd-change ' + changeClass + '">' + changeText + '</div>' : ''}
          </div>
        \`;
      }).join('');
    }
    
    async function placeBet(selection, odds) {
      try {
        const res = await fetch('/api/bet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selection, odds, amount: 10 })
        });
        const data = await res.json();
        alert(data.success ? 'Bet slip opened in Fliff!' : 'Error: ' + data.error);
      } catch (e) {
        alert('Error placing bet');
      }
    }
    
    // Initial load
    fetch('/api/live').then(r => r.json()).then(games => {
      games.forEach(g => liveGames[g.id] = g);
      renderGames();
    });
    
    fetch('/api/odds').then(r => r.json()).then(odds => {
      odds.forEach(o => { if(o.event) allOdds[o.id] = o; });
    });
    
    connect();
  </script>
</body>
</html>`;
  }

  async start() {
    console.log('\n🤖 FLIFF LIVE DASHBOARD BOT');
    console.log('═'.repeat(60));
    console.log(`Profile: ${this.settings.name}`);
    
    const proxy = this.parseProxy(this.settings.proxy);
    if (proxy) console.log(`Proxy: ${proxy.host}:${proxy.port}`);
    console.log('─'.repeat(60));

    try {
      const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const browserDataPath = path.join(__dirname, 'profiles', 'ray', 'browser_data');

      console.log('\n🚀 Launching browser...');
      
      this.browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        userDataDir: browserDataPath,
        args: [
          proxy ? `--proxy-server=${proxy.host}:${proxy.port}` : '',
          '--window-size=420,850'
        ].filter(Boolean),
        defaultViewport: null
      });

      const pages = await this.browser.pages();
      this.page = pages[0] || await this.browser.newPage();

      if (proxy) {
        await this.page.authenticate({ username: proxy.username, password: proxy.password });
      }

      await this.page.emulate({
        viewport: { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
      });

      // CDP for WebSocket interception
      this.cdp = await this.page.target().createCDPSession();
      await this.cdp.send('Network.enable');

      this.cdp.on('Network.webSocketFrameReceived', (params) => {
        if (params.response?.payloadData) {
          this.handleWSFrame(params.response.payloadData);
        }
      });

      this.cdp.on('Network.webSocketCreated', (params) => {
        if (params.url?.includes('heraldz')) {
          console.log('🔌 WebSocket connected');
        }
      });

      console.log('📱 Loading Fliff...');
      await this.page.goto('https://sports.getfliff.com/', { waitUntil: 'networkidle2', timeout: 60000 });

      console.log('🟢 Ready! Open dashboard in browser.\n');
      console.log('═'.repeat(60));

      await new Promise(() => {});

    } catch (error) {
      console.error('❌ Error:', error.message);
      this.cleanup();
    }
  }

  handleWSFrame(payloadData) {
    this.messageCount++;
    
    const decoded = this.decode(payloadData);
    if (!decoded) return;

    // Live games
    if (decoded.inplay_conflicts) {
      const updates = [];
      decoded.inplay_conflicts.forEach(g => {
        const existing = this.liveGames.get(g.id);
        
        if (existing && (existing.homeScore !== g.live_home_score || existing.awayScore !== g.live_away_score)) {
          console.log(`⚽ SCORE: ${g.home_team_name} ${g.live_home_score} - ${g.live_away_score} ${g.away_team_name}`);
        }

        const gameData = {
          id: g.id,
          home: g.home_team_name,
          away: g.away_team_name,
          homeScore: g.live_home_score,
          awayScore: g.live_away_score,
          status: g.live_state_desc,
          channel: g.channel_id
        };
        
        this.liveGames.set(g.id, gameData);
        updates.push(gameData);
      });

      this.broadcast({ type: 'games', games: updates });
      console.log(`🏀 LIVE: ${this.liveGames.size} games`);
    }

    // Odds - LIVE ONLY (ignore prematch)
    if (decoded.inplay_subfeeds_update) {
      const updates = [];
      const update = decoded.inplay_subfeeds_update;
      
      update?.packed_subfeed_updates?.forEach(sf => {
        sf.market_updates?.forEach(m => {
          m.groups?.forEach(g => {
            g.proposals?.forEach(p => {
              if (!p.coeff) return;

              const oddData = {
                id: p.proposal_fkey,
                event: p.t_121_event_info,
                market: p.t_131_market_name,
                selection: p.t_141_selection_name,
                odds: p.coeff,
                decimal: p.eu_coeff,
                prevOdds: p.prev_coeff,
                updated: Date.now()
              };
              
              this.odds.set(p.proposal_fkey, oddData);
              updates.push(oddData);

              // Only log live odds changes
              if (p.prev_coeff && Math.abs(p.coeff - p.prev_coeff) >= 5) {
                const dir = p.coeff > p.prev_coeff ? '📈' : '📉';
                console.log(`${dir} LIVE: ${p.t_141_selection_name}: ${p.prev_coeff} → ${p.coeff}`);
              }
            });
          });
        });
      });

      if (updates.length > 0) {
        this.broadcast({ type: 'odds', updates });
      }
    }

    // Stats broadcast
    if (this.messageCount % 10 === 0) {
      this.broadcast({ type: 'stats', messages: this.messageCount, odds: this.odds.size });
    }
  }

  cleanup() {
    if (this.browser) this.browser.close();
  }
}

// =============================================
// RUN
// =============================================

const bot = new FliffBot();
bot.start();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.cleanup();
  setTimeout(() => process.exit(0), 1000);
});
