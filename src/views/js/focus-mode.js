// These values are set by inline script before this file loads
// window.FOCUS_MODE_INIT = { quadrant: '...', actionableCount: N }
let currentLeverage = 10;
let lastQuadrant = window.FOCUS_MODE_INIT?.quadrant || 'NEU+NEU';
let lastActionableCount = window.FOCUS_MODE_INIT?.actionableCount || 0;
let audioContext = null;

// Quadrant rules - maps quadrant to recommended action
// Must match the Quick Reference panel in focus-mode-dashboard.ts
const QUADRANT_RULES = {
  'BULL+BULL': 'SHORT',  // Fade euphoria - HIGH WIN RATE
  'BULL+NEU': 'SKIP',    // Wait for clearer signal
  'BULL+BEAR': 'LONG',   // Buy macro-bull dip
  'NEU+BULL': 'SHORT',   // Fade the rally
  'NEU+NEU': 'SKIP',     // No clear regime
  'NEU+BEAR': 'LONG',    // Contrarian long - buy the dip
  'BEAR+BULL': 'SKIP',   // BULL TRAP - never trade
  'BEAR+NEU': 'SKIP',    // Wait for clearer signal
  'BEAR+BEAR': 'LONG'    // Deep contrarian long
};

function getQuadrantAction(quadrant) {
  return QUADRANT_RULES[quadrant] || 'SKIP';
}

// Load Focus Mode settings from localStorage (separate from Screener)
function loadFocusModeSettings() {
  try {
    const saved = localStorage.getItem('focusMode_settings');
    if (saved) return JSON.parse(saved);
  } catch (e) {}
  return { notificationsEnabled: false, audioEnabled: true, linkDestination: 'futures', activeWindowHours: 4 };
}

function saveFocusModeSettings() {
  try {
    localStorage.setItem('focusMode_settings', JSON.stringify({
      notificationsEnabled,
      audioEnabled,
      linkDestination,
      activeWindowHours
    }));
  } catch (e) {}
}

// Initialize from saved settings
let { notificationsEnabled, audioEnabled, linkDestination, activeWindowHours } = loadFocusModeSettings();
activeWindowHours = activeWindowHours || 4; // Default fallback

// Change time window and reload with new filter
function changeTimeWindow(hours) {
  activeWindowHours = parseInt(hours);
  saveFocusModeSettings();
  // Reload page with new time window
  const currentConfig = document.getElementById('config-select')?.value || '4h/1h';
  window.location.href = '/focus?config=' + encodeURIComponent(currentConfig) + '&window=' + hours;
}

// Toggle link destination between bots and futures
function toggleLinkDestination() {
  linkDestination = linkDestination === 'bots' ? 'futures' : 'bots';
  saveFocusModeSettings();
  updateLinkButton();
  showToast(linkDestination === 'bots' ? '🤖 Links open Trading Bots' : '📊 Links open Futures Trading');
}

function updateLinkButton() {
  const btn = document.getElementById('link-btn');
  if (btn) {
    btn.textContent = linkDestination === 'bots' ? '🤖 Bots' : '📊 Futures';
    btn.classList.toggle('active', linkDestination === 'bots');
  }
}

// Open MEXC trade URL based on Focus Mode settings
function openMexcTrade(symbol) {
  const base = symbol.replace('USDT', '');
  let url;
  if (linkDestination === 'bots') {
    url = 'https://www.mexc.com/futures/trading-bots/grid/' + base + '_USDT';
  } else {
    url = 'https://www.mexc.com/futures/' + base + '_USDT';
  }
  window.open(url, '_blank');
}

// Update manual entry price
function updateManualEntry(cardId) {
  const input = document.getElementById('entry-input-' + cardId);
  if (!input || !activePositions[cardId]) return;

  const newEntry = parseFloat(input.value);
  if (isNaN(newEntry) || newEntry <= 0) {
    showToast('❌ Invalid entry price');
    return;
  }

  activePositions[cardId].entryPrice = newEntry;
  activePositions[cardId].manualEntry = true;

  // Reset tracking values so trail alerts can trigger again with new entry
  // This fixes the bug where adjusting entry would stop trail notifications
  activePositions[cardId].prevPnlPct = undefined;
  activePositions[cardId].prevRoiPct = undefined;
  activePositions[cardId].prevTrailStatus = undefined;
  activePositions[cardId].prevDangers = undefined;
  activePositions[cardId].trailStopAlerted = false;
  activePositions[cardId].trailStopAlertedAt = null;

  saveActivePositions();
  updatePositionHealth(cardId);
  showToast('✅ Entry updated to $' + newEntry.toFixed(6));
}

// Calculate entry price from current ROI%
// ROI% = (P&L% * leverage), so P&L% = ROI% / leverage
// For LONG: P&L% = (current - entry) / entry * 100 => entry = current / (1 + P&L%/100)
// For SHORT: P&L% = (entry - current) / entry * 100 => entry = current / (1 - P&L%/100)
function updateFromROI(cardId) {
  const roiInput = document.getElementById('roi-input-' + cardId);
  const entryInput = document.getElementById('entry-input-' + cardId);
  const pos = activePositions[cardId];

  if (!roiInput || !entryInput || !pos) {
    showToast('❌ Start tracking first');
    return;
  }

  const roiPct = parseFloat(roiInput.value);
  if (isNaN(roiPct)) {
    showToast('❌ Enter a valid ROI% (e.g. 44.5 or -12.3)');
    return;
  }

  if (!pos.currentPrice) {
    showToast('❌ Waiting for price data...');
    return;
  }

  // Get suggested leverage from card data attribute, or use existing position leverage, or default to 15
  const card = document.getElementById(cardId);
  const suggestedLev = (card && card.dataset.leverage) ? card.dataset.leverage : (pos.leverage || '15');

  // Ask for leverage to convert ROI to spot P&L
  const leverage = prompt('What leverage are you using?', suggestedLev.toString());
  if (!leverage) return;
  const lev = parseFloat(leverage);
  if (isNaN(lev) || lev <= 0) {
    showToast('❌ Invalid leverage');
    return;
  }

  // Convert ROI% to spot P&L%
  const spotPnlPct = roiPct / lev;
  const current = pos.currentPrice;
  const isLong = pos.direction === 'LONG';

  // Calculate entry from current price and P&L%
  let calculatedEntry;
  if (isLong) {
    // P&L% = (current - entry) / entry * 100
    // entry = current / (1 + P&L%/100)
    calculatedEntry = current / (1 + spotPnlPct / 100);
  } else {
    // P&L% = (entry - current) / entry * 100
    // entry = current / (1 - P&L%/100)
    calculatedEntry = current / (1 - spotPnlPct / 100);
  }

  // Update the entry input and save
  entryInput.value = calculatedEntry.toFixed(6);
  pos.entryPrice = calculatedEntry;
  pos.manualEntry = true;
  pos.leverage = lev; // Save leverage for display

  // Reset tracking values so trail alerts can trigger again with new entry
  // This fixes the bug where adjusting entry would stop trail notifications
  pos.prevPnlPct = undefined;
  pos.prevRoiPct = undefined;
  pos.prevTrailStatus = undefined;
  pos.prevDangers = undefined;
  pos.trailStopAlerted = false;
  pos.trailStopAlertedAt = null;

  saveActivePositions();
  updatePositionHealth(cardId);
  showToast('✅ Entry calculated: $' + calculatedEntry.toFixed(6) + ' (from ' + roiPct + '% ROI at ' + lev + 'x)');
}

// Calculate trailing stop based on P&L
// Thresholds are based on ROI% (leveraged P&L) for better UX
function calculateTrailingStop(pos) {
  if (!pos.entryPrice || !pos.currentPrice) {
    return { stop: null, info: 'Waiting for price data...' };
  }

  const entry = pos.entryPrice;
  const current = pos.currentPrice;
  const isLong = pos.direction === 'LONG';
  const leverage = pos.leverage || 1;

  // Calculate spot P&L %
  const spotPnlPct = isLong
    ? ((current - entry) / entry) * 100
    : ((entry - current) / entry) * 100;

  // Calculate ROI (leveraged P&L) for threshold checks
  const roiPct = spotPnlPct * leverage;

  let suggestedStop;
  let info;
  let status; // profit, breakeven, loss

  // Thresholds based on ROI% (leveraged returns)
  // At 15x: 30% ROI = 2% spot, 75% ROI = 5% spot, 150% ROI = 10% spot
  if (roiPct >= 30) {
    // At +30% ROI: Trail at 70% of gains
    const lockSpotPct = spotPnlPct * 0.7;
    const lockRoiPct = roiPct * 0.7;
    suggestedStop = isLong
      ? entry * (1 + lockSpotPct / 100)
      : entry * (1 - lockSpotPct / 100);
    info = '🚀 +' + roiPct.toFixed(0) + '% ROI! Trail at 70% (lock ' + lockRoiPct.toFixed(0) + '% ROI)';
    status = 'profit';
  } else if (roiPct >= 15) {
    // At +15% ROI: Trail at 50% of gains
    const lockSpotPct = spotPnlPct * 0.5;
    const lockRoiPct = roiPct * 0.5;
    suggestedStop = isLong
      ? entry * (1 + lockSpotPct / 100)
      : entry * (1 - lockSpotPct / 100);
    info = '📈 +' + roiPct.toFixed(0) + '% ROI. Trail at 50% (lock ' + lockRoiPct.toFixed(0) + '% ROI)';
    status = 'profit';
  } else if (roiPct >= 5) {
    // At +5% ROI: Move to breakeven
    suggestedStop = entry;
    info = '✅ +' + roiPct.toFixed(0) + '% ROI - Move stop to breakeven';
    status = 'breakeven';
  } else if (roiPct >= 0) {
    // 0-5% ROI: Keep original stop
    suggestedStop = pos.stopPrice;
    info = '⏳ +' + roiPct.toFixed(1) + '% ROI - Keep original stop, wait for +5% to move to BE';
    status = 'neutral';
  } else {
    // Negative: Keep original stop
    suggestedStop = pos.stopPrice;
    info = '⚠️ ' + roiPct.toFixed(1) + '% ROI - In drawdown, keep original stop';
    status = 'loss';
  }

  return { stop: suggestedStop, info, status, pnlPct: spotPnlPct, roiPct };
}

