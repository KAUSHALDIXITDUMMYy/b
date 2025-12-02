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
  // Get profile status
  const profileStatuses = [];
  for (const [profileName, client] of fliffClients.entries()) {
    // Skip live event profiles in status (they're for data scraping only)
    if (client.isLiveEventProfile) {
      continue;
    }
    const isReady = !!(client.page && client.browser);
    const apiStatus = client.getBettingAPIStatus();
    profileStatuses.push({
      name: profileName,
      ready: isReady,
      hasPage: !!client.page,
      hasBrowser: !!client.browser,
      hasBettingEndpoint: !!apiStatus.endpoint,
      hasAuth: apiStatus.hasAuth,
      method: apiStatus.method,
      profileType: client.isBettingProfile ? 'betting' : 'liveEvent'
    });
  }
  
  res.json({
    connected: stats.connected,
    messages: stats.messages,
    liveGames: liveGames.size,
    totalOdds: Array.from(gameOdds.values()).reduce((sum, m) => sum + m.size, 0),
    accountStats,
    profiles: {
      total: fliffClients.size,
      ready: profileStatuses.filter(p => p.ready).length,
      statuses: profileStatuses
    }
  });
});

// =============================================
// API ENDPOINTS - BETTING
// =============================================

// Simple bet (legacy - uses primary client only, use /api/prefire or /api/place-bet for all profiles)
app.post('/api/bet', async (req, res) => {
  const { gameId, selection, odds, wager, coinType } = req.body;
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  // Use first available client for backward compatibility
  const client = fliffClient || Array.from(fliffClients.values())[0];
  
  if (!client) {
    return res.status(500).json({ error: 'No Fliff client available' });
  }
  
  try {
    const result = await client.placeBet(selection, odds, wager || 10, coinType || 'cash');
    
    // Log the bet
    logBet({
      type: 'simple',
      selection,
      odds,
      wager: wager || 10,
      coinType: coinType || 'cash',
      result: result.success ? 'placed' : 'failed',
      timestamp: Date.now()
    });
    
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PREFIRE BET - Now works with ALL profiles and includes page reload option
app.post('/api/prefire', async (req, res) => {
  // Validate request body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, wager, coinType, reloadPage } = req.body;
  
  // Validate required fields
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  // Default wager if not provided
  const betWager = wager || 10;
  const betCoinType = coinType || 'cash';
  const shouldReload = reloadPage === true; // Default to false - prefire should NOT reload by default
  
  logBetting(`💰 PREFIRE BET (${fliffClients.size} profile(s)): ${selection} @ ${odds} - $${betWager} (${betCoinType})${shouldReload ? ' [with reload]' : ' [no reload - odds verification only]'}`);
  logBetting(`   Odd ID: ${oddId || 'N/A'}`);
  logBetting(`   Param: ${param || 'N/A'} | Market: ${market || 'N/A'}`);
  
  try {
    // Verify we have the correct odd data from the game
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        logBetting(`   ✅ Stored odd found: ${storedOdd.selection} @ ${storedOdd.odds} (Market: ${storedOdd.market})`);
        finalSelection = storedOdd.selection || selection;
        finalOdds = storedOdd.odds || odds;
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    logBetting(`   📊 Using: ${finalSelection} @ ${finalOdds} | Market: ${finalMarket} | Param: ${finalParam}`);
    
    // Verify all clients are ready
    const readyClients = [];
    const notReadyClients = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      // Only use betting profiles for placing bets
      if (client.isLiveEventProfile) {
        continue; // Skip live event profiles
      }
      if (!client.page || !client.browser) {
        notReadyClients.push(profileName);
        logBetting(`   ⚠️ [${profileName}] Client not ready (no page/browser)`);
        continue;
      }
      readyClients.push({ name: profileName, client });
    }
    
    if (readyClients.length === 0) {
      logBetting(`   ❌ No clients ready to place bets!`);
      return res.status(500).json({ 
        error: 'No clients ready', 
        notReady: notReadyClients,
        totalClients: fliffClients.size
      });
    }
    
    if (notReadyClients.length > 0) {
      logBetting(`   ⚠️ ${notReadyClients.length} client(s) not ready: ${notReadyClients.join(', ')}`);
    }
    
    logBetting(`   ✅ ${readyClients.length} client(s) ready to place bets`);
    
    // Send bet request to ALL ready profiles
    const profileResults = [];
    const profilePromises = [];
    
    for (const { name: profileName, client } of readyClients) {
      logBetting(`   [${profileName}] Placing bet: ${finalSelection} @ ${finalOdds} - $${betWager} (${betCoinType})`);
      
      // Check if client has betting endpoint or will use Puppeteer
      const apiStatus = client.getBettingAPIStatus();
      if (apiStatus.endpoint) {
        logBetting(`      Using API endpoint: ${apiStatus.endpoint.substring(0, 50)}...`);
      } else {
        logBetting(`      Using Puppeteer method (no API endpoint captured)`);
      }
      
      const profilePromise = (async () => {
        try {
          // Prefire: Verify odds first, then place bet (NO page reload)
          // Only reload if explicitly requested (reloadPage: true)
          let betResult;
          
          if (shouldReload) {
            // If reload is explicitly requested, reload page during bet submission
            const betPromise = client.placeBet(finalSelection, finalOdds, betWager, betCoinType, finalParam, finalMarket, oddId);
            const reloadPromise = client.reloadPage();
            const [result, reloadRes] = await Promise.all([betPromise, reloadPromise]);
            result.reloadResult = reloadRes;
            betResult = result;
          } else {
            // No reload - just place bet (prefire default behavior)
            betResult = await client.placeBet(finalSelection, finalOdds, betWager, betCoinType, finalParam, finalMarket, oddId);
          }
          
          if (betResult.success) {
            // Verify bet was actually placed by checking API response
            const verified = await verifyBetPlaced(client, betResult, finalSelection, finalOdds);
            betResult.verified = verified;
            
            if (verified.confirmed) {
              logBet({
                type: 'bet',
                selection: finalSelection,
                odds: finalOdds,
                wager: betWager,
                coinType: betCoinType,
                profile: profileName,
                result: 'accepted',
                verified: true,
                apiStatus: verified.status,
                timestamp: Date.now()
              });
              
              return {
                profileName,
                success: true,
                verified: true,
                message: `Bet placed and verified: ${finalSelection} @ ${finalOdds} - $${betWager}`,
                error: null,
                status: verified.status
              };
            } else {
              // Bet might have been placed but couldn't verify
              logBet({
                type: 'bet',
                selection: finalSelection,
                odds: finalOdds,
                wager: betWager,
                coinType: betCoinType,
                profile: profileName,
                result: 'accepted',
                verified: false,
                timestamp: Date.now()
              });
              
              return {
                profileName,
                success: true,
                verified: false,
                message: `Bet placed (unverified): ${finalSelection} @ ${finalOdds} - $${betWager}`,
                error: verified.reason || 'Could not verify bet placement',
                status: verified.status
              };
            }
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
    
    // Log detailed results
    logBetting(`\n📊 Bet Results Summary:`);
    logBetting(`   Total profiles attempted: ${results.length}`);
    logBetting(`   Successful: ${successfulBets.length}`);
    logBetting(`   Failed: ${failedBets.length}`);
    logBetting(`   Odds changed: ${oddsChangedBets.length}`);
    
    if (successfulBets.length > 0) {
      const verifiedBets = successfulBets.filter(r => r.verified);
      const unverifiedBets = successfulBets.filter(r => !r.verified);
      
      if (verifiedBets.length > 0) {
        logBetting(`   ✅ Verified success on: ${verifiedBets.map(r => `${r.profileName} (status: ${r.status || 'N/A'})`).join(', ')}`);
      }
      if (unverifiedBets.length > 0) {
        logBetting(`   ⚠️ Unverified success on: ${unverifiedBets.map(r => r.profileName).join(', ')}`);
      }
    }
    if (failedBets.length > 0) {
      failedBets.forEach(r => {
        logBetting(`   ❌ Failed on ${r.profileName}: ${r.error || 'Unknown error'}`);
      });
    }
    if (oddsChangedBets.length > 0) {
      logBetting(`   ⚠️ Odds changed on: ${oddsChangedBets.map(r => r.profileName).join(', ')}`);
    }
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += betWager * successfulBets.length;
    
    // Build message
    let message;
    const totalExpected = readyClients.length;
    if (successfulBets.length === totalExpected) {
      message = `✅ Bet placed on all ${totalExpected} profile(s): ${finalSelection} @ ${finalOdds} - $${betWager}`;
    } else if (successfulBets.length > 0) {
      const successProfiles = successfulBets.map(r => r.profileName).join(', ');
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `⚠️ Bet placed on ${successfulBets.length}/${totalExpected} profile(s). Success: ${successProfiles}. Failed: ${failProfiles}`;
    } else {
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `❌ Bet failed on all profiles: ${failProfiles}`;
    }
    
    // Warn if some clients weren't ready
    if (notReadyClients.length > 0) {
      message += ` (${notReadyClients.length} profile(s) not ready: ${notReadyClients.join(', ')})`;
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
      message: `Bet placed on ${successfulBets.length}/${totalExpected} profile(s)!`,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Prefire bet error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// BURN PREFIRE - Fast bet placement on all profiles (optimized for speed)
app.post('/api/burn-prefire', async (req, res) => {
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
  
  const betWager = wager || 10;
  // Cleaner logging like other bot
  const readyClients = [];
  for (const [profileName, client] of fliffClients.entries()) {
    if (client.page && client.browser) {
      readyClients.push({ name: profileName, client });
    }
  }
  
  if (readyClients.length === 0) {
    return res.status(500).json({ error: 'No clients ready' });
  }
  
  // Log which accounts are processing
  readyClients.forEach(({ name }) => {
    console.log(`🔥 ${name} processing BURN bet: BURN_PREFIRE_${oddId || 'unknown'}`);
  });
  
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
    
    // Place bets in parallel for maximum speed
    const profilePromises = readyClients.map(({ name: profileName, client }) => {
      return (async () => {
        try {
          // Check for bearer token from injection
          try {
            const injectedToken = await client.page.evaluate(() => {
              return window.__fliffBearerToken || null;
            });
            
            if (injectedToken && injectedToken !== client.bearerToken) {
              client.bearerToken = injectedToken;
              console.log(`🔑 Bearer token captured from injection: present`);
              client.saveAPICredentials();
            }
          } catch (e) {
            // Ignore if page context not ready
          }
          
          console.log(`💰 Placing bet (BURN)`);
          
          // Prefer API method for speed
          const apiStatus = client.getBettingAPIStatus();
          if (apiStatus.endpoint && apiStatus.hasAuth) {
            // Use API method (fastest)
            const betResult = await client.placeBetViaAPI(finalSelection, finalOdds, betWager, 'cash', finalParam, finalMarket, oddId);
            
            // Log result like other bot
            if (betResult.response) {
              console.log(`Response: ${betResult.response.status || 200}`);
              console.log(`Final result: ${JSON.stringify({ status: betResult.response.status, hasPickResult: betResult.response.hasPickResult || false })}`);
              
              if (betResult.response.status === 8301) {
                console.log(`✅ ${profileName} burn successful (8301 as expected)`);
              }
            }
            
            return {
              profileName,
              success: betResult.success,
              retry: betResult.oddsChanged,
              error: betResult.error,
              method: 'api',
              status: betResult.response?.status
            };
          } else {
            // Fallback to regular placeBet
            const betResult = await client.placeBet(finalSelection, finalOdds, betWager, 'cash', finalParam, finalMarket, oddId);
            return {
              profileName,
              success: betResult.success,
              retry: betResult.oddsChanged,
              error: betResult.error,
              method: 'puppeteer'
            };
          }
        } catch (e) {
          return {
            profileName,
            success: false,
            retry: false,
            error: e.message,
            method: 'error'
          };
        }
      })();
    });
    
    const results = await Promise.all(profilePromises);
    const successfulBets = results.filter(r => r.success);
    const failedBets = results.filter(r => !r.success);
    const oddsChangedBets = results.filter(r => r.retry);
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += betWager * successfulBets.length;
    
    setImmediate(() => saveLogs());
    
    if (oddsChangedBets.length > 0) {
      return res.json({ 
        success: false, 
        retry: true, 
        message: `Odds changed on ${oddsChangedBets.length} profile(s)`,
        profileResults: results
      });
    }
    
    return res.json({ 
      success: successfulBets.length > 0, 
      message: `Burn prefire: ${successfulBets.length}/${readyClients.length} successful`,
      profileResults: results
    });
    
  } catch (e) {
    console.error('Burn prefire error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// LOCK AND LOAD - Places $0.20 bet with Cash and refreshes page during submission to lock odds
// Now works with ALL profiles - only shows "locked and loaded" when ALL profiles' odds don't change
app.post('/api/lock-and-load', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  
  const { gameId, oddId, selection, odds, param, market, reloadPage } = req.body;
  
  if (!selection || odds === undefined) {
    return res.status(400).json({ error: 'Missing selection or odds' });
  }
  
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
    const lockWager = 0.20; // Always use $0.20 for lock and load
  // Lock and load captures the exact API request and saves it - no page reload needed!
  // When placing the actual bet, we reuse that locked API request (only changing wager amount)
  logBetting(`🔒 LOCK & LOAD (${fliffClients.size} profile(s)): ${selection} @ ${odds} - $${lockWager} (Cash) [capturing locked API request]`);
  
  try {
    const gameOddsMap = gameOdds.get(parseInt(gameId));
    let finalSelection = selection;
    let finalOdds = odds;
    let finalParam = param;
    let finalMarket = market;
    
    // Normalize odds to number format
    if (typeof finalOdds === 'string') {
      finalOdds = finalOdds.startsWith('+') ? parseInt(finalOdds.substring(1)) : parseInt(finalOdds);
    }
    
    if (gameOddsMap) {
      const storedOdd = gameOddsMap.get(oddId);
      if (storedOdd) {
        finalSelection = storedOdd.selection || selection;
        // Ensure stored odds is a number
        const storedOdds = storedOdd.odds;
        if (typeof storedOdds === 'string') {
          finalOdds = storedOdds.startsWith('+') ? parseInt(storedOdds.substring(1)) : parseInt(storedOdds);
        } else {
          finalOdds = storedOdds || finalOdds;
        }
        finalParam = storedOdd.param || param;
        finalMarket = storedOdd.market || market;
      }
    }
    
    // Verify all clients are ready
    const readyClients = [];
    const notReadyClients = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      // Only use betting profiles for placing bets
      if (client.isLiveEventProfile) {
        continue; // Skip live event profiles
      }
      if (!client.page || !client.browser) {
        notReadyClients.push(profileName);
        logBetting(`   ⚠️ [${profileName}] Client not ready (no page/browser)`);
        continue;
      }
      readyClients.push({ name: profileName, client });
    }
    
    if (readyClients.length === 0) {
      logBetting(`   ❌ No clients ready for lock & load!`);
      return res.status(500).json({ 
        error: 'No clients ready', 
        notReady: notReadyClients,
        totalClients: fliffClients.size
      });
    }
    
    if (notReadyClients.length > 0) {
      logBetting(`   ⚠️ ${notReadyClients.length} client(s) not ready: ${notReadyClients.join(', ')}`);
    }
    
    logBetting(`   ✅ ${readyClients.length} client(s) ready for lock & load`);
    logBetting(`   📋 Processing profiles: ${readyClients.map(c => c.name).join(', ')}`);
    
    // Send lock-and-load request to ALL ready profiles
    const profileResults = [];
    const profilePromises = [];
    
    for (const { name: profileName, client } of readyClients) {
      logBetting(`   [${profileName}] Starting lock & load: reload page, then place $${lockWager} bet via API...`);
      
      const profilePromise = (async () => {
        try {
          // Refresh bearer token from page before lock & load (tokens can expire/change)
          try {
            const injectedToken = await client.page.evaluate(() => {
              return window.__fliffBearerToken || null;
            });
            
            if (injectedToken && injectedToken !== client.bearerToken) {
              client.bearerToken = injectedToken;
              logBetting(`   [${profileName}] 🔑 Refreshed bearer token from page`);
              client.saveAPICredentials();
            } else if (!client.bearerToken && !client.authToken) {
              logBetting(`   [${profileName}] ⚠️ No bearer token or auth token available - may fail`);
            }
          } catch (e) {
            // Ignore if page context not ready, but log warning
            if (client.bearerToken || client.authToken) {
              logBetting(`   [${profileName}] ⚠️ Could not refresh token from page, using stored token`);
            } else {
              logBetting(`   [${profileName}] ⚠️ Could not refresh token and no stored token available`);
            }
          }
          
          // LOCK AND LOAD FLOW (Backend API Only - No UI):
          // 1. Place $0.20 bet via API directly (fast, no UI clicks)
          // 2. Immediately reload page to lock odds
          // 3. After reload, check if odds changed
          // 4. If odds didn't change, mark as successful
          
          logBetting(`   [${profileName}] Step 1: Placing $${lockWager} bet via API (backend only)...`);
          
          // Check if API is available
          const apiStatus = client.getBettingAPIStatus();
          if (!apiStatus.endpoint || !apiStatus.hasAuth) {
            logBetting(`   [${profileName}] ⚠️ API not available, falling back to UI method...`);
            // Fallback to UI method if API not available
            const lockAndLoadResult = await client.placeBetWithReload(finalSelection, finalOdds, lockWager, 'cash', finalParam, finalMarket, oddId);
            
            if (!lockAndLoadResult.betPlaced) {
              return {
                profileName,
                success: false,
                betPlaced: false,
                pageReloaded: false,
                oddsLocked: false,
                oddsChanged: false,
                lockedOdds: null,
                currentOdds: null,
                error: lockAndLoadResult.error || 'Bet placement failed'
              };
            }
            
            if (lockAndLoadResult.oddsChanged) {
              return {
                profileName,
                success: false,
                betPlaced: true,
                pageReloaded: true,
                oddsLocked: false,
                oddsChanged: true,
                lockedOdds: finalOdds,
                currentOdds: lockAndLoadResult.currentOdds,
                error: `Odds changed: ${lockAndLoadResult.currentOdds}`
              };
            }
            
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: true,
              oddsLocked: true,
              oddsChanged: false,
              lockedOdds: finalOdds,
              currentOdds: finalOdds,
              error: null,
              method: 'puppeteer'
            };
          }
          
          // API METHOD: Place $0.20 bet via API and capture the exact request
          // This request will be saved and reused for the actual bet (locks odds without reload!)
          logBetting(`   [${profileName}] Placing $${lockWager} bet via API to capture locked request...`);
          const betResult = await client.placeBetViaAPI(finalSelection, finalOdds, lockWager, 'cash', finalParam, finalMarket, oddId, false);
          
          if (!betResult.success) {
            logBetting(`   [${profileName}] ❌ API bet failed: ${betResult.error}`);
            return {
              profileName,
              success: false,
              betPlaced: false,
              pageReloaded: false, // No reload needed with locked API
              oddsLocked: false,
              oddsChanged: false,
              lockedOdds: null,
              currentOdds: null,
              error: betResult.error || 'API bet failed',
              marketNotAvailable: betResult.marketNotAvailable || false
            };
          }
          
          // Check if locked request was saved
          const hasLockedRequest = client.getLockedAPIRequest(oddId);
          if (hasLockedRequest) {
            logBetting(`   [${profileName}] ✅ Lock & Load successful! API request captured and locked for oddId: ${oddId}`);
            logBetting(`   [${profileName}]    No page reload needed - odds are locked via API request`);
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: false, // No reload needed!
              oddsLocked: true, // Locked via API request
              oddsChanged: false,
              lockedOdds: finalOdds,
              currentOdds: finalOdds,
              error: null,
              method: 'api_locked'
            };
          } else {
            // Fallback: bet was placed but request wasn't captured
            logBetting(`   [${profileName}] ⚠️ Bet placed but locked request not captured`);
            return {
              profileName,
              success: true,
              betPlaced: true,
              pageReloaded: false,
              oddsLocked: false, // Can't verify without locked request
              oddsChanged: false,
              lockedOdds: finalOdds,
              currentOdds: finalOdds,
              error: null,
              method: 'api'
            };
          }
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          return {
            profileName,
            success: false,
            betPlaced: false,
            pageReloaded: false, // Reload would have failed if bet failed
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
      // Determine result status: if bet was placed successfully, it's locked (even if element not found)
      let resultStatus = 'unknown';
      if (r.betPlaced && r.success) {
        // If bet was placed successfully, it's locked (API accepted it)
        // Only mark as 'odds_changed' if odds actually changed, otherwise it's locked
        resultStatus = r.oddsChanged ? 'odds_changed' : 'locked'; // Changed 'placed' to 'locked' since bet was accepted
      } else if (r.oddsChanged) {
        resultStatus = 'odds_changed';
      } else if (!r.success) {
        resultStatus = 'failed';
      }
      
      logBet({
        type: 'lock_and_load',
        selection: finalSelection,
        odds: finalOdds,
        wager: lockWager,
        coinType: 'cash',
        profile: r.profileName,
        result: resultStatus,
        timestamp: Date.now()
      });
      
      // Normalize odds format for display (always show + for positive odds)
      const displayOdds = typeof finalOdds === 'number' 
        ? (finalOdds > 0 ? `+${finalOdds}` : finalOdds.toString())
        : finalOdds;
      
      // Log final status (matching other bot format)
      if (resultStatus === 'locked') {
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = armed`);
      } else if (resultStatus === 'odds_changed') {
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = failed`);
      } else if (resultStatus === 'placed') {
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = armed`);
      } else {
        // For failed results, include error info
        const errorInfo = r.error ? ` (${r.error.substring(0, 50)})` : '';
        logBetting(`LOCK_AND_LOAD: ${finalSelection} @ ${displayOdds} = failed${errorInfo}`);
      }
    });
    
    accountStats.totalBets += results.filter(r => r.betPlaced).length;
    accountStats.totalWagered += lockWager * results.filter(r => r.betPlaced).length;
    
    // Only show "ARMED" if ALL profiles' odds are locked (don't change)
    // But if all bets were placed successfully, consider them locked (API accepted them)
    const allLocked = (allOddsLocked && !anyOddsChanged) || (allBetsPlaced && allProfilesSuccess);
    
    let message;
    if (allLocked) {
      const successCount = results.filter(r => r.betPlaced && r.success).length;
      message = `🔒 ARMED (${successCount}/${fliffClients.size} profiles): ${finalSelection} @ ${finalOdds} - Odds locked, ready to place bet!`;
    } else if (anyOddsChanged) {
      const changedProfiles = results.filter(r => r.oddsChanged).map(r => r.profileName);
      message = `❌ Lock & Load Failed (${changedProfiles.length} profile(s)): ${finalSelection} @ ${finalOdds} - Odds changed on: ${changedProfiles.join(', ')}`;
    } else if (allBetsPlaced) {
      const successCount = results.filter(r => r.betPlaced && r.success).length;
      message = `🔒 ARMED (${successCount}/${fliffClients.size} profiles): ${finalSelection} @ ${finalOdds} - All bets placed, ready to place bet!`;
    } else {
      const failedProfiles = results.filter(r => !r.success);
      const failedNames = failedProfiles.map(r => r.profileName);
      const failedErrors = failedProfiles
        .map(r => {
          const err = r.error || 'Unknown error';
          if (typeof err === 'string') return err;
          if (typeof err === 'object' && err !== null) {
            return err.message || err.error || JSON.stringify(err);
          }
          return String(err);
        })
        .filter(err => err && err !== 'Unknown error');
      
      if (failedErrors.length > 0) {
        message = `❌ Lock & Load Failed: ${failedNames.join(', ')} - ${failedErrors.join('; ')}`;
      } else {
        message = `❌ Lock & Load Failed: ${failedNames.join(', ')} - Unknown error`;
      }
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
      armed: allLocked, // ARMED status - ready to place bet
      message: allLocked 
        ? `🔒 ARMED! All ${fliffClients.size} profile(s) verified locked at ${finalOdds}. Ready to place bet!`
        : anyOddsChanged
          ? `❌ Lock & Load Failed. Odds changed on some profiles. Expected ${finalOdds}, but odds may have moved.`
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
    const errorMsg = e.message || e.toString() || 'Unknown error occurred during Lock & Load';
    return res.status(500).json({ error: errorMsg, details: e.stack });
  }
});

// RELOAD PAGE - Refresh page for all profiles or a specific profile
app.post('/api/reload-page', async (req, res) => {
  if (fliffClients.size === 0) {
    return res.status(500).json({ error: 'No Fliff profiles connected' });
  }
  
  const { profileName } = req.body || {};
  
  try {
    const profilesToReload = [];
    
    if (profileName) {
      // Reload specific profile
      const client = fliffClients.get(profileName);
      if (!client) {
        return res.status(404).json({ error: `Profile "${profileName}" not found` });
      }
      if (!client.page || !client.browser) {
        return res.status(500).json({ error: `Profile "${profileName}" not ready (no page/browser)` });
      }
      profilesToReload.push({ name: profileName, client });
    } else {
      // Reload all profiles
      for (const [name, client] of fliffClients.entries()) {
        if (client.page && client.browser) {
          profilesToReload.push({ name, client });
        }
      }
    }
    
    if (profilesToReload.length === 0) {
      return res.status(500).json({ error: 'No profiles ready to reload' });
    }
    
    logBetting(`🔄 RELOAD PAGE (${profilesToReload.length} profile(s))${profileName ? `: ${profileName}` : ' (all profiles)'}`);
    
    const reloadPromises = profilesToReload.map(({ name, client }) => 
      (async () => {
        try {
          const result = await client.reloadPage();
          logBetting(`   [${name}] ${result.success ? '✅ Page reloaded' : '❌ Reload failed: ' + (result.error || 'Unknown error')}`);
          return {
            profileName: name,
            success: result.success,
            error: result.error || null
          };
        } catch (e) {
          logBetting(`   [${name}] ❌ Reload error: ${e.message}`);
          return {
            profileName: name,
            success: false,
            error: e.message
          };
        }
      })()
    );
    
    const results = await Promise.all(reloadPromises);
    const allSuccess = results.every(r => r.success);
    const anySuccess = results.some(r => r.success);
    
    return res.json({
      success: allSuccess,
      message: allSuccess 
        ? `All ${results.length} profile(s) reloaded successfully`
        : anySuccess
          ? `Some profiles reloaded (${results.filter(r => r.success).length}/${results.length})`
          : 'All reloads failed',
      profileResults: results
    });
    
  } catch (e) {
    console.error('Reload page error:', e);
    return res.status(500).json({ error: e.message || 'Unknown error occurred during page reload' });
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
  
  // Log which profiles will receive the bet (only betting profiles)
  const bettingProfileNames = Array.from(fliffClients.entries())
    .filter(([name, client]) => !client.isLiveEventProfile)
    .map(([name]) => name);
  const bettingProfileCount = bettingProfileNames.length;
  logBetting(`💰 PLACE BET (${bettingProfileCount} profile(s)): ${selection} @ ${odds} - $${wager} (Cash)`);
  logBetting(`   Profiles: ${bettingProfileNames.join(', ')}`);
  
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
    
    // Verify all clients are ready
    const readyClients = [];
    const notReadyClients = [];
    
    for (const [profileName, client] of fliffClients.entries()) {
      // Only use betting profiles for placing bets
      if (client.isLiveEventProfile) {
        continue; // Skip live event profiles
      }
      if (!client.page || !client.browser) {
        notReadyClients.push(profileName);
        logBetting(`   ⚠️ [${profileName}] Client not ready (no page/browser)`);
        continue;
      }
      readyClients.push({ name: profileName, client });
    }
    
    if (readyClients.length === 0) {
      logBetting(`   ❌ No clients ready to place bets!`);
      return res.status(500).json({ 
        error: 'No clients ready', 
        notReady: notReadyClients,
        totalClients: fliffClients.size
      });
    }
    
    if (notReadyClients.length > 0) {
      logBetting(`   ⚠️ ${notReadyClients.length} client(s) not ready: ${notReadyClients.join(', ')}`);
    }
    
    logBetting(`   ✅ ${readyClients.length} client(s) ready to place bets`);
    logBetting(`   📋 Processing profiles: ${readyClients.map(c => c.name).join(', ')}`);
    
    for (const { name: profileName, client } of readyClients) {
      logBetting(`   [${profileName}] Placing bet: ${finalSelection} @ ${finalOdds} - $${wager} (Cash)`);
      
      // Check if client has betting endpoint or will use Puppeteer
      const apiStatus = client.getBettingAPIStatus();
      if (apiStatus.endpoint) {
        logBetting(`      Using API endpoint: ${apiStatus.endpoint.substring(0, 50)}...`);
      } else {
        logBetting(`      Using Puppeteer method (no API endpoint captured)`);
      }
      
      const profilePromise = (async () => {
        try {
          // Refresh bearer token from page before placing bet (tokens can expire/change)
          try {
            const injectedToken = await client.page.evaluate(() => {
              return window.__fliffBearerToken || null;
            });
            
            if (injectedToken && injectedToken !== client.bearerToken) {
              client.bearerToken = injectedToken;
              logBetting(`   [${profileName}] 🔑 Refreshed bearer token from page`);
              client.saveAPICredentials();
            } else if (!client.bearerToken && !client.authToken) {
              logBetting(`   [${profileName}] ⚠️ No bearer token or auth token available - may fail`);
            }
          } catch (e) {
            // Ignore if page context not ready, but log warning
            if (client.bearerToken || client.authToken) {
              logBetting(`   [${profileName}] ⚠️ Could not refresh token from page, using stored token`);
            } else {
              logBetting(`   [${profileName}] ⚠️ Could not refresh token and no stored token available`);
            }
          }
          
          // Check API status before placing bet
          const apiStatus = client.getBettingAPIStatus();
          if (!apiStatus.endpoint) {
            logBetting(`   [${profileName}] ⚠️ No API endpoint captured - will use Puppeteer method`);
          } else if (!apiStatus.hasAuth) {
            logBetting(`   [${profileName}] ⚠️ API endpoint found but no auth token - bet may fail`);
          } else {
            logBetting(`   [${profileName}] ✅ API ready: endpoint + auth token available`);
          }
          
          // Check if we have a locked API request for this oddId (from lock and load)
          const hasLockedRequest = client.getLockedAPIRequest(oddId);
          if (hasLockedRequest) {
            logBetting(`   [${profileName}] 🔒 Using locked API request for oddId: ${oddId} - odds are locked!`);
            // Use locked API request - only change the wager amount
            const betResult = await client.placeBetViaAPI(finalSelection, finalOdds, wager, 'cash', finalParam, finalMarket, oddId, true);
            
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
                message: `Bet placed (locked odds): ${finalSelection} @ ${finalOdds} - $${wager}`,
                error: null
              };
            }
            
            // Check for unauthorized error
            const errorMsg = betResult.error || '';
            const isUnauthorized = errorMsg.toLowerCase().includes('unauthorized') || 
                                  errorMsg.toLowerCase().includes('401') ||
                                  errorMsg.toLowerCase().includes('authentication');
            
            return {
              profileName,
              success: false,
              retry: isUnauthorized, // Retry if unauthorized (token might need refresh)
              message: 'Bet failed',
              error: errorMsg || 'Bet failed',
              marketNotAvailable: betResult.marketNotAvailable || false,
              unauthorized: isUnauthorized
            };
          }
          
          // No locked request - use regular place bet method
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
          
          // Check for unauthorized error
          const errorMsg = betResult.error || '';
          const isUnauthorized = errorMsg.toLowerCase().includes('unauthorized') || 
                                errorMsg.toLowerCase().includes('401') ||
                                errorMsg.toLowerCase().includes('authentication');
          
          return {
            profileName,
            success: false,
            retry: isUnauthorized,
            message: 'Bet failed',
            error: errorMsg || 'Bet failed',
            unauthorized: isUnauthorized
          };
        } catch (e) {
          logBetting(`   [${profileName}] ❌ Error: ${e.message}`);
          const errorMsg = e.message || '';
          const isUnauthorized = errorMsg.toLowerCase().includes('unauthorized') || 
                                errorMsg.toLowerCase().includes('401') ||
                                errorMsg.toLowerCase().includes('authentication');
          
          return {
            profileName,
            success: false,
            retry: isUnauthorized,
            message: 'Error',
            error: errorMsg,
            unauthorized: isUnauthorized
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
    
    // Log detailed results
    const unauthorizedBets = results.filter(r => r.unauthorized);
    logBetting(`\n📊 Bet Results Summary:`);
    logBetting(`   Total profiles attempted: ${results.length}`);
    logBetting(`   Successful: ${successfulBets.length}`);
    logBetting(`   Failed: ${failedBets.length}`);
    logBetting(`   Odds changed: ${oddsChangedBets.length}`);
    if (unauthorizedBets.length > 0) {
      logBetting(`   🔐 Unauthorized: ${unauthorizedBets.length} (bearer token may be expired)`);
    }
    
    if (successfulBets.length > 0) {
      logBetting(`   ✅ Success on: ${successfulBets.map(r => r.profileName).join(', ')}`);
    }
    if (failedBets.length > 0) {
      failedBets.forEach(r => {
        const errorType = r.unauthorized ? '🔐 UNAUTHORIZED' : '❌';
        logBetting(`   ${errorType} Failed on ${r.profileName}: ${r.error || 'Unknown error'}`);
        if (r.unauthorized) {
          logBetting(`      → Bearer token may be expired or invalid. Try refreshing the page for this profile.`);
        }
      });
    }
    if (oddsChangedBets.length > 0) {
      logBetting(`   ⚠️ Odds changed on: ${oddsChangedBets.map(r => r.profileName).join(', ')}`);
    }
    if (unauthorizedBets.length > 0) {
      logBetting(`   🔐 Unauthorized errors on: ${unauthorizedBets.map(r => r.profileName).join(', ')}`);
      logBetting(`      → These profiles may need to refresh their bearer tokens.`);
    }
    
    // Update stats
    accountStats.totalBets += successfulBets.length;
    accountStats.pending += successfulBets.length;
    accountStats.totalWagered += wager * successfulBets.length;
    
    // Build message
    let message;
    const totalExpected = readyClients.length;
    if (successfulBets.length === totalExpected) {
      message = `✅ Bet placed on all ${totalExpected} profile(s): ${finalSelection} @ ${finalOdds} - $${wager}`;
    } else if (successfulBets.length > 0) {
      const successProfiles = successfulBets.map(r => r.profileName).join(', ');
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `⚠️ Bet placed on ${successfulBets.length}/${totalExpected} profile(s). Success: ${successProfiles}. Failed: ${failProfiles}`;
    } else {
      const failProfiles = failedBets.map(r => r.profileName).join(', ');
      message = `❌ Bet failed on all profiles: ${failProfiles}`;
    }
    
    // Warn if some clients weren't ready
    if (notReadyClients.length > 0) {
      message += ` (${notReadyClients.length} profile(s) not ready: ${notReadyClients.join(', ')})`;
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
// HELPER FUNCTIONS
// =============================================

// Verify that a bet was actually placed by checking API response
async function verifyBetPlaced(client, betResult, selection, odds) {
  // If bet was placed via API, check the response
  if (betResult.response) {
    const response = betResult.response;
    const status = response.status || response.result?.status;
    
    // Status 8301 and 8300 = confirmed placed (as seen in other bots)
    if (status === 8301 || status === '8301' || status === 8300 || status === '8300') {
      return {
        confirmed: true,
        status: status,
        reason: `API confirmed (status ${status})`
      };
    }
    
    // Other success indicators
    if (response.id || response.bet_id || response.ticket_id) {
      return {
        confirmed: true,
        status: status || 'success',
        reason: 'API returned bet ID'
      };
    }
    
    // If status exists but not 8301, still consider it placed if HTTP was 200
    if (status && betResult.success) {
      return {
        confirmed: true,
        status: status,
        reason: `API returned status ${status}`
      };
    }
    
    // If no status but response exists and success=true, assume placed
    if (betResult.success && !response.error) {
      return {
        confirmed: true,
        status: 'unknown',
        reason: 'API returned success but no status code'
      };
    }
  }
  
  // If bet was placed via Puppeteer, we can't verify easily
  if (betResult.success && !betResult.response) {
    return {
      confirmed: false,
      status: null,
      reason: 'Placed via Puppeteer - cannot verify via API'
    };
  }
  
  return {
    confirmed: false,
    status: null,
    reason: 'No response data or bet failed'
  };
}

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
  try {
    broadcastToGame(gid, { type: 'odd', gameId: gid, odd });
    
    // Also broadcast to all clients for live feed
    broadcast({ type: 'odd_update', gameId: gid, odd });
  } catch (e) {
    // Log but don't fail - odds updates should continue even if broadcast fails
    console.error(`⚠️ Error broadcasting odds update for game ${gid}:`, e.message);
  }
}

function handleStats(newStats) {
  stats = { ...stats, ...newStats };
  broadcast({ type: 'stats', stats });
}

// =============================================
// PROFILE DISCOVERY
// =============================================

function discoverProfiles() {
  const liveEventProfiles = [];
  const bettingProfiles = [];
  const profilesDir = path.join(__dirname, '..', 'profiles');
  
  // Directories to exclude from profile discovery
  const excludedDirs = new Set([
    'node_modules',
    'backend',
    'frontend',
    'assets',
    '.git',
    '.vscode',
    '.idea'
  ]);
  
  console.log('🔍 Discovering profiles...');
  
  // Check if profiles directory exists
  if (!fs.existsSync(profilesDir)) {
    console.log('⚠️ Profiles directory not found, creating it...');
    fs.mkdirSync(profilesDir, { recursive: true });
    return { liveEvent: liveEventProfiles, betting: bettingProfiles };
  }
  
  // Check for profile directories in profiles folder
  const items = fs.readdirSync(profilesDir, { withFileTypes: true });
  
  for (const item of items) {
    // Skip if not a directory or in excluded list
    if (!item.isDirectory() || item.name.startsWith('.') || excludedDirs.has(item.name)) {
      continue;
    }
    
    const settingsPath = path.join(profilesDir, item.name, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const profileName = settings.name || item.name;
        const profileData = {
          name: profileName,
          directory: path.join('profiles', item.name),
          settings: settings,
          settingsPath: settingsPath
        };
        
        // Determine if this is a live event profile or betting profile
        // Live Event profiles: name contains "Live Event" or "live" (case insensitive) OR no account_number
        // Betting profiles: have account_number set and not empty
        const isLiveEvent = item.name.toLowerCase().includes('live event') || 
                           item.name.toLowerCase().includes('liveevent') ||
                           profileName.toLowerCase().includes('live event') ||
                           !settings.account_number || 
                           settings.account_number === '' ||
                           settings.account_number === null;
        
        if (isLiveEvent) {
          liveEventProfiles.push(profileData);
          console.log(`   📡 Found LIVE EVENT profile: ${profileName} (${item.name}) - for data scraping only`);
        } else {
          bettingProfiles.push(profileData);
          console.log(`   💰 Found BETTING profile: ${profileName} (${item.name}) - account: ${settings.account_number || 'N/A'}`);
        }
      } catch (e) {
        console.log(`   ⚠️ Could not load profile ${item.name}: ${e.message}`);
      }
    }
  }
  
  console.log(`\n📋 Total profiles discovered:`);
  console.log(`   📡 Live Event (scraping only): ${liveEventProfiles.length}`);
  console.log(`   💰 Betting (with accounts): ${bettingProfiles.length}\n`);
  
  return { liveEvent: liveEventProfiles, betting: bettingProfiles };
}

// =============================================
// START
// =============================================

async function startFliff() {
  // Discover all profiles (separated into live event and betting)
  const { liveEvent: liveEventProfiles, betting: bettingProfiles } = discoverProfiles();
  
  const allProfiles = [...liveEventProfiles, ...bettingProfiles];
  
  if (allProfiles.length === 0) {
    console.log('⚠️ No profiles found, using default ray profile');
    // Fallback to default - check if profiles/ray exists
    const defaultSettingsPath = path.join(__dirname, '..', 'profiles', 'ray', 'settings.json');
    if (!fs.existsSync(defaultSettingsPath)) {
      console.log('❌ Default profile not found at profiles/ray/settings.json');
      return;
    }
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
    }, 'ray'); // Pass 'ray' as profile directory for fallback
    
    await fliffClient.start();
    fliffClients.set('default', fliffClient);
    return;
  }
  
  console.log(`\n📋 Starting ${allProfiles.length} profile(s):`);
  console.log(`   📡 Live Event profiles: ${liveEventProfiles.length} (data scraping only)`);
  console.log(`   💰 Betting profiles: ${bettingProfiles.length} (with logged-in accounts)`);
  console.log('');
  
  // Track which profiles failed to start
  const failedProfiles = [];
  
  // Start all profiles with delays to avoid conflicts
  // With many profiles, use shorter delays but still stagger them
  const delayBetweenProfiles = Math.max(2000, Math.min(3000, 3000 / Math.sqrt(allProfiles.length))); // Adaptive delay
  
  for (let i = 0; i < allProfiles.length; i++) {
    const profile = allProfiles[i];
    const isLiveEvent = liveEventProfiles.includes(profile);
    try {
      // Add delay between profile startups to avoid browser conflicts
      if (i > 0) {
        const delay = delayBetweenProfiles * i; // Staggered delay
        console.log(`⏳ [${i + 1}/${allProfiles.length}] Waiting ${(delay/1000).toFixed(1)}s before starting ${profile.name}...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      const profileType = isLiveEvent ? '📡 LIVE EVENT' : '💰 BETTING';
      console.log(`🚀 [${i + 1}/${allProfiles.length}] Starting ${profileType} profile: ${profile.name}...`);
      
      // Extract profile directory name from profile.directory (e.g., "profiles/justin-voneck" -> "justin-voneck")
      const profileDirName = path.basename(profile.directory);
      
      // Create a FliffClient with profile-specific directory
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
          broadcast({ type: 'connected', profile: profile.name, profileType: isLiveEvent ? 'liveEvent' : 'betting' });
        },
        onDisconnect: () => {
          broadcast({ type: 'disconnected', profile: profile.name, profileType: isLiveEvent ? 'liveEvent' : 'betting' });
        }
      }, profileDirName);
      
      // Mark client as live event or betting profile
      client.isLiveEventProfile = isLiveEvent;
      client.isBettingProfile = !isLiveEvent;
      
      // Override settings to use profile-specific settings
      client.settings = profile.settings;
      
      // Reload API credentials with profile-specific path (now handled by FliffClient constructor)
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
          
          // Check for lockfile that might indicate browser is already running
          const lockfilePath = path.join(browserDataPath, 'lockfile');
          if (fs.existsSync(lockfilePath)) {
            console.log(`⚠️ [${profile.name}] Lockfile found - browser may already be running for this profile`);
            console.log(`   Attempting to continue anyway...`);
            // Try to remove lockfile (it's safe if browser isn't actually running)
            try {
              fs.unlinkSync(lockfilePath);
              console.log(`   ✅ Removed stale lockfile`);
            } catch (e) {
              console.log(`   ⚠️ Could not remove lockfile (browser may be running): ${e.message}`);
            }
          }
          
          // Check for DevToolsActivePort which might indicate browser is running
          const devToolsPortPath = path.join(browserDataPath, 'DevToolsActivePort');
          if (fs.existsSync(devToolsPortPath)) {
            try {
              const portContent = fs.readFileSync(devToolsPortPath, 'utf8').trim();
              if (portContent) {
                console.log(`⚠️ [${profile.name}] DevToolsActivePort file exists - browser may be running`);
                console.log(`   Port: ${portContent}`);
              }
            } catch (e) {
              // Ignore read errors
            }
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

          // Mobile emulation - MUST be set before CDP session
          const mobileUserAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
          await this.page.setUserAgent(mobileUserAgent);
          await this.page.setViewport({
            width: 375,
            height: 812,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true
          });
          
          // Also use emulate for additional mobile features
          await this.page.emulate({
            viewport: { 
              width: 375, 
              height: 812, 
              deviceScaleFactor: 3, 
              isMobile: true, 
              hasTouch: true 
            },
            userAgent: mobileUserAgent
          });
          
          console.log(`📱 [${profile.name}] Mobile emulation enabled`);

          // CDP for WebSocket interception
          this.cdp = await this.page.target().createCDPSession();
          await this.cdp.send('Network.enable');

          // ALWAYS set geolocation override (use settings or defaults)
          // This prevents geolocation check prompts
          const defaultLat = 40.7132; // New York default
          const defaultLon = -74.0061;
          const defaultAcc = 75;
          
          const geoLat = this.settings.latitude ? parseFloat(this.settings.latitude) : defaultLat;
          const geoLon = this.settings.longitude ? parseFloat(this.settings.longitude) : defaultLon;
          const geoAcc = this.settings.accuracy ? parseFloat(this.settings.accuracy) : defaultAcc;
          
          try {
            await this.cdp.send('Emulation.setGeolocationOverride', {
              latitude: geoLat,
              longitude: geoLon,
              accuracy: geoAcc
            });
            console.log(`📍 [${profile.name}] Geolocation set: ${geoLat}, ${geoLon} (accuracy: ${geoAcc}m)`);
          } catch (e) {
            console.log(`⚠️ [${profile.name}] Could not set geolocation via CDP: ${e.message}`);
          }

          // Grant geolocation permissions BEFORE navigation
          const context = this.browser.defaultBrowserContext();
          try {
            await context.overridePermissions('https://sports.getfliff.com', ['geolocation']);
            console.log(`✅ [${profile.name}] Geolocation permissions granted`);
          } catch (e) {
            console.log(`⚠️ [${profile.name}] Could not override permissions: ${e.message}`);
          }

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

          // Inject geolocation override script - MUST be before navigation
          // This bypasses any geolocation checks by overriding the API
          await this.page.evaluateOnNewDocument((lat, lon, acc) => {
            // Override getCurrentPosition
            if (navigator.geolocation) {
              const originalGetCurrentPosition = navigator.geolocation.getCurrentPosition;
              navigator.geolocation.getCurrentPosition = function(success, error, options) {
                if (success) {
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
                return originalGetCurrentPosition ? originalGetCurrentPosition.call(this, success, error, options) : null;
              };
              
              // Override watchPosition
              const originalWatchPosition = navigator.geolocation.watchPosition;
              navigator.geolocation.watchPosition = function(success, error, options) {
                if (success) {
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
                return originalWatchPosition ? originalWatchPosition.call(this, success, error, options) : 1;
              };
            }
          }, geoLat, geoLon, geoAcc);
          
          console.log(`🔒 [${profile.name}] Geolocation bypass script injected`);

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
      
      try {
        await client.start();
        
        // Verify client actually started successfully
        if (!client.browser) {
          throw new Error('Browser failed to launch');
        }
        if (!client.page) {
          throw new Error('Page failed to initialize');
        }
        
        fliffClients.set(profile.name, client);
        
        // Set first client as primary for backward compatibility
        if (!fliffClient) {
          fliffClient = client;
        }
        
        console.log(`✅ [${i + 1}/${allProfiles.length}] Profile ${profile.name} started successfully`);
        console.log(`   Browser: ${client.browser ? '✅' : '❌'}, Page: ${client.page ? '✅' : '❌'}\n`);
        
        // Add a small delay after successful start to ensure stability
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (startError) {
        // If start() throws, it's a startup error
        throw new Error(`Startup failed: ${startError.message}`);
      }
    } catch (e) {
      failedProfiles.push({ 
        name: profile.name, 
        directory: profile.directory,
        error: e.message, 
        stack: e.stack 
      });
      console.error(`\n❌ [${i + 1}/${allProfiles.length}] Failed to start profile ${profile.name}:`);
      console.error(`   Directory: ${profile.directory}`);
      console.error(`   Error: ${e.message}`);
      
      // Provide more specific error messages
      if (e.message.includes('Chrome not found') || e.message.includes('Chrome/Chromium not found')) {
        console.error(`   💡 Issue: Chrome browser not found. Please install Google Chrome.`);
      } else if (e.message.includes('Navigation failed') || e.message.includes('timeout')) {
        console.error(`   💡 Issue: Page navigation failed. Check proxy connection: ${profile.settings.proxy}`);
      } else if (e.message.includes('Browser failed to launch')) {
        console.error(`   💡 Issue: Browser process failed to start. Check browser data directory: ${path.join(__dirname, '..', profile.directory, 'browser_data')}`);
      } else if (e.message.includes('Page failed to initialize')) {
        console.error(`   💡 Issue: Page object not created. Browser may have crashed during startup.`);
      } else if (e.message.includes('proxy') || e.message.includes('Proxy')) {
        console.error(`   💡 Issue: Proxy connection problem. Verify proxy: ${profile.settings.proxy}`);
      }
      
      if (e.stack) {
        console.error(`   Stack trace:`, e.stack.split('\n').slice(0, 5).join('\n   '));
      }
      console.error('');
      // Continue with other profiles even if one fails
    }
  }
  
  console.log(`\n✅ Started ${fliffClients.size} profile(s) out of ${allProfiles.length} total`);
  if (failedProfiles.length > 0) {
    console.log(`\n❌ Failed to start ${failedProfiles.length} profile(s):`);
    failedProfiles.forEach(fp => {
      console.log(`   - ${fp.name}: ${fp.error}`);
    });
  }
  
  // List all successfully started profiles
  console.log(`\n📋 Successfully started profiles:`);
  fliffClients.forEach((client, name) => {
    console.log(`   ✅ ${name}`);
  });
  console.log('');
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
  console.log('  POST /api/prefire        - Place bet (all profiles)');
  console.log('  POST /api/place-bet      - Place bet (all profiles)');
  console.log('  POST /api/burn-prefire   - Burn prefire (fast bet, all profiles)');
  console.log('  POST /api/lock-and-load  - Lock & Load (all profiles)');
  console.log('  POST /api/reload-page    - Reload page (all profiles or specific)');
  console.log('  GET  /api/status         - Server & profile status');
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
