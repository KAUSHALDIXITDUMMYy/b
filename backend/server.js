const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
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

let fliffClient = null; // Keep for backward compatibility (primary client)
let fliffClients = new Map(); // Map of profileName -> FliffClient for all profiles
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
    // Use writeFileSync with a small delay to batch writes and reduce nodemon restarts
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
          
          setImmediate(() => saveLogs());
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
          
          setImmediate(() => saveLogs());
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

// LOCK AND LOAD - Places $0.20 bet with Cash and refreshes page during submission to lock odds
// Now works with ALL profiles - only shows "locked and loaded" when ALL profiles' odds don't change
app.post('/api/lock-and-load', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  const lockWager = 0.20; // Always use $0.20 for lock and load
  logBetting(`🔒 LOCK & LOAD (${fliffClients.size} profile(s)): ${selection} @ ${odds} - $${lockWager} (Cash)`);
  
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
    
    // Send lock-and-load request to ALL profiles
    const profileResults = [];
    const profilePromises = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      logBetting(`   [${profileName}] Step 1: Placing $${lockWager} bet with Cash...`);
      
      const profilePromise = (async () => {
        try {
          // Step 1: Place bet with $0.20 Cash
          const betPromise = client.placeBet(finalSelection, finalOdds, lockWager, 'cash', finalParam, finalMarket, oddId);
          
          // Step 2: While bet is submitting, refresh the page to lock odds
          logBetting(`   [${profileName}] Step 2: Refreshing page during submission to lock odds...`);
          const reloadPromise = client.reloadPage();
          
          // Wait for both to complete
          const [betResult, reloadResult] = await Promise.all([betPromise, reloadPromise]);
          
          if (betResult.success) {
            logBetting(`   [${profileName}] ✅ Step 1 Complete: $${lockWager} bet placed`);
            
            if (reloadResult.success) {
              logBetting(`   [${profileName}] ✅ Step 2 Complete: Page refreshed`);
            } else {
              logBetting(`   [${profileName}] ⚠️ Step 2 Warning: Page refresh had issues: ${reloadResult.error}`);
            }
            
            // Step 3: Verify odds haven't changed after refresh
            logBetting(`   [${profileName}] Step 3: Verifying odds are locked...`);
            const oddsCheck = await client.getCurrentOddsAfterRefresh(finalSelection, finalOdds, finalParam, finalMarket, oddId);
            
            let oddsLocked = false;
            let oddsChanged = false;
            
            if (oddsCheck.found) {
              // Compare odds - allow small tolerance for rounding
              const oddsMatch = oddsCheck.currentOdds !== null && 
                                Math.abs(oddsCheck.currentOdds - finalOdds) <= 1;
              
              // Check if selection text still matches
              const selectionMatch = oddsCheck.currentSelection && 
                                     oddsCheck.currentSelection.toLowerCase().includes(finalSelection.toLowerCase());
              
              if (oddsMatch && selectionMatch) {
                oddsLocked = true;
                logBetting(`   [${profileName}] ✅ Step 3 Complete: Odds verified - ${finalSelection} @ ${oddsCheck.currentOdds} (locked)`);
              } else {
                oddsChanged = true;
                logBetting(`   [${profileName}] ⚠️ Step 3 Warning: Odds changed - Expected: ${finalSelection} @ ${finalOdds}, Found: ${oddsCheck.currentSelection} @ ${oddsCheck.currentOdds}`);
              }
            } else {
              logBetting(`   [${profileName}] ⚠️ Step 3 Warning: Could not verify odds - ${oddsCheck.error || 'Element not found'}`);
            }
            
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: reloadResult.success,
              oddsLocked,
              oddsChanged,
              lockedOdds: oddsLocked ? finalOdds : null,
              currentOdds: oddsCheck.found ? oddsCheck.currentOdds : null,
              error: null
            };
          } else {
            return {
              profileName,
              success: false,
              betPlaced: false,
              pageReloaded: false,
              oddsLocked: false,
              oddsChanged: false,
              lockedOdds: null,
              currentOdds: null,
              error: betResult.error || 'Lock & Load failed - could not place $0.20 bet'
            };
          }
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          return {
            profileName,
            success: false,
            betPlaced: false,
            pageReloaded: false,
            oddsLocked: false,
            oddsChanged: false,
            lockedOdds: null,
            currentOdds: null,
            error: e.message
          };
        }
      })();
      
      profilePromises.push(profilePromise);
    }
    
    // Wait for all profiles to complete
    const results = await Promise.all(profilePromises);
    
    // Analyze results - only show "locked and loaded" if ALL profiles have stable odds
    const allBetsPlaced = results.every(r => r.betPlaced);
    const allOddsLocked = results.every(r => r.oddsLocked);
    const anyOddsChanged = results.some(r => r.oddsChanged);
    const allProfilesSuccess = results.every(r => r.success);
    
    // Log results for each profile
    results.forEach(r => {
      logBet({
        type: 'lock_and_load',
        selection: finalSelection,
        odds: finalOdds,
        wager: lockWager,
        coinType: 'cash',
        profile: r.profileName,
        result: r.oddsLocked ? 'locked' : (r.oddsChanged ? 'odds_changed' : 'unknown'),
        timestamp: Date.now()
      });
    });
    
    accountStats.totalBets += results.filter(r => r.betPlaced).length;
    accountStats.totalWagered += lockWager * results.filter(r => r.betPlaced).length;
    
    // Only show "Locked & Loaded" if ALL profiles' odds are locked (don't change)
    const allLocked = allOddsLocked && !anyOddsChanged;
    
    let message;
    if (allLocked) {
      message = `🔒 LOCKED & LOADED (${fliffClients.size} profiles): ${finalSelection} @ ${finalOdds} - All profiles verified locked!`;
    } else if (anyOddsChanged) {
      const changedProfiles = results.filter(r => r.oddsChanged).map(r => r.profileName);
      message = `⚠️ Odds Changed (${changedProfiles.length} profile(s)): ${finalSelection} @ ${finalOdds} - Odds changed on: ${changedProfiles.join(', ')}`;
    } else if (allBetsPlaced) {
      message = `✅ Bet Placed (${fliffClients.size} profiles): ${finalSelection} @ ${finalOdds} - Could not verify all odds`;
    } else {
      const failedProfiles = results.filter(r => !r.success).map(r => r.profileName);
      message = `❌ Some profiles failed: ${failedProfiles.join(', ')}`;
    }
    
    broadcast({
      type: 'prefire_result',
      success: allLocked,
      message: message,
      profileResults: results
    });
    
    // Save logs after response is sent
    setImmediate(() => saveLogs());
    
    return res.json({ 
      success: allLocked, // Only true if ALL profiles' odds are locked
      message: allLocked 
        ? `Locked & Loaded! All ${fliffClients.size} profile(s) verified locked at ${finalOdds}.`
        : anyOddsChanged
          ? `Odds changed on some profiles. Expected ${finalOdds}, but odds may have moved.`
          : allBetsPlaced
            ? `Bet placed on all profiles but could not verify if all odds are locked.`
            : `Some profiles failed to place bet.`,
      betPlaced: allBetsPlaced,
      allOddsLocked: allLocked,
      anyOddsChanged: anyOddsChanged,
      lockedOdds: allLocked ? finalOdds : null,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Lock & Load error:', e);
    setImmediate(() => saveLogs());
    return res.status(500).json({ error: e.message });
  }
});