// Search/filter signals
function filterSignals(query) {
  const q = query.toUpperCase().trim();
  const cards = document.querySelectorAll('.trade-card');
  const archiveCards = document.querySelectorAll('.archive-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const symbol = card.id.replace('card-', '').split('-')[0].toUpperCase();
    const matches = !q || symbol.includes(q);
    card.style.display = matches ? '' : 'none';
    if (matches) visibleCount++;
  });

  // Also filter archive
  archiveCards.forEach(card => {
    const symbol = (card.getAttribute('data-symbol') || '').toUpperCase();
    const matches = !q || symbol.includes(q);
    card.style.display = matches ? '' : 'none';
  });

  document.getElementById('search-count').textContent = visibleCount + ' active';
}

// Toggle archive section
let archiveExpanded = false;
function toggleArchive() {
  archiveExpanded = !archiveExpanded;
  const cards = document.getElementById('archive-cards');
  const toggle = document.getElementById('archive-toggle');
  if (cards && toggle) {
    cards.style.display = archiveExpanded ? 'grid' : 'none';
    toggle.textContent = archiveExpanded ? '▲ Hide' : '▼ Show';
  }
}

// ============= Position Monitor =============
let activePositions = {};  // { cardId: { symbol, direction, entryPrice, entryRsi, enteredAt } }

function loadActivePositions() {
  try {
    const saved = localStorage.getItem('focusMode_positions');
    if (saved) activePositions = JSON.parse(saved);
  } catch (e) {}
}

function saveActivePositions() {
  try {
    localStorage.setItem('focusMode_positions', JSON.stringify(activePositions));
  } catch (e) {}
}

function enterTrade(cardId, symbol, direction, entryPrice, entryRsi, targetPrice, stopPrice) {
  activePositions[cardId] = {
    symbol,
    direction,
    entryPrice,
    entryRsi,
    targetPrice,
    stopPrice,
    enteredAt: Date.now()
  };
  saveActivePositions();

  // Update UI
  document.getElementById('enter-btn-' + cardId).style.display = 'none';
  document.getElementById('monitor-active-' + cardId).style.display = 'block';

  // Highlight the card instead of expanding
  const card = document.getElementById(cardId);
  if (card) {
    highlightCard(cardId);
  }

  updatePositionHealth(cardId);
  updateCloseAllButton();
  showToast('📊 Position monitor started for ' + symbol.replace('USDT', ''));
}

function exitTrade(cardId) {
  delete activePositions[cardId];
  saveActivePositions();

  // Update UI
  const enterBtn = document.getElementById('enter-btn-' + cardId);
  const monitorActive = document.getElementById('monitor-active-' + cardId);
  const headerStatus = document.getElementById('header-status-' + cardId);
  if (enterBtn) enterBtn.style.display = 'block';
  if (monitorActive) monitorActive.style.display = 'none';
  if (headerStatus) headerStatus.classList.remove('active');

  showToast('Position monitor stopped');
  updateCloseAllButton();
}

function closeAllPositions() {
  const positionCount = Object.keys(activePositions).length;
  if (positionCount === 0) {
    showToast('No positions being tracked');
    return;
  }

  if (!confirm('Stop tracking all ' + positionCount + ' position(s)?\\n\\nThis will NOT close your actual MEXC positions - you must do that manually.')) {
    return;
  }

  // Get all card IDs before clearing
  const cardIds = Object.keys(activePositions);

  // Clear all positions
  activePositions = {};
  saveActivePositions();

  // Update UI for each card
  cardIds.forEach(function(cardId) {
    const enterBtn = document.getElementById('enter-btn-' + cardId);
    const monitorActive = document.getElementById('monitor-active-' + cardId);
    const headerStatus = document.getElementById('header-status-' + cardId);
    if (enterBtn) enterBtn.style.display = 'block';
    if (monitorActive) monitorActive.style.display = 'none';
    if (headerStatus) headerStatus.classList.remove('active');
  });

  updateCloseAllButton();
  showToast('🛑 Stopped tracking ' + positionCount + ' position(s). Remember to close on MEXC!');
}

function updateCloseAllButton() {
  const btn = document.getElementById('close-all-btn');
  if (btn) {
    const hasPositions = Object.keys(activePositions).length > 0;
    btn.classList.toggle('visible', hasPositions);
  }
}

// Investment Amount Management
let currentInvestmentAmount = 2000;  // Default

async function loadInvestmentAmount() {
  try {
    const res = await fetch('/api/investment-amount');
    const data = await res.json();
    currentInvestmentAmount = data.amount;

    // Update the input field
    const input = document.getElementById('investment-amount-input');
    if (input) input.value = currentInvestmentAmount;

    console.log('[Focus] Investment amount loaded:', currentInvestmentAmount);
  } catch (err) {
    console.error('[Focus] Failed to load investment amount:', err);
  }
}

async function saveInvestmentAmount() {
  const input = document.getElementById('investment-amount-input');
  const btn = document.getElementById('investment-save-btn');
  const amount = parseFloat(input.value);

  if (isNaN(amount) || amount <= 0) {
    showToast('❌ Enter a valid investment amount');
    return;
  }

  // Disable button during save
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  try {
    const res = await fetch('/api/investment-amount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount, resetBots: false })
    });

    const data = await res.json();

    if (data.success) {
      currentInvestmentAmount = data.amount;
      showToast('✅ Investment amount updated to $' + amount.toLocaleString());
    } else {
      showToast('❌ Failed to update investment amount');
    }
  } catch (err) {
    console.error('[Focus] Failed to save investment amount:', err);
    showToast('❌ Error saving investment amount');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }
}

// Load investment amount on page load
loadInvestmentAmount();

function toggleMonitor(cardId) {
  const content = document.getElementById('monitor-content-' + cardId);
  if (content) {
    content.classList.toggle('collapsed');
  }
}

// Update distance from signal entry for all cards (not just active positions)
function updateAllEntryDistances(prices) {
  document.querySelectorAll('.trade-card').forEach(function(card) {
    const cardId = card.id;
    const symbol = card.dataset.symbol;
    const signalEntry = parseFloat(card.dataset.signalEntry);
    const direction = card.dataset.direction;

    if (!symbol || !signalEntry || !direction) return;

    const currentPrice = prices[symbol];
    if (!currentPrice) return;

    updateEntryDistance(cardId, signalEntry, currentPrice, direction);
  });
}

function updateEntryDistance(cardId, signalEntry, currentPrice, direction) {
  const distanceBadge = document.getElementById('entry-distance-' + cardId);
  const entryCurrentValue = document.getElementById('entry-current-value-' + cardId);
  const card = document.getElementById(cardId);

  if (!signalEntry || !currentPrice) return;

  // Calculate percentage change from signal entry
  const pctChange = ((currentPrice - signalEntry) / signalEntry) * 100;

  // Determine if this is favorable or against based on direction
  const isLong = direction === 'LONG';
  const isFavorable = isLong ? pctChange < 0 : pctChange > 0;  // For longs, lower price is favorable entry
  const isAgainst = isLong ? pctChange > 0 : pctChange < 0;    // For longs, higher price means missed entry

  // Format the percentage
  const sign = pctChange >= 0 ? '+' : '';
  const pctText = sign + pctChange.toFixed(1) + '%';

  // Determine class based on favorability
  let statusClass = 'neutral';
  if (Math.abs(pctChange) > 1) {  // Only color if moved more than 1%
    statusClass = isFavorable ? 'favorable' : 'against';
  }

  // Update badge in header (collapsed view)
  if (distanceBadge) {
    distanceBadge.textContent = '📍 ' + pctText;
    distanceBadge.className = 'entry-distance ' + statusClass;
  }

  // Update expanded view row
  if (entryCurrentValue) {
    const formatPrice = function(p) { return p >= 1 ? p.toFixed(4) : p.toFixed(6); };
    const priceClass = pctChange >= 0 ? 'up' : 'down';
    entryCurrentValue.innerHTML = '$' + formatPrice(signalEntry) +
      ' → <span class="current-price ' + priceClass + '">$' + formatPrice(currentPrice) + '</span>' +
      ' <span class="distance-pct ' + statusClass + '">' + pctText + '</span>';
  }

  // Add stale class if price moved more than 20% from entry
  if (card && Math.abs(pctChange) > 20) {
    card.classList.add('stale');
  } else if (card) {
    card.classList.remove('stale');
  }
}

