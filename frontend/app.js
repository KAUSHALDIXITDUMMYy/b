// =============================================
// FLIFF LIVE BETTING - FRONTEND APP
// =============================================

const API_URL = 'http://localhost:3001';
const WS_URL = 'ws://localhost:3001';

// State
let ws = null;
let games = {};
let selectedGame = null;
let gameOdds = {};

// Betting Settings
let wagerAmount = 100; // Default $100 for Fliff Coin testing
let coinType = 'coin'; // 'coin' or 'cash'
let isPrefiring = false;

// =============================================
// INITIALIZATION
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  connectWebSocket();
  loadGames();
});

function loadSettings() {
  const savedWager = localStorage.getItem('fliff_wager');
  const savedCoinType = localStorage.getItem('fliff_coin_type');
  
  if (savedWager) {
    wagerAmount = parseFloat(savedWager);
    document.getElementById('wager-amount').value = savedWager;
  }
  
  if (savedCoinType) {
    coinType = savedCoinType;
    setCoinType(savedCoinType, false);
  }
  
  updateDisplays();
}

// =============================================
// SETTINGS CONTROLS
// =============================================

function setWager(value) {
  wagerAmount = parseFloat(value);
  localStorage.setItem('fliff_wager', value);
  updateDisplays();
}

function setCoinType(type, save = true) {
  coinType = type;
  
  document.getElementById('coin-btn').classList.toggle('active', type === 'coin');
  document.getElementById('cash-btn').classList.toggle('active', type === 'cash');
  
  // Update wager dropdown based on coin type
  const select = document.getElementById('wager-amount');
  
  if (type === 'cash') {
    // Fliff Cash: $0.20 - $500
    select.innerHTML = `
      <option value="0.20">$0.20</option>
      <option value="0.50">$0.50</option>
      <option value="1">$1</option>
      <option value="2">$2</option>
      <option value="5">$5</option>
      <option value="10" selected>$10</option>
      <option value="25">$25</option>
      <option value="50">$50</option>
      <option value="100">$100</option>
      <option value="200">$200</option>
      <option value="500">$500</option>
    `;
    wagerAmount = 10;
  } else {
    // Fliff Coin: $10 - $1000
    select.innerHTML = `
      <option value="10">$10</option>
      <option value="25">$25</option>
      <option value="50">$50</option>
      <option value="100" selected>$100</option>
      <option value="250">$250</option>
      <option value="500">$500</option>
      <option value="1000">$1000</option>
    `;
    wagerAmount = 100;
  }
  
  if (save) {
    localStorage.setItem('fliff_coin_type', type);
  }
  
  updateDisplays();
}

function updateDisplays() {
  document.getElementById('current-wager').textContent = wagerAmount.toFixed(2);
  
  const coinDisplay = document.getElementById('coin-type-display');
  if (coinType === 'cash') {
    coinDisplay.textContent = '💵 Cash';
    coinDisplay.classList.add('cash');
  } else {
    coinDisplay.textContent = '🪙 Coin';
    coinDisplay.classList.remove('cash');
  }
}

