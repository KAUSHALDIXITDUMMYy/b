/**
 * Test script to place bets directly from backend without frontend
 * 
 * Usage:
 *   node test-bet.js
 * 
 * Or use curl:
 *   curl -X POST http://localhost:3001/api/prefire \
 *     -H "Content-Type: application/json" \
 *     -d '{"gameId": 123, "oddId": "456", "selection": "Over 45.5", "odds": -110, "wager": 10, "coinType": "cash", "param": "45.5", "market": "Game Total"}'
 */

const http = require('http');

// Configuration
const API_BASE = 'http://localhost:3001';
const ENDPOINTS = {
  status: '/api/status',
  games: '/api/games',
  prefire: '/api/prefire',
  placeBet: '/api/place-bet',
  lockAndLoad: '/api/lock-and-load'
};

// Helper function to make HTTP requests
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
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
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', (e) => reject(e));

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// Test functions
async function checkStatus() {
  console.log('\n📊 Checking server status...');
  const result = await makeRequest('GET', ENDPOINTS.status);
  console.log('Status:', result.status);
  console.log('Profiles:', result.data.profiles);
  return result.data;
}

async function getGames() {
  console.log('\n🎮 Getting live games...');
  const result = await makeRequest('GET', ENDPOINTS.games);
  console.log(`Found ${result.data.length} live games`);
  if (result.data.length > 0) {
    console.log('First game:', result.data[0]);
    return result.data[0];
  }
  return null;
}

async function placeBet(betData) {
  console.log('\n💰 Placing bet via /api/prefire...');
  console.log('Bet data:', betData);
  const result = await makeRequest('POST', ENDPOINTS.prefire, betData);
  console.log('Result:', result);
  return result;
}

async function placeBetDirect(betData) {
  console.log('\n💰 Placing bet via /api/place-bet...');
  console.log('Bet data:', betData);
  const result = await makeRequest('POST', ENDPOINTS.placeBet, betData);
  console.log('Result:', result);
  return result;
}

async function lockAndLoad(betData) {
  console.log('\n🔒 Lock & Load...');
  console.log('Bet data:', betData);
  const result = await makeRequest('POST', ENDPOINTS.lockAndLoad, betData);
  console.log('Result:', result);
  return result;
}

// Main test function
async function main() {
  console.log('🧪 Testing Fliff Betting API');
  console.log('═'.repeat(60));

  try {
    // Check status
    const status = await checkStatus();
    
    if (status.profiles.total === 0) {
      console.log('❌ No profiles connected!');
      return;
    }

    console.log(`\n✅ ${status.profiles.total} profile(s) connected`);
    console.log(`   ${status.profiles.ready} ready`);
    
    // Get games
    const game = await getGames();
    
    if (!game) {
      console.log('\n⚠️ No live games available. You need to provide game data manually.');
      console.log('\nExample bet request:');
      console.log(JSON.stringify({
        gameId: 123,
        oddId: "456789",
        selection: "Over 45.5",
        odds: -110,
        wager: 10,
        coinType: "cash",
        param: "45.5",
        market: "Game Total"
      }, null, 2));
      return;
    }

    // Example bet - you'll need to adjust these values based on actual game data
    const exampleBet = {
      gameId: game.id,
      oddId: "example_odd_id", // You need to get this from /api/games/:id/odds
      selection: "Over 45.5",
      odds: -110,
      wager: 10,
      coinType: "cash",
      param: "45.5",
      market: "Game Total"
    };

    console.log('\n⚠️ To place a real bet, you need:');
    console.log('   1. A valid gameId (from /api/games)');
    console.log('   2. A valid oddId (from /api/games/:id/odds)');
    console.log('   3. Selection, odds, param, and market from the odds data');
    console.log('\nExample usage:');
    console.log(`   node test-bet.js --gameId ${game.id} --oddId "123" --selection "Over 45.5" --odds -110 --wager 10`);

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length > 0) {
  const betData = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    let value = args[i + 1];
    // Try to parse as number
    if (value && !isNaN(value)) {
      value = parseFloat(value);
    }
    betData[key] = value;
  }

  if (betData.gameId && betData.oddId && betData.selection && betData.odds) {
    placeBet(betData).then(() => process.exit(0));
  } else {
    console.log('❌ Missing required fields: gameId, oddId, selection, odds');
    process.exit(1);
  }
} else {
  main().then(() => process.exit(0));
}

