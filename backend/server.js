const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const FliffClient = require('./fliff');

// =============================================
// FLIFF BACKEND SERVER
// =============================================

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// =============================================
// SEPARATE LOGGING
// =============================================

// logLive is now defined below with other logging functions

// logBetting is now defined below with other logging functions

// Data stores
const liveGames = new Map();
const gameOdds = new Map();
const clients = new Set();

// Betting logs
const betLogs = [];
const accountStats = {
  totalBets: 0,
  wins: 0,
  losses: 0,
  pending: 0,
  totalWagered: 0,
  totalWon: 0,
  prefireAttempts: 0,
  prefireSuccess: 0
};

let fliffClient = null;
let stats = { messages: 0, connected: false };

// Load existing logs
function loadLogs() {
  try {
    const logsPath = path.join(__dirname, 'bet_logs.json');
    if (fs.existsSync(logsPath)) {
      const data = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
      betLogs.push(...data.logs);
      Object.assign(accountStats, data.stats);
    }
  } catch (e) {
    console.log('No existing logs found');
  }
}

// Save logs
function saveLogs() {
  try {
    const logsPath = path.join(__dirname, 'bet_logs.json');
    fs.writeFileSync(logsPath, JSON.stringify({
      logs: betLogs.slice(-1000), // Keep last 1000
      stats: accountStats
    }, null, 2));
  } catch (e) {
    console.error('Error saving logs:', e);
  }
}

loadLogs();

// =============================================
// API ENDPOINTS - GAMES
// =============================================

app.get('/api/games', (req, res) => {
  res.json(Array.from(liveGames.values()));
});

app.get('/api/games/:id', (req, res) => {
  const game = liveGames.get(parseInt(req.params.id));
  if (game) {
    res.json(game);
  } else {
    res.status(404).json({ error: 'Game not found' });
  }
});

app.get('/api/betting/status', (req, res) => {
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  const status = fliffClient.getBettingAPIStatus();
  res.json(status);
});

