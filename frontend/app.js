// =============================================
// FLIFF LIVE BETTING - FRONTEND APP
// =============================================

const API_URL = window.location.origin;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

// State
let ws = null;
let games = {};
let selectedGame = null;
let gameOdds = {};
let activeSection = null; // Currently selected odds section (Gameline, Player Props, etc.)
let lockedLines = new Set(); // Track locked lines (format: "gameId_oddId")
let unavailableMarkets = new Set(); // Track unavailable markets (format: "gameId_oddId")
let hideUnavailableMarkets = false; // By default, SHOW unavailable markets with a label
let lastArmedLockKey = null; // Track last ARMED lock key to avoid duplicate popups
let lockedOddsMap = {}; // Track locked odds per line (format: "gameId_oddId" -> odds number)
let activeLeagueFilter = 'all'; // Current league filter for games list ('all' or specific league name)
let gameStatusFilter = 'live'; // 'live' = only live games, 'all' = all games including upcoming
let eventUnavailable = false; // Track if current selected event is unavailable

// Performance optimization: Debounce renderOdds to prevent flickering
let renderOddsTimeout = null;
let pendingRenderOdds = false;

// Betting Settings
let wagerAmount = 100; // Default $100 for betting
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
  const isCustom = localStorage.getItem('fliff_wager_custom') === 'true';
  
  if (savedWager) {
    wagerAmount = parseFloat(savedWager);
    const standardValues = ['0.20', '0.50', '1', '2', '5', '10', '25', '50', '100', '200', '250', '500'];
    const selects = [
      document.getElementById('wager-amount'),
      document.getElementById('wager-amount-inner')
    ].filter(Boolean);
    const customInputs = [
      document.getElementById('custom-wager'),
      document.getElementById('custom-wager-inner')
    ].filter(Boolean);

    if (isCustom && !standardValues.includes(savedWager)) {
      selects.forEach(sel => {
        sel.value = 'custom';
      });
      customInputs.forEach(input => {
        input.value = savedWager;
        input.style.display = 'inline-block';
      });
    } else {
      selects.forEach(sel => {
        if (sel) sel.value = savedWager;
      });
      customInputs.forEach(input => {
        if (input) input.style.display = 'none';
      });
    }
  }
  
  updateDisplays();

  // Initialize league filter options after games are loaded
  updateLeagueFilterOptions();
}

// =============================================
// SETTINGS CONTROLS
// =============================================

function handleWagerChange(value) {
  const customInputs = [
    document.getElementById('custom-wager'),
    document.getElementById('custom-wager-inner')
  ].filter(Boolean);
  const selects = [
    document.getElementById('wager-amount'),
    document.getElementById('wager-amount-inner')
  ].filter(Boolean);

  if (value === 'custom') {
    // Show custom inputs and sync selects to 'custom'
    customInputs.forEach(input => {
      input.style.display = 'inline-block';
    });
    selects.forEach(sel => {
      if (sel.value !== 'custom') sel.value = 'custom';
    });
    // Use saved custom value if present
    const savedWager = localStorage.getItem('fliff_wager');
    const isCustomSaved = localStorage.getItem('fliff_wager_custom') === 'true';
    if (savedWager && isCustomSaved) {
      customInputs.forEach(input => {
        input.value = savedWager;
      });
      wagerAmount = parseFloat(savedWager);
      updateDisplays();
    } else if (customInputs[0]) {
      customInputs[0].focus();
    }
  } else {
    // Hide custom inputs and sync all selects to the chosen standard value
    customInputs.forEach(input => {
      input.style.display = 'none';
    });
    selects.forEach(sel => {
      if (sel.value !== value) sel.value = value;
    });
    setWager(value, false);
  }
}

function setCustomWager(value) {
  const amount = parseFloat(value);
  if (amount && amount > 0) {
    // Sync both custom inputs with this value
    const customInputs = [
      document.getElementById('custom-wager'),
      document.getElementById('custom-wager-inner')
    ].filter(Boolean);
    customInputs.forEach(input => {
      input.value = amount.toString();
    });
    setWager(amount.toString(), true);
  }
}

function setWager(value, isCustom = false) {
  wagerAmount = parseFloat(value);
  localStorage.setItem('fliff_wager', value);
  if (isCustom) {
    localStorage.setItem('fliff_wager_custom', 'true');
  } else {
    localStorage.setItem('fliff_wager_custom', 'false');
  }
  // Keep both wager selects in sync with the chosen value
  const selects = [
    document.getElementById('wager-amount'),
    document.getElementById('wager-amount-inner')
  ].filter(Boolean);
  selects.forEach(sel => {
    if (sel.value !== (isCustom ? 'custom' : value)) {
      sel.value = isCustom ? 'custom' : value;
    }
  });
  updateDisplays();
}

// Toggle filter for unavailable markets
function toggleUnavailableFilter() {
  const checkbox = document.getElementById('hide-unavailable');
  hideUnavailableMarkets = checkbox ? checkbox.checked : true;
  // Re-render odds to apply filter
  if (selectedGame) {
    renderOdds();
  }
}

function updateDisplays() {
  document.getElementById('current-wager').textContent = wagerAmount.toFixed(2);
  
  // Always show Cash (coin selection removed)
  const coinDisplay = document.getElementById('coin-type-display');
  coinDisplay.textContent = '💵 Cash';
  coinDisplay.classList.add('cash');
}

// =============================================
// WEBSOCKET CONNECTION
// =============================================

function connectWebSocket() {
  ws = new WebSocket(WS_URL);
  
  ws.onopen = () => {
    updateStatus(true);
  };
  
  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleMessage(data);
  };
  
  ws.onclose = () => {
    updateStatus(false);
    setTimeout(connectWebSocket, 3000);
  };
  
  ws.onerror = (error) => {
    // Silent error handling for production
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
      if (selectedGame && parseInt(selectedGame.id) === oddsGameId) {
        scheduleRenderOdds();
      }
      break;
      
    case 'odd':
      // Ensure gameId is integer
      const oddGameId = parseInt(data.gameId);
      if (!gameOdds[oddGameId]) {
        gameOdds[oddGameId] = {};
      }
      gameOdds[oddGameId][data.odd.id] = data.odd;
      if (selectedGame && parseInt(selectedGame.id) === oddGameId) {
        scheduleRenderOdds();
      }
      break;
    
    case 'odd_update':
      // Live odds update from any game - ensure gameId is integer
      const updateGameId = parseInt(data.gameId);
      if (!gameOdds[updateGameId]) {
        gameOdds[updateGameId] = {};
      }
      gameOdds[updateGameId][data.odd.id] = data.odd;
      if (selectedGame && parseInt(selectedGame.id) === updateGameId) {
        scheduleRenderOdds();
      }
      break;
    
    case 'odds_update':
      // Priority game bulk odds update - for faster loading
      const priorityGameId = parseInt(data.gameId);
      if (!gameOdds[priorityGameId]) {
        gameOdds[priorityGameId] = {};
      }
      // Update all odds at once
      data.odds.forEach(odd => {
        gameOdds[priorityGameId][odd.id] = odd;
      });
      if (selectedGame && parseInt(selectedGame.id) === priorityGameId) {
        scheduleRenderOdds();
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
    updateLeagueFilterOptions();
    renderGames();
  } catch (error) {
    console.error('Error loading games:', error);
  }
}

async function loadGameOdds(gameId) {
  // Ensure gameId is integer
  const gameIdInt = parseInt(gameId);
  try {
    const response = await fetch(`${API_URL}/api/games/${gameIdInt}/odds`);
    const data = await response.json();
    
    // Initialize if needed - use integer key
    if (!gameOdds[gameIdInt]) {
      gameOdds[gameIdInt] = {};
    }
    
    // Merge new odds with existing (don't overwrite, just update)
    data.forEach(odd => {
      gameOdds[gameIdInt][odd.id] = odd;
    });
    
    renderOdds();
  } catch (error) {
    // Silent error handling
  }
}

// =============================================
// PREFIRE BETTING - Auto on first click
// =============================================