function updatePositionHealth(cardId) {
  const pos = activePositions[cardId];
  if (!pos) return;

  const monitor = document.getElementById('monitor-' + cardId);
  if (!monitor) return;

  // Calculate health indicators
  const now = Date.now();
  const timeInTrade = now - pos.enteredAt;
  const timeMinutes = Math.floor(timeInTrade / 60000);
  const timeHours = Math.floor(timeMinutes / 60);

  // Time health
  let timeStatus = 'good';
  let timeText = timeMinutes + 'm';
  if (timeHours >= 24) {
    timeStatus = 'bad';
    timeText = Math.floor(timeHours / 24) + 'd ' + (timeHours % 24) + 'h';
  } else if (timeHours >= 12) {
    timeStatus = 'warning';
    timeText = timeHours + 'h ' + (timeMinutes % 60) + 'm';
  } else if (timeHours >= 1) {
    timeText = timeHours + 'h ' + (timeMinutes % 60) + 'm';
  }

  // RSI analysis (would need live data - simplified for now)
  const entryRsi = pos.entryRsi || 50;
  const isLong = pos.direction === 'LONG';
  let rsiStatus = 'neutral';
  let rsiText = 'Entry RSI: ' + entryRsi.toFixed(0);

  if (isLong) {
    if (entryRsi <= 30) rsiText += ' (Oversold ✓)';
    else if (entryRsi >= 60) { rsiText += ' (Overbought ⚠️)'; rsiStatus = 'warning'; }
  } else {
    if (entryRsi >= 70) rsiText += ' (Overbought ✓)';
    else if (entryRsi <= 40) { rsiText += ' (Oversold ⚠️)'; rsiStatus = 'warning'; }
  }

  // Regime alignment (from current quadrant via window.FOCUS_MODE_INIT or live data)
  const currentQuadrant = (window.FOCUS_MODE_INIT && window.FOCUS_MODE_INIT.quadrant) || 'NEU+NEU';
  const currentAction = getQuadrantAction(currentQuadrant);
  let regimeStatus = 'good';
  let regimeText = currentQuadrant + ' → ' + currentAction;

  if (currentAction === 'SKIP') {
    regimeStatus = 'warning';
    regimeText += ' (Regime changed!)';
  } else if (currentAction !== pos.direction) {
    regimeStatus = 'bad';
    regimeText += ' (Opposite direction!)';
  } else {
    regimeText += ' (Aligned ✓)';
  }

  // Update UI elements
  const timeEl = document.getElementById('health-time-' + cardId);
  const rsiEl = document.getElementById('health-rsi-' + cardId);
  const regimeEl = document.getElementById('health-regime-' + cardId);
  const targetEl = document.getElementById('health-target-' + cardId);
  const badgeEl = document.getElementById('monitor-badge-' + cardId);
  const suggestionEl = document.getElementById('monitor-suggestion-' + cardId);

  if (timeEl) {
    timeEl.textContent = timeText;
    timeEl.className = 'health-value ' + timeStatus;
  }
  if (rsiEl) {
    rsiEl.textContent = rsiText;
    rsiEl.className = 'health-value ' + rsiStatus;
  }
  if (regimeEl) {
    regimeEl.textContent = regimeText;
    regimeEl.className = 'health-value ' + regimeStatus;
  }
  // Distance to target - needs current price
  let targetStatus = 'neutral';
  let targetText = 'Loading...';
  let pnlPct = 0;

  if (pos.targetPrice && pos.stopPrice && pos.currentPrice) {
    const isLong = pos.direction === 'LONG';
    const entry = pos.entryPrice;
    const current = pos.currentPrice;
    const target = pos.targetPrice;
    const stop = pos.stopPrice;

    // Calculate P&L %
    pnlPct = isLong
      ? ((current - entry) / entry) * 100
      : ((entry - current) / entry) * 100;

    // Calculate distance to target as % of total move
    const totalMove = Math.abs(target - entry);
    const currentMove = isLong ? (current - entry) : (entry - current);
    const progressPct = totalMove > 0 ? (currentMove / totalMove) * 100 : 0;

    // Calculate distance to stop
    const distToStop = isLong
      ? ((current - stop) / current) * 100
      : ((stop - current) / current) * 100;

    if (pnlPct >= 0) {
      if (progressPct >= 75) {
        targetStatus = 'good';
        targetText = '🎯 ' + progressPct.toFixed(0) + '% to TP (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%)';
      } else if (progressPct >= 50) {
        targetStatus = 'good';
        targetText = '📈 ' + progressPct.toFixed(0) + '% to TP (+' + pnlPct.toFixed(1) + '%)';
      } else {
        targetStatus = 'neutral';
        targetText = '📊 ' + progressPct.toFixed(0) + '% to TP (+' + pnlPct.toFixed(1) + '%)';
      }
    } else {
      if (distToStop < 2) {
        targetStatus = 'bad';
        targetText = '🚨 Near SL! (' + pnlPct.toFixed(1) + '%)';
      } else if (pnlPct < -5) {
        targetStatus = 'warning';
        targetText = '📉 Underwater (' + pnlPct.toFixed(1) + '%)';
      } else {
        targetStatus = 'neutral';
        targetText = '📊 In progress (' + pnlPct.toFixed(1) + '%)';
      }
    }
  } else if (pos.targetPrice && pos.stopPrice) {
    // No current price available - show targets instead
    pos.priceFetchAttempts = (pos.priceFetchAttempts || 0) + 1;
    if (pos.priceFetchAttempts > 3) {
      // After 3 attempts (30 seconds), show helpful info instead
      const formatP = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
      targetText = 'TP: $' + formatP(pos.targetPrice) + ' / SL: $' + formatP(pos.stopPrice);
    } else {
      targetText = 'Fetching price...';
    }
  }

  if (targetEl) {
    targetEl.textContent = targetText;
    targetEl.className = 'health-value ' + targetStatus;
  }

  // Update trailing stop suggestion
  const trailResult = calculateTrailingStop(pos);
  const pnlDisplayEl = document.getElementById('pnl-display-' + cardId);
  const trailStopEl = document.getElementById('trail-stop-' + cardId);
  const trailInfoEl = document.getElementById('trail-info-' + cardId);

  if (pnlDisplayEl) {
    if (trailResult.pnlPct !== undefined) {
      const spotPnl = trailResult.pnlPct;
      const roiPnl = trailResult.roiPct || spotPnl;
      // Show ROI prominently if leverage is known, spot P&L secondary
      let displayText;
      if (pos.leverage && pos.leverage > 1) {
        displayText = 'ROI: ' + (roiPnl >= 0 ? '+' : '') + roiPnl.toFixed(1) + '% (' + pos.leverage + 'x)';
      } else {
        displayText = 'P&L: ' + (spotPnl >= 0 ? '+' : '') + spotPnl.toFixed(2) + '%';
      }
      pnlDisplayEl.textContent = displayText;
      pnlDisplayEl.className = 'pnl-display ' + (trailResult.status === 'profit' ? 'profit' : trailResult.status === 'loss' ? 'loss' : 'neutral');
    } else {
      pnlDisplayEl.textContent = 'Waiting for price data...';
      pnlDisplayEl.className = 'pnl-display neutral';
    }
  }

  if (trailStopEl) {
    if (trailResult.stop) {
      const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
      trailStopEl.textContent = '$' + formatPrice(trailResult.stop);
      trailStopEl.className = 'trailing-stop-value ' + (trailResult.status === 'profit' ? 'profit' : trailResult.status === 'breakeven' ? 'breakeven' : 'neutral');
    } else {
      trailStopEl.textContent = '--';
      trailStopEl.className = 'trailing-stop-value neutral';
    }
  }

  if (trailInfoEl) {
    trailInfoEl.textContent = trailResult.info || 'Enter trade to see trailing stop suggestions';
  }

  // Check if trailing stop has been hit (price crossed the suggested stop level)
  if (trailResult.stop && pos.currentPrice && pos.entryPrice) {
    const isLong = pos.direction === 'LONG';
    const trailStopHit = isLong
      ? pos.currentPrice <= trailResult.stop
      : pos.currentPrice >= trailResult.stop;

    // Only alert if we had a profitable trailing stop (not the original stop)
    const isTrailingStop = trailResult.status === 'profit' || trailResult.status === 'breakeven';

    if (trailStopHit && isTrailingStop && !pos.trailStopAlerted) {
      // Mark as alerted so we don't spam
      pos.trailStopAlerted = true;
      pos.trailStopAlertedAt = Date.now();
      saveActivePositions();

      const symbol = pos.symbol.replace('USDT', '');
      const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);

      // Send notification
      sendNotification(
        '🛑 TRAILING STOP HIT: ' + symbol,
        'Price crossed your trailing stop at $' + formatPrice(trailResult.stop) + '. Consider closing position.',
        pos.direction
      );

      // Play alert sound
      playAlert(pos.direction);

      // Show toast
      showToast('🛑 ' + symbol + ' trailing stop hit! Close position manually.');

      // Flash the card
      highlightCard(cardId);
    }

    // Reset alert if price recovers above trailing stop (so it can alert again)
    if (!trailStopHit && pos.trailStopAlerted) {
      // Only reset if it's been more than 5 minutes since last alert
      if (Date.now() - (pos.trailStopAlertedAt || 0) > 5 * 60 * 1000) {
        pos.trailStopAlerted = false;
        saveActivePositions();
      }
    }
  }

  // Calculate overall health and suggestion
  const warnings = [timeStatus, rsiStatus, regimeStatus, targetStatus].filter(s => s === 'warning').length;
  const dangers = [timeStatus, rsiStatus, regimeStatus, targetStatus].filter(s => s === 'bad').length;

  if (badgeEl) {
    if (dangers > 0) {
      badgeEl.textContent = '⚠️ ' + dangers + ' Alert' + (dangers > 1 ? 's' : '');
      badgeEl.className = 'monitor-badge danger';
    } else if (warnings > 0) {
      badgeEl.textContent = '⚠️ ' + warnings + ' Warning' + (warnings > 1 ? 's' : '');
      badgeEl.className = 'monitor-badge warning';
    } else if (pnlPct > 0) {
      badgeEl.textContent = '✓ In Profit (+' + pnlPct.toFixed(1) + '%)';
      badgeEl.className = 'monitor-badge healthy';
    } else {
      badgeEl.textContent = '✓ Healthy';
      badgeEl.className = 'monitor-badge healthy';
    }
  }

  // Calculate urgency score (higher = more urgent, needs attention)
  // 100 = trailing stop hit (immediate action)
  // 90 = near stop loss (critical)
  // 80 = regime changed against position (critical)
  // 60 = trade aging with warnings
  // 50 = multiple warnings
  // 40 = great profit (action opportunity)
  // 30 = solid profit (action opportunity)
  // 20 = profitable, consider breakeven
  // 10 = healthy, let it develop
  // 0 = not tracking
  let urgencyScore = 0;

  if (suggestionEl) {
    if (targetStatus === 'bad') {
      suggestionEl.textContent = '🚨 Price near stop loss! Consider exiting or adjusting.';
      suggestionEl.className = 'monitor-suggestion warning';
      urgencyScore = 90;
    } else if (regimeStatus === 'bad') {
      // Position direction conflicts with current signal direction
      const currentQuad = (window.FOCUS_MODE_INIT && window.FOCUS_MODE_INIT.quadrant) || 'NEU+NEU';
      const currentAct = getQuadrantAction(currentQuad);
      suggestionEl.textContent = '🚨 CONFLICT: Signal now says ' + currentAct + ' but you are ' + pos.direction + '. Consider closing.';
      suggestionEl.className = 'monitor-suggestion warning';
      urgencyScore = 85;
    } else if (dangers > 0) {
      suggestionEl.textContent = '🚨 Multiple warning signals. Review your position.';
      suggestionEl.className = 'monitor-suggestion warning';
      urgencyScore = 80;
    } else if (pnlPct >= 10) {
      suggestionEl.textContent = '🎯 Great profit! Consider taking partial profits or trailing stop.';
      suggestionEl.className = 'monitor-suggestion action';
      urgencyScore = 40;
    } else if (pnlPct >= 5) {
      suggestionEl.textContent = '💰 In solid profit. Consider moving stop to breakeven.';
      suggestionEl.className = 'monitor-suggestion action';
      urgencyScore = 30;
    } else if (timeHours >= 12) {
      suggestionEl.textContent = '⏰ Trade aging: Consider taking profits or tightening stop loss.';
      suggestionEl.className = 'monitor-suggestion warning';
      urgencyScore = 60;
    } else if (warnings >= 2) {
      suggestionEl.textContent = '⚠️ Multiple warnings: Review your position and consider adjustments.';
      suggestionEl.className = 'monitor-suggestion warning';
      urgencyScore = 50;
    } else if (pnlPct > 0 && timeHours >= 4) {
      suggestionEl.textContent = '💡 Position profitable. Consider moving stop to breakeven.';
      suggestionEl.className = 'monitor-suggestion action';
      urgencyScore = 20;
    } else {
      suggestionEl.textContent = '💡 Position looks healthy. Let it develop.';
      suggestionEl.className = 'monitor-suggestion';
      urgencyScore = 10;
    }
  }

  // Trailing stop hit is highest urgency
  if (pos.trailStopAlerted) {
    urgencyScore = 100;
  }

  // Store urgency score on position for sorting
  pos.urgencyScore = urgencyScore;

  // Update header status (visible when collapsed)
  const headerStatusEl = document.getElementById('header-status-' + cardId);
  const headerPnlEl = document.getElementById('header-pnl-' + cardId);
  const headerSuggestionEl = document.getElementById('header-suggestion-' + cardId);

  if (headerStatusEl) {
    headerStatusEl.classList.add('active');
  }

  if (headerPnlEl) {
    if (pos.currentPrice) {
      const pnlText = (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(1) + '%';
      headerPnlEl.textContent = pnlText;
      headerPnlEl.className = 'header-pnl ' + (pnlPct > 0 ? 'profit' : pnlPct < 0 ? 'loss' : 'neutral');
    } else {
      headerPnlEl.textContent = '📊 Monitoring';
      headerPnlEl.className = 'header-pnl neutral';
    }
  }

  // Show/hide conflict badge when position direction opposes current signal
  const headerConflictEl = document.getElementById('header-conflict-' + cardId);
  if (headerConflictEl) {
    const hasConflict = regimeStatus === 'bad';
    headerConflictEl.classList.toggle('visible', hasConflict);
  }

  if (headerSuggestionEl && suggestionEl) {
    // Mirror the suggestion text (without leading emoji for compactness)
    // Use indexOf to find first space, avoids regex issues with emoji surrogate pairs
    const fullText = suggestionEl.textContent || '';
    const spaceIdx = fullText.indexOf(' ');
    const suggestionText = spaceIdx > 0 ? fullText.substring(spaceIdx + 1) : fullText;
    headerSuggestionEl.textContent = suggestionText;
    // Use danger class for conflicts (highest priority visual)
    const isConflict = regimeStatus === 'bad';
    headerSuggestionEl.className = 'header-suggestion' +
      (isConflict ? ' danger' : '') +
      (suggestionEl.className.includes('warning') && !isConflict ? ' warning' : '') +
      (suggestionEl.className.includes('action') ? ' action' : '');
  }

  // Show update badge on collapsed cards when status changes significantly
  const card = document.getElementById(cardId);
  if (card && card.classList.contains('collapsed')) {
    const prevPnl = pos.prevPnlPct || 0;
    const prevDangers = pos.prevDangers || 0;
    const prevTrailStatus = pos.prevTrailStatus || 'neutral';
    const roiPct = trailResult.roiPct || 0;
    const prevRoi = pos.prevRoiPct || 0;

    // Check for trailing stop status changes (most important for manual trailing)
    if (trailResult.status === 'profit' && prevTrailStatus !== 'profit') {
      // Just entered trailing territory - time to move stop!
      highlightCard(cardId);
      showUpdateBadge(cardId, '🛡️ TRAIL STOP');
      playAlert(pos.direction);
    } else if (trailResult.status === 'breakeven' && prevTrailStatus !== 'breakeven' && prevTrailStatus !== 'profit') {
      // Just hit breakeven threshold
      highlightCard(cardId);
      showUpdateBadge(cardId, '🛡️ MOVE TO BE');
    } else if (roiPct >= 30 && prevRoi < 30) {
      // Crossed 30% ROI - trail at 70%
      highlightCard(cardId);
      showUpdateBadge(cardId, '🚀 +30% TRAIL');
    } else if (roiPct >= 15 && prevRoi < 15) {
      // Crossed 15% ROI - trail at 50%
      highlightCard(cardId);
      showUpdateBadge(cardId, '📈 +15% TRAIL');
    } else if ((prevPnl <= 0 && pnlPct > 0) || (prevPnl >= 0 && pnlPct < 0)) {
      // Crossing profit/loss threshold
      highlightCard(cardId);
      showUpdateBadge(cardId, pnlPct > 0 ? 'PROFIT' : 'LOSS');
    } else if (dangers > prevDangers) {
      highlightCard(cardId);
      showUpdateBadge(cardId, '⚠️ ALERT');
    }

    // Store for next comparison
    pos.prevPnlPct = pnlPct;
    pos.prevRoiPct = roiPct;
    pos.prevDangers = dangers;
    pos.prevTrailStatus = trailResult.status;
  }
}