// =============================================
// WEBSOCKET CONNECTION
// =============================================

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.onopen = () => {
    console.log('✅ Connected to backend');
    updateStatus(true);
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMessage(data);
  };
  
  ws.onclose = () => {
    console.log('❌ Disconnected from backend');
    updateStatus(false);
    setTimeout(connectWebSocket, 3000);
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function handleMessage(data) {
  switch (data.type) {
    case 'init':
      data.games.forEach(game => {
        games[game.id] = game;
      });
      renderGames();
      break;
      
    case 'game':
      games[data.game.id] = data.game;
      renderGames();
      if (selectedGame && selectedGame.id === data.game.id) {
        renderScoreCard(data.game);
      }
      break;
      
    case 'score':
      games[data.game.id] = data.game;
      renderGames();
      if (selectedGame && selectedGame.id === data.game.id) {
        renderScoreCard(data.game);
      }
      break;
      
    case 'odds':
      // Ensure gameId is integer for consistent mapping
      const oddsGameId = parseInt(data.gameId);
      if (!gameOdds[oddsGameId]) {
        gameOdds[oddsGameId] = {};
      }
      data.odds.forEach(odd => {
        gameOdds[oddsGameId][odd.id] = odd;
      });
      console.log(`📊 Received ${data.odds.length} odds for game ${oddsGameId}`);
      if (selectedGame && parseInt(selectedGame.id) === oddsGameId) {
        renderOdds();
      }
      break;
      
    case 'odd':
      // Ensure gameId is integer
      const oddGameId = parseInt(data.gameId);
      if (!gameOdds[oddGameId]) {
        gameOdds[oddGameId] = {};
      }
      gameOdds[oddGameId][data.odd.id] = data.odd;
      console.log(`📊 Updated odd ${data.odd.id} for game ${oddGameId}`);
      if (selectedGame && parseInt(selectedGame.id) === oddGameId) {
        renderOdds();
      }
      break;
    
    case 'odd_update':
      // Live odds update from any game - ensure gameId is integer
      const updateGameId = parseInt(data.gameId);
      if (!gameOdds[updateGameId]) {
        gameOdds[updateGameId] = {};
        console.log(`📊 Created new odds map for game ${updateGameId}`);
      }
      gameOdds[updateGameId][data.odd.id] = data.odd;
      if (selectedGame && parseInt(selectedGame.id) === updateGameId) {
        renderOdds();
      }
      break;
      
    case 'prefire_result':
      handlePrefireResult(data);
      break;
      
    case 'connected':
      updateStatus(true);
      break;
      
    case 'disconnected':
      updateStatus(false);
      break;
  }
}

// =============================================
// API CALLS
// =============================================

async function loadGames() {
  try {
    const response = await fetch(`${API_URL}/api/games`);
    const data = await response.json();
    data.forEach(game => {
      games[game.id] = game;
    });
    renderGames();
  } catch (error) {
    console.error('Error loading games:', error);
  }
}

async function loadGameOdds(gameId) {
  // Ensure gameId is integer
  const gameIdInt = parseInt(gameId);
  console.log('📥 Loading odds for game:', gameIdInt);
  try {
    const response = await fetch(`${API_URL}/api/games/${gameIdInt}/odds`);
    const data = await response.json();
    console.log(`✅ Received ${data.length} odds for game ${gameIdInt}`);
    
    // Initialize if needed - use integer key
    if (!gameOdds[gameIdInt]) {
      gameOdds[gameIdInt] = {};
      console.log(`📊 Created new odds map for game ${gameIdInt}`);
    }
    
    // Merge new odds with existing (don't overwrite, just update)
    let newCount = 0;
    let updateCount = 0;
    data.forEach(odd => {
      if (!gameOdds[gameIdInt][odd.id]) {
        newCount++;
      } else {
        updateCount++;
      }
      gameOdds[gameIdInt][odd.id] = odd;
    });
    
    console.log(`📊 Game ${gameIdInt} odds: ${newCount} new, ${updateCount} updated, ${Object.keys(gameOdds[gameIdInt]).length} total`);
    
    // Log sample of what we received
    if (data.length > 0) {
      console.log('📋 Sample odds received:', data.slice(0, 3).map(o => ({
        id: o.id,
        market: o.market,
        selection: o.selection?.substring(0, 30),
        param: o.param,
        event: o.event?.substring(0, 30)
      })));
    }
    
    renderOdds();
  } catch (error) {
    console.error('❌ Error loading odds:', error);
  }
}

// =============================================
// PREFIRE BETTING - Auto on first click
// =============================================

// Helper function to generate bet buttons HTML
function getBetButtonsHTML(oddId) {
  return `
    <div class="d-flex gap-1 mt-2" style="gap: 4px;">
      <button class="btn btn-sm btn-warning flex-fill" onclick="lockAndLoad('${oddId}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600;">
        🔒 Lock & Load
      </button>
      <button class="btn btn-sm btn-success flex-fill" onclick="placeBet('${oddId}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600;">
        💰 Place Bet
      </button>
    </div>
  `;
}

// Lock and Load - Places bet with Fliff Coin and reloads page
async function lockAndLoad(oddId) {
  if (isPrefiring) {
    console.log('⏳ Already processing...');
    return;
  }
  
  if (!selectedGame || !selectedGame.id) {
    console.log('❌ No game selected');
    return;
  }
  
  const odd = gameOdds[selectedGame.id]?.[oddId];
  if (!odd || !odd.selection || odd.odds === undefined) {
    console.log('❌ Invalid odds data');
    return;
  }
  
  isPrefiring = true;
  showPrefireStatus(`🔒 LOCK & LOAD: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} → $${wagerAmount} (Coin)`);
  
  const betData = {
    gameId: selectedGame.id,
    oddId: String(oddId),
    selection: String(odd.selection || ''),
    odds: Number(odd.odds) || 0,
    param: String(odd.param || ''),
    market: String(odd.market || ''),
    wager: Number(wagerAmount) || 100,
    coinType: 'coin' // Always use coin for lock and load
  };
  
  try {
    const response = await fetch(`${API_URL}/api/lock-and-load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(betData)
    });
    
    const result = await response.json();
    
    if (result.success) {
      const statusMsg = result.betPlaced && result.pageReloaded 
        ? `✅ LOCKED: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} - Bet placed with Coin, page reloaded!`
        : result.betPlaced 
          ? `✅ BET PLACED: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} - Page reload in progress...`
          : `✅ LOCKED: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds}`;
      
      showPrefireStatus(statusMsg);
      
      // Show success pop-up with detailed info
      const toastMsg = result.betPlaced && result.pageReloaded
        ? `🔒 LOCK & LOAD COMPLETE!<br><strong>${odd.selection}</strong> @ ${odd.odds > 0 ? '+' : ''}${odd.odds}<br>✅ Bet placed with Fliff Coin<br>✅ Page reloaded to lock odds`
        : result.betPlaced
          ? `🔒 LOCK & LOAD IN PROGRESS<br><strong>${odd.selection}</strong> @ ${odd.odds > 0 ? '+' : ''}${odd.odds}<br>✅ Bet placed with Fliff Coin<br>⏳ Reloading page...`
          : `🔒 LOCK & LOAD SUCCESS<br><strong>${odd.selection}</strong> @ ${odd.odds > 0 ? '+' : ''}${odd.odds}`;
      
      showToast(toastMsg, 'lock', 6000);
      
      setTimeout(hidePrefireStatus, 4000);
    } else {
      showPrefireStatus(`❌ ${result.error || 'Lock & Load failed'}`);
      showToast(`❌ Lock & Load Failed: ${result.error || 'Unknown error'}`, 'error', 4000);
      setTimeout(hidePrefireStatus, 3000);
    }
  } catch (error) {
    console.error('Lock & Load error:', error);
    showPrefireStatus('❌ Error connecting to server');
    showToast(`❌ Connection Error: ${error.message || 'Failed to connect to server'}`, 'error', 4000);
    setTimeout(hidePrefireStatus, 3000);
  }
  
  isPrefiring = false;
}

// Place Bet - Places bet with Fliff Cash
async function placeBet(oddId) {
  if (isPrefiring) {
    console.log('⏳ Already processing...');
    return;
  }
  
  if (!selectedGame || !selectedGame.id) {
    console.log('❌ No game selected');
    return;
  }
  
  const odd = gameOdds[selectedGame.id]?.[oddId];
  if (!odd || !odd.selection || odd.odds === undefined) {
    console.log('❌ Invalid odds data');
    return;
  }
  
  isPrefiring = true;
  showPrefireStatus(`💰 PLACING BET: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} → $${wagerAmount} (Cash)`);
  
  const betData = {
    gameId: selectedGame.id,
    oddId: String(oddId),
    selection: String(odd.selection || ''),
    odds: Number(odd.odds) || 0,
    param: String(odd.param || ''),
    market: String(odd.market || ''),
    wager: Number(wagerAmount) || 100,
    coinType: 'cash' // Always use cash for place bet
  };
  
  try {
    const response = await fetch(`${API_URL}/api/place-bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(betData)
    });
    
    const result = await response.json();
    
    if (result.success) {
      showPrefireStatus(`✅ BET PLACED: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} - $${wagerAmount}`);
      
      // Show success pop-up
      showToast(
        `💰 BET PLACED SUCCESSFULLY!<br><strong>${odd.selection}</strong> @ ${odd.odds > 0 ? '+' : ''}${odd.odds}<br>Amount: $${wagerAmount} (Fliff Cash)`,
        'success',
        5000
      );
      
      setTimeout(hidePrefireStatus, 4000);
    } else if (result.retry) {
      showPrefireStatus(`⚠️ Odds changed! ${result.newOdds ? `New: ${result.newOdds}` : 'Click again to retry.'}`);
      showToast(`⚠️ Odds Changed! ${result.newOdds ? `New odds: ${result.newOdds}` : 'Please try again.'}`, 'warning', 4000);
      setTimeout(hidePrefireStatus, 3000);
    } else {
      showPrefireStatus(`❌ ${result.error || 'Bet failed'}`);
      showToast(`❌ Bet Failed: ${result.error || 'Unknown error'}`, 'error', 4000);
      setTimeout(hidePrefireStatus, 3000);
    }
  } catch (error) {
    console.error('Place bet error:', error);
    showPrefireStatus('❌ Error connecting to server');
    showToast(`❌ Connection Error: ${error.message || 'Failed to connect to server'}`, 'error', 4000);
    setTimeout(hidePrefireStatus, 3000);
  }
  
  isPrefiring = false;
}

// Legacy function - kept for compatibility
async function clickOdds(oddId) {
  // Default to place bet behavior
  await placeBet(oddId);
}

function showPrefireStatus(text) {
  const status = document.getElementById('prefire-status');
  document.getElementById('prefire-text').textContent = text;
  status.classList.remove('hidden');
}

function hidePrefireStatus() {
  document.getElementById('prefire-status').classList.add('hidden');
}