app.post('/api/betting/capture-endpoint', async (req, res) => {
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  const { gameId } = req.body;
  
  try {
    if (gameId) {
      await fliffClient.navigateToGame(gameId);
    }
    
    const status = fliffClient.getBettingAPIStatus();
    res.json({ 
      success: true, 
      message: 'Navigate to game page and place a bet manually to capture the endpoint',
      status 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/games/:id/odds', (req, res) => {
  const gameId = parseInt(req.params.id);
  const game = liveGames.get(gameId);
  
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  const odds = gameOdds.get(gameId) || new Map();
  const oddsArray = Array.from(odds.values());
  
  // STRICT FINAL VERIFICATION: Filter out any odds that don't match this game
  const homeName = (game.home || '').toLowerCase().trim();
  const awayName = (game.away || '').toLowerCase().trim();
  
  // Extract key words
  const extractKeyWords = (name) => {
    return name
      .replace(/\b(state|university|univ|college|tech|tech|st|u|of|the)\b/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .join(' ')
      .trim();
  };
  
  const homeKeyWords = extractKeyWords(homeName);
  const awayKeyWords = extractKeyWords(awayName);
  
  const verifiedOdds = [];
  const rejectedOdds = [];
  
  oddsArray.forEach(odd => {
    if (!odd.event) {
      rejectedOdds.push({ reason: 'no_event_info', odd: odd.selection });
      return;
    }
    
    const eventInfo = (odd.event || '').toLowerCase().trim();
    
    // Check for full team name matches (strongest)
    const hasHomeFull = eventInfo.includes(homeName);
    const hasAwayFull = eventInfo.includes(awayName);
    
    // Check for key words
    const hasHomeKey = homeKeyWords && eventInfo.includes(homeKeyWords);
    const hasAwayKey = awayKeyWords && eventInfo.includes(awayKeyWords);
    
    // Check for individual significant words
    const homeWords = homeName.split(/\s+/).filter(w => w.length > 2);
    const awayWords = awayName.split(/\s+/).filter(w => w.length > 2);
    const hasHomeWord = homeWords.some(word => eventInfo.includes(word));
    const hasAwayWord = awayWords.some(word => eventInfo.includes(word));
    
    // Check for full game pattern
    const hasFullGame = eventInfo.includes(`${homeName} vs ${awayName}`) ||
                       eventInfo.includes(`${awayName} vs ${homeName}`);
    
    // Require STRONG match - full name OR both key words OR full game pattern
    const hasStrongMatch = hasHomeFull || hasAwayFull || hasFullGame || 
                          (hasHomeKey && hasAwayKey) ||
                          (hasHomeFull && hasAwayWord) ||
                          (hasAwayFull && hasHomeWord);
    
    if (hasStrongMatch) {
      verifiedOdds.push(odd);
    } else {
      rejectedOdds.push({ 
        reason: 'no_match', 
        event: odd.event, 
        selection: odd.selection,
        hasHome: hasHomeFull || hasHomeKey || hasHomeWord,
        hasAway: hasAwayFull || hasAwayKey || hasAwayWord
      });
    }
  });
  
  // Log summary with separate odds logging
  if (rejectedOdds.length > 0) {
    logOdds(`🧹 Removed ${rejectedOdds.length} mismatched odds`, { gameId, count: rejectedOdds.length });
    if (rejectedOdds.length <= 10) {
      rejectedOdds.forEach(r => {
        logOdds(`   ❌ Rejected: "${r.event}" - ${r.selection}`, { gameId });
      });
    } else {
      logOdds(`   ❌ Sample rejected: ${rejectedOdds.slice(0, 3).map(r => r.event).join(', ')}...`, { gameId });
    }
  }
  
  logOdds(`${game.home} vs ${game.away}: ${oddsArray.length} stored → ${verifiedOdds.length} verified`, { gameId, count: verifiedOdds.length });
  
  // Also clean up stored odds map
  if (rejectedOdds.length > 0) {
    const verifiedIds = new Set(verifiedOdds.map(o => o.id));
    const cleanedOdds = new Map();
    odds.forEach((odd, id) => {
      if (verifiedIds.has(id)) {
        cleanedOdds.set(id, odd);
      }
    });
    gameOdds.set(gameId, cleanedOdds);
    logOdds(`🧹 Cleaned stored odds: ${odds.size} → ${cleanedOdds.size}`, { gameId });
  }
  
  res.json(verifiedOdds);
});

app.get('/api/odds', (req, res) => {
  const allOdds = [];
  gameOdds.forEach((odds, gameId) => {
    odds.forEach(odd => {
      allOdds.push({ ...odd, gameId });
    });
  });
  res.json(allOdds);
});

app.get('/api/status', (req, res) => {
  res.json({
    connected: stats.connected,
    messages: stats.messages,
    liveGames: liveGames.size,
    totalOdds: Array.from(gameOdds.values()).reduce((sum, m) => sum + m.size, 0),
    accountStats
  });
});

// =============================================
// API ENDPOINTS - BETTING
// =============================================

// Simple bet (opens in browser)
app.post('/api/bet', async (req, res) => {
  const { gameId, selection, odds, wager, coinType } = req.body;
  
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  try {
    const result = await fliffClient.placeBet(selection, odds, wager, coinType);
    
    // Log the bet
    logBet({
      type: 'simple',
      selection,
      odds,
      wager,
      coinType,
      result: result.success ? 'placed' : 'failed',
      timestamp: Date.now()
    });
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PREFIRE BET - DISABLED: Now just places bet directly
app.post('/api/prefire', async (req, res) => {
  // Validate request body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager, coinType } = req.body;
  
  // Validate required fields
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  logBetting(`💰 PLACING BET (Prefire Disabled)`);
  logBetting(`   Odd ID: ${oddId || 'N/A'}`);
  logBetting(`   Selection: ${selection} @ ${odds}`);
  logBetting(`   Param: ${param || 'N/A'} | Market: ${market || 'N/A'}`);
  logBetting(`   Wager: $${wager} ${coinType}`);
  
  try {
    // Verify we have the correct odd data from the game
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        logBetting(`   ✅ Stored odd found: ${storedOdd.selection} @ ${storedOdd.odds} (Market: ${storedOdd.market})`);
      // Use stored data - it's more reliable
      const finalSelection = storedOdd.selection || selection;
      const finalOdds = storedOdd.odds || odds;
      const finalParam = storedOdd.param || param;
      const finalMarket = storedOdd.market || market;
      
      logBetting(`   📊 Using: ${finalSelection} @ ${finalOdds} | Market: ${finalMarket} | Param: ${finalParam}`);
      
      try {
        // Place bet directly (no prefire) - use stored data
        const betResult = await fliffClient.placeBet(finalSelection, finalOdds, wager, coinType, finalParam, finalMarket, oddId);
        
        if (betResult.success) {
          accountStats.totalBets++;
          accountStats.pending++;
          accountStats.totalWagered += wager;
          
          logBet({
            type: 'bet',
            selection: finalSelection,
            odds: finalOdds,
            wager,
            coinType,
            result: 'accepted',
            timestamp: Date.now()
          });
          
          broadcast({
            type: 'prefire_result',
            success: true,
            message: `✅ Bet placed: ${finalSelection} @ ${finalOdds} - $${wager}`
          });
          
          saveLogs();
          return res.json({ success: true, message: 'Bet accepted!' });
        }
        
        if (betResult.oddsChanged) {
          logBet({
            type: 'bet',
            selection: finalSelection,
            odds: finalOdds,
            wager,
            coinType,
            result: 'odds_changed',
            timestamp: Date.now()
          });
          
          broadcast({
            type: 'prefire_result',
            success: false,
            retry: true,
            message: 'Odds changed. Click again to retry.'
          });
          
          return res.json({ success: false, retry: true, message: 'Odds changed' });
        }
        
        // Bet failed
        logBet({
          type: 'bet',
          selection: finalSelection,
          odds: finalOdds,
          wager,
          coinType,
          result: 'failed',
          error: betResult.error,
          timestamp: Date.now()
        });
        
        return res.json({ success: false, error: betResult.error || 'Bet failed' });
        
      } catch (e) {
        console.error('Bet error:', e);
        return res.status(500).json({ error: e.message });
      }
    } else {
      logBetting(`   ⚠️ Odd ID ${oddId} not found in stored odds - using provided data`);
      
      try {
        // Use provided data if stored odd not found
        const betResult = await fliffClient.placeBet(selection, odds, wager, coinType, param, market, oddId);
        
        if (betResult.success) {
          accountStats.totalBets++;
          accountStats.pending++;
          accountStats.totalWagered += wager;
          
          logBet({
            type: 'bet',
            selection,
            odds,
            wager,
            coinType,
            result: 'accepted',
            timestamp: Date.now()
          });
          
          broadcast({
            type: 'prefire_result',
            success: true,
            message: `✅ Bet placed: ${selection} @ ${odds} - $${wager}`
          });
          
          saveLogs();
          return res.json({ success: true, message: 'Bet accepted!' });
        }
        
        if (betResult.oddsChanged) {
          logBet({
            type: 'bet',
            selection,
            odds,
            wager,
            coinType,
            result: 'odds_changed',
            timestamp: Date.now()
          });
          
          broadcast({
            type: 'prefire_result',
            success: false,
            retry: true,
            message: 'Odds changed. Click again to retry.'
          });
          
          return res.json({ success: false, retry: true, message: 'Odds changed' });
        }
        
        // Bet failed
        logBet({
          type: 'bet',
          selection,
          odds,
          wager,
          coinType,
          result: 'failed',
          error: betResult.error,
          timestamp: Date.now()
        });
        
        return res.json({ success: false, error: betResult.error || 'Bet failed' });
        
      } catch (e) {
        console.error('Bet error:', e);
        return res.status(500).json({ error: e.message });
      }
    }
  } else {
    return res.status(400).json({ error: 'Game odds not found' });
  }
  } catch (e) {
    console.error('Bet error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// LOCK AND LOAD - Places bet with Fliff Coin and reloads page
app.post('/api/lock-and-load', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  logBetting(`🔒 LOCK & LOAD: ${selection} @ ${odds} - $${wager} (Coin)`);
  
  try {
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        finalSelection = storedOdd.selection || selection;
        finalOdds = storedOdd.odds || odds;
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    // Step 1: Place bet with Fliff Coin
    logBetting(`   Step 1: Placing bet with Fliff Coin...`);
    const betResult = await fliffClient.placeBet(finalSelection, finalOdds, wager, 'coin', finalParam, finalMarket, oddId);
    
    if (betResult.success) {
      logBetting(`   ✅ Step 1 Complete: Bet placed with Fliff Coin`);
      
      // Small delay to ensure bet is fully processed before reload
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Step 2: Reload the page to lock the odds (this is the bug exploit)
      logBetting(`   Step 2: Reloading page to lock odds...`);
      const reloadResult = await fliffClient.reloadPage();
      
      if (reloadResult.success) {
        logBetting(`   ✅ Step 2 Complete: Page reloaded - odds should be locked`);
      } else {
        logBetting(`   ⚠️ Step 2 Warning: Page reload had issues: ${reloadResult.error}`);
        // Still continue - bet was placed, reload is just for locking
      }
      
      logBet({
        type: 'lock_and_load',
        selection: finalSelection,
        odds: finalOdds,
        wager,
        coinType: 'coin',
        result: 'locked',
        timestamp: Date.now()
      });
      
      accountStats.totalBets++;
      accountStats.totalWagered += wager;
      
      broadcast({
        type: 'prefire_result',
        success: true,
        message: `🔒 Locked: ${finalSelection} @ ${finalOdds} - Bet placed with Coin, page reloaded`
      });
      
      saveLogs();
      return res.json({ 
        success: true, 
        message: 'Lock & Load complete! Bet placed with Fliff Coin and page reloaded to lock odds.',
        betPlaced: true,
        pageReloaded: reloadResult.success
      });
    }
    
    return res.json({ 
      success: false, 
      error: betResult.error || 'Lock & Load failed - could not place bet with Fliff Coin' 
    });
    
  } catch (e) {
    console.error('Lock & Load error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// PLACE BET - Places bet with Fliff Cash
app.post('/api/place-bet', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (!fliffClient) {
    return res.status(500).json({ error: 'Fliff not connected' });
  }
  
  logBetting(`💰 PLACE BET: ${selection} @ ${odds} - $${wager} (Cash)`);
  
  try {
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        finalSelection = storedOdd.selection || selection;
        finalOdds = storedOdd.odds || odds;
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    // Place bet with Fliff Cash
    const betResult = await fliffClient.placeBet(finalSelection, finalOdds, wager, 'cash', finalParam, finalMarket, oddId);
    
    if (betResult.success) {
      accountStats.totalBets++;
      accountStats.pending++;
      accountStats.totalWagered += wager;
      
      logBet({
        type: 'bet',
        selection: finalSelection,
        odds: finalOdds,
        wager,
        coinType: 'cash',
        result: 'accepted',
        timestamp: Date.now()
      });
      
      broadcast({
        type: 'prefire_result',
        success: true,
        message: `✅ Bet placed: ${finalSelection} @ ${finalOdds} - $${wager}`
      });
      
      saveLogs();
      return res.json({ success: true, message: 'Bet placed!' });
    }
    
    if (betResult.oddsChanged) {
      return res.json({ success: false, retry: true, message: 'Odds changed' });
    }
    
    return res.json({ success: false, error: betResult.error || 'Bet failed' });
    
  } catch (e) {
    console.error('Place bet error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// =============================================
// API ENDPOINTS - ADMIN
// =============================================

// Get all bet logs
app.get('/api/admin/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = betLogs.slice(-limit).reverse();
  res.json(logs);
});

// Get account statistics
app.get('/api/admin/stats', (req, res) => {
  res.json({
    ...accountStats,
    winRate: accountStats.totalBets > 0 
      ? ((accountStats.wins / accountStats.totalBets) * 100).toFixed(1) + '%'
      : '0%',
    prefireRate: accountStats.prefireAttempts > 0
      ? ((accountStats.prefireSuccess / accountStats.prefireAttempts) * 100).toFixed(1) + '%'
      : '0%',
    profit: accountStats.totalWon - accountStats.totalWagered
  });
});

// Update bet result (win/loss)
app.post('/api/admin/result', (req, res) => {
  const { betId, result, payout } = req.body;
  
  // Find and update bet
  const bet = betLogs.find(b => b.id === betId);
  if (bet) {
    bet.result = result;
    bet.payout = payout;
    
    accountStats.pending--;
    if (result === 'win') {
      accountStats.wins++;
      accountStats.totalWon += payout;
    } else {
      accountStats.losses++;
    }
    
    saveLogs();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Bet not found' });
  }
});

// Clear logs
app.post('/api/admin/clear', (req, res) => {
  betLogs.length = 0;
  Object.assign(accountStats, {
    totalBets: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    totalWagered: 0,
    totalWon: 0,
    prefireAttempts: 0,
    prefireSuccess: 0
  });
  saveLogs();
  res.json({ success: true });
});

// =============================================
// HELPER FUNCTIONS - SEPARATE LOGGING
// =============================================

// Betting logs (separate from odds)
function logBet(bet) {
  bet.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  betLogs.push(bet);
  const timestamp = new Date().toLocaleTimeString();
  console.log(`💰 [BET ${timestamp}] ${bet.type.toUpperCase()}: ${bet.selection} @ ${bet.odds > 0 ? '+' : ''}${bet.odds} = ${bet.result}`);
  
  // Auto-save every 10 bets
  if (betLogs.length % 10 === 0) {
    saveLogs();
  }
}

// Odds fetching logs (separate from betting)
function logOdds(message, data = {}) {
  const timestamp = new Date().toLocaleTimeString();
  if (data.gameId && data.count !== undefined) {
    console.log(`📊 [ODDS ${timestamp}] Game ${data.gameId}: ${message} (${data.count} odds)`);
  } else if (data.gameId) {
    console.log(`📊 [ODDS ${timestamp}] Game ${data.gameId}: ${message}`);
  } else {
    console.log(`📊 [ODDS ${timestamp}] ${message}`);
  }
}

// Betting action logs
function logBetting(message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`💰 [BET ${timestamp}] ${message}`);
}

// Live game/score logs
function logLive(message) {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`🎮 [LIVE ${timestamp}] ${message}`);
}

// =============================================
// WEBSOCKET
// =============================================

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('📱 Client connected');
  
  ws.send(JSON.stringify({
    type: 'init',
    games: Array.from(liveGames.values()),
    stats: stats
  }));
  
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      
      if (data.type === 'subscribe' && data.gameId) {
        const gameId = parseInt(data.gameId);
        ws.gameId = gameId;
        
        const odds = gameOdds.get(gameId) || new Map();
        const oddsArray = Array.from(odds.values());
        
        console.log(`📺 Subscribe: game ${gameId}, sending ${oddsArray.length} odds`);
        
        ws.send(JSON.stringify({
          type: 'odds',
          gameId: gameId,
          odds: oddsArray
        }));
      }
    } catch (e) {
      console.error('WS message error:', e);
    }
  });
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('📱 Client disconnected');
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastToGame(gameId, data) {
  const msg = JSON.stringify(data);
  const gid = parseInt(gameId);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws.gameId === gid) {
      ws.send(msg);
    }
  });
}

// =============================================
// FLIFF HANDLERS
// =============================================

function handleGameUpdate(game) {
  const existing = liveGames.get(game.id);
  
  if (existing && (existing.homeScore !== game.homeScore || existing.awayScore !== game.awayScore)) {
    logLive(`⚽ SCORE: ${game.home} ${game.homeScore} - ${game.awayScore} ${game.away}`);
    broadcast({ type: 'score', game });
  } else if (!existing) {
    logLive(`🎮 NEW GAME: ${game.home} vs ${game.away} (${game.sport})`);
  }
  
  liveGames.set(game.id, game);
  
  if (!gameOdds.has(game.id)) {
    gameOdds.set(game.id, new Map());
  }
  
  broadcast({ type: 'game', game });
}

function handleOddsUpdate(gameId, odd) {
  const gid = parseInt(gameId);
  
  // VERIFICATION: Ensure odd belongs to this game
  const game = liveGames.get(gid);
  if (!game) {
    logOdds(`Game ${gid} not found, skipping odd: ${odd.selection || 'N/A'}`);
    return;
  }
  
  // Verify odd's gameId matches (if stored in odd)
  if (odd.gameId && parseInt(odd.gameId) !== gid) {
    logOdds(`❌ MISMATCH: Odd gameId ${odd.gameId} doesn't match target ${gid}`, { gameId: gid });
    logOdds(`   Odd: ${odd.selection} @ ${odd.odds} | Event: ${odd.event || 'N/A'}`, { gameId: gid });
    logOdds(`   Target: ${game.home} vs ${game.away}`, { gameId: gid });
    return; // Don't store mismatched odds
  }
  
  // STRICT VERIFICATION: event_info MUST match game teams
  if (!odd.event) {
    // No event_info - can't verify, skip it
    logOdds(`❌ NO EVENT INFO: Skipping odd ${odd.selection} @ ${odd.odds}`, { gameId: gid });
    return;
  }
  
  const eventInfo = (odd.event || '').toLowerCase().trim();
  const homeName = (game.home || '').toLowerCase().trim();
  const awayName = (game.away || '').toLowerCase().trim();
  
  // Extract key words from team names
  const extractKeyWords = (name) => {
    return name
      .replace(/\b(state|university|univ|college|tech|tech|st|u|of|the)\b/gi, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
      .join(' ')
      .trim();
  };
  
  const homeKeyWords = extractKeyWords(homeName);
  const awayKeyWords = extractKeyWords(awayName);
  
  // Check for matches
  const hasHomeFull = eventInfo.includes(homeName);
  const hasAwayFull = eventInfo.includes(awayName);
  const hasHomeKey = homeKeyWords && eventInfo.includes(homeKeyWords);
  const hasAwayKey = awayKeyWords && eventInfo.includes(awayKeyWords);
  
  // Check for individual significant words (at least 3 chars)
  const homeWords = homeName.split(/\s+/).filter(w => w.length > 2);
  const awayWords = awayName.split(/\s+/).filter(w => w.length > 2);
  const hasHomeWord = homeWords.some(word => eventInfo.includes(word));
  const hasAwayWord = awayWords.some(word => eventInfo.includes(word));
  
  // Check for full game name pattern
  const hasFullGame = eventInfo.includes(`${homeName} vs ${awayName}`) ||
                     eventInfo.includes(`${awayName} vs ${homeName}`) ||
                     eventInfo.includes(`${homeName} ${awayName}`) ||
                     eventInfo.includes(`${awayName} ${homeName}`);
  
  // Require STRONG match - at least one full team name OR both key words OR full game pattern
  const hasStrongMatch = hasHomeFull || hasAwayFull || hasFullGame || 
                        (hasHomeKey && hasAwayKey) ||
                        (hasHomeFull && hasAwayWord) ||
                        (hasAwayFull && hasHomeWord);
  
  if (!hasStrongMatch) {
    logOdds(`❌ VERIFICATION FAILED: Event "${odd.event}" doesn't match game ${gid}`, { gameId: gid });
    logOdds(`   Game: ${game.home} vs ${game.away}`, { gameId: gid });
    logOdds(`   Odd: ${odd.selection} @ ${odd.odds} | Market: ${odd.market}`, { gameId: gid });
    return; // Don't store mismatched odds
  }
  
  let odds = gameOdds.get(gid);
  if (!odds) {
    odds = new Map();
    gameOdds.set(gid, odds);
  }
  
  const existing = odds.get(odd.id);
  
  // Only log significant odds changes (reduce noise)
  if (existing && existing.odds !== odd.odds) {
    const dir = odd.odds > existing.odds ? '📈' : '📉';
    // Only log if odds changed by more than 5
    if (Math.abs(odd.odds - existing.odds) >= 5) {
      logLive(`${dir} ${odd.selection}: ${existing.odds} → ${odd.odds}`);
    }
  }
  
  odds.set(odd.id, odd);
  
  // Broadcast to all clients watching this game
  broadcastToGame(gid, { type: 'odd', gameId: gid, odd });
  
  // Also broadcast to all clients for live feed
  broadcast({ type: 'odd_update', gameId: gid, odd });
}

function handleStats(newStats) {
  stats = { ...stats, ...newStats };
  broadcast({ type: 'stats', stats });
}

// =============================================
// START
// =============================================

async function startFliff() {
  fliffClient = new FliffClient({
    onGame: handleGameUpdate,
    onOdds: handleOddsUpdate,
    onStats: handleStats,
    onConnect: () => {
      stats.connected = true;
      broadcast({ type: 'connected' });
    },
    onDisconnect: () => {
      stats.connected = false;
      broadcast({ type: 'disconnected' });
    }
  });
  
  await fliffClient.start();
}

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log('\n🚀 FLIFF BACKEND SERVER');
  console.log('═'.repeat(50));
  console.log(`📡 API:       http://localhost:${PORT}/api`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log('═'.repeat(50));
  console.log('\nEndpoints:');
  console.log('  GET  /api/games          - All live games');
  console.log('  GET  /api/games/:id/odds - Game odds');
  console.log('  POST /api/prefire        - Prefire bet');
  console.log('  GET  /api/admin/logs     - Bet logs');
  console.log('  GET  /api/admin/stats    - Account stats');
  console.log('─'.repeat(50));
  
  startFliff();
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  saveLogs();
  if (fliffClient) fliffClient.stop();
  process.exit(0);
});