// Fetch current prices for all symbols (active positions + all cards for distance display)
async function fetchCurrentPrices() {
  // Get symbols from active positions
  const positionSymbols = Object.values(activePositions).map(p => p.symbol);

  // Also get symbols from all visible cards (for distance from entry display)
  const cardSymbols = [];
  document.querySelectorAll('.trade-card').forEach(function(card) {
    if (card.dataset.symbol) cardSymbols.push(card.dataset.symbol);
  });

  const symbols = [...new Set([...positionSymbols, ...cardSymbols])];
  if (symbols.length === 0) return {};

  try {
    // Use our server-side proxy to avoid CORS issues
    const response = await fetch('/api/prices?symbols=' + symbols.join(','));
    const data = await response.json();

    if (data.prices) {
      // Update active positions with current prices
      Object.keys(activePositions).forEach(cardId => {
        const symbol = activePositions[cardId].symbol;
        if (data.prices[symbol]) {
          activePositions[cardId].currentPrice = data.prices[symbol];
        }
      });
      return data.prices;
    }
    return {};
  } catch (e) {
    console.log('[Focus] Price fetch error:', e);
    return {};
  }
}

async function updateAllPositionHealth() {
  const prices = await fetchCurrentPrices();

  // Update position health for active trades
  Object.keys(activePositions).forEach(cardId => {
    updatePositionHealth(cardId);
  });

  // Update distance from entry for all cards (active or not)
  updateAllEntryDistances(prices);

  // Update the trailing stop alerts bar
  updateTrailAlertsBar();

  // Re-sort if using urgency sort (since urgency scores just updated)
  if (currentSortOrder === 'urgency-desc') {
    sortSignals('urgency-desc');
  }
}