// Toast notification system for pop-ups
function showToast(message, type = 'success', duration = 5000) {
  // Remove any existing toasts
  const existingToasts = document.querySelectorAll('.toast-notification');
  existingToasts.forEach(toast => toast.remove());
  
  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast-notification toast-${type}`;
  
  // Set icon based on type
  let icon = '✅';
  if (type === 'error') icon = '❌';
  else if (type === 'warning') icon = '⚠️';
  else if (type === 'info') icon = 'ℹ️';
  else if (type === 'lock') icon = '🔒';
  
  toast.innerHTML = `
    <div class="toast-content">
      <span class="toast-icon">${icon}</span>
      <span class="toast-message">${message}</span>
      <button class="toast-close" onclick="this.parentElement.parentElement.remove()">×</button>
    </div>
  `;
  
  // Add to body
  document.body.appendChild(toast);
  
  // Animate in
  setTimeout(() => {
    toast.classList.add('show');
  }, 10);
  
  // Auto remove after duration
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentElement) {
        toast.remove();
      }
    }, 300);
  }, duration);
  
  return toast;
}

function handlePrefireResult(data) {
  if (data.success) {
    showPrefireStatus('✅ ' + data.message);
  } else if (data.retry) {
    showPrefireStatus('⚠️ ' + data.message);
  } else {
    showPrefireStatus('❌ ' + data.message);
  }
  
  if (!data.retry) {
    setTimeout(hidePrefireStatus, 4000);
  }
}

// =============================================
// RENDERING
// =============================================

function renderGames() {
  const container = document.getElementById('games-list');
  const gamesList = Object.values(games);
  
  document.getElementById('games-count').textContent = gamesList.length;
  
  if (gamesList.length === 0) {
    container.innerHTML = '<div class="no-data">No live games right now</div>';
    return;
  }
  
  container.innerHTML = gamesList.map(game => `
    <div class="game-card" onclick="selectGame(${game.id})">
      <div class="game-header">
        <span class="game-status">${game.status || 'In Progress'}</span>
        <span class="live-badge">🔴 LIVE</span>
      </div>
      <div class="teams-display">
        <div class="team">
          <div class="team-name">${game.home}</div>
          <div class="team-score">${game.homeScore}</div>
        </div>
        <div class="vs-divider">VS</div>
        <div class="team">
          <div class="team-name">${game.away}</div>
          <div class="team-score">${game.awayScore}</div>
        </div>
      </div>
    </div>
  `).join('');
}

function renderScoreCard(game) {
  const container = document.getElementById('score-card');
  
  container.innerHTML = `
    <div class="score-teams">
      <div class="score-team">
        <div class="score-team-name">${game.home}</div>
        <div class="score-team-score">${game.homeScore}</div>
      </div>
      <div class="score-vs">-</div>
      <div class="score-team">
        <div class="score-team-name">${game.away}</div>
        <div class="score-team-score">${game.awayScore}</div>
      </div>
    </div>
    <div class="score-status">${game.status || 'In Progress'}</div>
  `;
}

// Categorize odds by section, subsection, and type
function categorizeOdd(odd) {
  const market = (odd.market || '').toLowerCase();
  const selection = (odd.selection || '').toLowerCase();
  const param = String(odd.param || '').toLowerCase();
  const event = (odd.event || '').toLowerCase();
  
  // Combine all text for searching
  const allText = `${market} ${selection} ${param} ${event}`;
  
  // Determine period/subsection (Game, Quarter, Half, Period)
  let subsection = 'Game';
  
  // Check for quarters - very aggressive matching including "1H" style
  // Check for "1H", "2H" format first (common abbreviation) - check anywhere in text
  if (allText.match(/1h/i) || market.match(/1h/i) || selection.match(/1h/i) || param.match(/1h/i)) {
    subsection = '1st Half';
  } else if (allText.match(/2h/i) || market.match(/2h/i) || selection.match(/2h/i) || param.match(/2h/i)) {
    subsection = '2nd Half';
  }
  // Check for quarters - Q1, Q2, Q3, Q4 - check anywhere
  else if (allText.match(/q1/i) || market.match(/q1/i) || selection.match(/q1/i) || param.match(/q1/i)) {
    subsection = '1st Quarter';
  } else if (allText.match(/q2/i) || market.match(/q2/i) || selection.match(/q2/i) || param.match(/q2/i)) {
    subsection = '2nd Quarter';
  } else if (allText.match(/q3/i) || market.match(/q3/i) || selection.match(/q3/i) || param.match(/q3/i)) {
    subsection = '3rd Quarter';
  } else if (allText.match(/q4/i) || market.match(/q4/i) || selection.match(/q4/i) || param.match(/q4/i)) {
    subsection = '4th Quarter';
  }
  // Check for quarters - more patterns (including variations)
  else if (allText.match(/\b(q1|1st\s*quarter|first\s*quarter|quarter\s*1|q\s*1|1\s*q)\b/i)) {
    subsection = '1st Quarter';
  } else if (allText.match(/\b(q2|2nd\s*quarter|second\s*quarter|quarter\s*2|q\s*2|2\s*q)\b/i)) {
    subsection = '2nd Quarter';
  } else if (allText.match(/\b(q3|3rd\s*quarter|third\s*quarter|quarter\s*3|q\s*3|3\s*q)\b/i)) {
    subsection = '3rd Quarter';
  } else if (allText.match(/\b(q4|4th\s*quarter|fourth\s*quarter|quarter\s*4|q\s*4|4\s*q)\b/i)) {
    subsection = '4th Quarter';
  }
  // Check for halves - H1, H2 format
  else if (allText.match(/\b(h1|1st\s*half|first\s*half|half\s*1|h\s*1|1\s*h)\b/i)) {
    subsection = '1st Half';
  } else if (allText.match(/\b(h2|2nd\s*half|second\s*half|half\s*2|h\s*2|2\s*h)\b/i)) {
    subsection = '2nd Half';
  }
  // Check for periods (hockey/other sports)
  else if (allText.match(/\b(p1|1st\s*period|first\s*period|period\s*1|p\s*1|1\s*p)\b/i)) {
    subsection = '1st Period';
  } else if (allText.match(/\b(p2|2nd\s*period|second\s*period|period\s*2|p\s*2|2\s*p)\b/i)) {
    subsection = '2nd Period';
  } else if (allText.match(/\b(p3|3rd\s*period|third\s*period|period\s*3|p\s*3|3\s*p)\b/i)) {
    subsection = '3rd Period';
  }
  // Also check for just numbers followed by quarter/half/period
  else if (allText.match(/\b1\s*(quarter|q)\b/i)) {
    subsection = '1st Quarter';
  } else if (allText.match(/\b2\s*(quarter|q)\b/i)) {
    subsection = '2nd Quarter';
  } else if (allText.match(/\b3\s*(quarter|q)\b/i)) {
    subsection = '3rd Quarter';
  } else if (allText.match(/\b4\s*(quarter|q)\b/i)) {
    subsection = '4th Quarter';
  } else if (allText.match(/\b1\s*(half|h)\b/i)) {
    subsection = '1st Half';
  } else if (allText.match(/\b2\s*(half|h)\b/i)) {
    subsection = '2nd Half';
  }
  
  // Determine section from subsection
  let section = 'Gameline';
  if (subsection.includes('Quarter')) {
    section = 'Quarters';
  } else if (subsection.includes('Half')) {
    section = 'Halves';
  } else if (subsection.includes('Period')) {
    section = 'Periods';
  } else if (subsection === 'Game') {
    section = 'Gameline';
  } else {
    section = 'Other';
  }
  
  // Determine bet type - improved detection with separation of variants
  let type = 'Other';
  
  // Check for 3-way moneyline first (before regular moneyline)
  const is3WayMoneyline = market.includes('3-way') || 
                          market.includes('3 way') || 
                          market.includes('three way') ||
                          (market.includes('moneyline') && (market.includes('3') || selection.includes('draw'))) ||
                          (market.includes('ml') && (market.includes('3') || selection.includes('draw'))) ||
                          (selection && (selection.includes('draw') || selection.includes('tie')));
  
  // Check for alternative point spread - Match exact Fliff naming: "Alternative Point Spread"
  const isAlternativeSpread = market.includes('alternative point spread') ||
                              market.includes('alternate point spread') ||
                              market.includes('alt point spread') ||
                              market.includes('alternative spread') || 
                              market.includes('alternate spread') || 
                              market.includes('alt spread') ||
                              market.includes('alt. spread') ||
                              (market.includes('alternative') && market.includes('point spread')) ||
                              (market.includes('alternate') && market.includes('point spread')) ||
                              (param.includes('alternative') && (market.includes('spread') || param.includes('spread'))) ||
                              (param.includes('alternate') && (market.includes('spread') || param.includes('spread'))) ||
                              (param.includes('alt') && (market.includes('spread') || param.includes('spread'))) ||
                              ((market.includes('alternative') || market.includes('alternate') || market.includes('alt')) && 
                               (market.includes('spread') || param.includes('spread')));
  
  // Check for alternative total score - Match exact Fliff naming: "Alternative Total Score"
  const isAlternativeTotalScore = market.includes('alternative total score') ||
                                  market.includes('alternate total score') || 
                                  market.includes('alt total score') ||
                                  market.includes('alt. total score') ||
                                  (market.includes('alternative') && market.includes('total score')) ||
                                  (market.includes('alternate') && market.includes('total score')) ||
                                  (market.includes('alt') && market.includes('total score')) ||
                                  (param.includes('alternative') && (market.includes('total score') || param.includes('total score'))) ||
                                  (param.includes('alternate') && (market.includes('total score') || param.includes('total score'))) ||
                                  (param.includes('alt') && (market.includes('total score') || param.includes('total score')));
  
  // Check for total score - must include "total score" but NOT alternative (check market and param)
  const isTotalScore = (market.includes('total score') || param.includes('total score')) && 
                      !isAlternativeTotalScore &&
                      !param.includes('alternative') && 
                      !param.includes('alternate') && 
                      !param.includes('alt');
  
  // Check for alternative totals - MUST include "total" (but not "total score") AND alternative indicator (check market and param)
  const isAlternativeTotal = (market.includes('total') || param.includes('total')) && 
                             !market.includes('total score') && // Exclude total score
                             !param.includes('total score') && // Exclude total score in param
                             !market.includes('spread') && // Exclude spreads
                             !param.includes('spread') && // Exclude spreads in param
                             (market.includes('alternative total') || 
                              market.includes('alternate total') || 
                              market.includes('alt total') ||
                              market.includes('alt. total') ||
                              param.includes('alternative') ||
                              param.includes('alternate') ||
                              param.includes('alt') ||
                              (market.includes('alternative') && market.includes('total')) ||
                              (market.includes('alternate') && market.includes('total')) ||
                              (market.includes('alt') && market.includes('total')));
  
  // Check for team totals (separate from game totals)
  const isTeamTotal = market.includes('team total') || 
                     market.includes('tt') ||
                     (market.includes('total') && (selection.includes('home') || selection.includes('away')) && !market.includes('score'));
  
  // Props - look for "prop", "player", "team", or specific prop indicators
  if (market.includes('prop') || 
      market.includes('player') ||
      market.includes('team prop') ||
      market.includes('game prop') ||
      selection.includes('prop') ||
      (market && !market.includes('spread') && !market.includes('moneyline') && !market.includes('total') && 
       !market.includes('ml') && !market.includes('over') && !market.includes('under') &&
       (market.includes('first') || market.includes('last') || market.includes('most') || 
        market.includes('least') || market.includes('total') || market.includes('score') ||
        market.includes('assist') || market.includes('rebound') || market.includes('point')))) {
    type = 'Props';
  }
  // Alternative Point Spread - check FIRST (before regular spread) - Match Fliff naming
  else if (isAlternativeSpread) {
    type = 'Alternative Point Spread';  // Changed to match Fliff exact naming
  }
  // Point Spread - Match Fliff naming: "Point Spread" (but NOT alternative point spread)
  // Check for exact "point spread" first, then fallback to just "spread"
  else if ((market.includes('point spread') || market.includes('spread')) && !isAlternativeSpread) {
    // Double-check it's not alternative
    if (!market.includes('alternative') && !market.includes('alternate') && !market.includes('alt') &&
        !param.includes('alternative') && !param.includes('alternate') && !param.includes('alt')) {
      type = 'Point Spread';
    }
  }
  // Also check for spread patterns in selection (but not alternative - check both market and param)
  else if (!isAlternativeSpread && 
           !market.includes('alternative') && !market.includes('alternate') && !market.includes('alt') &&
           !param.includes('alternative') && !param.includes('alternate') && !param.includes('alt') &&
           ((selection.match(/[+-]\d+\.?\d*/) && !selection.includes('over') && !selection.includes('under') && !selection.includes('total')) || 
            (selection.includes('spread') && !selection.includes('alternative')) ||
            ((selection.includes('+') || selection.includes('-')) && selection.match(/\d/) && !selection.includes('over') && !selection.includes('under') && !selection.includes('total')))) {
    type = 'Point Spread';
  }
  // 3-Way Moneyline - check before regular moneyline
  else if (is3WayMoneyline) {
    type = '3-Way Moneyline';
  }
  // Moneyline - look for "moneyline", "ml", "win", or just team names without numbers (but not 3-way)
  else if ((market.includes('moneyline') && !is3WayMoneyline) || 
           (market.includes('ml') && !is3WayMoneyline) || 
           (market.includes('win') && !is3WayMoneyline) ||
           (selection.includes(' w') && !selection.includes('draw')) ||
           (selection.includes('win') && !selection.includes('draw')) ||
           (selection && !selection.match(/[+-]\d/) && !selection.includes('over') && !selection.includes('under') && !selection.includes('prop') && !selection.includes('draw') && !selection.includes('tie'))) {
    type = 'Moneyline';
  }
  // Alternative Total Score - check FIRST (before total score and other totals)
  else if (isAlternativeTotalScore) {
    type = 'Alternative Total Score';
  }
  // Total Score - check before regular totals (must be exact "total score" in market, not alternative)
  else if (isTotalScore) {
    type = 'Total Score';
  }
  // Team Totals - check before regular totals
  else if (isTeamTotal) {
    type = 'Team Totals';
  }
  // Alternative Totals - check before regular totals
  else if (isAlternativeTotal) {
    type = 'Alternative Totals';
  }
  // Totals - look for "total", "over", "under", "o/u" (but not alternative, team totals, or total score)
  else if ((market.includes('total') && !isAlternativeTotal && !isTeamTotal && !isTotalScore && !isAlternativeTotalScore) || 
           (market.includes('over') && !isTotalScore && !isAlternativeTotalScore) || 
           (market.includes('under') && !isTotalScore && !isAlternativeTotalScore) ||
           market.includes('o/u') ||
           ((selection.includes('over') || selection.includes('under')) && !isTeamTotal && !isTotalScore && !isAlternativeTotalScore) ||
           (selection.match(/^o\s*\d+/i) && !isTotalScore && !isAlternativeTotalScore) ||
           (selection.match(/^u\s*\d+/i) && !isTotalScore && !isAlternativeTotalScore)) {
    type = 'Totals';
  }
  
  return { section, subsection, type, category: `${section}::${subsection}::${type}` };
}

// Get section display order
function getSectionOrder(section) {
  const order = {
    'Gameline': 1,
    'Quarters': 2,
    'Halves': 3,
    'Periods': 4,
    'Other': 999
  };
  return order[section] || 999;
}

// Get subsection display order within a section
function getSubsectionOrder(subsection) {
  const order = {
    'Game': 1,
    '1st Quarter': 1,
    '2nd Quarter': 2,
    '3rd Quarter': 3,
    '4th Quarter': 4,
    '1st Half': 1,
    '2nd Half': 2,
    '1st Period': 1,
    '2nd Period': 2,
    '3rd Period': 3
  };
  return order[subsection] || 999;
}

// Get type display order - Match Fliff order from screenshot
function getTypeOrder(type) {
  const order = {
    'Moneyline': 1,  // First in Fliff
    'Point Spread': 2,  // Second in Fliff
    'Total Score': 3,  // Third in Fliff
    'Alternative Point Spread': 4,  // Fourth in Fliff (changed name)
    'Alternative Total Score': 5,  // Fifth in Fliff
    '3-Way Moneyline': 6,
    'Totals': 7,
    'Alternative Totals': 8,
    'Team Totals': 9,
    'Props': 10,
    'Other': 999
  };
  return order[type] || 999;
}

function renderOdds() {
  const container = document.getElementById('odds-list');
  
  if (!selectedGame) {
    container.innerHTML = '<div class="alert alert-info">Select a game to view odds</div>';
    return;
  }
  
  const gameId = parseInt(selectedGame.id);
  console.log('🎮 Rendering odds for game:', gameId, selectedGame);
  console.log('📊 Available gameOdds keys:', Object.keys(gameOdds).map(k => parseInt(k)));
  
  // Ensure we're using the correct game ID
  const odds = gameOdds[gameId] || {};
  const oddsList = Object.values(odds);
  
  console.log(`📈 Found ${oddsList.length} odds for game ${gameId}`);
  
  // Debug: Check if odds belong to this game
  if (oddsList.length > 0) {
    const sampleOdd = oddsList[0];
    console.log('🔍 Sample odd data:', {
      id: sampleOdd.id,
      market: sampleOdd.market,
      selection: sampleOdd.selection,
      event: sampleOdd.event,
      channelId: sampleOdd.channelId,
      _debug: sampleOdd._debug
    });
  }
  
  if (oddsList.length === 0) {
    container.innerHTML = `
      <div class="alert alert-warning">
        <h5>No odds available</h5>
        <p>Loading odds for game ${gameId}... Check console for details.</p>
        <small class="text-muted">Game: ${selectedGame.home} vs ${selectedGame.away}</small>
      </div>
    `;
    return;
  }
  
  // Organize odds by section -> subsection -> type
  const organizedOdds = {}; // { section: { subsection: { type: [odds] } }
  
  // Debug: Track market names for spreads and totals
  const marketDebug = {
    spreads: new Set(),
    totalScores: new Set(),
    alternativeSpreads: new Set(),
    alternativeTotalScores: new Set()
  };
  
  oddsList.forEach(odd => {
    const { section, subsection, type } = categorizeOdd(odd);
    
    // Debug: Track market names
    const market = (odd.market || '').toLowerCase();
    if (type === 'Point Spread' || type === 'Alternative Point Spread') {
      if (type === 'Alternative Point Spread') {
        marketDebug.alternativeSpreads.add(odd.market || 'N/A');
      } else {
        marketDebug.spreads.add(odd.market || 'N/A');
      }
    }
    if (type === 'Total Score' || type === 'Alternative Total Score') {
      if (type === 'Alternative Total Score') {
        marketDebug.alternativeTotalScores.add(odd.market || 'N/A');
      } else {
        marketDebug.totalScores.add(odd.market || 'N/A');
      }
    }
    
    if (!organizedOdds[section]) {
      organizedOdds[section] = {};
    }
    if (!organizedOdds[section][subsection]) {
      organizedOdds[section][subsection] = {};
    }
    if (!organizedOdds[section][subsection][type]) {
      organizedOdds[section][subsection][type] = [];
    }
    
    organizedOdds[section][subsection][type].push(odd);
  });
  
  // Debug logging
  if (marketDebug.spreads.size > 0 || marketDebug.alternativeSpreads.size > 0) {
    console.log('📊 Spread Markets Found:');
    console.log('  Regular Spreads:', Array.from(marketDebug.spreads));
    console.log('  Alternative Spreads:', Array.from(marketDebug.alternativeSpreads));
  }
  if (marketDebug.totalScores.size > 0 || marketDebug.alternativeTotalScores.size > 0) {
    console.log('📊 Total Score Markets Found:');
    console.log('  Regular Total Scores:', Array.from(marketDebug.totalScores));
    console.log('  Alternative Total Scores:', Array.from(marketDebug.alternativeTotalScores));
  }
  
  // Sort odds within each type by market name, then selection
  Object.keys(organizedOdds).forEach(section => {
    Object.keys(organizedOdds[section]).forEach(subsection => {
      Object.keys(organizedOdds[section][subsection]).forEach(type => {
        organizedOdds[section][subsection][type].sort((a, b) => {
          const marketCompare = (a.market || '').localeCompare(b.market || '');
          if (marketCompare !== 0) return marketCompare;
          return (a.selection || '').localeCompare(b.selection || '');
        });
      });
    });
  });
  
  // Debug logging
  console.log('📊 Total odds:', oddsList.length);
  console.log('📊 Organized by sections:', Object.keys(organizedOdds));
  
  // Render organized odds
  let html = '';
  
  // Sort sections
  const sortedSections = Object.keys(organizedOdds).sort((a, b) => {
    return getSectionOrder(a) - getSectionOrder(b);
  });
  
  // Render each section
  sortedSections.forEach((section, sectionIndex) => {
    const sectionData = organizedOdds[section];
    const sectionId = `section-${sectionIndex}`;
    
    // Count total odds in this section
    let sectionTotal = 0;
    Object.keys(sectionData).forEach(subsection => {
      Object.keys(sectionData[subsection]).forEach(type => {
        sectionTotal += sectionData[subsection][type].length;
      });
    });
    
    if (sectionTotal === 0) return;
    
    // Sort subsections
    const sortedSubsections = Object.keys(sectionData).sort((a, b) => {
      return getSubsectionOrder(a) - getSubsectionOrder(b);
    });
    
    html += `
      <div class="card mb-3">
        <div class="card-header bg-primary text-white" style="cursor: pointer;" onclick="toggleSection('${sectionId}')">
          <div class="d-flex justify-content-between align-items-center">
            <h5 class="mb-0">${section} <span class="badge bg-light text-dark ms-2">${sectionTotal}</span></h5>
            <span class="section-toggle" id="toggle-${sectionId}">▼</span>
          </div>
        </div>
        <div class="card-body" id="${sectionId}" style="display: block;">
    `;
    
    // Render each subsection within section
    sortedSubsections.forEach((subsection, subsectionIndex) => {
      const subsectionData = sectionData[subsection];
      const subsectionId = `${sectionId}-sub-${subsectionIndex}`;
      
      // Count total odds in this subsection
      let subsectionTotal = 0;
      Object.keys(subsectionData).forEach(type => {
        subsectionTotal += subsectionData[type].length;
      });
      
      if (subsectionTotal === 0) return;
      
      // Sort types
      const sortedTypes = Object.keys(subsectionData).sort((a, b) => {
        return getTypeOrder(a) - getTypeOrder(b);
      });
      
      html += `
        <div class="mb-4">
          <h6 class="text-primary mb-3" style="cursor: pointer; font-size: 16px; font-weight: 700;" onclick="toggleSubsection('${subsectionId}')">
            ${subsection} <span class="badge bg-secondary" style="font-size: 0.85em;">${subsectionTotal}</span>
            <span class="subsection-toggle" id="toggle-${subsectionId}" style="font-size: 0.9em; margin-left: 8px;">▼</span>
          </h6>
          <div id="${subsectionId}" style="display: block;">
      `;
      
      // Render each type within subsection
      sortedTypes.forEach(type => {
        const typeOdds = subsectionData[type];
        if (typeOdds.length === 0) return;
        
        // Check if this is a Totals type (Over/Under)
        const isTotalsType = type === 'Totals' || type === 'Total Score' || type === 'Alternative Total Score' || 
                            type === 'Alternative Totals' || type === 'Team Totals';
        
        html += `
          <div class="mb-3">
            <h6 class="text-muted mb-2" style="font-size: 0.95rem; font-weight: 600;">
              ${type} <span class="badge bg-secondary" style="font-size: 0.8rem;">${typeOdds.length}</span>
            </h6>
        `;
        
        if (isTotalsType) {
          // Group Over/Under by extracting number from selection text (e.g., "Over 62.5" -> 62.5)
          const groupedByLine = {};
          typeOdds.forEach(odd => {
            const selection = odd.selection || '';
            const selectionLower = selection.toLowerCase();
            const isOver = selectionLower.includes('over') || selectionLower.startsWith('o ');
            const isUnder = selectionLower.includes('under') || selectionLower.startsWith('u ');
            
            // Extract number from selection (e.g., "Over 62.5" -> "62.5", "Under 68.5" -> "68.5")
            // Look for number after "over" or "under" keyword, or any number in the text
            let lineKey = '';
            
            // First try to find number after "over" or "under"
            const afterKeywordMatch = selectionLower.match(/(?:over|under|o|u)\s+(\d+\.?\d*)/);
            if (afterKeywordMatch) {
              lineKey = afterKeywordMatch[1];
            } else {
              // Fallback: find any number in the selection
              const numberMatch = selection.match(/(\d+\.?\d*)/);
              if (numberMatch) {
                lineKey = numberMatch[1];
              } else {
                // Last resort: use param or selection
                lineKey = odd.param || selection;
              }
            }
            
            if (!groupedByLine[lineKey]) {
              groupedByLine[lineKey] = { over: null, under: null, lineKey: lineKey };
            }
            
            if (isOver) {
              groupedByLine[lineKey].over = odd;
            } else if (isUnder) {
              groupedByLine[lineKey].under = odd;
            }
          });
          
          // Render grouped Over/Under pairs - sort by line number
          const sortedPairs = Object.values(groupedByLine).sort((a, b) => {
            const numA = parseFloat(a.lineKey) || 0;
            const numB = parseFloat(b.lineKey) || 0;
            return numA - numB; // Sort ascending by line number
          });
          
          html += `<div class="row g-2">`;
          
          sortedPairs.forEach(({ over, under, lineKey }) => {
            const param = over?.param || under?.param || lineKey;
            // Render Over and Under side by side
            html += `
              <div class="col-12 mb-3">
                <div class="d-flex gap-2" style="gap: 8px;">
            `;
            
            // Over card
            if (over) {
              const change = over.prevOdds ? over.odds - over.prevOdds : 0;
              const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
              const changeText = change !== 0 
                ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                : '';
              const tooltip = `Market: ${over.market || 'N/A'}\nSelection: ${over.selection || 'N/A'}\nParam: ${over.param || 'N/A'}\nEvent: ${over.event || 'N/A'}\nID: ${over.id}`;
              const oddClass = over.odds > 0 ? 'text-success' : 'text-danger';
              
              html += `
                <div class="flex-fill">
                  <div class="card h-100 odd-card" style="border-color: var(--border);">
                    <div class="card-body p-3">
                      <div class="d-flex justify-content-between align-items-start mb-2">
                        <small style="font-size: 0.75rem; font-weight: 600; color: white;">OVER</small>
                        ${changeText ? `<small class="${changeClass}" style="font-weight: 600;">${changeText}</small>` : ''}
                      </div>
                      <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${over.selection || 'Over'}</div>
                      ${param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${param}</small>` : ''}
                      <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                        ${over.odds > 0 ? '+' : ''}${over.odds}
                      </div>
                      <div class="d-flex gap-1 mt-2" style="gap: 4px;">
                        <button class="btn btn-sm btn-warning flex-fill" onclick="lockAndLoad('${over.id}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600;">
                          🔒 Lock & Load
                        </button>
                        <button class="btn btn-sm btn-success flex-fill" onclick="placeBet('${over.id}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600;">
                          💰 Place Bet
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              `;
            }
            
            // Under card
            if (under) {
              const change = under.prevOdds ? under.odds - under.prevOdds : 0;
              const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
              const changeText = change !== 0 
                ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                : '';
              const tooltip = `Market: ${under.market || 'N/A'}\nSelection: ${under.selection || 'N/A'}\nParam: ${under.param || 'N/A'}\nEvent: ${under.event || 'N/A'}\nID: ${under.id}`;
              const oddClass = under.odds > 0 ? 'text-success' : 'text-danger';
              
              html += `
                <div class="flex-fill">
                  <div class="card h-100 odd-card" style="border-color: var(--border);">
                    <div class="card-body p-3">
                      <div class="d-flex justify-content-between align-items-start mb-2">
                        <small style="font-size: 0.75rem; font-weight: 600; color: white;">UNDER</small>
                        ${changeText ? `<small class="${changeClass}" style="font-weight: 600;">${changeText}</small>` : ''}
                      </div>
                      <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${under.selection || 'Under'}</div>
                      ${param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${param}</small>` : ''}
                      <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                        ${under.odds > 0 ? '+' : ''}${under.odds}
                      </div>
                      <div class="d-flex gap-1 mt-2" style="gap: 4px;">
                        <button class="btn btn-sm btn-warning flex-fill" onclick="lockAndLoad('${under.id}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600;">
                          🔒 Lock & Load
                        </button>
                        <button class="btn btn-sm btn-success flex-fill" onclick="placeBet('${under.id}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600;">
                          💰 Place Bet
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              `;
            }
            
            html += `
                </div>
              </div>
            `;
          });
          
          // Render any unpaired odds (if any)
          typeOdds.forEach(odd => {
            const selection = odd.selection || '';
            const selectionLower = selection.toLowerCase();
            const isOver = selectionLower.includes('over') || selectionLower.startsWith('o ');
            const isUnder = selectionLower.includes('under') || selectionLower.startsWith('u ');
            
            // Extract number to find the group (same logic as above)
            let lineKey = '';
            const afterKeywordMatch = selectionLower.match(/(?:over|under|o|u)\s+(\d+\.?\d*)/);
            if (afterKeywordMatch) {
              lineKey = afterKeywordMatch[1];
            } else {
              const numberMatch = selection.match(/(\d+\.?\d*)/);
              if (numberMatch) {
                lineKey = numberMatch[1];
              } else {
                lineKey = odd.param || selection;
              }
            }
            
            // Check if already rendered in a pair
            const alreadyRendered = groupedByLine[lineKey] && 
                                   ((isOver && groupedByLine[lineKey].over?.id === odd.id) ||
                                    (isUnder && groupedByLine[lineKey].under?.id === odd.id));
            
            if (!alreadyRendered) {
              const change = odd.prevOdds ? odd.odds - odd.prevOdds : 0;
              const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
              const changeText = change !== 0 
                ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                : '';
              const tooltip = `Market: ${odd.market || 'N/A'}\nSelection: ${odd.selection || 'N/A'}\nParam: ${odd.param || 'N/A'}\nEvent: ${odd.event || 'N/A'}\nID: ${odd.id}`;
              const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
              
              html += `
                <div class="col-6">
                  <div class="card h-100 odd-card">
                    <div class="card-body p-3">
                      <div class="d-flex justify-content-between align-items-start mb-2">
                        <small style="font-size: 0.75rem; font-weight: 600; color: white;">${odd.market || 'Line'}</small>
                        ${changeText ? `<small class="${changeClass}" style="font-weight: 600;">${changeText}</small>` : ''}
                      </div>
                      <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${odd.selection || '-'}</div>
                      ${odd.param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${odd.param}</small>` : ''}
                      <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                        ${odd.odds > 0 ? '+' : ''}${odd.odds}
                      </div>
                      ${getBetButtonsHTML(odd.id)}
                    </div>
                  </div>
                </div>
              `;
            }
          });
          
          html += `</div>`;
        } else {
          // Check if this is Point Spread type (needs white text and pairing)
          const isPointSpreadType = type === 'Point Spread' || type === 'Alternative Point Spread';
          
          if (isPointSpreadType) {
            // Group Point Spread odds by their line number (+X and -X should be paired)
            const groupedByLine = {};
            typeOdds.forEach(odd => {
              const selection = odd.selection || '';
              // Extract the number from selection (e.g., "+7.5", "-7.5", "Team +7.5", etc.)
              const numberMatch = selection.match(/([+-]?\d+\.?\d*)/);
              if (numberMatch) {
                const lineNumber = Math.abs(parseFloat(numberMatch[1])); // Use absolute value as key
                const isPositive = selection.includes('+') || (numberMatch[1] && !numberMatch[1].startsWith('-'));
                
                if (!groupedByLine[lineNumber]) {
                  groupedByLine[lineNumber] = { positive: null, negative: null, lineNumber: lineNumber };
                }
                
                if (isPositive) {
                  groupedByLine[lineNumber].positive = odd;
                } else {
                  groupedByLine[lineNumber].negative = odd;
                }
              } else {
                // If no number found, use selection as key
                const key = selection || 'other';
                if (!groupedByLine[key]) {
                  groupedByLine[key] = { positive: null, negative: null, lineNumber: key };
                }
                groupedByLine[key].positive = odd;
              }
            });
            
            // Render grouped Point Spread pairs
            html += `<div class="row g-2">`;
            
            Object.values(groupedByLine).forEach(({ positive, negative, lineNumber }) => {
              // Render +X and -X side by side
              html += `
                <div class="col-12 mb-3">
                  <div class="d-flex gap-2" style="gap: 8px;">
              `;
              
              // Positive spread card (+X)
              if (positive) {
                const change = positive.prevOdds ? positive.odds - positive.prevOdds : 0;
                const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
                const changeText = change !== 0 
                  ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                  : '';
                const tooltip = `Market: ${positive.market || 'N/A'}\nSelection: ${positive.selection || 'N/A'}\nParam: ${positive.param || 'N/A'}\nEvent: ${positive.event || 'N/A'}\nID: ${positive.id}`;
                const oddClass = positive.odds > 0 ? 'text-success' : 'text-danger';
                
                html += `
                  <div class="flex-fill">
                    <div class="card h-100 odd-card" style="border-color: var(--border);">
                      <div class="card-body p-3">
                        <div class="d-flex justify-content-between align-items-start mb-2">
                          <small style="font-size: 0.75rem; font-weight: 600; color: white;">${positive.market || 'Line'}</small>
                          ${changeText ? `<small class="${changeClass}" style="font-weight: 600; color: white;">${changeText}</small>` : ''}
                        </div>
                        <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${positive.selection || '+'}</div>
                        ${positive.param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${positive.param}</small>` : ''}
                        <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                          ${positive.odds > 0 ? '+' : ''}${positive.odds}
                        </div>
                        ${getBetButtonsHTML(positive.id)}
                      </div>
                    </div>
                  </div>
                `;
              }
              
              // Negative spread card (-X)
              if (negative) {
                const change = negative.prevOdds ? negative.odds - negative.prevOdds : 0;
                const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
                const changeText = change !== 0 
                  ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                  : '';
                const tooltip = `Market: ${negative.market || 'N/A'}\nSelection: ${negative.selection || 'N/A'}\nParam: ${negative.param || 'N/A'}\nEvent: ${negative.event || 'N/A'}\nID: ${negative.id}`;
                const oddClass = negative.odds > 0 ? 'text-success' : 'text-danger';
                
                html += `
                  <div class="flex-fill">
                    <div class="card h-100 odd-card" style="border-color: var(--border);">
                      <div class="card-body p-3">
                        <div class="d-flex justify-content-between align-items-start mb-2">
                          <small style="font-size: 0.75rem; font-weight: 600; color: white;">${negative.market || 'Line'}</small>
                          ${changeText ? `<small class="${changeClass}" style="font-weight: 600; color: white;">${changeText}</small>` : ''}
                        </div>
                        <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${negative.selection || '-'}</div>
                        ${negative.param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${negative.param}</small>` : ''}
                        <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                          ${negative.odds > 0 ? '+' : ''}${negative.odds}
                        </div>
                        ${getBetButtonsHTML(negative.id)}
                      </div>
                    </div>
                  </div>
                `;
              }
              
              html += `
                  </div>
                </div>
              `;
            });
            
            // Render any unpaired odds (if any)
            typeOdds.forEach(odd => {
              const selection = odd.selection || '';
              const numberMatch = selection.match(/([+-]?\d+\.?\d*)/);
              let alreadyRendered = false;
              
              if (numberMatch) {
                const lineNumber = Math.abs(parseFloat(numberMatch[1]));
                const isPositive = selection.includes('+') || (numberMatch[1] && !numberMatch[1].startsWith('-'));
                const group = groupedByLine[lineNumber];
                
                if (group) {
                  alreadyRendered = (isPositive && group.positive?.id === odd.id) ||
                                   (!isPositive && group.negative?.id === odd.id);
                }
              } else {
                const key = selection || 'other';
                const group = groupedByLine[key];
                if (group && group.positive?.id === odd.id) {
                  alreadyRendered = true;
                }
              }
              
              if (!alreadyRendered) {
                const change = odd.prevOdds ? odd.odds - odd.prevOdds : 0;
                const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
                const changeText = change !== 0 
                  ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                  : '';
                const tooltip = `Market: ${odd.market || 'N/A'}\nSelection: ${odd.selection || 'N/A'}\nParam: ${odd.param || 'N/A'}\nEvent: ${odd.event || 'N/A'}\nID: ${odd.id}`;
                const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
                
                html += `
                  <div class="col-6">
                    <div class="card h-100 odd-card">
                      <div class="card-body p-3">
                        <div class="d-flex justify-content-between align-items-start mb-2">
                          <small style="font-size: 0.75rem; font-weight: 600; color: white;">${odd.market || 'Line'}</small>
                          ${changeText ? `<small class="${changeClass}" style="font-weight: 600; color: white;">${changeText}</small>` : ''}
                        </div>
                        <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${odd.selection || '-'}</div>
                        ${odd.param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${odd.param}</small>` : ''}
                        <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                          ${odd.odds > 0 ? '+' : ''}${odd.odds}
                        </div>
                        ${getBetButtonsHTML(odd.id)}
                      </div>
                    </div>
                  </div>
                `;
              }
            });
            
            html += `</div>`;
          } else {
            // Regular rendering for non-totals, non-spread types
            html += `<div class="row g-2">`;
            
            typeOdds.forEach(odd => {
              const change = odd.prevOdds ? odd.odds - odd.prevOdds : 0;
              const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
              const changeText = change !== 0 
                ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`)
                : '';
              
              const tooltip = `Market: ${odd.market || 'N/A'}\nSelection: ${odd.selection || 'N/A'}\nParam: ${odd.param || 'N/A'}\nEvent: ${odd.event || 'N/A'}\nID: ${odd.id}`;
              const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
              
              html += `
                <div class="col-6">
                  <div class="card h-100 odd-card">
                    <div class="card-body p-3">
                      <div class="d-flex justify-content-between align-items-start mb-2">
                        <small class="text-muted" style="font-size: 0.75rem; font-weight: 600;">${odd.market || 'Line'}</small>
                        ${changeText ? `<small class="${changeClass}" style="font-weight: 600;">${changeText}</small>` : ''}
                      </div>
                      <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4;">${odd.selection || '-'}</div>
                      ${odd.param ? `<small class="text-muted d-block mb-2" style="font-size: 0.75rem; font-weight: 500;">${odd.param}</small>` : ''}
                      <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700;">
                        ${odd.odds > 0 ? '+' : ''}${odd.odds}
                      </div>
                      ${getBetButtonsHTML(odd.id)}
                    </div>
                  </div>
                </div>
              `;
            });
            
            html += `</div>`;
          }
        }
        
        html += `
          </div>
        `;
      });
      
      html += `
          </div>
        </div>
      `;
    });
    
    html += `
        </div>
      </div>
    `;
  });
  
  // Add summary at top
  const summaryHtml = `
    <div class="alert alert-info mb-3">
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <strong>📊 Total Odds: ${oddsList.length}</strong>
          <span class="ms-2 text-muted">Sections: ${sortedSections.length}</span>
        </div>
        <div>
          <small class="text-muted">Game ID: ${gameId}</small>
        </div>
      </div>
    </div>
  `;
  
  container.innerHTML = summaryHtml + html;
}