// PLACE BET - Places bet with Fliff Cash (uses wager amount from dashboard)
// Now works with ALL profiles - sends bet to each profile with their respective bearer token
app.post('/api/place-bet', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  logBetting(`💰 PLACE BET (${fliffClients.size} profile(s)): ${selection} @ ${odds} - $${wager} (Cash)`);
  
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
    
    // Send place-bet request to ALL profiles with their respective bearer tokens
    const profileResults = [];
    const profilePromises = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      logBetting(`   [${profileName}] Placing bet: ${finalSelection} @ ${finalOdds} - $${wager} (Cash)`);
      
      const profilePromise = (async () => {
        try {
          // Place bet with Fliff Cash (uses profile's bearer token automatically)
          const betResult = await client.placeBet(finalSelection, finalOdds, wager, 'cash', finalParam, finalMarket, oddId);
          
          if (betResult.success) {
            logBet({
              type: 'bet',
              selection: finalSelection,
              odds: finalOdds,
              wager,
              coinType: 'cash',
              profile: profileName,
              result: 'accepted',
              timestamp: Date.now()
            });
            
            return {
              profileName,
              success: true,
              message: `Bet placed: ${finalSelection} @ ${finalOdds} - $${wager}`,
              error: null
            };
          }
          
          if (betResult.oddsChanged) {
            return {
              profileName,
              success: false,
              retry: true,
              message: 'Odds changed',
              error: 'Odds changed'
            };
          }
          
          return {
            profileName,
            success: false,
            retry: false,
            message: 'Bet failed',
            error: betResult.error || 'Bet failed'
          };
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          return {
            profileName,
            success: false,
            retry: false,
            message: 'Error',
            error: e.message
          };
        }
      })();
      
      profilePromises.push(profilePromise);
    }
    
    // Wait for all profiles to complete
    const results = await Promise.all(profilePromises);
    
    // Analyze results
    const successfulBets = results.filter(r => r.success);
    const failedBets = results.filter(r => !r.success);
    const oddsChangedBets = results.filter(r => r.retry);
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += wager * successfulBets.length;
    
    // Build message
    let message;
    if (successfulBets.length === fliffClients.size) {
      message = `✅ Bet placed on all ${fliffClients.size} profile(s): ${finalSelection} @ ${finalOdds} - $${wager}`;
    } else if (successfulBets.length > 0) {
      const successProfiles = successfulBets.map(r => r.profileName).join(', ');
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `⚠️ Bet placed on ${successfulBets.length}/${fliffClients.size} profile(s). Success: ${successProfiles}. Failed: ${failProfiles}`;
    } else {
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `❌ Bet failed on all profiles: ${failProfiles}`;
    }
    
    broadcast({
      type: 'prefire_result',
      success: successfulBets.length > 0,
      message: message,
      profileResults: results
    });
    
    setImmediate(() => saveLogs());
    
    if (oddsChangedBets.length > 0) {
      return res.json({ 
        success: false, 
        retry: true, 
        message: `Odds changed on ${oddsChangedBets.length} profile(s). Click again to retry.`,
        profileResults: results
      });
    }
    
    if (successfulBets.length === 0) {
      return res.json({ 
        success: false, 
        error: 'Bet failed on all profiles',
        profileResults: results
      });
    }
    
    return res.json({ 
      success: true, 
      message: `Bet placed on ${successfulBets.length}/${fliffClients.size} profile(s)!`,
      profileResults: results
    });
    
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
    
    setImmediate(() => saveLogs());
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
  
  // Auto-save every 10 bets (use setImmediate to prevent nodemon restart)
  if (betLogs.length % 10 === 0) {
    setImmediate(() => saveLogs());
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
// PROFILE DISCOVERY
// =============================================

function discoverProfiles() {
  const profiles = [];
  const rootDir = path.join(__dirname, '..');
  
  // Check for profile directories
  const items = fs.readdirSync(rootDir, { withFileTypes: true });
  
  for (const item of items) {
    if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules' && 
        item.name !== 'backend' && item.name !== 'frontend' && item.name !== 'assets') {
      const settingsPath = path.join(rootDir, item.name, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        try {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          profiles.push({
            name: settings.name || item.name,
            directory: item.name,
            settings: settings,
            settingsPath: settingsPath
          });
        } catch (e) {
          console.log(`⚠️ Could not load profile ${item.name}: ${e.message}`);
        }
      }
    }
  }
  
  return profiles;
}