// Update the trailing stop alerts bar at top of page
function updateTrailAlertsBar() {
  const bar = document.getElementById('trail-alerts-bar');
  const list = document.getElementById('trail-alerts-list');
  if (!bar || !list) return;

  // Find all positions with active trail stop alerts
  const alerts = [];
  Object.keys(activePositions).forEach(cardId => {
    const pos = activePositions[cardId];
    if (pos.trailStopAlerted && pos.trailStopAlertedAt) {
      // Calculate the suggested stop for display
      const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
      let stopPrice = pos.entryPrice; // Default to breakeven

      if (pos.currentPrice && pos.entryPrice && pos.leverage) {
        const isLong = pos.direction === 'LONG';
        const spotPnl = isLong
          ? ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100
          : ((pos.entryPrice - pos.currentPrice) / pos.entryPrice) * 100;
        const roiPct = spotPnl * pos.leverage;

        if (roiPct >= 30) {
          const lockSpotPct = spotPnl * 0.7;
          stopPrice = isLong
            ? pos.entryPrice * (1 + lockSpotPct / 100)
            : pos.entryPrice * (1 - lockSpotPct / 100);
        } else if (roiPct >= 15) {
          const lockSpotPct = spotPnl * 0.5;
          stopPrice = isLong
            ? pos.entryPrice * (1 + lockSpotPct / 100)
            : pos.entryPrice * (1 - lockSpotPct / 100);
        }
      }

      alerts.push({
        cardId: cardId,
        symbol: pos.symbol,
        direction: pos.direction,
        stopPrice: stopPrice,
        alertedAt: pos.trailStopAlertedAt
      });
    }
  });

  if (alerts.length === 0) {
    bar.classList.remove('active');
    list.innerHTML = '';
    return;
  }

  // Sort by most recent alert
  alerts.sort((a, b) => b.alertedAt - a.alertedAt);

  // Show the bar
  bar.classList.add('active');

  // Build alert items
  const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
  list.innerHTML = alerts.map(a => {
    const symbolShort = a.symbol.replace('USDT', '');
    return '<div class="trail-alert-item" onclick="scrollToCard(\'' + a.cardId + '\')">' +
      '<span class="symbol">' + symbolShort + '</span>' +
      '<span class="direction ' + a.direction.toLowerCase() + '">' + a.direction + '</span>' +
      '<span class="price">SL @ $' + formatPrice(a.stopPrice) + '</span>' +
      '<button class="trail-alert-dismiss" onclick="event.stopPropagation(); dismissTrailAlert(\'' + a.cardId + '\')" title="Dismiss">×</button>' +
      '</div>';
  }).join('');
}

// Scroll to a card and expand it
function scrollToCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    // Expand the card if collapsed
    card.classList.remove('collapsed');
    clearUpdateBadge(cardId);

    // Scroll into view
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Flash highlight
    highlightCard(cardId);
  }
}

// Dismiss a trail alert (user acknowledged it)
function dismissTrailAlert(cardId) {
  const pos = activePositions[cardId];
  if (pos) {
    pos.trailStopAlerted = false;
    pos.trailStopAlertedAt = null;
    saveActivePositions();
    updateTrailAlertsBar();
    showToast('✓ Alert dismissed for ' + pos.symbol.replace('USDT', ''));
  }
}

// Create a minimal position card for orphaned positions (signal expired but position still active)
function createOrphanedPositionCard(cardId, pos) {
  const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);
  const symbol = pos.symbol;
  const direction = pos.direction;
  const entryPrice = pos.entryPrice || 0;
  const leverage = pos.leverage || 1;

  return `
    <div class="trade-card ${direction.toLowerCase()} orphaned collapsed" id="${cardId}" data-symbol="${symbol}" data-direction="${direction}" data-signal-entry="${entryPrice}" data-leverage="${leverage}">
      <div class="trade-card-header" onclick="toggleCard('${cardId}')">
        <span class="trade-symbol">${symbol.replace('USDT', '')}</span>
        <span class="trade-action ${direction.toLowerCase()}">${direction}</span>
        <span class="orphaned-badge">ACTIVE</span>
        <span class="leverage-badge">${leverage}x</span>
        <span class="entry-distance neutral" id="entry-distance-${cardId}" title="Distance from entry">📍 --</span>
        <span class="header-spacer"></span>
        <span class="collapse-icon">▼</span>
        <div class="header-position-status active" id="header-status-${cardId}">
          <span class="header-pnl neutral" id="header-pnl-${cardId}">--</span>
          <span class="header-conflict-badge" id="header-conflict-${cardId}">⚠️ CONFLICT</span>
          <span class="header-suggestion" id="header-suggestion-${cardId}">Monitoring...</span>
        </div>
      </div>

      <div class="trade-card-collapsible">
        <div class="orphaned-notice">
          ⚠️ Signal expired from active window, but position is still being monitored.
        </div>

        <!-- Position Monitor Section (always active for orphaned cards) -->
        <div class="position-monitor" id="monitor-${cardId}" data-symbol="${symbol}" data-direction="${direction}" data-entry="${entryPrice}">
          <div class="monitor-active" id="monitor-active-${cardId}" style="display: block;">
            <div class="monitor-header" onclick="toggleMonitor('${cardId}')">
              <span class="monitor-title">📊 Position Monitor</span>
              <div class="monitor-summary">
                <span class="monitor-badge healthy" id="monitor-badge-${cardId}">✓ Monitoring</span>
                <button class="exit-trade-btn" onclick="event.stopPropagation(); exitTrade('${cardId}')">Exit Monitor</button>
              </div>
            </div>
            <div class="monitor-content" id="monitor-content-${cardId}">
              <!-- Manual Entry Price or ROI -->
              <div class="monitor-entry-row">
                <span class="entry-label">My Entry:</span>
                <input type="text" class="entry-input" id="entry-input-${cardId}"
                       value="${entryPrice}"
                       onchange="updateManualEntry('${cardId}')"
                       onclick="event.stopPropagation()">
                <button class="entry-btn" onclick="event.stopPropagation(); updateManualEntry('${cardId}')">Set</button>
              </div>
              <div class="monitor-entry-row">
                <span class="entry-label">Or ROI%:</span>
                <input type="text" class="entry-input" id="roi-input-${cardId}"
                       placeholder="e.g. 44.5 or -12.3"
                       onclick="event.stopPropagation()">
                <button class="entry-btn" onclick="event.stopPropagation(); updateFromROI('${cardId}')">Calc</button>
              </div>

              <!-- P&L Display -->
              <div class="pnl-display neutral" id="pnl-display-${cardId}">
                Calculating...
              </div>

              <!-- Trailing Stop Suggestion -->
              <div class="trailing-stop-box">
                <div class="trailing-stop-header">
                  <span class="trailing-stop-title">🛡️ Suggested Stop Loss</span>
                  <span class="trailing-stop-value neutral" id="trail-stop-${cardId}">--</span>
                </div>
                <div class="trailing-stop-info" id="trail-info-${cardId}">
                  Waiting for price data...
                </div>
              </div>

              <div class="health-indicator" style="margin-top: 10px;">
                <span class="health-label">⏱️ Time in Trade</span>
                <span class="health-value neutral" id="health-time-${cardId}">--</span>
              </div>
              <div class="monitor-suggestion" id="monitor-suggestion-${cardId}">
                💡 Position monitoring active for expired signal.
              </div>
            </div>
          </div>
        </div>

        <div class="trade-card-footer">
          <a href="#" onclick="openMexcTrade('${symbol}'); return false;" class="trade-btn ${direction.toLowerCase()}">
            Open ${direction} on MEXC →
          </a>
        </div>
      </div>
    </div>
  `;
}

function restoreActivePositions() {
  loadActivePositions();
  console.log('[Focus] Restoring positions:', Object.keys(activePositions));

  // First, check for orphaned positions (positions without active cards)
  const orphanedPositions = [];
  Object.keys(activePositions).forEach(cardId => {
    const pos = activePositions[cardId];
    const existingCard = document.getElementById(cardId);
    if (!existingCard) {
      console.log('[Focus] Orphaned position found:', cardId, pos.symbol);
      orphanedPositions.push({ cardId, pos });
    }
  });

  // Inject orphaned position cards into the active section
  if (orphanedPositions.length > 0) {
    const container = document.querySelector('.trade-cards');
    if (container) {
      orphanedPositions.forEach(({ cardId, pos }) => {
        const cardHtml = createOrphanedPositionCard(cardId, pos);
        container.insertAdjacentHTML('afterbegin', cardHtml);
        console.log('[Focus] Created orphaned card for', pos.symbol);
      });
    }
  }

  // Now restore all positions (including newly created orphaned cards)
  Object.keys(activePositions).forEach(cardId => {
    const pos = activePositions[cardId];
    const enterBtn = document.getElementById('enter-btn-' + cardId);
    const monitorActive = document.getElementById('monitor-active-' + cardId);
    if (enterBtn && monitorActive) {
      enterBtn.style.display = 'none';
      monitorActive.style.display = 'block';
    }
    // Always restore saved entry price if position exists (regardless of manualEntry flag)
    if (pos.entryPrice) {
      const entryInput = document.getElementById('entry-input-' + cardId);
      if (entryInput) {
        console.log('[Focus] Restoring entry for', cardId, ':', pos.entryPrice);
        entryInput.value = pos.entryPrice.toString();
      } else {
        console.log('[Focus] Entry input not found for', cardId);
      }
    }
  });
  // Fetch prices and update health after restoring
  updateAllPositionHealth();
  // Show/hide close all button based on active positions
  updateCloseAllButton();
}

// Card collapse functionality
function toggleCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.toggle('collapsed');
    saveCollapsedState();
    // Clear update badge when expanding
    if (!card.classList.contains('collapsed')) {
      clearUpdateBadge(cardId);
    }
  }
}