// =============================================
// GAME SELECTION
// =============================================

function selectGame(gameId) {
  // Ensure gameId is a number
  const gameIdInt = parseInt(gameId);
  
  selectedGame = games[gameIdInt];
  console.log(`🎮 Selected game ${gameIdInt}:`, selectedGame);
  
  if (!selectedGame) {
    console.error('❌ Game not found:', gameIdInt, 'Available:', Object.keys(games).map(k => parseInt(k)));
    return;
  }
  
  document.getElementById('panel-title').textContent = 
    `${selectedGame.home} vs ${selectedGame.away}`;
  
  renderScoreCard(selectedGame);
  updateDisplays();
  
  document.getElementById('game-panel').classList.remove('hidden');
  document.querySelector('.games-section').classList.add('hidden');
  
  // Load odds for this game
  loadGameOdds(gameIdInt);
  
  // Subscribe to game updates
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', gameId }));
    console.log('Subscribed to game:', gameId);
  }
  
  loadGameOdds(gameId);
}

function closeGamePanel() {
  selectedGame = null;
  document.getElementById('game-panel').classList.add('hidden');
  document.querySelector('.games-section').classList.remove('hidden');
}

// =============================================
// STATUS UPDATES
// =============================================

function updateStatus(connected) {
  const dot = document.querySelector('.dot');
  const text = document.getElementById('status-text');
  
  if (connected) {
    dot.classList.add('connected');
    text.textContent = 'Connected';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Disconnected';
  }
}

// =============================================
// SECTION/SUBSECTION TOGGLE FUNCTIONS
// =============================================

function toggleSection(sectionId) {
  const section = document.getElementById(sectionId);
  const toggle = document.getElementById(`toggle-${sectionId}`);
  
  if (section.style.display === 'none') {
    section.style.display = 'block';
    toggle.textContent = '▼';
  } else {
    section.style.display = 'none';
    toggle.textContent = '▶';
  }
}

function toggleSubsection(subsectionId) {
  const subsection = document.getElementById(subsectionId);
  const toggle = document.getElementById(`toggle-${subsectionId}`);
  
  if (subsection.style.display === 'none') {
    subsection.style.display = 'block';
    toggle.textContent = '▼';
  } else {
    subsection.style.display = 'none';
    toggle.textContent = '▶';
  }
}

// =============================================
// EXPORTS
// =============================================

window.FliffApp = {
  games,
  gameOdds,
  selectedGame,
  selectGame,
  clickOdds,
  lockAndLoad,
  placeBet,
  setWager,
  setCoinType,
  toggleSection,
  toggleSubsection
};