// =============================================
// START
// =============================================

async function startFliff() {
  // Discover all profiles
  const profiles = discoverProfiles();
  
  if (profiles.length === 0) {
    console.log('⚠️ No profiles found, using default ray profile');
    // Fallback to default
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
    fliffClients.set('default', fliffClient);
    return;
  }
  
  console.log(`\n📋 Found ${profiles.length} profile(s):`);
  profiles.forEach(p => console.log(`   - ${p.name} (${p.directory})`));
  console.log('');
  
  // Start all profiles with delays to avoid conflicts
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    try {
      // Add delay between profile startups to avoid browser conflicts
      if (i > 0) {
        const delay = 3000 * i; // 3 seconds between each profile
        console.log(`⏳ Waiting ${delay/1000}s before starting next profile...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      console.log(`🚀 Starting profile: ${profile.name}...`);
      
      // Create a FliffClient with custom settings path
      const client = new FliffClient({
        onGame: (game) => {
          // Merge games from all profiles (use first one that reports it)
          handleGameUpdate(game);
        },
        onOdds: (gameId, odd) => {
          // Store odds per profile
          handleOddsUpdate(gameId, odd);
        },
        onStats: (newStats) => {
          // Aggregate stats
          handleStats(newStats);
        },
        onConnect: () => {
          stats.connected = true;
          broadcast({ type: 'connected', profile: profile.name });
        },
        onDisconnect: () => {
          broadcast({ type: 'disconnected', profile: profile.name });
        }
      });
      
      // Override settings to use profile-specific settings
      client.settings = profile.settings;
      
      // Override loadAPICredentials to use profile-specific directory
      const originalLoadAPICredentials = client.loadAPICredentials;
      client.loadAPICredentials = function() {
        try {
          const credentialsPath = path.join(__dirname, '..', profile.directory, 'api_credentials.json');
          if (fs.existsSync(credentialsPath)) {
            const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
            if (data.bettingEndpoint) {
              this.bettingEndpoint = data.bettingEndpoint;
              console.log(`📂 [${profile.name}] Loaded persisted betting endpoint`);
            }
            if (data.bearerToken) {
              this.bearerToken = data.bearerToken;
              console.log(`📂 [${profile.name}] Loaded persisted bearer token`);
            }
            if (data.authToken) {
              this.authToken = data.authToken;
              console.log(`📂 [${profile.name}] Loaded persisted auth token`);
            }
            if (data.apiHeaders) {
              this.apiHeaders = data.apiHeaders;
            }
            if (data.capturedBetRequests && Array.isArray(data.capturedBetRequests)) {
              this.capturedBetRequests = data.capturedBetRequests.slice(-10);
              console.log(`📂 [${profile.name}] Loaded ${this.capturedBetRequests.length} persisted bet request templates`);
            }
          }
        } catch (e) {
          console.log(`⚠️ [${profile.name}] Could not load API credentials:`, e.message);
        }
      };
      
      // Override saveAPICredentials to use profile-specific directory
      const originalSaveAPICredentials = client.saveAPICredentials;
      client.saveAPICredentials = function() {
        try {
          const credentialsPath = path.join(__dirname, '..', profile.directory, 'api_credentials.json');
          const data = {
            bettingEndpoint: this.bettingEndpoint,
            bearerToken: this.bearerToken,
            authToken: this.authToken,
            apiHeaders: this.apiHeaders,
            capturedBetRequests: this.capturedBetRequests.slice(-10),
            lastUpdated: new Date().toISOString()
          };
          fs.writeFileSync(credentialsPath, JSON.stringify(data, null, 2), 'utf8');
          console.log(`💾 [${profile.name}] Saved API credentials to disk`);
        } catch (e) {
          console.log(`⚠️ [${profile.name}] Could not save API credentials:`, e.message);
        }
      };
      
      // Reload API credentials with profile-specific path
      client.loadAPICredentials();
      
      // Override browser data path to use profile-specific directory
      const originalStart = client.start;
      client.start = async function() {
        // Temporarily override browser data path
        const browserDataPath = path.join(__dirname, '..', profile.directory, 'browser_data');
        
        // Call original start but with modified browser data path
        console.log(`🎮 Starting Fliff Client for ${profile.name}...`);
        console.log(`Profile: ${this.settings.name}`);
        
        const proxy = this.parseProxy(this.settings.proxy);
        if (proxy) {
          console.log(`Proxy: ${proxy.host}:${proxy.port}`);
        }
        
        // Show API credentials status
        if (this.bettingEndpoint) {
          console.log(`📂 Using persisted betting endpoint: ${this.bettingEndpoint}`);
        }
        if (this.bearerToken || this.authToken) {
          console.log(`📂 Using persisted authentication tokens`);
        }

        try {
          // Detect OS and set Chrome path (same as original)
          let chromePath;
          if (process.platform === 'win32') {
            const possiblePaths = [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
              path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
              path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
              path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe')
            ];
            chromePath = possiblePaths.find(p => p && fs.existsSync(p));
            if (!chromePath) {
              throw new Error('Chrome not found');
            }
          } else if (process.platform === 'darwin') {
            chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
            if (!fs.existsSync(chromePath)) {
              throw new Error('Chrome not found at: ' + chromePath);
            }
          } else {
            const linuxPaths = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
            chromePath = linuxPaths.find(p => fs.existsSync(p));
            if (!chromePath) {
              throw new Error('Chrome/Chromium not found');
            }
          }
          
          console.log(`🚀 [${profile.name}] Launching browser with data dir: ${browserDataPath}`);
          
          // Ensure browser data directory exists
          if (!fs.existsSync(browserDataPath)) {
            fs.mkdirSync(browserDataPath, { recursive: true });
            console.log(`📁 [${profile.name}] Created browser data directory`);
          }
          
          // Build args array
          const browserArgs = [
            proxy ? `--proxy-server=${proxy.host}:${proxy.port}` : '',
            '--window-size=420,850',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage', // Overcome limited resource problems
            '--disable-gpu', // Disable GPU hardware acceleration
            `--user-data-dir=${browserDataPath}` // Explicitly set user data dir
          ].filter(Boolean);
          
          console.log(`🔧 [${profile.name}] Browser args: ${browserArgs.filter(a => !a.includes('proxy')).join(', ')}`);
          
          this.browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,
            userDataDir: browserDataPath,
            args: browserArgs,
            defaultViewport: null,
            ignoreHTTPSErrors: true,
            timeout: 60000
          });

          const pages = await this.browser.pages();
          this.page = pages[0] || await this.browser.newPage();
          
          // Set proxy authentication BEFORE navigating
          if (proxy) {
            console.log(`🔐 [${profile.name}] Setting proxy authentication: ${proxy.username}@${proxy.host}:${proxy.port}`);
            try {
              await this.page.authenticate({ 
                username: proxy.username, 
                password: proxy.password 
              });
              console.log(`✅ [${profile.name}] Proxy authentication set successfully`);
            } catch (authError) {
              console.error(`⚠️ [${profile.name}] Proxy authentication error:`, authError.message);
              // Continue anyway - some proxies don't require explicit auth
            }
          }
          
          // Wait a bit for browser to be ready
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Mobile emulation
          await this.page.emulate({
            viewport: { 
              width: 375, 
              height: 812, 
              deviceScaleFactor: 3, 
              isMobile: true, 
              hasTouch: true 
            },
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
          });

          // CDP for WebSocket interception
          this.cdp = await this.page.target().createCDPSession();
          await this.cdp.send('Network.enable');

          // Set geolocation to match proxy location
          if (this.settings.latitude && this.settings.longitude) {
            try {
              await this.cdp.send('Emulation.setGeolocationOverride', {
                latitude: parseFloat(this.settings.latitude),
                longitude: parseFloat(this.settings.longitude),
                accuracy: parseFloat(this.settings.accuracy) || 75
              });
              console.log(`📍 Location set: ${this.settings.latitude}, ${this.settings.longitude}`);
            } catch (e) {
              console.log('⚠️ Could not set geolocation:', e.message);
            }
          }

          // Grant geolocation permissions
          const context = this.browser.defaultBrowserContext();
          await context.overridePermissions('https://sports.getfliff.com', ['geolocation']);

          // Capture auth tokens and betting API endpoints (same as original)
          this.cdp.on('Network.requestWillBeSent', (params) => {
            const headers = params.request.headers;
            const url = params.request.url || '';
            const method = params.request.method || '';
            const postData = params.request.postData;
            
            if (headers.Authorization) {
              const newToken = headers.Authorization;
              if (this.bearerToken !== newToken) {
                const wasNew = !this.bearerToken;
                this.bearerToken = newToken;
                if (wasNew) {
                  console.log(`🔑 [${profile.name}] Captured bearer token`);
                }
                this.saveAPICredentials();
              }
            }
            
            if (url.includes('auth_token=')) {
              const match = url.match(/auth_token=([^&]+)/);
              if (match) {
                const newToken = match[1];
                if (this.authToken !== newToken) {
                  this.authToken = newToken;
                  console.log(`🔑 [${profile.name}] Captured auth token`);
                  this.saveAPICredentials();
                }
              }
            }
            
            if (method === 'POST' && postData) {
              const lowerUrl = url.toLowerCase();
              const lowerPostData = postData.toLowerCase();
              
              const isBettingEndpoint = lowerUrl.includes('bet') || 
                  lowerUrl.includes('wager') || 
                  lowerUrl.includes('stake') || 
                  lowerUrl.includes('proposal') ||
                  lowerUrl.includes('place') ||
                  lowerUrl.includes('order') ||
                  lowerUrl.includes('ticket') ||
                  lowerUrl.includes('transaction') ||
                  (lowerUrl.includes('api') && (lowerPostData.includes('amount') || lowerPostData.includes('wager') || lowerPostData.includes('bet'))) ||
                  (lowerUrl.includes('fliff') && lowerPostData.includes('amount'));
              
              if (isBettingEndpoint) {
                const betRequest = {
                  url: url,
                  method: method,
                  headers: headers,
                  postData: postData,
                  timestamp: Date.now()
                };
                
                this.capturedBetRequests.push(betRequest);
                if (this.capturedBetRequests.length > 20) {
                  this.capturedBetRequests.shift();
                }
                if (this.capturedBetRequests.length % 5 === 0) {
                  this.saveAPICredentials();
                }
                
                const isBetterMatch = !this.bettingEndpoint || 
                                   (lowerUrl.includes('bet') && !this.bettingEndpoint.toLowerCase().includes('bet')) ||
                                   (lowerUrl.includes('wager') && !this.bettingEndpoint.toLowerCase().includes('wager'));
                
                if (!this.bettingEndpoint || isBetterMatch) {
                  this.bettingEndpoint = url;
                  this.apiHeaders = { ...headers };
                  console.log(`🎯 [${profile.name}] Captured betting API endpoint: ${url}`);
                  this.saveAPICredentials();
                }
              }
            }
          });
          
          this.cdp.on('Network.responseReceived', async (params) => {
            const url = params.response.url || '';
            if (this.bettingEndpoint && url === this.bettingEndpoint) {
              try {
                const response = await this.cdp.send('Network.getResponseBody', {
                  requestId: params.requestId
                });
                if (response.body) {
                  console.log(`📥 [${profile.name}] Betting API response: ${response.body.substring(0, 500)}`);
                }
              } catch (e) {
                // Response body might not be available
              }
            }
          });

          this.cdp.on('Network.webSocketFrameReceived', (params) => {
            if (params.response?.payloadData) {
              this.handleWSFrame(params.response.payloadData);
            }
          });

          this.cdp.on('Network.webSocketCreated', (params) => {
            if (params.url?.includes('heraldz')) {
              console.log(`🔌 [${profile.name}] Fliff WebSocket connected`);
              this.onConnect();
            }
          });

          this.cdp.on('Network.webSocketClosed', () => {
            console.log(`⚫ [${profile.name}] WebSocket disconnected`);
            this.onDisconnect();
          });

          // Inject geolocation override script
          await this.page.evaluateOnNewDocument((lat, lon, acc) => {
            Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
              value: function(success, error) {
                success({
                  coords: {
                    latitude: lat,
                    longitude: lon,
                    accuracy: acc,
                    altitude: null,
                    altitudeAccuracy: null,
                    heading: null,
                    speed: null
                  },
                  timestamp: Date.now()
                });
              }
            });
            
            Object.defineProperty(navigator.geolocation, 'watchPosition', {
              value: function(success, error) {
                success({
                  coords: {
                    latitude: lat,
                    longitude: lon,
                    accuracy: acc,
                    altitude: null,
                    altitudeAccuracy: null,
                    heading: null,
                    speed: null
                  },
                  timestamp: Date.now()
                });
                return 1;
              }
            });
          }, 
          parseFloat(this.settings.latitude || 40.7132), 
          parseFloat(this.settings.longitude || -74.0061),
          parseFloat(this.settings.accuracy || 75));

          console.log(`📱 [${profile.name}] Loading Fliff...`);
          
          // Try to navigate with retries
          let navigationSuccess = false;
          let retries = 3;
          
          while (!navigationSuccess && retries > 0) {
            try {
              await this.page.goto('https://sports.getfliff.com/', { 
                waitUntil: 'networkidle2', 
                timeout: 60000 
              });
              
              // Wait a bit for page to render
              await new Promise(resolve => setTimeout(resolve, 3000));
              
              // Check if page loaded successfully
              const pageTitle = await this.page.title().catch(() => '');
              const pageUrl = this.page.url();
              const pageContent = await this.page.evaluate(() => document.body.innerText).catch(() => '');
              
              // Check for error messages
              const hasError = pageContent.toLowerCase().includes('temporarily down') || 
                              pageContent.toLowerCase().includes('moved permanently') ||
                              pageContent.toLowerCase().includes('this site can\'t be reached') ||
                              pageTitle.toLowerCase().includes('temporarily down') ||
                              pageTitle.toLowerCase().includes('error');
              
              if (pageUrl.includes('getfliff.com') && !hasError) {
                navigationSuccess = true;
                console.log(`🟢 [${profile.name}] Fliff loaded successfully! (URL: ${pageUrl.substring(0, 50)}...)`);
              } else {
                const errorMsg = hasError ? 'Page shows error message' : `Unexpected URL: ${pageUrl}`;
                throw new Error(`${errorMsg} - Title: ${pageTitle.substring(0, 50)}`);
              }
            } catch (e) {
              retries--;
              if (retries > 0) {
                console.log(`⚠️ [${profile.name}] Navigation failed: ${e.message}`);
                console.log(`   Retrying... (${retries} attempts left)`);
                // Close current page and create new one
                try {
                  await this.page.close();
                } catch {}
                this.page = await this.browser.newPage();
                if (proxy) {
                  await this.page.authenticate({ 
                    username: proxy.username, 
                    password: proxy.password 
                  });
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
              } else {
                console.error(`❌ [${profile.name}] Failed to load Fliff after 3 attempts: ${e.message}`);
                throw e;
              }
            }
          }
          
          // Wait a bit more for page to fully initialize
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          console.log(`🟢 [${profile.name}] Fliff ready!\n`);
        } catch (error) {
          console.error(`❌ [${profile.name}] Error starting Fliff:`, error.message);
          throw error;
        }
      };
      
      await client.start();
      
      fliffClients.set(profile.name, client);
      
      // Set first client as primary for backward compatibility
      if (!fliffClient) {
        fliffClient = client;
      }
      
      console.log(`✅ Profile ${profile.name} started successfully\n`);
      
      // Add a small delay after successful start to ensure stability
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
      console.error(`❌ Failed to start profile ${profile.name}:`, e.message);
      console.error(`   Stack:`, e.stack);
      // Continue with other profiles even if one fails
    }
  }
  
  console.log(`\n✅ Started ${fliffClients.size} profile(s) out of ${profiles.length} total\n`);
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
  // Stop all profile clients
  for (const [profileName, client] of fliffClients.entries()) {
    try {
      client.stop();
      console.log(`   Stopped profile: ${profileName}`);
    } catch (e) {
      console.error(`   Error stopping profile ${profileName}:`, e.message);
    }
  }
  // Also stop primary client if different
  if (fliffClient && !fliffClients.has(fliffClient.settings?.name || 'default')) {
    try {
      fliffClient.stop();
    } catch (e) {
      // Ignore
    }
  }
  process.exit(0);
});