function collapseAllCards() {
  document.querySelectorAll('.trade-card').forEach(card => card.classList.add('collapsed'));
  saveCollapsedState();
}

function expandAllCards() {
  document.querySelectorAll('.trade-card').forEach(card => {
    card.classList.remove('collapsed');
    clearUpdateBadge(card.id);
  });
  saveCollapsedState();
}

// Card highlight and update badge
function highlightCard(cardId) {
  const card = document.getElementById(cardId);
  if (card) {
    card.classList.remove('highlight');
    // Force reflow to restart animation
    void card.offsetWidth;
    card.classList.add('highlight');

    // Show update badge if card is collapsed
    if (card.classList.contains('collapsed')) {
      showUpdateBadge(cardId);
    }

    // Remove highlight class after animation
    setTimeout(() => card.classList.remove('highlight'), 3000);
  }
}

function showUpdateBadge(cardId, text = 'UPDATED') {
  const badge = document.getElementById('update-badge-' + cardId);
  if (badge) {
    badge.textContent = text;
    badge.classList.add('show');
  }
}

function clearUpdateBadge(cardId) {
  const badge = document.getElementById('update-badge-' + cardId);
  if (badge) {
    badge.classList.remove('show');
  }
}

function saveCollapsedState() {
  const collapsed = [];
  document.querySelectorAll('.trade-card.collapsed').forEach(card => {
    if (card.id) collapsed.push(card.id);
  });
  try {
    localStorage.setItem('focusMode_collapsedCards', JSON.stringify(collapsed));
  } catch (e) {}
}

function restoreCollapsedState() {
  try {
    const saved = localStorage.getItem('focusMode_collapsedCards');
    if (saved) {
      const collapsed = JSON.parse(saved);
      collapsed.forEach(cardId => {
        const card = document.getElementById(cardId);
        if (card) card.classList.add('collapsed');
      });
    }
  } catch (e) {}
}

// Sorting functionality
let currentSortOrder = 'time-desc';

function sortSignals(sortOrder) {
  currentSortOrder = sortOrder;
  saveSortPreference(sortOrder);

  const container = document.querySelector('.trade-cards');
  if (!container) return;

  const cards = Array.from(container.querySelectorAll('.trade-card'));
  if (cards.length === 0) return;

  cards.sort((a, b) => {
    const symbolA = a.dataset.symbol || '';
    const symbolB = b.dataset.symbol || '';
    const timeA = parseInt(a.dataset.timestamp || '0');
    const timeB = parseInt(b.dataset.timestamp || '0');
    const posA = activePositions[a.id];
    const posB = activePositions[b.id];
    const trackingA = posA ? 1 : 0;
    const trackingB = posB ? 1 : 0;
    // Quality = R:R ratio + signal count bonus
    const qualityA = parseFloat(a.dataset.quality || '0') + (parseInt(a.dataset.signals || '1') - 1) * 0.5;
    const qualityB = parseFloat(b.dataset.quality || '0') + (parseInt(b.dataset.signals || '1') - 1) * 0.5;
    // Urgency score (0 for untracked, 10-100 for tracked based on status)
    const urgencyA = posA ? (posA.urgencyScore || 0) : 0;
    const urgencyB = posB ? (posB.urgencyScore || 0) : 0;

    switch (sortOrder) {
      case 'alpha-asc':
        return symbolA.localeCompare(symbolB);
      case 'alpha-desc':
        return symbolB.localeCompare(symbolA);
      case 'time-asc':
        return timeA - timeB;
      case 'time-desc':
        return timeB - timeA;
      case 'urgency-desc':
        // Most urgent first, then by tracking status, then by time
        if (urgencyA !== urgencyB) return urgencyB - urgencyA;
        if (trackingA !== trackingB) return trackingB - trackingA;
        return timeB - timeA;
      case 'quality-desc':
        if (qualityA !== qualityB) return qualityB - qualityA;
        return timeB - timeA; // Secondary sort by time
      case 'quality-asc':
        if (qualityA !== qualityB) return qualityA - qualityB;
        return timeB - timeA; // Secondary sort by time
      case 'tracking-first':
        if (trackingA !== trackingB) return trackingB - trackingA;
        return timeB - timeA; // Secondary sort by time
      case 'tracking-last':
        if (trackingA !== trackingB) return trackingA - trackingB;
        return timeB - timeA; // Secondary sort by time
      default:
        return timeB - timeA;
    }
  });

  // Re-append cards in sorted order
  cards.forEach(card => container.appendChild(card));

  // Add separator between tracked and untracked when using relevant sort
  updateTrackingSeparator(sortOrder, container, cards);
}

function updateTrackingSeparator(sortOrder, container, cards) {
  // Remove existing separator
  const existingSep = container.querySelector('.tracking-separator');
  if (existingSep) existingSep.remove();

  // Only show separator for tracking-based or urgency sorts
  if (!['tracking-first', 'tracking-last', 'urgency-desc'].includes(sortOrder)) {
    return;
  }

  // Find the boundary between tracked and untracked
  let separatorIndex = -1;
  for (let i = 0; i < cards.length; i++) {
    const isTracked = !!activePositions[cards[i].id];
    const nextIsTracked = i + 1 < cards.length ? !!activePositions[cards[i + 1].id] : null;

    // For tracking-first and urgency-desc: tracked cards come first
    // Separator goes after last tracked card
    if ((sortOrder === 'tracking-first' || sortOrder === 'urgency-desc') && isTracked && nextIsTracked === false) {
      separatorIndex = i;
      break;
    }
    // For tracking-last: untracked cards come first
    // Separator goes after last untracked card
    if (sortOrder === 'tracking-last' && !isTracked && nextIsTracked === true) {
      separatorIndex = i;
      break;
    }
  }

  // Insert separator if boundary found
  if (separatorIndex >= 0 && separatorIndex < cards.length - 1) {
    const trackedCount = Object.keys(activePositions).filter(id => document.getElementById(id)).length;
    const untrackedCount = cards.length - trackedCount;

    const separator = document.createElement('div');
    separator.className = 'tracking-separator';
    separator.innerHTML = sortOrder === 'tracking-last'
      ? '<span>📊 Tracking (' + trackedCount + ' positions)</span>'
      : '<span>📋 Not Tracking (' + untrackedCount + ' signals)</span>';

    // Insert after the card at separatorIndex
    cards[separatorIndex].after(separator);
  }
}

function saveSortPreference(sortOrder) {
  try {
    localStorage.setItem('focusMode_sortOrder', sortOrder);
  } catch (e) {}
}

function restoreSortPreference() {
  try {
    const saved = localStorage.getItem('focusMode_sortOrder');
    if (saved) {
      currentSortOrder = saved;
      const sortSelect = document.getElementById('sort-select');
      if (sortSelect) sortSelect.value = saved;
      sortSignals(saved);
    }
  } catch (e) {}
}

