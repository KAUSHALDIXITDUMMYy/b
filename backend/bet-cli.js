#!/usr/bin/env node

/**
 * Command-line interface for placing bets via backend
 * Usage:
 *   node bet-cli.js prefire <gameId> <oddId> <selection> <odds> [wager] [param] [market]
 *   node bet-cli.js lock-and-load <gameId> <oddId> <selection> <odds> [param] [market]
 *   node bet-cli.js place-bet <gameId> <oddId> <selection> <odds> <wager> [coinType] [param] [market]
 */

const http = require('http');

const API_URL = 'http://localhost:3001';
const API_PORT = 3001;

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${API_PORT}`);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function prefire(gameId, oddId, selection, odds, wager = 10, param = null, market = null) {
  console.log(`🚀 PREFIRE: ${selection} @ ${odds} - $${wager}`);
  console.log(`   Game ID: ${gameId}, Odd ID: ${oddId}`);
  
  const result = await makeRequest('/api/prefire', 'POST', {
    gameId: parseInt(gameId),
    oddId: oddId,
    selection: selection,
    odds: parseFloat(odds),
    wager: parseFloat(wager),
    param: param,
    market: market
  });
  
  console.log(`\n📊 Result:`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Message: ${result.data.message || 'N/A'}`);
  if (result.data.profileResults) {
    result.data.profileResults.forEach(r => {
      console.log(`   [${r.profileName}]: ${r.success ? '✅' : '❌'} ${r.message || r.error || 'N/A'}`);
    });
  }
  
  return result;
}

async function lockAndLoad(gameId, oddId, selection, odds, param = null, market = null) {
  console.log(`🔒 LOCK & LOAD: ${selection} @ ${odds}`);
  console.log(`   Game ID: ${gameId}, Odd ID: ${oddId}`);
  
  const result = await makeRequest('/api/lock-and-load', 'POST', {
    gameId: parseInt(gameId),
    oddId: oddId,
    selection: selection,
    odds: parseFloat(odds),
    param: param,
    market: market
  });
  
  console.log(`\n📊 Result:`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Success: ${result.data.success ? '✅' : '❌'}`);
  console.log(`   Armed: ${result.data.armed ? '🔒 ARMED' : '❌ NOT ARMED'}`);
  console.log(`   Message: ${result.data.message || 'N/A'}`);
  if (result.data.profileResults) {
    result.data.profileResults.forEach(r => {
      const status = r.oddsLocked ? '🔒 LOCKED' : (r.oddsChanged ? '⚠️ CHANGED' : (r.success ? '✅ PLACED' : '❌ FAILED'));
      console.log(`   [${r.profileName}]: ${status} - ${r.message || r.error || 'N/A'}`);
    });
  }
  
  return result;
}

async function placeBet(gameId, oddId, selection, odds, wager, coinType = 'cash', param = null, market = null) {
  console.log(`💰 PLACE BET: ${selection} @ ${odds} - $${wager} (${coinType})`);
  console.log(`   Game ID: ${gameId}, Odd ID: ${oddId}`);
  
  const result = await makeRequest('/api/place-bet', 'POST', {
    gameId: parseInt(gameId),
    oddId: oddId,
    selection: selection,
    odds: parseFloat(odds),
    wager: parseFloat(wager),
    coinType: coinType,
    param: param,
    market: market
  });
  
  console.log(`\n📊 Result:`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Message: ${result.data.message || 'N/A'}`);
  if (result.data.profileResults) {
    result.data.profileResults.forEach(r => {
      console.log(`   [${r.profileName}]: ${r.success ? '✅' : '❌'} ${r.message || r.error || 'N/A'}`);
    });
  }
  
  return result;
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.log(`
Usage:
  node bet-cli.js prefire <gameId> <oddId> <selection> <odds> [wager] [param] [market]
  node bet-cli.js lock-and-load <gameId> <oddId> <selection> <odds> [param] [market]
  node bet-cli.js place-bet <gameId> <oddId> <selection> <odds> <wager> [coinType] [param] [market]

Examples:
  node bet-cli.js prefire 348339 "7987992_p_399_inplay" "Over 6.5" 125 10 "6.5" "TOTAL SCORE"
  node bet-cli.js lock-and-load 348339 "7987992_p_399_inplay" "Over 6.5" 125 "6.5" "TOTAL SCORE"
  node bet-cli.js place-bet 348339 "7987992_p_399_inplay" "Over 6.5" 125 10 cash "6.5" "TOTAL SCORE"
  `);
  process.exit(1);
}

(async () => {
  try {
    if (command === 'prefire') {
      const [gameId, oddId, selection, odds, wager = 10, param = null, market = null] = args.slice(1);
      if (!gameId || !oddId || !selection || !odds) {
        console.error('❌ Missing required arguments: gameId, oddId, selection, odds');
        process.exit(1);
      }
      await prefire(gameId, oddId, selection, odds, wager, param, market);
    } else if (command === 'lock-and-load' || command === 'lockandload') {
      const [gameId, oddId, selection, odds, param = null, market = null] = args.slice(1);
      if (!gameId || !oddId || !selection || !odds) {
        console.error('❌ Missing required arguments: gameId, oddId, selection, odds');
        process.exit(1);
      }
      await lockAndLoad(gameId, oddId, selection, odds, param, market);
    } else if (command === 'place-bet' || command === 'placebet') {
      const [gameId, oddId, selection, odds, wager, coinType = 'cash', param = null, market = null] = args.slice(1);
      if (!gameId || !oddId || !selection || !odds || !wager) {
        console.error('❌ Missing required arguments: gameId, oddId, selection, odds, wager');
        process.exit(1);
      }
      await placeBet(gameId, oddId, selection, odds, wager, coinType, param, market);
    } else {
      console.error(`❌ Unknown command: ${command}`);
      console.error('Available commands: prefire, lock-and-load, place-bet');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
})();