// Helper function to generate bet buttons HTML
function getBetButtonsHTML(oddId, isLocked = false, isUnavailable = false, isSuspended = false) {
  // Check if market is suspended (locked on Fliff with lock icon) - show this BEFORE trying to bet
  if (isSuspended) {
    return `
      <div class="d-flex gap-1 mt-2" style="gap: 4px;">
        <button class="btn btn-sm btn-secondary flex-fill" disabled style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600; opacity: 0.6; cursor: not-allowed; background: #444; border-color: #555;">
          🔒 Market Suspended
        </button>
      </div>
    `;
  }
  
  if (isUnavailable) {
    // Show disabled buttons when market is unavailable
    return `
      <div class="d-flex gap-1 mt-2" style="gap: 4px;">
        <button class="btn btn-sm btn-secondary flex-fill" disabled style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600; opacity: 0.5; cursor: not-allowed;">
          ⚠️ Market Unavailable
        </button>
      </div>
    `;
  }
  
  if (isLocked) {
    // Show "Ready to Bet" when locked
    return `
      <div class="d-flex gap-1 mt-2" style="gap: 4px;">
        <button class="btn btn-sm btn-success flex-fill locked-ready-btn" onclick="placeBet('${oddId}')" style="font-size: 0.7rem; padding: 4px 8px; font-weight: 600; animation: pulse-glow 2s infinite;">
          ✅ Ready to Bet
        </button>
      </div>
    `;
  }
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

// Lock and Load - Selects bet (clicks on it) and reloads page to lock odds
async function lockAndLoad(oddId) {
  if (isPrefiring) {
    return;
  }
  
  if (!selectedGame || !selectedGame.id) {
    return;
  }
  
  const odd = gameOdds[selectedGame.id]?.[oddId];
  if (!odd || !odd.selection || odd.odds === undefined) {
    return;
  }
  
  // Check if market is already marked as unavailable
  const marketKey = `${selectedGame.id}_${oddId}`;
  if (unavailableMarkets.has(marketKey)) {
    showPrefireStatus(`⚠️ Market Not Available: ${odd.selection}`);
    showToast(`⚠️ Market Not Available<br>This market is no longer available for betting`, 'warning', 3000);
    return;
  }
  
  // Check if market is suspended (locked on Fliff with lock icon)
  if (odd.suspended === true) {
    showPrefireStatus(`🔒 Market Suspended: ${odd.selection}`);
    showToast(`🔒 Market Suspended<br>This market is currently locked on Fliff and cannot be bet on`, 'warning', 3000);
    return;
  }
  
  isPrefiring = true;
  // Show immediate feedback (optimistic UI)
  showPrefireStatus(`🚀 LOCK & LOAD: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} → $0.20 (Fast mode)...`);
  
  const betData = {
    gameId: selectedGame.id,
    oddId: String(oddId),
    selection: String(odd.selection || ''),
    odds: Number(odd.odds) || 0,
    param: String(odd.param || ''),
    market: String(odd.market || '')
    // wager is always $0.20 for lock and load (set in backend)
  };
  
  try {
    // Use AbortController for timeout (1.5 second max for faster response)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    
    // Use user-scoped endpoint if in user mode
    const lockEndpoint = window.USER_MODE && window.CURRENT_USERNAME
      ? `${API_URL}/api/user/${window.CURRENT_USERNAME}/lock-and-load`
      : `${API_URL}/api/lock-and-load`;
    
    const response = await fetch(lockEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(betData),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    const result = await response.json();
    
    // Immediately update UI based on result (no delays)
    // Check for market/event not available first
    if (result.marketNotAvailable || result.eventNotAvailable) {
      const marketKey = `${selectedGame.id}_${oddId}`;
      unavailableMarkets.add(marketKey);
      showPrefireStatus(`⚠️ Market Not Available: ${odd.selection}`);
      showToast(`⚠️ Market / Event Not Available<br>This selection is no longer available for betting`, 'warning', 3000);
      scheduleRenderOdds();
      setTimeout(hidePrefireStatus, 2000);
    } else if (result.armed || result.success) {
      // Lock & Load successful (even if partial) - mark this line as locked
      const lockKey = `${selectedGame.id}_${oddId}`;
      lockedLines.add(lockKey);
      lastArmedLockKey = lockKey;
      
      // Use locked odds from backend if provided, otherwise fall back to current odds
      const lockedOdds = typeof result.lockedOdds === 'number' ? result.lockedOdds : odd.odds;
      lockedOddsMap[lockKey] = lockedOdds;
      
      // Get success/failure counts
      const successCount = result.successCount || (result.profileResults ? result.profileResults.filter(r => r.success && r.oddsLocked).length : 0);
      const failedCount = result.failedCount || (result.profileResults ? result.profileResults.filter(r => !r.success || !r.betPlaced).length : 0);
      const totalProfiles = result.totalProfiles || (result.profileResults ? result.profileResults.length : 0);
      const isPartialSuccess = result.isPartialSuccess || (successCount > 0 && successCount < totalProfiles);
      
      // Build status message
      let statusMsg;
      if (isPartialSuccess) {
        statusMsg = `✅ ARMED (${successCount}/${totalProfiles}): ${odd.selection} @ ${lockedOdds > 0 ? '+' : ''}${lockedOdds} - Partial success, ready to bet!`;
      } else {
        statusMsg = `✅ ARMED: ${odd.selection} @ ${lockedOdds > 0 ? '+' : ''}${lockedOdds} - Ready to bet!`;
      }
      showPrefireStatus(statusMsg);
      
      // Show clear success popup with detailed counts
      let toastMsg;
      if (isPartialSuccess) {
        toastMsg = `🔒 LOCK & LOAD PARTIAL SUCCESS!<br><br><strong>${odd.selection}</strong><br>@ ${lockedOdds > 0 ? '+' : ''}${lockedOdds}<br><br>✅ $0.20 bet placed on ${successCount}/${totalProfiles} profile(s)<br>⚠️ ${failedCount} profile(s) failed<br>✅ Ready to place your bet on ${successCount} account(s)!`;
        showToast(toastMsg, 'warning', 6000);
      } else {
        toastMsg = `🔒 LOCK & LOAD SUCCESSFUL!<br><br><strong>${odd.selection}</strong><br>@ ${lockedOdds > 0 ? '+' : ''}${lockedOdds}<br><br>✅ $0.20 bet placed on ${successCount}/${totalProfiles} profile(s)<br>✅ Odds locked and verified<br>✅ Ready to place your bet!`;
        showToast(toastMsg, 'lock', 5000);
      }
      
      // Re-render odds immediately to show locked status
      scheduleRenderOdds();
      
      setTimeout(hidePrefireStatus, 3000);
    } else if (result.betPlaced) {
      // Bet placed but odds not locked
      const statusMsg = `⚠️ BET PLACED: ${odd.selection} @ ${odd.odds > 0 ? '+' : ''}${odd.odds} - Odds may have changed`;
      showPrefireStatus(statusMsg);
      showToast(`⚠️ Bet placed but odds may have changed`, 'warning', 2000);
      setTimeout(hidePrefireStatus, 2000);
    } else {
      // Bet failed - distinguish between market unavailable and odds changed
      const errorMsg = result.error || 'Lock & Load failed';
      const marketKey = `${selectedGame.id}_${oddId}`;
      
      const lower = (errorMsg || '').toLowerCase();
      const unavailableByText =
        lower.includes('market not available') ||
        lower.includes('event not available') ||
        lower.includes('no longer in') ||
        lower.includes("no longer in 'inplay'") ||
        lower.includes('no longer in "inplay"') ||
        lower.includes('inplay state');
      const oddsChangedByText =
        lower.includes('odds have changed') ||
        lower.includes('odds changed') ||
        lower.includes('price changed');

      if (result.marketNotAvailable || result.eventNotAvailable || unavailableByText) {
        // Mark this line as unavailable so the card shows the warning badge
        unavailableMarkets.add(marketKey);
        showPrefireStatus(`⚠️ Market Not Available: ${odd.selection}`);
        showToast(
          `⚠️ Market / Event Not Available<br>This selection is no longer available for betting`,
          'warning',
          3000
        );
        
        // If event not available, show banner on dashboard
        if (result.eventNotAvailable || unavailableByText && lower.includes('event not available')) {
          markEventUnavailable('Event Not Available - This event is no longer available for betting');
        }
        
        scheduleRenderOdds();
      } else if (result.anyOddsChanged || oddsChangedByText) {
        // Odds moved while trying to lock – nothing locked, advise user what to do
        showPrefireStatus(
          `⚠️ Lock & Load failed: odds moved for ${odd.selection}. No bet was locked.`
        );
        showToast(
          `⚠️ Lock & Load Failed: Odds moved on this market before we could lock them.<br>` +
            `👉 Recommendation: Check the new odds on Fliff. If you still like it, Lock & Load again at the new price, otherwise skip this market.`,
          'warning',
          6000
        );
      } else {
        showPrefireStatus(`❌ ${errorMsg}`);
        showToast(`❌ ${errorMsg}`, 'error', 2000);
      }
      setTimeout(hidePrefireStatus, 2000);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      showPrefireStatus('⏱️ Request timeout - checking status...');
      showToast('⏱️ Request taking longer than expected', 'warning', 2000);
    } else {
      console.error('Lock & Load error:', error);
      showPrefireStatus('❌ Connection error');
      showToast(`❌ ${error.message || 'Connection failed'}`, 'error', 2000);
    }
    setTimeout(hidePrefireStatus, 2000);
  } finally {
    isPrefiring = false;
  }
  
  isPrefiring = false;
}

// Place Bet - Places bet with Fliff Cash
async function placeBet(oddId) {
  if (isPrefiring) {
    return;
  }
  
  if (!selectedGame || !selectedGame.id) {
    return;
  }
  
  const odd = gameOdds[selectedGame.id]?.[oddId];
  if (!odd || !odd.selection || odd.odds === undefined) {
    return;
  }
  
  // Check if market is already marked as unavailable
  const marketKey = `${selectedGame.id}_${oddId}`;
  if (unavailableMarkets.has(marketKey)) {
    showPrefireStatus(`⚠️ Market Not Available: ${odd.selection}`);
    showToast(`⚠️ Market Not Available<br>This market is no longer available for betting`, 'warning', 3000);
    return;
  }
  
  // Check if market is suspended (locked on Fliff with lock icon)
  if (odd.suspended === true) {
    showPrefireStatus(`🔒 Market Suspended: ${odd.selection}`);
    showToast(`🔒 Market Suspended<br>This market is currently locked on Fliff and cannot be bet on`, 'warning', 3000);
    return;
  }
  
  isPrefiring = true;
  const lockKey = `${selectedGame.id}_${oddId}`;
  const effectiveOdds =
    typeof lockedOddsMap[lockKey] === 'number' ? lockedOddsMap[lockKey] : odd.odds;
  const effectiveOddsDisplay =
    effectiveOdds > 0 ? `+${effectiveOdds}` : `${effectiveOdds}`;

  showPrefireStatus(`💰 PLACING BET: ${odd.selection} @ ${effectiveOddsDisplay} → $${wagerAmount} (Cash)`);
  
  const betData = {
    gameId: selectedGame.id,
    oddId: String(oddId),
    selection: String(odd.selection || ''),
    odds: Number(odd.odds) || 0,
    param: String(odd.param || ''),
    market: String(odd.market || ''),
    wager: Number(wagerAmount) || 100,
    coinType: 'cash' // Always use cash
  };
  
  try {
    // Use user-scoped endpoint if in user mode
    const betEndpoint = window.USER_MODE && window.CURRENT_USERNAME
      ? `${API_URL}/api/user/${window.CURRENT_USERNAME}/place-bet`
      : `${API_URL}/api/place-bet`;
    
    const response = await fetch(betEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(betData)
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Prefer locked odds if we have them
      let placedOdds = effectiveOdds;
      if (typeof result.lockedOdds === 'number') {
        placedOdds = result.lockedOdds;
        lockedOddsMap[lockKey] = result.lockedOdds;
      }
      const placedOddsDisplay = placedOdds > 0 ? `+${placedOdds}` : `${placedOdds}`;

      showPrefireStatus(`✅ BET PLACED: ${odd.selection} @ ${placedOddsDisplay} - $${wagerAmount}`);
      // Show success pop-up with locked odds
      showToast(
        `💰 BET PLACED SUCCESSFULLY!<br><strong>${odd.selection}</strong> @ ${placedOddsDisplay}<br>Amount: $${wagerAmount} (Fliff Cash)`,
        'success',
        5000
      );
      
      setTimeout(hidePrefireStatus, 4000);
    } else if (result.retry) {
      showPrefireStatus(`⚠️ Odds changed! ${result.newOdds ? `New: ${result.newOdds}` : 'Click again to retry.'}`);
      showToast(`⚠️ Odds Changed! ${result.newOdds ? `New odds: ${result.newOdds}` : 'Please try again.'}`, 'warning', 4000);
      setTimeout(hidePrefireStatus, 3000);
    } else {
      const errorMsg = result.error || 'Bet failed';
      const marketKey = `${selectedGame.id}_${oddId}`;
      
      // Check if error indicates market/event is not available
      const lower = (errorMsg || '').toLowerCase();
      const unavailableByText = lower.includes('market not available') ||
                                lower.includes('event not available') ||
                                lower.includes('no longer in') ||
                                lower.includes('no longer in \'inplay\'') ||
                                lower.includes('no longer in \"inplay\"') ||
                                lower.includes('inplay state');

      if (result.marketNotAvailable || result.eventNotAvailable || unavailableByText) {
        unavailableMarkets.add(marketKey);
        showPrefireStatus(`⚠️ Market Not Available: ${odd.selection}`);
        showToast(`⚠️ Market / Event Not Available<br>This selection is no longer available for betting`, 'warning', 3000);
        
        // If event not available, show banner on dashboard
        if (result.eventNotAvailable || lower.includes('event not available')) {
          markEventUnavailable('Event Not Available - This event is no longer available for betting');
        }
        
        // Re-render to show the warning label
        scheduleRenderOdds();
      } else {
        showPrefireStatus(`❌ ${errorMsg}`);
        showToast(`❌ Bet Failed: ${errorMsg}`, 'error', 4000);
      }
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
  // WebSocket notification from backend after Lock & Load flow completes.
  // This is especially important when the HTTP request times out but the
  // backend still finishes and ARMS the bet.

  // If this selection is armed/locked (even if partial), mark the line as locked in the UI
  if (data.armed || data.success) {
    if (data.gameId && data.oddId) {
      const gameIdInt = parseInt(data.gameId);
      const lockKey = `${gameIdInt}_${data.oddId}`;
      lockedLines.add(lockKey);
      // Re-render odds so the card shows the LOCKED badge and "Ready to Bet"
      if (selectedGame && parseInt(selectedGame.id) === gameIdInt) {
        scheduleRenderOdds();
      }

      // Update locked odds map from backend, if provided
      if (typeof data.lockedOdds === 'number') {
        lockedOddsMap[lockKey] = data.lockedOdds;
      }

      // Get success/failure counts
      const successCount = data.successCount || 0;
      const failedCount = data.failedCount || 0;
      const totalProfiles = data.totalProfiles || 0;
      const isPartialSuccess = data.isPartialSuccess || (successCount > 0 && successCount < totalProfiles);

      // Show a Lock & Load ARMED popup if we didn't already show it for this line
      if (!lastArmedLockKey || lastArmedLockKey !== lockKey) {
        const sel = data.selection || 'Selection';
        const oddsSource =
          typeof data.lockedOdds === 'number'
            ? data.lockedOdds
            : typeof data.odds === 'number'
              ? data.odds
              : null;
        const oddsVal =
          typeof oddsSource === 'number'
            ? (oddsSource > 0 ? `+${oddsSource}` : `${oddsSource}`)
            : '';
        
        let toastMsg;
        if (isPartialSuccess && totalProfiles > 0) {
          toastMsg = `🔒 LOCK & LOAD ARMED (Partial)!<br><br><strong>${sel}</strong>${oddsVal ? `<br>@ ${oddsVal}` : ''}<br><br>✅ ${successCount}/${totalProfiles} account(s) locked<br>⚠️ ${failedCount} account(s) failed<br>✅ Ready to place bet on ${successCount} account(s)!`;
          showToast(toastMsg, 'warning', 6000);
        } else {
          toastMsg = `🔒 LOCK & LOAD ARMED!<br><br><strong>${sel}</strong>${oddsVal ? `<br>@ ${oddsVal}` : ''}<br><br>✅ Ready to place your real bet.`;
          showToast(toastMsg, 'lock', 5000);
        }
      }

      // Remember last armed key so we don't double-pop the same ARMED toast
      lastArmedLockKey = lockKey;
    }
    const armedMsg = data.message || 'Lock & Load ARMED and ready to bet';
    showPrefireStatus('✅ ' + armedMsg);
  } else if (data.marketNotAvailable || data.eventNotAvailable) {
    // Mark this line as unavailable if backend says so
    if (data.gameId && data.oddId) {
      const gameIdInt = parseInt(data.gameId);
      const marketKey = `${gameIdInt}_${data.oddId}`;
      unavailableMarkets.add(marketKey);
      if (selectedGame && parseInt(selectedGame.id) === gameIdInt) {
        scheduleRenderOdds();
      }
    }
    
    // If entire event is not available, show banner on dashboard
    if (data.eventNotAvailable) {
      markEventUnavailable(data.message || 'Event Not Available - This event is no longer available for betting');
    }
    
    const unavailableMsg = data.message || 'Market / Event Not Available';
    showPrefireStatus('⚠️ ' + unavailableMsg);
  } else if (data.retry) {
    showPrefireStatus('⚠️ ' + (data.message || 'Lock & Load: please retry'));
  } else {
    showPrefireStatus('❌ ' + (data.message || 'Lock & Load failed'));
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
  let allGames = Object.values(games);
  
  // Filter by game status (live or all)
  if (gameStatusFilter === 'live') {
    allGames = allGames.filter(game => {
      const status = (game.status || '').toLowerCase();
      // Check if game is actually live (has a score, status indicates in progress, etc.)
      // Games are considered live if:
      // - status contains time indicators (e.g., "1H 23:45", "2Q", "3rd", "4th", etc.)
      // - status contains "progress", "live", "playing"
      // - status is NOT "scheduled", "upcoming", "finished", "final", "ended"
      const notLiveStatuses = ['scheduled', 'upcoming', 'final', 'finished', 'ended', 'ft', 'postponed', 'cancelled', 'not started'];
      const isNotLive = notLiveStatuses.some(s => status.includes(s));
      
      // Also check if game has scores (indicates it's in play)
      const hasScores = (game.homeScore !== undefined && game.homeScore !== null && game.homeScore !== '') ||
                        (game.awayScore !== undefined && game.awayScore !== null && game.awayScore !== '');
      
      // If status indicates not live, filter out
      if (isNotLive) return false;
      
      // If has scores or has any status, consider it live
      return hasScores || status.length > 0;
    });
  }
  
  // Then filter by league
  const gamesList = activeLeagueFilter === 'all'
    ? allGames
    : allGames.filter(game => {
        const league =
          game.league ||
          game.competition ||
          game.sport ||
          game.category ||
          '';
        return String(league).toLowerCase() === activeLeagueFilter.toLowerCase();
      });
  
  document.getElementById('games-count').textContent = gamesList.length;
  
  if (gamesList.length === 0) {
    const noDataMsg =
      allGames.length === 0
        ? (gameStatusFilter === 'live' ? 'No live games right now' : 'No games available')
        : `No games found for league filter: ${activeLeagueFilter}`;
    container.innerHTML = `<div class="no-data">${noDataMsg}</div>`;
    return;
  }
  
  container.innerHTML = gamesList.map(game => {
    const status = (game.status || '').toLowerCase();
    const notLiveStatuses = ['scheduled', 'upcoming', 'final', 'finished', 'ended', 'ft', 'postponed', 'cancelled', 'not started'];
    const isLive = !notLiveStatuses.some(s => status.includes(s));
    const liveBadge = isLive ? '<span class="live-badge">🔴 LIVE</span>' : '<span class="upcoming-badge">📅 Upcoming</span>';
    
    return `
    <div class="game-card" onclick="selectGame(${game.id})">
      <div class="game-header">
        <span class="game-status">${game.status || 'In Progress'}</span>
        ${liveBadge}
        ${renderGameLeagueBadge(game)}
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
  `}).join('');
}

// Handle game status filter change (Live Only / All Games)
function handleGameStatusFilterChange(value) {
  gameStatusFilter = value || 'live';
  renderGames();
}

// Helper: render league badge for a game card (if league info available)
function renderGameLeagueBadge(game) {
  const league =
    game.league ||
    game.competition ||
    game.sport ||
    game.category ||
    '';
  if (!league) return '';
  return `<span class="badge bg-secondary ms-2" style="font-size: 0.7rem; text-transform: uppercase;">${league}</span>`;
}

// Update league filter dropdown options based on current games
function updateLeagueFilterOptions() {
  const select = document.getElementById('league-filter-select');
  if (!select) return;

  const leaguesSet = new Set();
  Object.values(games).forEach(game => {
    const league =
      game.league ||
      game.competition ||
      game.sport ||
      game.category ||
      '';
    if (league) {
      leaguesSet.add(String(league).trim());
    }
  });

  const leagues = Array.from(leaguesSet).sort((a, b) =>
    a.localeCompare(b)
  );

  // Preserve currently selected value if still present
  const currentValue = select.value || 'all';

  // Rebuild options
  select.innerHTML =
    '<option value="all">All</option>' +
    leagues
      .map(
        lg =>
          `<option value="${lg}">${lg}</option>`
      )
      .join('');

  // Restore selection when possible
  if (
    currentValue !== 'all' &&
    leagues.some(lg => lg.toLowerCase() === currentValue.toLowerCase())
  ) {
    select.value = currentValue;
    activeLeagueFilter = currentValue;
  } else {
    select.value = 'all';
    activeLeagueFilter = 'all';
  }
}

// Handle league filter change from UI
function handleLeagueFilterChange(value) {
  activeLeagueFilter = value || 'all';
  renderGames();
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

// Market Class Code to Tab mapping (from Fliff API - like Fliff Cluster V1)
const MARKET_CLASS_TABS = {
  // Main tabs
  55000: 'Popular',
  55001: 'Game Lines',
  55010: 'Props',
  55099: 'Showcase',
  101: 'Featured',
  
  // Period tabs
  55002: 'Halves',
  55003: 'Quarters',
  55007: 'Set',
  55008: 'Innings',
  
  // Props tabs  
  55004: 'Game Props',
  55005: 'Team Props',
  55006: 'Player Props',
  55009: 'Fast Props',
  
  // Soccer specific
  55021: 'Goals',
  55022: 'Cards',
  55023: 'Corners'
};

// Props tab codes for filtering
const PROPS_TAB_CODES = [55004, 55005, 55006, 55009, 55010];

// Categorize odds by section, subsection, and type - using market_class_codes like Fliff Cluster V1
function categorizeOdd(odd) {
  const market = (odd.market || '').toLowerCase();
  const selection = (odd.selection || '').toLowerCase();
  const param = String(odd.param || '').toLowerCase();
  const event = (odd.event || '').toLowerCase();
  const marketClassCodes = odd.marketClassCodes || [];
  const groupVisualName = (odd.groupVisualName || '').toLowerCase();
  const playerFkey = odd.playerFkey || '';
  
  // Combine all text for searching
  const allText = `${market} ${selection} ${param} ${event}`;
  
  // ==========================================
  // STEP 1: Determine TAB from market_class_codes (Fliff Cluster V1 approach)
  // Priority order matches Fliff's tab display order
  // ==========================================
  let tab = 'Game Lines'; // Default
  
  if (marketClassCodes && marketClassCodes.length > 0) {
    // Priority order for tab assignment (matches Fliff UI)
    if (marketClassCodes.includes(55099)) {
      tab = 'Showcase';
    } else if (marketClassCodes.includes(101)) {
      tab = 'Featured';
    } else if (marketClassCodes.includes(55000)) {
      tab = 'Popular';
    } else if (marketClassCodes.includes(55006)) {
      tab = 'Player Props';
    } else if (marketClassCodes.includes(55005)) {
      tab = 'Team Props';
    } else if (marketClassCodes.includes(55004)) {
      tab = 'Game Props';
    } else if (marketClassCodes.includes(55009)) {
      tab = 'Fast Props';
    } else if (marketClassCodes.includes(55010)) {
      tab = 'Props';
    } else if (marketClassCodes.includes(55002)) {
      tab = 'Halves';
    } else if (marketClassCodes.includes(55003)) {
      tab = 'Quarters';
    } else if (marketClassCodes.includes(55007)) {
      tab = 'Set';
    } else if (marketClassCodes.includes(55008)) {
      tab = 'Innings';
    } else if (marketClassCodes.includes(55021)) {
      tab = 'Goals';
    } else if (marketClassCodes.includes(55022)) {
      tab = 'Cards';
    } else if (marketClassCodes.includes(55023)) {
      tab = 'Corners';
    } else if (marketClassCodes.includes(55001)) {
      tab = 'Game Lines';
    }
  }
  
  // ==========================================
  // STEP 2: Fallback detection from market name if no market_class_codes
  // ==========================================
  
  // Detect player props from market name patterns
  // Include soccer-specific player props like "Goals", "Assists", "Shots"
  const isPlayerPropFromName = (
    market.includes('player prop') ||
    market.includes('player points') ||
    market.includes('player rebounds') ||
    market.includes('player assists') ||
    market.includes('player steals') ||
    market.includes('player blocks') ||
    market.includes('player threes') ||
    market.includes('player turnovers') ||
    market.includes('anytime scorer') ||
    market.includes('first scorer') ||
    market.includes('last scorer') ||
    market.includes('to score') ||
    market.includes('pts+') || 
    market.includes('reb+') ||
    market.includes('ast+') ||
    // Soccer player props - "Goals", "Assists", "Shots" etc with player name
    market === 'goals' ||
    market === 'assists' ||
    market === 'shots' ||
    market === 'shots on target' ||
    market === 'tackles' ||
    market === 'passes' ||
    market === 'fouls' ||
    market === 'cards' ||
    market.includes('anytime goal') ||
    market.includes('first goal') ||
    market.includes('last goal') ||
    market.includes('to score first') ||
    market.includes('to score last') ||
    market.includes('to score anytime') ||
    (playerFkey && playerFkey.length > 0) || // Has player fkey
    (groupVisualName && /^[a-z]+\s+[a-z]+$/i.test(groupVisualName)) // Group looks like player name
  );
  
  // Check if selection looks like a player name (for player props without explicit market indicator)
  // Also check if selection contains a player name with Over/Under pattern
  const hasPlayerNamePattern = selection && (
    /^[A-Z][a-z]+\s+[A-Z][a-z]+/i.test(selection) ||  // "LeBron James"
    /^[A-Z]\.\s*[A-Z][a-z]+/i.test(selection) ||       // "L. James"
    /^[A-Z][a-z]+\s+[A-Z]\./i.test(selection) ||       // "LeBron J."
    // Player name + Over/Under pattern: "Lionel Messi Over 0.5" or "Over 0.5 - Lionel Messi"
    /[A-Z][a-z]+\s+[A-Z][a-z]+.*\s+(over|under)\s*/i.test(selection) ||
    /(over|under)\s+[\d.]+\s*[-–]\s*[A-Z][a-z]+/i.test(selection)
  );
  
  // Detect if this is a player prop by checking for player-specific patterns in selection
  // E.g., "Lionel Messi Over 0.5", "C. Ronaldo Under 1.5"
  const selectionHasPlayerOverUnder = selection && (
    /[A-Z][a-z]+\s+[A-Z][a-z]+.*\s+(over|under)/i.test(selection) ||
    /[A-Z]\.\s*[A-Z][a-z]+.*\s+(over|under)/i.test(selection) ||
    /(over|under)\s+[\d.]+\s*[-–—:]\s*[A-Z]/i.test(selection)
  );
  
  // Detect team props from market name patterns
  const isTeamPropFromName = (
    market.includes('team prop') ||
    market.includes('team points') ||
    market.includes('team rebounds') ||
    market.includes('team total') ||
    market.includes('team to score') ||
    (market.includes('prop') && (market.includes('team') || market.includes('home') || market.includes('away')))
  );
  
  // Update tab if we detected props but didn't get from market_class_codes
  if (tab === 'Game Lines') {
    if (isPlayerPropFromName || selectionHasPlayerOverUnder || (hasPlayerNamePattern && !selection.includes('team'))) {
      tab = 'Player Props';
    } else if (isTeamPropFromName) {
      tab = 'Team Props';
    }
  }
  
  // ==========================================
  // STEP 3: Determine subsection (period info) from market name
  // ==========================================
  let subsection = 'Game';
  
  // Check for quarters
  if (allText.match(/\b(q1|1st\s*quarter|first\s*quarter|quarter\s*1)\b/i)) {
    subsection = '1st Quarter';
  } else if (allText.match(/\b(q2|2nd\s*quarter|second\s*quarter|quarter\s*2)\b/i)) {
    subsection = '2nd Quarter';
  } else if (allText.match(/\b(q3|3rd\s*quarter|third\s*quarter|quarter\s*3)\b/i)) {
    subsection = '3rd Quarter';
  } else if (allText.match(/\b(q4|4th\s*quarter|fourth\s*quarter|quarter\s*4)\b/i)) {
    subsection = '4th Quarter';
  }
  // Check for halves
  else if (allText.match(/\b(1h|h1|1st\s*half|first\s*half|half\s*1)\b/i)) {
    subsection = '1st Half';
  } else if (allText.match(/\b(2h|h2|2nd\s*half|second\s*half|half\s*2)\b/i)) {
    subsection = '2nd Half';
  }
  // Check for periods (hockey)
  else if (allText.match(/\b(p1|1st\s*period|first\s*period|period\s*1)\b/i)) {
    subsection = '1st Period';
  } else if (allText.match(/\b(p2|2nd\s*period|second\s*period|period\s*2)\b/i)) {
    subsection = '2nd Period';
  } else if (allText.match(/\b(p3|3rd\s*period|third\s*period|period\s*3)\b/i)) {
    subsection = '3rd Period';
  }
  // Check for innings (baseball)
  else if (allText.match(/\b(1st\s*inning|inning\s*1)\b/i)) {
    subsection = '1st Inning';
  } else if (allText.match(/\b(first\s*5|f5|1st\s*5)\b/i)) {
    subsection = 'First 5 Innings';
  }
  // Check for sets (tennis)
  else if (allText.match(/\b(set\s*1|1st\s*set|first\s*set)\b/i)) {
    subsection = '1st Set';
  } else if (allText.match(/\b(set\s*2|2nd\s*set|second\s*set)\b/i)) {
    subsection = '2nd Set';
  }
  
  // ==========================================
  // STEP 4: Determine section from tab and period info
  // ==========================================
  let section = tab;
  
  // Add period info to section if applicable
  if (subsection !== 'Game') {
    if (subsection.includes('Quarter')) {
      if (tab === 'Player Props') {
        section = 'Player Props - Quarters';
      } else if (tab === 'Team Props') {
        section = 'Team Props - Quarters';
      } else if (tab !== 'Quarters') {
        section = `${tab} - Quarters`;
      }
    } else if (subsection.includes('Half')) {
      if (tab === 'Player Props') {
        section = 'Player Props - Halves';
      } else if (tab === 'Team Props') {
        section = 'Team Props - Halves';
      } else if (tab !== 'Halves') {
        section = `${tab} - Halves`;
      }
    } else if (subsection.includes('Period')) {
      if (tab === 'Player Props') {
        section = 'Player Props - Periods';
      } else if (tab === 'Team Props') {
        section = 'Team Props - Periods';
      } else {
        section = `${tab} - Periods`;
      }
    } else if (subsection.includes('Inning')) {
      if (tab !== 'Innings') {
        section = `${tab} - Innings`;
      }
    } else if (subsection.includes('Set')) {
      if (tab !== 'Set') {
        section = `${tab} - Sets`;
      }
    }
  }
  
  // ==========================================
  // STEP 5: Determine bet type from market name
  // IMPORTANT: Check main game lines FIRST, then props
  // This prevents moneyline/spread/totals from being misclassified as props
  // ==========================================
  let type = 'Other';
  
  // Alternative/Alternate checks - comprehensive detection
  const isAlternative = (
    market.includes('alternative') || 
    market.includes('alternate') || 
    market.includes('alt ') || 
    market.includes('alt.') ||
    market.includes('alt-') ||
    market.startsWith('alt ') ||
    /\balt\b/i.test(market) ||  // Word boundary match for "alt"
    /\balternate\b/i.test(market) ||
    /\balternative\b/i.test(market)
  );
  
  // FIRST: Check if this is a prop based on tab (from market_class_codes) or detection
  const isDefinitelyPlayerProp = tab === 'Player Props' || isPlayerPropFromName || selectionHasPlayerOverUnder;
  const isDefinitelyTeamProp = tab === 'Team Props' || isTeamPropFromName;
  const isDefinitelyGameProp = tab === 'Game Props' || tab === 'Props' || tab === 'Fast Props';
  
  // Check if this is a main game line type (moneyline, spread, totals)
  // These should NOT be classified as props even if they appear in prop tabs
  const isMoneylineMarket = market.includes('moneyline') || market.includes('money line') || market.includes(' ml') || market === 'ml' || market.includes('to win');
  const isSpreadMarket = market.includes('point spread') || market.includes('spread') || market.includes('handicap');
  const isTotalMarket = market.includes('total score') || market.includes('total points') || (market.includes('total') && !market.includes('team total') && !isDefinitelyPlayerProp);
  const isMainGameLine = isMoneylineMarket || isSpreadMarket || isTotalMarket;
  
  // ==========================================
  // MAIN GAME LINES FIRST (prevent misclassification)
  // ==========================================
  
  // Moneyline detection - check FIRST (before props)
  if (isMoneylineMarket) {
    if (market.includes('3-way') || market.includes('3 way') || selection.includes('draw') || selection.includes('tie')) {
      type = '3-Way Moneyline';
    } else if (isAlternative) {
      type = 'Alternative Moneyline';
    } else {
      type = 'Moneyline';
    }
  }
  // Spread detection - check before props
  else if (isSpreadMarket) {
    if (isAlternative) {
      type = 'Alternative Point Spread';
    } else {
      type = 'Point Spread';
    }
  }
  // Total Score detection - check before props
  else if (market.includes('total score')) {
    if (isAlternative) {
      type = 'Alternative Total Score';
    } else {
      type = 'Total Score';
    }
  }
  // Team Total detection
  else if (market.includes('team total') || (market.includes('total') && (selection.includes('home') || selection.includes('away')))) {
    if (isAlternative) {
      type = 'Alternative Team Totals';
    } else {
    type = 'Team Totals';
    }
  }
  // General Total detection (only for game-level totals, not player props)
  else if (isTotalMarket || market.includes('over/under') || market.includes('o/u')) {
    if (isAlternative) {
      type = 'Alternative Totals';
    } else {
      type = 'Totals';
    }
  }
  // ==========================================
  // PROPS (only if not a main game line)
  // ==========================================
  else if (isDefinitelyPlayerProp && !isMainGameLine) {
    type = 'Player Props';
  } else if (isDefinitelyTeamProp && !isMainGameLine) {
    type = 'Team Props';
  } else if (isDefinitelyGameProp && !isMainGameLine) {
    type = 'Game Props';
  }
  // ==========================================
  // FALLBACK DETECTION from selection patterns
  // ==========================================
  // Over/Under from selection (only if not already detected as prop and not a main game line)
  else if ((selection.includes('over') || selection.includes('under') || selection.match(/^[ou]\s*\d+/i)) && !isDefinitelyPlayerProp) {
    if (isAlternative) {
      type = 'Alternative Totals';
    } else {
    type = 'Totals';
  }
  }
  // Win/Draw from selection (likely moneyline)
  else if (selection.includes('win') || selection.includes('victory')) {
    if (isAlternative) {
      type = 'Alternative Moneyline';
    } else {
    type = 'Moneyline';
  }
  }
  // Spread pattern in selection (e.g., "+7.5", "-3")
  else if (selection.match(/[+-]\d+\.?\d*/) && !selection.includes('over') && !selection.includes('under')) {
    if (isAlternative) {
      type = 'Alternative Point Spread';
    } else {
    type = 'Point Spread';
    }
  }
  
  // ==========================================
  // STEP 6: OVERRIDE section for main game lines that were wrongly assigned to Props tabs
  // If it's a Moneyline/Spread/Totals type but was assigned to Player Props/Team Props/Game Props,
  // move it to Game Lines section instead
  // ==========================================
  const isMainGameLineType = (
    type === 'Moneyline' || 
    type === 'Alternative Moneyline' ||
    type === '3-Way Moneyline' ||
    type === 'Point Spread' || 
    type === 'Alternative Point Spread' ||
    type === 'Total Score' || 
    type === 'Alternative Total Score' ||
    type === 'Totals' || 
    type === 'Alternative Totals' ||
    type === 'Team Totals' ||
    type === 'Alternative Team Totals'
  );
  
  const isPropsSection = (
    section === 'Player Props' || 
    section === 'Team Props' || 
    section === 'Game Props' || 
    section === 'Props' ||
    section === 'Fast Props' ||
    section.includes('Player Props -') ||
    section.includes('Team Props -')
  );
  
  // Override: Move main game lines from Props sections to Game Lines
  if (isMainGameLineType && isPropsSection) {
    // Preserve the period/quarter/half info if present
    if (subsection !== 'Game') {
      if (subsection.includes('Quarter')) {
        section = 'Game Lines - Quarters';
      } else if (subsection.includes('Half')) {
        section = 'Game Lines - Halves';
      } else if (subsection.includes('Period')) {
        section = 'Game Lines - Periods';
      } else if (subsection.includes('Inning')) {
        section = 'Game Lines - Innings';
      } else if (subsection.includes('Set')) {
        section = 'Game Lines - Sets';
      } else {
        section = 'Game Lines';
      }
    } else {
      section = 'Game Lines';
    }
    // Also update tab for consistency
    tab = 'Game Lines';
  }
  
  return { 
    section, 
    subsection, 
    type, 
    tab, // Include raw tab for debugging
    marketClassCodes, // Include for debugging
    category: `${section}::${subsection}::${type}`,
    isAlternate: isAlternative, // Flag for alternate markets
    // Debug info
    _debug: {
      isPlayerProp: isDefinitelyPlayerProp,
      isTeamProp: isDefinitelyTeamProp,
      isGameProp: isDefinitelyGameProp,
      isAlternative,
      isMainGameLine,
      isMainGameLineType,
      isPropsSection,
      wasMovedToGameLines: isMainGameLineType && isPropsSection,
      isMoneylineMarket,
      isSpreadMarket,
      isTotalMarket,
      selectionHasPlayerOverUnder,
      hasPlayerNamePattern,
      isPlayerPropFromName
    }
  };
}

// Get section display order (matches Fliff tab order)
function getSectionOrder(section) {
  const order = {
    // Featured/Popular first
    'Showcase': 1,
    'Featured': 2,
    'Popular': 3,
    
    // Main game lines
    'Game Lines': 10,
    'Gameline': 10, // Legacy alias
    
    // Quarters
    'Quarters': 20,
    'Game Lines - Quarters': 21,
    
    // Halves
    'Halves': 30,
    'Game Lines - Halves': 31,
    
    // Props
    'Props': 40,
    'Game Props': 41,
    'Fast Props': 42,
    'Player Props': 50,
    'Team Props': 60,
    
    // Props with periods
    'Player Props - Quarters': 51,
    'Player Props - Halves': 52,
    'Player Props - Periods': 53,
    'Team Props - Quarters': 61,
    'Team Props - Halves': 62,
    'Team Props - Periods': 63,
    
    // Periods (hockey)
    'Periods': 70,
    'Game Lines - Periods': 71,
    
    // Baseball
    'Innings': 80,
    'Game Lines - Innings': 81,
    
    // Tennis
    'Set': 90,
    'Game Lines - Sets': 91,
    
    // Soccer specific
    'Goals': 100,
    'Cards': 101,
    'Corners': 102,
    
    // Other
    'Other': 999
  };
  return order[section] || 500; // Unknown sections go in middle
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

// Get type display order - Main markets first, then alternates, then props
function getTypeOrder(type) {
  const order = {
    // === MAIN GAME LINES (FIRST) ===
    'Moneyline': 1,           // Primary moneyline
    'Point Spread': 2,        // Primary spread
    'Total Score': 3,         // Primary total score
    'Totals': 4,              // Primary totals (over/under)
    '3-Way Moneyline': 5,     // 3-way (soccer)
    'Team Totals': 6,         // Team-specific totals
    
    // === ALTERNATE LINES (GROUPED TOGETHER) ===
    'Alternative Moneyline': 20,       // Alt moneyline
    'Alternative Point Spread': 21,    // Alt spread
    'Alternative Total Score': 22,     // Alt total score
    'Alternative Totals': 23,          // Alt totals
    'Alternative Team Totals': 24,     // Alt team totals
    
    // === PROPS (AFTER ALTERNATES) ===
    'Game Props': 30,
    'Player Props': 31,
    'Team Props': 32,
    'Props': 33,              // General props fallback
    
    // === OTHER ===
    'Other': 999
  };
  return order[type] || 500;
}

// Get display name for type - adds "Regulation" to main lines to distinguish from alternatives
function getTypeDisplayName(type) {
  const displayNames = {
    // Main game lines - add "Regulation" prefix
    'Moneyline': 'Regulation Moneyline',
    'Point Spread': 'Regulation Point Spread',
    'Total Score': 'Regulation Total Score',
    'Totals': 'Regulation Totals',
    'Team Totals': 'Regulation Team Totals',
    '3-Way Moneyline': '3-Way Regulation Moneyline',
    
    // Alternates - keep as is (already clear they're alternatives)
    'Alternative Moneyline': 'Alternative Moneyline',
    'Alternative Point Spread': 'Alternative Point Spread',
    'Alternative Total Score': 'Alternative Total Score',
    'Alternative Totals': 'Alternative Totals',
    'Alternative Team Totals': 'Alternative Team Totals',
    
    // Props - keep as is
    'Player Props': 'Player Props',
    'Team Props': 'Team Props',
    'Game Props': 'Game Props',
    'Props': 'Props'
  };
  return displayNames[type] || type;
}

// Build vertical odds layout like Fliff "Game Lines" UI:
// - Top: section tabs (Gameline, Halves, Player Props, etc.)
// - Below: for the active section, a vertical list of bet types
//   (Moneyline, Point Spread, Total Score, Alternative Point Spread, etc.)
//   where each type row is collapsible and shows its odds grouped by period.
function buildVerticalOddsHtml({ organizedOdds, oddsList, gameId }) {
  const sortedSections = Object.keys(organizedOdds).sort((a, b) => {
    return getSectionOrder(a) - getSectionOrder(b);
  });

  if (sortedSections.length === 0) {
    return `
      <div class="alert alert-warning">
        <h5>No odds available</h5>
        <p>There are currently no markets for this game.</p>
      </div>
    `;
  }

  // Decide which section is currently active; default to first available
  if (!activeSection || !organizedOdds[activeSection]) {
    activeSection = sortedSections[0];
  }

  const activeSectionData = organizedOdds[activeSection];

  // Build section tabs (Game Lines / Halves / etc.)
  const tabsHtml = `
    <ul class="nav nav-pills mb-3 odds-section-tabs">
      ${sortedSections
        .map(
          (section) => `
        <li class="nav-item">
          <button 
            class="nav-link ${section === activeSection ? 'active' : ''}" 
            onclick="setActiveSection('${section.replace(/'/g, "\\'")}')"
          >
            ${section}
          </button>
        </li>
      `
        )
        .join('')}
    </ul>
  `;

  // Render only the active section (vertical type list)
  let html = '';

  if (activeSectionData) {
    const sectionId = `section-active`;

    // Build type groups across all subsections so we can show a
    // vertical list like: MONEYLINE, POINT SPREAD, TOTAL SCORE, etc.
    const typeGroups = {}; // type -> { total, subsections: { [subsection]: odds[] } }

    Object.keys(activeSectionData).forEach((subsection) => {
      const subsectionData = activeSectionData[subsection];
      Object.keys(subsectionData).forEach((type) => {
        const oddsArr = subsectionData[type];
        if (!typeGroups[type]) {
          typeGroups[type] = { total: 0, subsections: {} };
        }
        typeGroups[type].total += oddsArr.length;
        typeGroups[type].subsections[subsection] = oddsArr;
      });
    });

    const sortedTypesForSection = Object.keys(typeGroups).sort((a, b) => {
      return getTypeOrder(a) - getTypeOrder(b);
    });

    // Helper renderers for different type layouts
    function renderTotalsGroup(typeOdds, subsectionLabel) {
      if (!typeOdds || typeOdds.length === 0) return '';

      const groupedByLine = {};
      typeOdds.forEach((odd) => {
        const selection = odd.selection || '';
        const selectionLower = selection.toLowerCase();
        const isOver = selectionLower.includes('over') || selectionLower.startsWith('o ');
        const isUnder = selectionLower.includes('under') || selectionLower.startsWith('u ');

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

        if (!groupedByLine[lineKey]) {
          groupedByLine[lineKey] = { over: null, under: null, lineKey };
        }
        if (isOver) groupedByLine[lineKey].over = odd;
        else if (isUnder) groupedByLine[lineKey].under = odd;
      });

      const sortedPairs = Object.values(groupedByLine).sort((a, b) => {
        const numA = parseFloat(a.lineKey) || 0;
        const numB = parseFloat(b.lineKey) || 0;
        return numA - numB;
      });

      let h = '';
      if (subsectionLabel && subsectionLabel !== 'Game') {
        h += `<div class="mb-1"><small class="text-uppercase text-muted" style="font-size: 0.7rem;">${subsectionLabel}</small></div>`;
      }
      h += `<div class="row g-2">`;

      sortedPairs.forEach(({ over, under, lineKey }) => {
        const param = over?.param || under?.param || lineKey;

        h += `
          <div class="col-12 mb-3">
            <div class="d-flex gap-2" style="gap: 8px;">
        `;

        function renderTotalsCard(label, odd) {
          const change = odd.prevOdds ? odd.odds - odd.prevOdds : 0;
          const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
          const changeText = change !== 0 ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`) : '';
          const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
          const lockKey = `${gameId}_${odd.id}`;
          const isLockedCheck = lockedLines.has(lockKey);
          const isUnavailableCheck = unavailableMarkets.has(lockKey);
          const isSuspendedCheck = odd.suspended === true;
          const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
          const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
          const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
          const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
          const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ Market Unavailable</div>' : '';
          const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';

          return `
            <div class="flex-fill">
              <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}" style="border-color: var(--border);">
                ${lockedBadge}
                ${unavailableBadge}
                ${suspendedBadge}
                <div class="card-body p-3">
                  <div class="d-flex justify-content-between align-items-start mb-2">
                    <small style="font-size: 0.75rem; font-weight: 600; color: white;">${label}</small>
                    ${changeText ? `<small class="${changeClass}" style="font-weight: 600;">${changeText}</small>` : ''}
                  </div>
                  <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${odd.selection || label}</div>
                  ${param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${param}</small>` : ''}
                  <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                    ${odd.odds > 0 ? '+' : ''}${odd.odds}
                  </div>
                  ${getBetButtonsHTML(odd.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
                </div>
              </div>
            </div>
          `;
        }

        if (over) h += renderTotalsCard('OVER', over);
        if (under) h += renderTotalsCard('UNDER', under);

        h += `
            </div>
          </div>
        `;
      });

      h += `</div>`;
      return h;
    }

    function renderSpreadGroup(typeOdds, subsectionLabel) {
      if (!typeOdds || typeOdds.length === 0) return '';

      const groupedByLine = {};
      typeOdds.forEach((odd) => {
        const selection = odd.selection || '';
        const numberMatch = selection.match(/([+-]?\d+\.?\d*)/);
        if (numberMatch) {
          const lineNumber = Math.abs(parseFloat(numberMatch[1]));
          const isPositive = selection.includes('+') || (numberMatch[1] && !numberMatch[1].startsWith('-'));

          if (!groupedByLine[lineNumber]) {
            groupedByLine[lineNumber] = { positive: null, negative: null };
          }
          if (isPositive) groupedByLine[lineNumber].positive = odd;
          else groupedByLine[lineNumber].negative = odd;
        } else {
          const key = selection || 'other';
          if (!groupedByLine[key]) {
            groupedByLine[key] = { positive: null, negative: null };
          }
          groupedByLine[key].positive = odd;
        }
      });

      let h = '';
      if (subsectionLabel && subsectionLabel !== 'Game') {
        h += `<div class="mb-1"><small class="text-uppercase text-muted" style="font-size: 0.7rem;">${subsectionLabel}</small></div>`;
      }
      h += `<div class="row g-2">`;

      Object.values(groupedByLine).forEach(({ positive, negative }) => {
        h += `
          <div class="col-12 mb-3">
            <div class="d-flex gap-2" style="gap: 8px;">
        `;

        function renderSpreadCard(odd) {
          const change = odd.prevOdds ? odd.odds - odd.prevOdds : 0;
          const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
          const changeText = change !== 0 ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`) : '';
          const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
          const lockKey = `${gameId}_${odd.id}`;
          const isLockedCheck = lockedLines.has(lockKey);
          const isUnavailableCheck = unavailableMarkets.has(lockKey);
          const isSuspendedCheck = odd.suspended === true;
          const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
          const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
          const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
          const suspendedBadge = isSuspendedCheck && !isLockedCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';

          return `
            <div class="flex-fill">
              <div class="card h-100 odd-card ${lockedClass} ${suspendedClass}" style="border-color: var(--border);">
                ${lockedBadge}
                ${suspendedBadge}
                <div class="card-body p-3">
                  <div class="d-flex justify-content-between align-items-start mb-2">
                    <small style="font-size: 0.75rem; font-weight: 600; color: white;">${odd.market || 'Line'}</small>
                    ${changeText ? `<small class="${changeClass}" style="font-weight: 600; color: white;">${changeText}</small>` : ''}
                  </div>
                  <div class="fw-bold mb-2" style="font-size: 0.95rem; font-weight: 600; line-height: 1.4; color: white;">${odd.selection || ''}</div>
                  ${odd.param ? `<small style="font-size: 0.75rem; font-weight: 500; color: rgba(255,255,255,0.8);">${odd.param}</small>` : ''}
                  <div class="odd-value ${oddClass} fw-bold mb-2" style="font-size: 1.25rem; font-weight: 700; color: white;">
                    ${odd.odds > 0 ? '+' : ''}${odd.odds}
                  </div>
                  ${getBetButtonsHTML(odd.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
                </div>
              </div>
            </div>
          `;
        }

        if (positive) h += renderSpreadCard(positive);
        if (negative) h += renderSpreadCard(negative);

        h += `
            </div>
          </div>
        `;
      });

      h += `</div>`;
      return h;
    }

    function renderGenericGroup(typeOdds, subsectionLabel) {
      if (!typeOdds || typeOdds.length === 0) return '';

      let h = '';
      if (subsectionLabel && subsectionLabel !== 'Game') {
        h += `<div class="mb-1"><small class="text-uppercase text-muted" style="font-size: 0.7rem;">${subsectionLabel}</small></div>`;
      }
      h += `<div class="row g-2">`;

      typeOdds.forEach((odd) => {
        const change = odd.prevOdds ? odd.odds - odd.prevOdds : 0;
        const changeClass = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : '';
        const changeText = change !== 0 ? (change > 0 ? `↑${change}` : `↓${Math.abs(change)}`) : '';
        const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
        const lockKey = `${gameId}_${odd.id}`;
        const isLockedCheck = lockedLines.has(lockKey);
        const isUnavailableCheck = unavailableMarkets.has(lockKey);
        const isSuspendedCheck = odd.suspended === true;
        const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
        const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
        const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
        const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
        const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ Market Unavailable</div>' : '';
        const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';

        h += `
          <div class="col-6">
            <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}">
              ${lockedBadge}
              ${unavailableBadge}
              ${suspendedBadge}
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
                ${getBetButtonsHTML(odd.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
              </div>
            </div>
          </div>
        `;
      });

      h += `</div>`;
      return h;
    }

    // Count total odds in this section
    const sectionTotal = Object.values(typeGroups).reduce((sum, g) => sum + g.total, 0);

    // Card wrapper for the active section
    html += `
      <div class="card mb-3">
        <div class="card-header bg-primary text-white">
          <div class="d-flex justify-content-between align-items-center">
            <h5 class="mb-0">${activeSection} <span class="badge bg-light text-dark ms-2">${sectionTotal}</span></h5>
          </div>
        </div>
        <div class="card-body" id="${sectionId}" style="display: block; overflow: hidden;">
          <div class="odds-type-columns-wrapper" style="overflow-x: auto; padding-bottom: 4px;">
            <div class="d-flex" style="gap: 24px; min-width: 100%;">
    `;

    // Render bet types (Moneyline, Point Spread, etc.) as horizontal columns.
    // Up to ~3 columns are visible depending on viewport; extra columns scroll horizontally.
    sortedTypesForSection.forEach((type, typeIndex) => {
      const group = typeGroups[type];
      const typeId = `${sectionId}-type-${typeIndex}`;

      html += `
              <div class="odds-type-column" style="flex: 0 0 calc(100% / 2 - 24px); min-width: 420px; max-width: 520px;">
                <div class="odds-type-group mb-3" style="border: 1px solid var(--border); border-radius: 12px; padding: 8px 8px 12px 8px; background: rgba(0,0,0,0.25);">
                  <div class="d-flex justify-content-between align-items-center odds-type-header"
                       style="cursor: pointer; padding: 10px 12px; border-bottom: 1px solid var(--border);"
                       onclick="toggleSubsection('${typeId}')">
                    <div class="d-flex align-items-center">
                      <span style="font-size: 0.8rem; margin-right: 6px;">★</span>
                      <span style="font-weight: 700; text-transform: uppercase;">${getTypeDisplayName(type)}</span>
                    </div>
                    <div>
                      <span class="badge bg-secondary me-2">${group.total}</span>
                      <span class="subsection-toggle" id="toggle-${typeId}" style="font-size: 0.9em;">▼</span>
                    </div>
                  </div>
                  <div id="${typeId}" style="display: block; padding: 8px 4px 0 4px;">
      `;

      // Within each type we still respect subsections (Game / 1st Half / etc.)
      const subsectionsForType = Object.keys(group.subsections).sort((a, b) => {
        return getSubsectionOrder(a) - getSubsectionOrder(b);
      });

      subsectionsForType.forEach((subsectionLabel) => {
        const typeOdds = group.subsections[subsectionLabel];
        if (!typeOdds || typeOdds.length === 0) return;

        const isTotalsType =
          type === 'Totals' ||
          type === 'Total Score' ||
          type === 'Alternative Total Score' ||
          type === 'Alternative Totals' ||
          type === 'Team Totals' ||
          type === 'Alternative Team Totals';
        const isSpreadType = type === 'Point Spread' || type === 'Alternative Point Spread';
        const isMoneylineType = type === 'Moneyline' || type === 'Alternative Moneyline' || type === '3-Way Moneyline';

        if (isTotalsType) {
          html += renderTotalsGroup(typeOdds, subsectionLabel);
        } else if (isSpreadType) {
          html += renderSpreadGroup(typeOdds, subsectionLabel);
        } else {
          html += renderGenericGroup(typeOdds, subsectionLabel);
        }
      });

      html += `
                  </div>
                </div>
              </div>
      `;
    });

    // Close flex row, wrapper, and card body
    html += `
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Add summary at top (same as before) and prepend tabs
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

  return summaryHtml + tabsHtml + html;
}

// Debounced render function to prevent flickering
// Increased debounce time for better performance on low-end servers
let lastRenderTime = 0;
function scheduleRenderOdds() {
  if (renderOddsTimeout) {
    clearTimeout(renderOddsTimeout);
  }
  pendingRenderOdds = true;
  
  // Throttle to max 2 renders per second (500ms minimum between renders)
  const now = Date.now();
  const timeSinceLastRender = now - lastRenderTime;
  const minInterval = 500; // 500ms minimum between renders
  
  const delay = Math.max(150, minInterval - timeSinceLastRender);
  
  renderOddsTimeout = setTimeout(() => {
    if (pendingRenderOdds) {
      pendingRenderOdds = false;
      lastRenderTime = Date.now();
      requestAnimationFrame(() => {
        renderOdds();
      });
    }
  }, delay);
}

function renderOdds() {
  const container = document.getElementById('odds-list');
  
  if (!selectedGame) {
    container.innerHTML = '<div class="alert alert-info">Select a game to view odds</div>';
    return;
  }
  
  const gameId = parseInt(selectedGame.id);
  
  // Ensure we're using the correct game ID
  const odds = gameOdds[gameId] || {};
  const allOddsList = Object.values(odds);
  
  // Filter out ghost lines (but show locked lines with special styling)
  // Ghost lines are typically:
  // 1. Odds that don't match the current game (wrong gameId)
  // 2. Odds without verified game info
  // 3. Odds with malformed IDs
  // 4. Odds missing required fields
  // Locked lines are shown with special animation/indicator
  const oddsList = allOddsList.filter(odd => {
    // Don't filter out locked lines - show them with animation instead
    const lockKey = `${gameId}_${odd.id}`;
    if (lockedLines.has(lockKey)) {
      odd._isLocked = true; // Mark as locked for rendering
    }
    
    // Filter out unavailable markets if filter is enabled
    if (hideUnavailableMarkets && unavailableMarkets.has(lockKey)) {
      return false; // Hide unavailable markets when filter is on
    }
    
    // CRITICAL: Must match the current game
    if (odd.gameId && parseInt(odd.gameId) !== gameId) {
      return false; // Filter out odds from wrong game (ghost lines)
    }
    
    // Must have verified game info (backend verified it belongs to this game)
    if (!odd.verifiedGame && !odd.gameId) {
      return false; // Filter out unverified odds
    }
    
    const oddId = odd.id || '';
    const oddIdStr = String(oddId);
    
    // Must have a valid ID
    if (!oddId || oddIdStr.length < 5) {
      return false; // Filter out odds with invalid/missing IDs
    }
    
    // Check for valid proposal_fkey format patterns:
    // Valid formats: "123456_p_399_inplay", "123456_p_399_prematch", "123456_p_602_universal"
    // Ghost lines often have incomplete or malformed IDs
    
    // Pattern 1: Standard format with underscore separators
    const hasStandardFormat = /^\d+_p_\d+_(inplay|prematch|universal)$/.test(oddIdStr);
    
    // Pattern 2: Alternative format (just numbers and underscores)
    const hasAltFormat = /^\d+_/.test(oddIdStr) && oddIdStr.split('_').length >= 2;
    
    // Pattern 3: Simple numeric ID (less common but valid)
    const isNumericOnly = /^\d+$/.test(oddIdStr);
    
    // Must have valid format OR be a simple numeric ID
    if (!hasStandardFormat && !hasAltFormat && !isNumericOnly) {
      return false; // Filter out malformed IDs (ghost lines)
    }
    
    // Must have required fields for placing bets
    if (!odd.selection || odd.odds === undefined || odd.odds === null) {
      return false; // Filter out odds missing required data
    }
    
    // Filter out odds with suspicious channel patterns (channel 461 with multiple games often has ghost lines)
    // If channel is 461 and gameId doesn't match, it's likely a ghost line
    if (odd.channelId === 461 && odd.gameId && parseInt(odd.gameId) !== gameId) {
      return false; // Filter out channel 461 ghost lines
    }
    
    // Keep odds that pass all checks
    return true;
  });
  
  
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
  
  // Debug: Track all sections found
  const sectionsFound = new Set();
  const tabsFromClassCodes = new Map();
  
  oddsList.forEach(odd => {
    const result = categorizeOdd(odd);
    const { section, subsection, type, tab, marketClassCodes } = result;
    
    sectionsFound.add(section);
    
    // Track market_class_codes usage
    if (marketClassCodes && marketClassCodes.length > 0) {
      const key = marketClassCodes.sort().join(',');
      if (!tabsFromClassCodes.has(key)) {
        tabsFromClassCodes.set(key, { tab, count: 0, sample: odd.market });
      }
      tabsFromClassCodes.get(key).count++;
    }
    
    
    // Debug: Track market names
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
  
  // Sort sections
  const sortedSections = Object.keys(organizedOdds).sort((a, b) => {
    return getSectionOrder(a) - getSectionOrder(b);
  });
  
  // Preserve activeSection if it still exists, otherwise use first available
  // This prevents tab switching on every odds update
  if (!activeSection || !organizedOdds[activeSection]) {
    // Only reset if the section truly doesn't exist
    if (sortedSections.length > 0) {
      activeSection = sortedSections[0];
    }
  }

  const activeSectionData = organizedOdds[activeSection];

  // Build section tabs (Fliff Cluster V1 style - Showcase / Game Lines / Props / etc)
  const tabIcons = {
    // Featured/Popular
    'Showcase': '🔥',
    'Featured': '⚡',
    'Popular': '⭐',
    
    // Main game lines
    'Game Lines': '🎯',
    'Gameline': '🎯',
    
    // Quarters
    'Quarters': '⏱️',
    'Game Lines - Quarters': '⏱️',
    
    // Halves
    'Halves': '⏰',
    'Game Lines - Halves': '⏰',
    
    // Props
    'Props': '📊',
    'Game Props': '🎲',
    'Fast Props': '⚡',
    'Player Props': '👤',
    'Team Props': '🏀',
    
    // Props with periods
    'Player Props - Quarters': '👤',
    'Player Props - Halves': '👤',
    'Player Props - Periods': '👤',
    'Team Props - Quarters': '🏀',
    'Team Props - Halves': '🏀',
    'Team Props - Periods': '🏀',
    
    // Periods (hockey)
    'Periods': '🕐',
    'Game Lines - Periods': '🕐',
    
    // Baseball
    'Innings': '⚾',
    'Game Lines - Innings': '⚾',
    
    // Tennis
    'Set': '🎾',
    'Game Lines - Sets': '🎾',
    
    // Soccer specific
    'Goals': '⚽',
    'Cards': '🟨',
    'Corners': '📐',
    
    // Other
    'Specials': '⭐',
    'Other': '📋'
  };
  
  // Count odds in each section for badges
  const sectionCounts = {};
  sortedSections.forEach(section => {
    let count = 0;
    const sectionData = organizedOdds[section];
    Object.keys(sectionData).forEach(subsection => {
      Object.keys(sectionData[subsection]).forEach(type => {
        count += sectionData[subsection][type].length;
      });
    });
    sectionCounts[section] = count;
  });
  
  const tabsHtml = `
    <div class="odds-tabs-container">
      <div class="odds-tabs">
        ${sortedSections.map(section => `
          <div 
            class="odds-tab ${section === activeSection ? 'active' : ''}" 
            onclick="setActiveSection('${section.replace(/'/g, "\\'")}')"
          >
            <span>${tabIcons[section] || '📋'} ${section}</span>
            <span class="odds-tab-count">${sectionCounts[section]}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Render only the active section (to avoid long scrolling)
  let html = '';

  if (activeSectionData) {
    const sectionId = `section-active`;

    // Count total odds in this section
    let sectionTotal = 0;
    Object.keys(activeSectionData).forEach(subsection => {
      Object.keys(activeSectionData[subsection]).forEach(type => {
        sectionTotal += activeSectionData[subsection][type].length;
      });
    });

    // Sort subsections within active section
    const sortedSubsections = Object.keys(activeSectionData).sort((a, b) => {
      return getSubsectionOrder(a) - getSubsectionOrder(b);
    });

    html += `
      <div class="market-group">
        <div class="market-group-header">
          <span class="market-group-title">${tabIcons[activeSection] || '📋'} ${activeSection}</span>
          <span class="market-group-count">${sectionTotal} markets</span>
        </div>
        <div class="market-group-content" id="${sectionId}">
    `;

    // Render each subsection within active section
    sortedSubsections.forEach((subsection, subsectionIndex) => {
      const subsectionData = activeSectionData[subsection];
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
          <div id="${subsectionId}" style="display: block; white-space: nowrap; overflow-x: auto; padding-bottom: 4px;">
      `;

      // Render each type within subsection (reuse existing logic)
      sortedTypes.forEach(type => {
        const typeOdds = subsectionData[type];
        if (typeOdds.length === 0) return;

        // Check if this is a Totals type (Over/Under)
        const isTotalsType = type === 'Totals' || type === 'Total Score' || type === 'Alternative Total Score' || 
                            type === 'Alternative Totals' || type === 'Team Totals' || type === 'Alternative Team Totals';

        html += `
          <div class="mb-3 odds-type-column" style="display: inline-block; vertical-align: top; width: 420px; max-width: 520px; margin-right: 24px; white-space: normal; border: 1px solid var(--border); border-radius: 12px; padding: 8px 8px 12px 8px; background: rgba(0,0,0,0.25);">
            <h6 class="text-muted mb-2" style="font-size: 0.95rem; font-weight: 600;">
              ${getTypeDisplayName(type)} <span class="badge bg-secondary" style="font-size: 0.8rem;">${typeOdds.length}</span>
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
              const oddClass = over.odds > 0 ? 'text-success' : 'text-danger';
              const lockKey = `${gameId}_${over.id}`;
              const isLockedCheck = lockedLines.has(lockKey);
              const isUnavailableCheck = unavailableMarkets.has(lockKey);
              const isSuspendedCheck = over.suspended === true;
              const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
              const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
              const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
              const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
              const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ MARKET UNAVAILABLE</div>' : '';
              const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
              
              html += `
                <div class="flex-fill">
                  <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}" style="border-color: var(--border);">
                    ${lockedBadge}
                    ${unavailableBadge}
                    ${suspendedBadge}
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
                      ${getBetButtonsHTML(over.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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
              const oddClass = under.odds > 0 ? 'text-success' : 'text-danger';
              const lockKey = `${gameId}_${under.id}`;
              const isLockedCheck = lockedLines.has(lockKey);
              const isUnavailableCheck = unavailableMarkets.has(lockKey);
              const isSuspendedCheck = under.suspended === true;
              const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
              const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
              const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
              const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
              const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ MARKET UNAVAILABLE</div>' : '';
              const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
              
              html += `
                <div class="flex-fill">
                  <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}" style="border-color: var(--border);">
                    ${lockedBadge}
                    ${unavailableBadge}
                    ${suspendedBadge}
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
                      ${getBetButtonsHTML(under.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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
              const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
              const lockKey = `${gameId}_${odd.id}`;
              const isLockedCheck = lockedLines.has(lockKey);
              const isUnavailableCheck = unavailableMarkets.has(lockKey);
              const isSuspendedCheck = odd.suspended === true;
              const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
              const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
              const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
              const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
              const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ MARKET UNAVAILABLE</div>' : '';
              const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
              
              html += `
                <div class="col-6">
                  <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}">
                    ${lockedBadge}
                    ${unavailableBadge}
                    ${suspendedBadge}
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
                      ${getBetButtonsHTML(odd.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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
            
            Object.values(groupedByLine).forEach(({ positive, negative }) => {
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
                const oddClass = positive.odds > 0 ? 'text-success' : 'text-danger';
                const lockKey = `${gameId}_${positive.id}`;
                const isLockedCheck = lockedLines.has(lockKey);
                const isUnavailableCheck = unavailableMarkets.has(lockKey);
                const isSuspendedCheck = positive.suspended === true;
                const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
                const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
                const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
                const suspendedBadge = isSuspendedCheck && !isLockedCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
                
                html += `
                  <div class="flex-fill">
                    <div class="card h-100 odd-card ${lockedClass} ${suspendedClass}" style="border-color: var(--border);">
                      ${lockedBadge}
                      ${suspendedBadge}
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
                        ${getBetButtonsHTML(positive.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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
                const oddClass = negative.odds > 0 ? 'text-success' : 'text-danger';
                const lockKey = `${gameId}_${negative.id}`;
                const isLockedCheck = lockedLines.has(lockKey);
                const isUnavailableCheck = unavailableMarkets.has(lockKey);
                const isSuspendedCheck = negative.suspended === true;
                const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
                const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
                const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
                const suspendedBadge = isSuspendedCheck && !isLockedCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
                
                html += `
                  <div class="flex-fill">
                    <div class="card h-100 odd-card ${lockedClass} ${suspendedClass}" style="border-color: var(--border);">
                      ${lockedBadge}
                      ${suspendedBadge}
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
                        ${getBetButtonsHTML(negative.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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
                const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
                const lockKey = `${gameId}_${odd.id}`;
                const isLockedCheck = lockedLines.has(lockKey);
                const isUnavailableCheck = unavailableMarkets.has(lockKey);
                const isSuspendedCheck = odd.suspended === true;
                const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
                const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
                const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
                const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
                const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ MARKET UNAVAILABLE</div>' : '';
                const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
                
                html += `
                  <div class="col-6">
                    <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}">
                      ${lockedBadge}
                      ${unavailableBadge}
                      ${suspendedBadge}
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
                        ${getBetButtonsHTML(odd.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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
              
              const oddClass = odd.odds > 0 ? 'text-success' : 'text-danger';
              const lockKey = `${gameId}_${odd.id}`;
              const isLockedCheck = lockedLines.has(lockKey);
              const isUnavailableCheck = unavailableMarkets.has(lockKey);
              const isSuspendedCheck = odd.suspended === true;
              const lockedClass = isLockedCheck ? 'odd-card-locked' : '';
              const unavailableClass = isUnavailableCheck ? 'odd-card-unavailable' : '';
              const suspendedClass = isSuspendedCheck ? 'odd-card-suspended' : '';
              const lockedBadge = isLockedCheck ? '<div class="locked-badge">🔒 LOCKED</div>' : '';
              const unavailableBadge = isUnavailableCheck ? '<div class="unavailable-badge">⚠️ Market Unavailable</div>' : '';
              const suspendedBadge = isSuspendedCheck && !isLockedCheck && !isUnavailableCheck ? '<div class="suspended-badge">🔒 SUSPENDED</div>' : '';
              
              html += `
                <div class="col-6">
                  <div class="card h-100 odd-card ${lockedClass} ${unavailableClass} ${suspendedClass}">
                    ${lockedBadge}
                    ${unavailableBadge}
                    ${suspendedBadge}
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
                      ${getBetButtonsHTML(odd.id, isLockedCheck, isUnavailableCheck, isSuspendedCheck)}
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

    // Close market-group-content and market-group
    html += `
        </div>
      </div>
    `;
  }
  
  // Add tabs and then content
  container.innerHTML = tabsHtml + html;
}

// =============================================
// GAME SELECTION
// =============================================

// Track game data loading state
let pendingGameLoad = null;
let pendingGameLoadStartTime = null;
let pendingGameLoadCheckInterval = null;

async function selectGame(gameId) {
  // Ensure gameId is a number
  const gameIdInt = parseInt(gameId);
  
  selectedGame = games[gameIdInt];
  
  if (!selectedGame) {
    return;
  }
  
  // Reset event unavailable state for new game
  eventUnavailable = false;
  hideEventUnavailableBanner();
  
  // Clear any previous pending load
  if (pendingGameLoadCheckInterval) {
    clearInterval(pendingGameLoadCheckInterval);
    pendingGameLoadCheckInterval = null;
  }
  
  // Set pending game load state
  pendingGameLoad = gameIdInt;
  pendingGameLoadStartTime = Date.now();
  
  // Show loading overlay
  showGameLoadingOverlay(selectedGame);
  
  // Update panel title and show game panel
  document.getElementById('panel-title').textContent = 
    `${selectedGame.home} vs ${selectedGame.away}`;
  
  renderScoreCard(selectedGame);
  updateDisplays();
  
  document.getElementById('game-panel').classList.remove('hidden');
  document.querySelector('.games-section').classList.add('hidden');
  
  // Subscribe to game updates via WebSocket FIRST (to receive data ASAP)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'subscribe', gameId: gameIdInt, priority: true }));
  }
  
  // Load existing odds for this game from backend
  loadGameOdds(gameIdInt);
  
  // Navigate main profile browser to game (this will trigger fresh data)
  const navResult = await navigateMainProfileToGame(gameIdInt);
  
  // Start checking for data arrival - keep overlay until we have good data
  pendingGameLoadCheckInterval = setInterval(() => {
    const oddsCount = Object.keys(gameOdds[gameIdInt] || {}).length;
    const elapsed = Date.now() - pendingGameLoadStartTime;
    
    // Update loading progress
    updateLoadingProgress(oddsCount, elapsed);
    
    // Check if we have enough data (at least 10 odds OR 8 seconds elapsed)
    if (oddsCount >= 10) {
      clearInterval(pendingGameLoadCheckInterval);
      pendingGameLoadCheckInterval = null;
      pendingGameLoad = null;
      hideGameLoadingOverlay();
      renderOdds(); // Force re-render with loaded data (user-initiated, not debounced)
    } else if (elapsed > 8000) {
      // Timeout after 8 seconds
      clearInterval(pendingGameLoadCheckInterval);
      pendingGameLoadCheckInterval = null;
      pendingGameLoad = null;
      hideGameLoadingOverlay();
      
      // If no odds after 8 seconds, the event might be unavailable
      if (oddsCount === 0) {
        markEventUnavailable('No markets available - event may have ended or is not available');
      }
      
      renderOdds(); // User-initiated, not debounced
    }
  }, 200); // Check every 200ms
}

// Update loading progress on overlay
function updateLoadingProgress(oddsCount, elapsed) {
  const subtitle = document.getElementById('loading-subtitle');
  const progressEl = document.getElementById('loading-progress');
  
  if (subtitle) {
    if (oddsCount > 0) {
      subtitle.textContent = `Loading markets... (${oddsCount} found)`;
    } else if (elapsed > 2000) {
      subtitle.textContent = 'Waiting for market data...';
    } else {
      subtitle.textContent = 'Navigating to game...';
    }
  }
  
  if (progressEl) {
    const progress = Math.min(100, (oddsCount / 50) * 100 + (elapsed / 8000) * 20);
    progressEl.style.width = `${progress}%`;
  }
}

// Timer variables
let loadingTimerInterval = null;
let loadingTimerSeconds = 15;

// Show game loading overlay with 15-second countdown
function showGameLoadingOverlay(game) {
  const overlay = document.getElementById('game-loading-overlay');
  const title = document.getElementById('loading-title');
  const subtitle = document.getElementById('loading-subtitle');
  const timerText = document.getElementById('timer-text');
  const timerCircle = document.getElementById('timer-circle');
  
  if (overlay) {
    title.textContent = `${game.home} vs ${game.away}`;
    subtitle.textContent = 'Opening game on main profile browser...';
    overlay.classList.remove('hidden');
    
    // Start countdown timer
    loadingTimerSeconds = 15;
    if (timerText) timerText.textContent = loadingTimerSeconds;
    if (timerCircle) {
      timerCircle.style.strokeDashoffset = '0';
      timerCircle.style.stroke = '#00d4ff';
    }
    
    // Clear any existing timer
    if (loadingTimerInterval) {
      clearInterval(loadingTimerInterval);
    }
    
    // Start countdown
    loadingTimerInterval = setInterval(() => {
      loadingTimerSeconds--;
      
      if (timerText) {
        timerText.textContent = Math.max(0, loadingTimerSeconds);
      }
      
      if (timerCircle) {
        // Circle circumference = 2 * PI * r = 2 * 3.14159 * 45 ≈ 283
        const circumference = 283;
        const offset = circumference * (1 - loadingTimerSeconds / 15);
        timerCircle.style.strokeDashoffset = offset;
        
        // Change color as time runs out
        if (loadingTimerSeconds <= 5) {
          timerCircle.style.stroke = '#ff6b6b';
        } else if (loadingTimerSeconds <= 10) {
          timerCircle.style.stroke = '#ffd93d';
        }
      }
      
      // Update subtitle based on progress
      if (subtitle) {
        if (loadingTimerSeconds > 12) {
          subtitle.textContent = 'Navigating to game...';
        } else if (loadingTimerSeconds > 8) {
          subtitle.textContent = 'Loading markets...';
        } else if (loadingTimerSeconds > 4) {
          subtitle.textContent = 'Fetching odds data...';
        } else {
          subtitle.textContent = 'Almost ready...';
        }
      }
      
      if (loadingTimerSeconds <= 0) {
        clearInterval(loadingTimerInterval);
        loadingTimerInterval = null;
        hideGameLoadingOverlay();
      }
    }, 1000);
  }
}

// Hide game loading overlay
function hideGameLoadingOverlay() {
  const overlay = document.getElementById('game-loading-overlay');
  
  // Clear timer
  if (loadingTimerInterval) {
    clearInterval(loadingTimerInterval);
    loadingTimerInterval = null;
  }
  
  if (overlay) {
    overlay.classList.add('hidden');
  }
}

// Navigate main profile browser to selected game
async function navigateMainProfileToGame(gameId) {
  const game = games[gameId];
  if (!game) {
    return false;
  }
  
  // Update loading subtitle
  const subtitle = document.getElementById('loading-subtitle');
  if (subtitle) {
    subtitle.textContent = 'Navigating browser to game...';
  }
  
  try {
    // Use conflictFkey if available, otherwise use gameId
    const requestBody = game.conflictFkey 
      ? { conflictFkey: game.conflictFkey }
      : { gameId: gameId };
    
    // Use user-scoped endpoint if in user mode
    const navEndpoint = window.USER_MODE && window.CURRENT_USERNAME
      ? `${API_URL}/api/user/${window.CURRENT_USERNAME}/navigate-to-game`
      : `${API_URL}/api/main-profile/navigate-to-game`;
    
    const response = await fetch(navEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    const result = await response.json();
    
    if (result.success) {
      // Update loading subtitle
      if (subtitle) {
        subtitle.textContent = 'Loading markets and odds...';
      }
      
      showToast(`🎯 Browser synced<br>${game.home} vs ${game.away}`, 'success', 2000);
      return true;
    } else {
      if (subtitle) {
        subtitle.textContent = 'Loading from cache...';
      }
      return false;
    }
  } catch (e) {
    if (subtitle) {
      subtitle.textContent = 'Loading from cache...';
    }
    return false;
  }
}

function closeGamePanel() {
  // Unsubscribe from game updates when leaving game view
  if (ws && ws.readyState === WebSocket.OPEN && selectedGame) {
    ws.send(JSON.stringify({ type: 'unsubscribe' }));
  }
  
  selectedGame = null;
  eventUnavailable = false;
  hideEventUnavailableBanner();
  document.getElementById('game-panel').classList.add('hidden');
  document.querySelector('.games-section').classList.remove('hidden');
}

// Mark entire event as unavailable (show banner on dashboard)
function markEventUnavailable(message) {
  eventUnavailable = true;
  showEventUnavailableBanner(message);
}

// Show event unavailable banner on dashboard
function showEventUnavailableBanner(message) {
  let banner = document.getElementById('event-unavailable-banner');
  if (!banner) {
    // Create banner if it doesn't exist
    banner = document.createElement('div');
    banner.id = 'event-unavailable-banner';
    banner.className = 'event-unavailable-banner';
    banner.innerHTML = `
      <div class="event-unavailable-content">
        <span class="event-unavailable-icon">⚠️</span>
        <span class="event-unavailable-text"></span>
      </div>
    `;
    // Insert at the top of odds-section
    const oddsSection = document.querySelector('.odds-section');
    if (oddsSection) {
      oddsSection.insertBefore(banner, oddsSection.firstChild);
    }
  }
  
  const textEl = banner.querySelector('.event-unavailable-text');
  if (textEl) {
    textEl.textContent = message || 'Event Not Available';
  }
  banner.style.display = 'block';
}

// Hide event unavailable banner
function hideEventUnavailableBanner() {
  const banner = document.getElementById('event-unavailable-banner');
  if (banner) {
    banner.style.display = 'none';
  }
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

// Change active odds section (Gameline, Player Props, etc.)
function setActiveSection(sectionName) {
  activeSection = sectionName;
  renderOdds();
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
  toggleUnavailableFilter,
  toggleSection,
  toggleSubsection,
  setActiveSection,
  handleLeagueFilterChange,
  handleGameStatusFilterChange,
  markEventUnavailable
};