function setLeverage(lev) {
  currentLeverage = lev;
  document.querySelectorAll('.leverage-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  updateTradeParams();
}

function updateTradeParams() {
  const rows = document.querySelectorAll('.signal-row');
  // Realistic targets based on excursion analysis
  const slPct = currentLeverage >= 10 ? 3 : 5;
  const tpPct = currentLeverage >= 10 ? 2 : 4;
  const rr = (tpPct / slPct).toFixed(1);
  // ROE = price % × leverage (what MEXC displays)
  const slROE = slPct * currentLeverage;
  const tpROE = tpPct * currentLeverage;

  rows.forEach(row => {
    const entry = parseFloat(row.dataset.entry);
    const direction = row.dataset.direction;
    const formatPrice = (p) => p >= 1 ? p.toFixed(4) : p.toFixed(6);

    let slPrice, tpPrice;
    if (direction === 'LONG') {
      slPrice = entry * (1 - slPct / 100);
      tpPrice = entry * (1 + tpPct / 100);
    } else {
      slPrice = entry * (1 + slPct / 100);
      tpPrice = entry * (1 - tpPct / 100);
    }

    row.querySelector('.sl-price').textContent = '$' + formatPrice(slPrice);
    row.querySelector('.sl-roe').textContent = '-' + slROE + '% ROE';
    row.querySelector('.sl-pct').textContent = '(' + slPct + '% price)';
    row.querySelector('.tp-price').textContent = '$' + formatPrice(tpPrice);
    row.querySelector('.tp-roe').textContent = '+' + tpROE + '% ROE';
    row.querySelector('.tp-pct').textContent = '(' + tpPct + '% price)';
    row.querySelector('.rr-ratio').textContent = rr + ':1';
  });
}

function changeConfig(configKey) {
  // Navigate to same page with new config (preserve current path)
  window.location.href = window.location.pathname + '?config=' + encodeURIComponent(configKey);
}

// Request notification permission
async function enableNotifications() {
  if ('Notification' in window) {
    const permission = await Notification.requestPermission();
    notificationsEnabled = permission === 'granted';
    saveFocusModeSettings();
    updateNotificationButton();
    if (notificationsEnabled) {
      showToast('🔔 Notifications enabled!');
    }
  }
}

// Toggle notifications on/off
function toggleNotifications() {
  if (!notificationsEnabled && Notification.permission !== 'granted') {
    // Need to request permission first
    enableNotifications();
    return;
  }
  notificationsEnabled = !notificationsEnabled;
  saveFocusModeSettings();
  updateNotificationButton();
  showToast(notificationsEnabled ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
}

function updateNotificationButton() {
  const btn = document.getElementById('notif-btn');
  if (btn) {
    btn.textContent = notificationsEnabled ? '🔔 Notifications ON' : '🔕 Notifications OFF';
    btn.classList.toggle('active', notificationsEnabled);
  }
}

function toggleAudio() {
  audioEnabled = !audioEnabled;
  saveFocusModeSettings();
  const btn = document.getElementById('audio-btn');
  if (btn) {
    btn.textContent = audioEnabled ? '🔊 Audio ON' : '🔇 Audio OFF';
    btn.classList.toggle('active', audioEnabled);
  }
  showToast(audioEnabled ? '🔊 Audio alerts enabled' : '🔇 Audio alerts muted');
}

// Test sound button - also wakes up audio context
function testSound() {
  console.log('[Focus] Test sound clicked, audioEnabled:', audioEnabled);
  // Force enable for test
  const wasEnabled = audioEnabled;
  audioEnabled = true;
  playAlert('LONG');
  audioEnabled = wasEnabled;
  showToast('🔊 Test sound played');
}

// Play alert sound using Web Audio API
function playAlert(type) {
  console.log('[Focus] playAlert called, type:', type, 'audioEnabled:', audioEnabled);
  if (!audioEnabled) {
    console.log('[Focus] Audio disabled, skipping sound');
    return;
  }

  try {
    if (!audioContext) {
      console.log('[Focus] Creating new AudioContext');
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Resume audio context if suspended (browser autoplay policy)
    if (audioContext.state === 'suspended') {
      console.log('[Focus] Resuming suspended AudioContext');
      audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    if (type === 'LONG') {
      // Rising tone for LONG
      oscillator.frequency.setValueAtTime(400, audioContext.currentTime);
      oscillator.frequency.linearRampToValueAtTime(800, audioContext.currentTime + 0.2);
      oscillator.frequency.linearRampToValueAtTime(600, audioContext.currentTime + 0.4);
    } else if (type === 'SHORT') {
      // Falling tone for SHORT
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.frequency.linearRampToValueAtTime(400, audioContext.currentTime + 0.2);
      oscillator.frequency.linearRampToValueAtTime(500, audioContext.currentTime + 0.4);
    } else {
      // Neutral beep
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
    }

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
    console.log('[Focus] Sound played successfully');
  } catch (e) {
    console.log('[Focus] Audio error:', e);
  }
}

// Show toast notification
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Bulk Update Modal functions
let parsedBulkData = [];

function showBulkUpdateModal() {
  document.getElementById('bulk-update-modal').style.display = 'flex';
  document.getElementById('bulk-paste-input').value = '';
  document.getElementById('bulk-preview').innerHTML = '';
  document.getElementById('apply-bulk-btn').disabled = true;
  parsedBulkData = [];
}

function closeBulkUpdateModal() {
  document.getElementById('bulk-update-modal').style.display = 'none';
}

function parseBulkUpdate() {
  const input = document.getElementById('bulk-paste-input').value;
  if (!input.trim()) {
    showToast('❌ Please paste MEXC data first');
    return;
  }

  // Parse the MEXC grid bot table format
  parsedBulkData = parseMexcGridData(input);

  if (parsedBulkData.length === 0) {
    showToast('❌ Could not parse any positions from the data');
    return;
  }

  // Show preview
  const preview = document.getElementById('bulk-preview');
  let html = '';
  let matchedCount = 0;

  parsedBulkData.forEach(item => {
    const cardId = 'card-' + item.symbol + '-' + item.direction;
    const isTracked = !!activePositions[cardId];
    const cardExists = !!document.getElementById(cardId);
    matchedCount++; // All positions will be processed now

    const roiClass = item.roi >= 0 ? 'profit' : 'loss';
    let statusClass, statusText;
    if (isTracked) {
      statusClass = 'matched';
      statusText = '✓ Will update';
    } else if (cardExists) {
      statusClass = 'matched';
      statusText = '+ Will start (card visible)';
    } else {
      statusClass = 'matched';
      statusText = '+ Will start (no card)';
    }

    html += '<div class="modal-preview-item">' +
      '<span class="symbol">' + item.symbol.replace('USDT', '') + '</span>' +
      '<span>' + item.direction + ' ' + item.leverage + 'x</span>' +
      '<span class="roi ' + roiClass + '">' + (item.roi >= 0 ? '+' : '') + item.roi.toFixed(2) + '%</span>' +
      '<span class="status ' + statusClass + '">' + statusText + '</span>' +
      '</div>';
  });

  preview.innerHTML = html || '<div style="color: #8b949e;">No data parsed</div>';
  document.getElementById('apply-bulk-btn').disabled = matchedCount === 0;
  showToast('📋 Found ' + parsedBulkData.length + ' positions, ' + matchedCount + ' tracked');
}

function parseMexcGridData(text) {
  const results = [];
  console.log('[Bulk] Input length: ' + text.length);

  // Strategy: Find all XXX USDT symbols, then search nearby for direction/leverage/ROI
  // This handles messy pastes where data may be on same line or split weirdly

  // First, find all potential symbols (word ending in USDT)
  const upperText = text.toUpperCase();
  const symbolRegex = /([A-Z][A-Z0-9]{1,12})USDT/g;
  const foundSymbols = [];
  let m;
  while ((m = symbolRegex.exec(upperText)) !== null) {
    const sym = m[1] + 'USDT';
    // Skip header words
    if (sym !== 'INVESTMENTAMOUNTUSDT' && sym !== 'TRADINGPAIRUSDT' && sym !== 'TOTALPNLUSDT') {
      foundSymbols.push({ symbol: sym, pos: m.index });
    }
  }
  console.log('[Bulk] Found ' + foundSymbols.length + ' symbols: ' + foundSymbols.map(function(s){return s.symbol;}).join(', '));

  // For each symbol, look at the text chunk between this symbol and the next
  for (let i = 0; i < foundSymbols.length; i++) {
    const sym = foundSymbols[i];
    const nextPos = (i + 1 < foundSymbols.length) ? foundSymbols[i + 1].pos : text.length;
    const chunk = text.substring(sym.pos, nextPos);

    // Find direction + leverage: Short15X, Long10X, etc
    const dirMatch = chunk.match(/(Short|Long)[^0-9]*([0-9]+)[^A-Za-z]*X/i);
    if (!dirMatch) {
      console.log('[Bulk] ' + sym.symbol + ': no direction found');
      continue;
    }
    const direction = dirMatch[1].toUpperCase();
    const leverage = parseInt(dirMatch[2], 10);

    // Find ROI: look for USDT followed by +/-XX.XX%
    // Pattern like "+18.0825 USDT+44.67%" - we want the percentage after USDT
    let roi = null;

    // Try pattern: number + USDT + percentage (the PNL line)
    const pnlPattern = chunk.match(/[+-]?[0-9.]+\s*USDT\s*([+-][0-9.]+)\s*%/);
    if (pnlPattern) {
      roi = parseFloat(pnlPattern[1]);
    }

    // Fallback: look for percentage that's not a TP/SL Ratio
    if (roi === null) {
      // Find all percentages in chunk
      const allPcts = [];
      const pctRegex = /([+-]?[0-9.]+)\s*%/g;
      let pm;
      while ((pm = pctRegex.exec(chunk)) !== null) {
        const val = parseFloat(pm[1]);
        const context = chunk.substring(Math.max(0, pm.index - 30), pm.index).toLowerCase();
        // Skip if this is a TP/SL ratio
        if (context.indexOf('ratio') < 0 && context.indexOf('tp ') < 0 && context.indexOf('sl ') < 0) {
          allPcts.push(val);
        }
      }
      // The ROI is usually a small percentage (not the big TP ratios like 181%)
      // Pick the one that looks most like an ROI (between -50 and +100 typically)
      for (let p of allPcts) {
        if (p >= -100 && p <= 100) {
          roi = p;
          break;
        }
      }
    }

    if (roi !== null) {
      console.log('[Bulk] Parsed: ' + sym.symbol + ' ' + direction + ' ' + leverage + 'x = ' + roi + '%');
      results.push({ symbol: sym.symbol, direction: direction, leverage: leverage, roi: roi });
    } else {
      console.log('[Bulk] ' + sym.symbol + ': no ROI found');
    }
  }

  console.log('[Bulk] Total: ' + results.length + ' positions');
  return results;
}

function applyBulkUpdate() {
  if (parsedBulkData.length === 0) {
    showToast('❌ No data to apply');
    return;
  }

  let updated = 0;
  let started = 0;

  parsedBulkData.forEach(item => {
    const cardId = 'card-' + item.symbol + '-' + item.direction;
    const pos = activePositions[cardId];
    const card = document.getElementById(cardId);

    if (pos) {
      // Already tracking - only update leverage, preserve existing entry price
      pos.leverage = item.leverage;

      // Only calculate entry if position has no entry price yet
      if (!pos.entryPrice || pos.entryPrice === 0) {
        if (pos.currentPrice) {
          const spotPnlPct = item.roi / item.leverage;
          const isLong = item.direction === 'LONG';

          let calculatedEntry;
          if (isLong) {
            calculatedEntry = pos.currentPrice / (1 + spotPnlPct / 100);
          } else {
            calculatedEntry = pos.currentPrice / (1 - spotPnlPct / 100);
          }

          pos.entryPrice = calculatedEntry;
          pos.manualEntry = true;

          const entryInput = document.getElementById('entry-input-' + cardId);
          if (entryInput) {
            entryInput.value = calculatedEntry.toFixed(6);
          }
        } else {
          // No current price yet, store pending ROI
          pos.pendingRoi = item.roi;
        }
      }

      updated++;
    } else {
      // Not tracking yet - create new position regardless of whether card is visible
      // This allows bulk import to work even if signals are in different time windows or played out
      activePositions[cardId] = {
        symbol: item.symbol,
        direction: item.direction,
        entryPrice: 0, // Will be calculated from ROI once we have price
        entryRsi: 50, // Default
        targetPrice: 0,
        stopPrice: 0,
        enteredAt: Date.now(),
        leverage: item.leverage,
        manualEntry: true,
        pendingRoi: item.roi // Store ROI to calculate entry when price arrives
      };

      // Update UI if card exists
      if (card) {
        const enterBtn = document.getElementById('enter-btn-' + cardId);
        const monitorActive = document.getElementById('monitor-active-' + cardId);
        if (enterBtn && monitorActive) {
          enterBtn.style.display = 'none';
          monitorActive.style.display = 'block';
        }
        highlightCard(cardId);
      }

      started++;
    }
  });

  saveActivePositions();

  // Fetch prices and update - this will also calculate entries for new positions
  fetchCurrentPrices().then(function() {
    // Now calculate entry prices for positions that have pendingRoi and no entry yet
    Object.keys(activePositions).forEach(function(cardId) {
      const pos = activePositions[cardId];
      // Only calculate if pendingRoi exists AND no entry price set yet
      if (pos.pendingRoi !== undefined && pos.currentPrice && (!pos.entryPrice || pos.entryPrice === 0)) {
        const spotPnlPct = pos.pendingRoi / (pos.leverage || 1);
        const isLong = pos.direction === 'LONG';

        let calculatedEntry;
        if (isLong) {
          calculatedEntry = pos.currentPrice / (1 + spotPnlPct / 100);
        } else {
          calculatedEntry = pos.currentPrice / (1 - spotPnlPct / 100);
        }

        pos.entryPrice = calculatedEntry;
        delete pos.pendingRoi;

        // Update entry input if visible
        const entryInput = document.getElementById('entry-input-' + cardId);
        if (entryInput) {
          entryInput.value = calculatedEntry.toFixed(6);
        }
      } else if (pos.pendingRoi !== undefined && pos.entryPrice && pos.entryPrice > 0) {
        // Already has entry, just clear the pending ROI
        delete pos.pendingRoi;
      }
    });
    saveActivePositions();
    updateAllPositionHealth();
  });

  closeBulkUpdateModal();

  let msg = '';
  if (updated > 0) msg += '✅ Updated ' + updated + ' positions';
  if (started > 0) msg += (msg ? ', ' : '✅ ') + 'Started tracking ' + started + ' new';
  if (!msg) msg = '⚠️ No matching positions found';
  showToast(msg);
}

// Send browser notification
function sendNotification(title, body, action) {
  console.log('[Focus] sendNotification called, notificationsEnabled:', notificationsEnabled, 'permission:', Notification.permission);
  if (!notificationsEnabled) {
    console.log('[Focus] Notifications disabled, skipping');
    return;
  }

  if (!('Notification' in window)) {
    console.log('[Focus] Notifications not supported in this browser');
    return;
  }

  if (Notification.permission !== 'granted') {
    console.log('[Focus] Notification permission not granted:', Notification.permission);
    return;
  }

  try {
    console.log('[Focus] Creating notification:', title, body);
    const notif = new Notification(title, {
      body: body,
      tag: 'focus-mode-' + Date.now(), // Unique tag to allow multiple notifications
      requireInteraction: false,
      silent: false
    });

    notif.onclick = () => {
      window.focus();
      notif.close();
    };

    notif.onerror = (e) => {
      console.log('[Focus] Notification error event:', e);
    };

    console.log('[Focus] Notification created successfully');
  } catch (e) {
    console.log('[Focus] Notification error:', e);
  }
}

// Test notification
function testNotification() {
  console.log('[Focus] Test notification clicked');
  console.log('[Focus] Notification support:', 'Notification' in window);
  console.log('[Focus] Notification permission:', Notification.permission);
  console.log('[Focus] notificationsEnabled:', notificationsEnabled);

  if (!('Notification' in window)) {
    showToast('❌ Notifications not supported');
    return;
  }

  if (Notification.permission === 'denied') {
    showToast('❌ Notifications blocked - check browser settings');
    return;
  }

  if (Notification.permission !== 'granted') {
    Notification.requestPermission().then(perm => {
      console.log('[Focus] Permission result:', perm);
      if (perm === 'granted') {
        sendTestNotif();
      } else {
        showToast('❌ Notification permission denied');
      }
    });
    return;
  }

  sendTestNotif();
}

function sendTestNotif() {
  try {
    console.log('[Focus] Creating notification...');
    console.log('[Focus] Protocol:', window.location.protocol);
    console.log('[Focus] Permission:', Notification.permission);

    const notif = new Notification('Focus Mode Test', {
      body: 'Notifications are working! Time: ' + new Date().toLocaleTimeString(),
      tag: 'focus-test-' + Date.now(),
      requireInteraction: false,
      silent: false
    });

    notif.onshow = () => console.log('[Focus] Notification shown');
    notif.onerror = (e) => {
      console.log('[Focus] Notification error event:', e);
      showToast('❌ Notification failed to display');
    };
    notif.onclick = () => notif.close();

    showToast('✅ Notification sent (check OS notification center)');

    // Also show protocol warning if not secure
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      showToast('⚠️ Non-HTTPS may block notifications');
    }
  } catch (e) {
    console.log('[Focus] Test notification error:', e);
    showToast('❌ Notification error: ' + e.message);
  }
}

// Poll for updates
async function checkForUpdates() {
  try {
    const currentConfig = document.getElementById('config-select')?.value || '4h/1h';
    const response = await fetch('/api/focus-mode?config=' + encodeURIComponent(currentConfig));
    const data = await response.json();

    const newQuadrant = data.quadrant;
    const newAction = data.rule.action;
    const newActionableCount = data.actionableSignals.length;

    console.log('[Focus] checkForUpdates - lastQ:', lastQuadrant, 'newQ:', newQuadrant,
                'lastCount:', lastActionableCount, 'newCount:', newActionableCount, 'action:', newAction);

    // Check if regime changed to actionable OR new signals appeared
    const regimeChanged = newQuadrant !== lastQuadrant;
    const signalsIncreased = newActionableCount > lastActionableCount;
    const isActionable = newAction !== 'SKIP';

    if (isActionable && (regimeChanged || signalsIncreased)) {
      console.log('[Focus] ALERT TRIGGERED! regimeChanged:', regimeChanged, 'signalsIncreased:', signalsIncreased);

      // Play sound
      playAlert(newAction);

      // Send notification
      const signalText = newActionableCount > 0
        ? `${newActionableCount} signal(s) available!`
        : 'Regime is now actionable';
      sendNotification(
        `🎯 ${newAction} Signal!`,
        `${newQuadrant}: ${data.rule.description}\\n${signalText}`,
        newAction
      );

      // Flash the page
      document.body.classList.add('alert-flash');
      setTimeout(() => document.body.classList.remove('alert-flash'), 1000);
    }

    // Also alert for new signals even if count didn't change (new symbol replaced old one)
    if (isActionable && newActionableCount > 0 && data.actionableSignals[0]) {
      const newestSignal = data.actionableSignals[0];
      const newestTime = new Date(newestSignal.timestamp).getTime();
      const tenSecsAgo = Date.now() - 15000; // 15 second window

      if (newestTime > tenSecsAgo && !regimeChanged && !signalsIncreased) {
        console.log('[Focus] New signal detected (same count but fresh):', newestSignal.symbol);
        playAlert(newAction);
        sendNotification(
          '🔥 New Signal!',
          newestSignal.symbol.replace('USDT', '') + ' - ' + newAction,
          newAction
        );
      }
    }

    lastQuadrant = newQuadrant;
    lastActionableCount = newActionableCount;

    // Update timestamp
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();

  } catch (e) {
    console.log('Update check failed:', e);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Settings are already loaded from localStorage at script start
  // But if browser permission was revoked, disable notifications
  if (notificationsEnabled && 'Notification' in window && Notification.permission !== 'granted') {
    notificationsEnabled = false;
    saveFocusModeSettings();
  }

  // Update UI to match loaded settings
  updateNotificationButton();
  updateAudioButton();
  updateLinkButton();

  // Set time window dropdown to saved value (may differ from URL if first load)
  const windowSelect = document.getElementById('time-window-select');
  if (windowSelect && activeWindowHours) {
    windowSelect.value = activeWindowHours.toString();
  }

  // Restore collapsed card states
  restoreCollapsedState();

  // Restore active position monitors BEFORE sorting
  // (so tracking-based sorts have access to activePositions)
  restoreActivePositions();

  // Restore sort preference (must run after activePositions is loaded)
  restoreSortPreference();

  // Start polling every 10 seconds
  setInterval(checkForUpdates, 10000);

  // Update position health every 10 seconds
  setInterval(updateAllPositionHealth, 10000);

  // Refresh full page every 60 seconds to get new signals list
  setTimeout(() => location.reload(), 60000);
});

function updateAudioButton() {
  const btn = document.getElementById('audio-btn');
  if (btn) {
    btn.textContent = audioEnabled ? '🔊 Audio ON' : '🔇 Audio OFF';
    btn.classList.toggle('active', audioEnabled);
  }
}

// Wake up audio context on first interaction
document.addEventListener('click', () => {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
}, { once: true });
