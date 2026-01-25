const eventSource = new EventSource('/events');

eventSource.onopen = () => {
  console.log('[Dashboard] SSE connected');
  document.getElementById('statusDot').className = 'status-dot active';
  document.getElementById('statusText').textContent = 'Connected';
  // Load notification settings on connect
  loadNotificationSettings();
};

eventSource.onerror = (err) => {
  console.error('[Dashboard] SSE error:', err);
  document.getElementById('statusDot').className = 'status-dot inactive';
  document.getElementById('statusText').textContent = 'Disconnected - Reconnecting...';
};

eventSource.addEventListener('state', (e) => {
  try {
    const state = JSON.parse(e.data);
    updateUI(state);
  } catch (err) {
    console.error('[Dashboard] Error parsing state:', err);
  }
});

eventSource.addEventListener('scan_status', (e) => {
  try {
    const { status } = JSON.parse(e.data);
    document.getElementById('statusText').textContent = status;
  } catch (err) {
    console.error('[Dashboard] Error parsing scan_status:', err);
  }
});

// Listen for position opened events from shadow bots
eventSource.addEventListener('position_opened', (e) => {
  try {
    const { bot, position } = JSON.parse(e.data);
    // Check if this bot's notifications are enabled
    if (isBotNotificationEnabled(bot)) {
      const ticker = position.symbol.replace('USDT', '');
      const dirEmoji = position.direction === 'long' ? '🟢 LONG' : '🔴 SHORT';
      const size = position.marginUsed || position.positionSize || 0;
      const entry = position.entryPrice || 0;
      showBrowserNotification(
        '⚡ ' + bot + ': ' + ticker + ' ' + dirEmoji,
        'Size: $' + size.toFixed(0) + ' | Entry: $' + entry.toPrecision(5),
        'bot-open-' + bot + '-' + position.symbol
      );
    }
  } catch (err) {
    console.error('[Dashboard] Error parsing position_opened:', err);
  }
});

// Listen for position closed events from shadow bots
eventSource.addEventListener('position_closed', (e) => {
  try {
    const { bot, position } = JSON.parse(e.data);
    // Check if this bot's notifications are enabled
    if (isBotNotificationEnabled(bot)) {
      const ticker = position.symbol.replace('USDT', '');
      const pnl = position.realizedPnL || position.pnl || 0;
      const pnlStr = pnl >= 0 ? '+$' + pnl.toFixed(2) : '-$' + Math.abs(pnl).toFixed(2);
      const emoji = pnl >= 0 ? '💰' : '❌';
      const reason = position.exitReason || 'closed';
      showBrowserNotification(
        emoji + ' ' + bot + ': ' + ticker + ' CLOSED',
        pnlStr + ' | ' + reason,
        'bot-close-' + bot + '-' + position.symbol
      );
    }
  } catch (err) {
    console.error('[Dashboard] Error parsing position_closed:', err);
  }
});

// Symbol check functionality
const symbolSearchEl = document.getElementById('symbolSearch');
if (symbolSearchEl) {
  symbolSearchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkSymbol();
  });
} else {
  console.error('[Dashboard] symbolSearch element not found');
}

async function checkSymbol() {
  const input = document.getElementById('symbolSearch');
  const symbol = input.value.trim();
  if (!symbol) return;

  const btn = document.getElementById('checkBtn');
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/check/' + encodeURIComponent(symbol));
    const data = await res.json();

    document.getElementById('checkTitle').textContent = data.symbol + ' Analysis';
    document.getElementById('checkResults').innerHTML = renderCheckResults(data);
    document.getElementById('checkModal').style.display = 'block';
  } catch (err) {
    alert('Error checking symbol: ' + err.message);
  } finally {
    btn.textContent = 'Check';
    btn.disabled = false;
  }
}

function closeModal() {
  document.getElementById('checkModal').style.display = 'none';
}

function openGuide() {
  document.getElementById('guideModal').style.display = 'block';
}

function closeGuide() {
  document.getElementById('guideModal').style.display = 'none';
}

// Settings modal functions
function openSettings() {
  // Update radio buttons to match current setting
  const botsRadio = document.querySelector('input[name="linkDestination"][value="bots"]');
  const futuresRadio = document.querySelector('input[name="linkDestination"][value="futures"]');
  if (botsRadio) botsRadio.checked = appSettings.linkDestination === 'bots';
  if (futuresRadio) futuresRadio.checked = appSettings.linkDestination === 'futures';

  // Highlight selected option
  document.getElementById('linkOption_bots').style.borderColor = appSettings.linkDestination === 'bots' ? '#58a6ff' : 'transparent';
  document.getElementById('linkOption_futures').style.borderColor = appSettings.linkDestination === 'futures' ? '#58a6ff' : 'transparent';

  // Update saved list count
  document.getElementById('settingsSavedCount').textContent = savedList.size;

  // Load daily reset settings from server
  loadDailyResetSettings();

  // Load notification settings from server
  loadNotificationSettings();

  // Load investment amount setting from server
  loadInvestmentAmount();

  // Load database stats
  loadDatabaseStats();

  document.getElementById('settingsModal').style.display = 'block';
}

function closeSettings() {
  document.getElementById('settingsModal').style.display = 'none';
}

function updateLinkSetting(value) {
  appSettings.linkDestination = value;
  persistSettings();

  // Update visual selection
  document.getElementById('linkOption_bots').style.borderColor = value === 'bots' ? '#58a6ff' : 'transparent';
  document.getElementById('linkOption_futures').style.borderColor = value === 'futures' ? '#58a6ff' : 'transparent';

  // Re-render tables to update links
  renderSetupsWithTab();
  console.log('[Settings] Link destination changed to:', value);
}

function clearSavedList() {
  if (confirm('Are you sure you want to clear your saved list? This cannot be undone.')) {
    savedList.clear();
    persistSavedList();
    updateSavedListCount();
    document.getElementById('settingsSavedCount').textContent = '0';
    renderSetupsWithTab();
    console.log('[Settings] Saved list cleared');
  }
}

// Daily reset functions
async function loadDailyResetSettings() {
  try {
    const res = await fetch('/api/daily-reset');
    const data = await res.json();

    // Update checkbox
    const toggle = document.getElementById('dailyResetToggle');
    if (toggle) toggle.checked = data.enabled;

    // Update status display
    const statusEl = document.getElementById('dailyResetStatus');
    const dateEl = document.getElementById('dailyResetLastDate');

    if (statusEl) statusEl.textContent = data.enabled ? 'Enabled' : 'Disabled';
    if (statusEl) statusEl.style.color = data.enabled ? '#3fb950' : '#6e7681';
    if (dateEl) dateEl.textContent = data.lastResetDate || '-';

    console.log('[Settings] Daily reset settings loaded:', data);
  } catch (err) {
    console.error('[Settings] Failed to load daily reset settings:', err);
  }
}

async function toggleDailyReset(enabled) {
  try {
    const res = await fetch('/api/daily-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();

    // Update status display
    const statusEl = document.getElementById('dailyResetStatus');
    if (statusEl) {
      statusEl.textContent = data.enabled ? 'Enabled' : 'Disabled';
      statusEl.style.color = data.enabled ? '#3fb950' : '#6e7681';
    }

    console.log('[Settings] Daily reset toggled:', data.enabled);
  } catch (err) {
    console.error('[Settings] Failed to toggle daily reset:', err);
    alert('Failed to update setting: ' + err.message);
  }
}

// Notification & Sound settings
let notificationsEnabled = true;
let soundEnabled = true;
let botNotifications = {};  // Per-bot notification settings

async function loadNotificationSettings() {
  try {
    const res = await fetch('/api/notification-settings');
    const data = await res.json();
    notificationsEnabled = data.notificationsEnabled;
    soundEnabled = data.soundEnabled;
    botNotifications = data.botNotifications || {};

    // Update UI toggles
    const notifToggle = document.getElementById('notificationsToggle');
    const soundToggle = document.getElementById('soundToggle');
    if (notifToggle) notifToggle.checked = notificationsEnabled;
    if (soundToggle) soundToggle.checked = soundEnabled;

    // Update bot notification checkboxes
    for (const [botId, enabled] of Object.entries(botNotifications)) {
      const checkbox = document.getElementById('botNotif_' + botId);
      if (checkbox) checkbox.checked = enabled;
    }

    // Update notification badges on bot cards
    updateNotificationBadges();
  } catch (err) {
    console.error('[Settings] Failed to load notification settings:', err);
  }
}

async function toggleNotifications(enabled) {
  try {
    const res = await fetch('/api/notification-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationsEnabled: enabled })
    });
    const data = await res.json();
    notificationsEnabled = data.notificationsEnabled;
    console.log('[Settings] Notifications toggled:', notificationsEnabled);
  } catch (err) {
    console.error('[Settings] Failed to toggle notifications:', err);
    alert('Failed to update setting: ' + err.message);
  }
}

async function toggleSound(enabled) {
  try {
    const res = await fetch('/api/notification-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soundEnabled: enabled })
    });
    const data = await res.json();
    soundEnabled = data.soundEnabled;
    console.log('[Settings] Sound toggled:', soundEnabled);
  } catch (err) {
    console.error('[Settings] Failed to toggle sound:', err);
    alert('Failed to update setting: ' + err.message);
  }
}

// Toggle notification for a specific bot
async function toggleBotNotification(botId, enabled) {
  try {
    const res = await fetch('/api/notification-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botNotifications: { [botId]: enabled } })
    });
    const data = await res.json();
    botNotifications = data.botNotifications || {};
    console.log('[Settings] Bot notification toggled:', botId, enabled);
    // Update notification badges on bot cards
    updateNotificationBadges();
    // Update settings checkbox if open
    const checkbox = document.getElementById('botNotif_' + botId);
    if (checkbox) checkbox.checked = enabled;
  } catch (err) {
    console.error('[Settings] Failed to toggle bot notification:', err);
    alert('Failed to update setting: ' + err.message);
  }
}

// Update notification badges on bot cards
function updateNotificationBadges() {
  // List of all bot IDs that have notification badges
  const botIds = [
    'exp-bb-sysB', 'exp-bb-sysB-contrarian',
    'exp-gp-sysA', 'exp-gp-sysB', 'exp-gp-regime', 'exp-gp-sysB-contrarian',
    'focus-baseline', 'focus-aggressive', 'focus-conservative',
    'focus-conflict', 'focus-hybrid', 'focus-excellent',
    'focus-contrarian-only', 'focus-euphoria-fade', 'focus-bull-dip', 'focus-full-quadrant'
  ];

  for (const botId of botIds) {
    const badge = document.getElementById('notifBadge_' + botId);
    if (badge) {
      const enabled = isBotNotificationEnabled(botId);
      badge.textContent = enabled ? '🔔' : '🔕';
      badge.style.opacity = enabled ? '1' : '0.4';
    }
  }
}

// Toggle all bot notifications on/off
async function toggleAllBotNotifications(enabled) {
  const allBotIds = Object.keys(botNotifications);
  const updates = {};
  for (const botId of allBotIds) {
    updates[botId] = enabled;
  }
  try {
    const res = await fetch('/api/notification-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botNotifications: updates })
    });
    const data = await res.json();
    botNotifications = data.botNotifications || {};
    // Update all checkboxes
    for (const [botId, isEnabled] of Object.entries(botNotifications)) {
      const checkbox = document.getElementById('botNotif_' + botId);
      if (checkbox) checkbox.checked = isEnabled;
    }
    console.log('[Settings] All bot notifications toggled:', enabled);
  } catch (err) {
    console.error('[Settings] Failed to toggle all bot notifications:', err);
    alert('Failed to update settings: ' + err.message);
  }
}

// Check if notifications are enabled for a specific bot
function isBotNotificationEnabled(botId) {
  if (!notificationsEnabled) return false;
  return botNotifications[botId] !== false;  // Default to true if not explicitly disabled
}

function testNotification() {
  if (!notificationsEnabled) {
    alert('Notifications are disabled. Enable them first.');
    return;
  }
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      new Notification('🔔 Test Notification', {
        body: 'Notifications are working!',
        icon: '🔥'
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          new Notification('🔔 Test Notification', {
            body: 'Notifications are now enabled!',
            icon: '🔥'
          });
        }
      });
    } else {
      alert('Notifications are blocked by your browser. Please allow them in your browser settings.');
    }
  } else {
    alert('Your browser does not support notifications.');
  }
}

function testSound() {
  if (!soundEnabled) {
    alert('Sound is disabled. Enable it first.');
    return;
  }
  // Play a simple beep using Web Audio API
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
    oscillator.frequency.linearRampToValueAtTime(600, audioContext.currentTime + 0.1);

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (err) {
    console.error('Failed to play sound:', err);
    alert('Failed to play sound: ' + err.message);
  }
}

// Investment amount settings
let currentInvestmentAmount = 2000;

async function loadInvestmentAmount() {
  try {
    const res = await fetch('/api/investment-amount');
    const data = await res.json();
    currentInvestmentAmount = data.amount;

    // Update the input field
    const input = document.getElementById('investmentAmountInput');
    if (input) input.value = currentInvestmentAmount;

    console.log('[Settings] Investment amount loaded:', currentInvestmentAmount);
  } catch (err) {
    console.error('[Settings] Failed to load investment amount:', err);
  }
}

async function updateInvestmentAmount(resetBots) {
  const input = document.getElementById('investmentAmountInput');
  const statusEl = document.getElementById('investmentStatus');
  const amount = parseFloat(input.value);

  if (!amount || amount <= 0) {
    statusEl.style.display = 'block';
    statusEl.style.color = '#f85149';
    statusEl.textContent = '❌ Please enter a valid positive amount';
    return;
  }

  const confirmMsg = resetBots
    ? 'Update investment amount to $' + amount + ' and RESET all bots? This will close all positions and reset balances.'
    : 'Update investment amount to $' + amount + '? Current bot balances will be preserved.';

  if (!confirm(confirmMsg)) {
    return;
  }

  try {
    const res = await fetch('/api/investment-amount', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amount, resetBots: resetBots })
    });
    const data = await res.json();

    if (data.success) {
      currentInvestmentAmount = data.amount;
      statusEl.style.display = 'block';
      statusEl.style.color = '#3fb950';
      if (data.botsReset) {
        statusEl.textContent = '✅ Investment set to $' + amount + ' - All bots reset to new balance';
      } else {
        statusEl.textContent = '✅ Investment set to $' + amount + ' - Future resets will use this amount';
      }
      console.log('[Settings] Investment amount updated:', data);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (err) {
    console.error('[Settings] Failed to update investment amount:', err);
    statusEl.style.display = 'block';
    statusEl.style.color = '#f85149';
    statusEl.textContent = '❌ Failed: ' + err.message;
  }
}

async function triggerManualReset() {
  if (!confirm('Reset all bots now? This will close all open positions and reset balances to $' + currentInvestmentAmount + '. Trade history will be preserved.')) {
    return;
  }

  try {
    const res = await fetch('/api/daily-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerNow: true })
    });
    const data = await res.json();

    // Update last reset date
    const dateEl = document.getElementById('dailyResetLastDate');
    if (dateEl) dateEl.textContent = data.lastResetDate;

    alert('All bots have been reset to $' + currentInvestmentAmount + ' starting balance.');
    console.log('[Settings] Manual reset triggered');
  } catch (err) {
    console.error('[Settings] Failed to trigger reset:', err);
    alert('Failed to reset bots: ' + err.message);
  }
}

// Database stats and export functions
async function loadDatabaseStats() {
  try {
    const res = await fetch('/api/db-stats');
    const stats = await res.json();

    document.getElementById('dbTotalTrades').textContent = stats.totalTrades || 0;
    document.getElementById('dbWinLoss').innerHTML =
      '<span style="color: #3fb950;">' + (stats.wins || 0) + ' W</span> / ' +
      '<span style="color: #f85149;">' + (stats.losses || 0) + ' L</span>';

    if (stats.firstTrade && stats.lastTrade) {
      const first = new Date(stats.firstTrade).toLocaleDateString();
      const last = new Date(stats.lastTrade).toLocaleDateString();
      document.getElementById('dbDateRange').textContent = first + ' - ' + last;
    } else {
      document.getElementById('dbDateRange').textContent = 'No trades yet';
    }

    const pnl = stats.totalPnl || 0;
    const pnlEl = document.getElementById('dbTotalPnl');
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
    pnlEl.style.color = pnl >= 0 ? '#3fb950' : '#f85149';

  } catch (err) {
    console.error('[Settings] Failed to load database stats:', err);
    document.getElementById('dbTotalTrades').textContent = 'Error';
  }
}

async function exportTrades() {
  const days = document.getElementById('exportDays').value;
  const url = '/api/export-trades?days=' + days;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Export failed');

    const blob = await res.blob();
    const filename = 'trades-' + days + 'days-' + new Date().toISOString().split('T')[0] + '.csv';

    // Create download link
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);

    console.log('[Export] Downloaded', filename);
  } catch (err) {
    console.error('[Export] Failed:', err);
    alert('Failed to export trades: ' + err.message);
  }
}

// History modal - stores last fetched state for rendering
let lastState = null;

function showBotHistory(botKey, botName) {
  document.getElementById('historyModalTitle').textContent = botName + ' History';
  if (lastState) {
    const content = renderHistoryModalContent(botKey, lastState);
    document.getElementById('historyModalContent').innerHTML = content;
  } else {
    document.getElementById('historyModalContent').innerHTML = '<div class="empty-state">Loading...</div>';
  }
  document.getElementById('historyModal').style.display = 'block';
}

function closeHistoryModal() {
  document.getElementById('historyModal').style.display = 'none';
}

function renderHistoryModalContent(botKey, state) {
  let trades = [];
  let isTrailing = true;

  // Map bot keys to state properties
  const botMap = {
    'fixedTP': { prop: 'fixedTPBot', trailing: false },
    'trailing1pct': { prop: 'trailing1pctBot', trailing: true },
    'trailing10pct10x': { prop: 'trailing10pct10xBot', trailing: true },
    'trailing10pct20x': { prop: 'trailing10pct20xBot', trailing: true },
    'trailWide': { prop: 'trailWideBot', trailing: true },
    'confluence': { prop: 'confluenceBot', trailing: true },
    'btcExtreme': { prop: 'btcExtremeBot', trailing: true, btc: true },
    'btcTrend': { prop: 'btcTrendBot', trailing: true, btc: true },
    'trendOverride': { prop: 'trendOverrideBot', trailing: true },
    'trendFlip': { prop: 'trendFlipBot', trailing: true },
    // GP Bots - use goldenPocketBots nested object
    'gpConservative': { prop: 'goldenPocketBots', gpKey: 'gp-conservative', trailing: true, gp: true },
    'gpStandard': { prop: 'goldenPocketBots', gpKey: 'gp-standard', trailing: true, gp: true },
    'gpAggressive': { prop: 'goldenPocketBots', gpKey: 'gp-aggressive', trailing: true, gp: true },
    'gpYolo': { prop: 'goldenPocketBots', gpKey: 'gp-yolo', trailing: true, gp: true },
  };

  const config = botMap[botKey];
  if (config && state[config.prop]) {
    if (config.gp && config.gpKey) {
      // GP bots use nested structure: state.goldenPocketBots['gp-conservative']
      const gpBot = state[config.prop][config.gpKey];
      trades = gpBot ? (gpBot.closedPositions || []) : [];
    } else {
      trades = state[config.prop].closedPositions || [];
    }
    isTrailing = config.trailing;
  }

  if (trades.length === 0) {
    return '<div class="empty-state">No trade history</div>';
  }

  if (isTrailing) {
    return renderTrailingHistoryTable(trades);
  } else {
    return renderHistoryTable(trades);
  }
}

// Close modals on escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeGuide();
    closeHistoryModal();
  }
});

// Section collapse/expand state - defaults (all expanded)
const defaultSectionState = {
  altcoinBots: true,
  // btcBiasBots V1 REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
  mexcSim: true,
  goldenPocket: true,
  // Bot Cards
  botCards: true,
  fixedTP: true,
  trailing1pct: true,
  trailing10pct10x: true,
  trailing10pct20x: true,
  trailWide: true,
  confluence: true,
  btcExtreme: true,
  btcTrend: true,
  trendOverride: true,
  trendFlip: true,
  // GP Bot Cards
  gpConservative: true,
  gpStandard: true,
  gpAggressive: true,
  gpYolo: true,
  // Experimental Bots
  expBots: true,
};

// Load section state from localStorage, falling back to defaults
function loadSectionState() {
  try {
    const saved = localStorage.getItem('backburner_sectionState');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Merge with defaults to handle new sections
      return { ...defaultSectionState, ...parsed };
    }
  } catch (e) {
    console.warn('[loadSectionState] Failed to load from localStorage:', e);
  }
  return { ...defaultSectionState };
}

// Save section state to localStorage
function saveSectionState() {
  try {
    localStorage.setItem('backburner_sectionState', JSON.stringify(sectionState));
  } catch (e) {
    console.warn('[saveSectionState] Failed to save to localStorage:', e);
  }
}

// Initialize section state from localStorage
const sectionState = loadSectionState();

function toggleSection(sectionId) {
  console.log('[toggleSection] Called for: ' + sectionId);
  // Toggle state
  sectionState[sectionId] = !sectionState[sectionId];
  const isExpanded = sectionState[sectionId];
  console.log('[toggleSection] New state for ' + sectionId + ': ' + (isExpanded ? 'expanded' : 'collapsed'));
  const content = document.getElementById(sectionId + 'Content');
  const toggle = document.getElementById(sectionId + 'Toggle');
  if (content && toggle) {
    // Use direct style manipulation for reliable hiding
    content.style.display = isExpanded ? 'block' : 'none';
    toggle.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    console.log('[toggleSection] Applied styles - display: ' + content.style.display + ', transform: ' + toggle.style.transform);
  } else {
    console.warn('[toggleSection] Elements not found for ' + sectionId + '. Content: ' + !!content + ', Toggle: ' + !!toggle);
  }
  // Persist state to localStorage
  saveSectionState();
}

function collapseAllSections() {
  Object.keys(sectionState).forEach(id => {
    sectionState[id] = false;
    const content = document.getElementById(id + 'Content');
    const toggle = document.getElementById(id + 'Toggle');
    if (content && toggle) {
      content.style.display = 'none';
      toggle.style.transform = 'rotate(-90deg)';
    }
  });
  saveSectionState();
}

function expandAllSections() {
  Object.keys(sectionState).forEach(id => {
    sectionState[id] = true;
    const content = document.getElementById(id + 'Content');
    const toggle = document.getElementById(id + 'Toggle');
    if (content && toggle) {
      content.style.display = 'block';
      toggle.style.transform = 'rotate(0deg)';
    }
  });
  saveSectionState();
}

// Apply saved section states to DOM (call on page load)
function applySectionStates() {
  Object.keys(sectionState).forEach(id => {
    const isExpanded = sectionState[id];
    const content = document.getElementById(id + 'Content');
    const toggle = document.getElementById(id + 'Toggle');
    if (content && toggle) {
      content.style.display = isExpanded ? 'block' : 'none';
      toggle.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
  });
}

// Apply section states once DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applySectionStates);
} else {
  // DOM already loaded
  applySectionStates();
}

function renderCheckResults(data) {
  let html = '<table style="width: 100%; border-collapse: collapse;">';
  html += '<tr style="border-bottom: 1px solid #30363d;"><th style="text-align: left; padding: 8px; color: #8b949e;">Market</th><th style="text-align: left; padding: 8px; color: #8b949e;">TF</th><th style="text-align: right; padding: 8px; color: #8b949e;">RSI</th><th style="text-align: left; padding: 8px; color: #8b949e;">Setup</th></tr>';

  for (const r of data.results) {
    if (r.error) {
      html += '<tr style="border-bottom: 1px solid #21262d;"><td style="padding: 8px; color: #8b949e;">' + r.marketType.toUpperCase() + '</td><td style="padding: 8px;">' + r.timeframe + '</td><td colspan="2" style="padding: 8px; color: #6e7681;">' + r.error + '</td></tr>';
      continue;
    }

    const rsiColor = r.rsiZone === 'oversold' ? '#f85149' : r.rsiZone === 'overbought' ? '#3fb950' : r.rsiZone === 'low' ? '#d29922' : r.rsiZone === 'high' ? '#58a6ff' : '#8b949e';
    const rsiLabel = r.rsiZone === 'oversold' ? ' (OS)' : r.rsiZone === 'overbought' ? ' (OB)' : '';

    let setupHtml = '<span style="color: #6e7681;">No setup</span>';
    if (r.setup) {
      const dirColor = r.setup.direction === 'long' ? '#3fb950' : '#f85149';
      const stateColor = r.setup.state === 'triggered' ? '#3fb950' : r.setup.state === 'deep_extreme' ? '#f85149' : r.setup.state === 'reversing' ? '#d29922' : '#8b949e';
      setupHtml = '<span style="color: ' + dirColor + '; font-weight: bold;">' + r.setup.direction.toUpperCase() + '</span> <span style="background: ' + stateColor + '22; color: ' + stateColor + '; padding: 2px 6px; border-radius: 4px; font-size: 12px;">' + r.setup.state.toUpperCase() + '</span>';
    }

    html += '<tr style="border-bottom: 1px solid #21262d;">';
    html += '<td style="padding: 8px; color: #c9d1d9;">' + r.marketType.toUpperCase() + '</td>';
    html += '<td style="padding: 8px; font-weight: 500;">' + r.timeframe + '</td>';
    html += '<td style="padding: 8px; text-align: right; color: ' + rsiColor + '; font-weight: bold;">' + r.currentRSI + rsiLabel + '</td>';
    html += '<td style="padding: 8px;">' + setupHtml + '</td>';
    html += '</tr>';
  }

  html += '</table>';

  if (data.activeSetups && data.activeSetups.length > 0) {
    html += '<div style="margin-top: 16px; padding: 12px; background: #0d1117; border-radius: 8px;"><strong style="color: #3fb950;">Active Setups: ' + data.activeSetups.length + '</strong></div>';
  }

  return html;
}

// Bot visibility state (synced with server)
let botVisibility = {
  fixedTP: true, trailing1pct: true, trailing10pct10x: true, trailing10pct20x: true,
  trailWide: true, confluence: true,
  btcExtreme: true, btcTrend: true, trendOverride: true, trendFlip: true,
  // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
};

// Setups tab state
let currentSetupsTab = 'active';
let allSetupsData = { all: [], active: [], playedOut: [], history: [], goldenPocket: [] };

// Saved list state (persisted to localStorage)
let savedList = new Set();  // Keys: symbol-timeframe-direction-marketType
let selectedSetups = new Set();  // Currently selected in UI

// Settings state (persisted to localStorage)
let appSettings = {
  linkDestination: 'bots',  // 'bots' or 'futures'
  marketFilter: 'all',      // 'all', 'spot', or 'futures'
};

// Load saved list and settings from localStorage on startup
function loadPersistedData() {
  try {
    const savedListData = localStorage.getItem('backburner_savedList');
    if (savedListData) {
      const arr = JSON.parse(savedListData);
      savedList = new Set(arr);
      console.log('[Settings] Loaded saved list with ' + savedList.size + ' items');
    }
    const settingsData = localStorage.getItem('backburner_settings');
    if (settingsData) {
      appSettings = { ...appSettings, ...JSON.parse(settingsData) };
      console.log('[Settings] Loaded settings:', appSettings);
    }
    // Update market filter dropdown to match saved setting
    const marketFilterEl = document.getElementById('marketFilter');
    if (marketFilterEl && appSettings.marketFilter) {
      marketFilterEl.value = appSettings.marketFilter;
    }
  } catch (e) {
    console.error('[Settings] Failed to load persisted data:', e);
  }
}

// Persist saved list to localStorage
function persistSavedList() {
  try {
    localStorage.setItem('backburner_savedList', JSON.stringify([...savedList]));
  } catch (e) {
    console.error('[Settings] Failed to persist saved list:', e);
  }
}

// Persist settings to localStorage
function persistSettings() {
  try {
    localStorage.setItem('backburner_settings', JSON.stringify(appSettings));
  } catch (e) {
    console.error('[Settings] Failed to persist settings:', e);
  }
}

// Get MEXC URL based on settings (bots or futures)
function getMexcUrl(symbol) {
  const base = symbol.replace('USDT', '');
  if (appSettings.linkDestination === 'bots') {
    return 'https://www.mexc.com/futures/trading-bots/grid/' + base + '_USDT';
  } else {
    return 'https://www.mexc.com/futures/' + base + '_USDT';
  }
}

// Initialize persisted data on load
loadPersistedData();
// Schedule update of saved list count after DOM is ready
setTimeout(function() {
  updateSavedListCount();
}, 100);

function getSetupKey(s) {
  return s.symbol + '-' + s.timeframe + '-' + s.direction + '-' + s.marketType;
}

function toggleSetupSelection(key) {
  if (selectedSetups.has(key)) {
    selectedSetups.delete(key);
  } else {
    selectedSetups.add(key);
  }
  updateSelectionStatus();
  // Update checkbox visual
  const cb = document.querySelector('[data-setup-key="' + key + '"]');
  if (cb) cb.checked = selectedSetups.has(key);
}

function selectAllSetups() {
  const currentSetups = getCurrentDisplayedSetups();
  currentSetups.forEach(s => selectedSetups.add(getSetupKey(s)));
  updateSelectionStatus();
  renderSetupsWithTab();
}

function deselectAllSetups() {
  selectedSetups.clear();
  updateSelectionStatus();
  renderSetupsWithTab();
}

function addSelectedToList() {
  selectedSetups.forEach(key => savedList.add(key));
  updateSavedListCount();
  persistSavedList();  // Persist to localStorage
  selectedSetups.clear();
  updateSelectionStatus();
  renderSetupsWithTab();
}

function removeSelectedFromList() {
  selectedSetups.forEach(key => savedList.delete(key));
  updateSavedListCount();
  persistSavedList();  // Persist to localStorage
  selectedSetups.clear();
  updateSelectionStatus();
  renderSetupsWithTab();
}

function updateSelectionStatus() {
  const el = document.getElementById('selectionStatus');
  if (el) el.textContent = selectedSetups.size + ' selected';
}

function updateSavedListCount() {
  const el = document.getElementById('savedListCount');
  if (el) {
    // Show count of saved items that actually have matching current data
    // (not just total keys in localStorage, which may include stale entries)
    const all = [...(allSetupsData.all || []), ...(allSetupsData.goldenPocket || [])];
    const visibleCount = all.filter(s => savedList.has(getSetupKey(s))).length;
    el.textContent = visibleCount;
  }
}

// Cross-strategy signal detection
// Returns: null if no match, 'align' if same direction, 'conflict' if opposite directions
function getCrossStrategySignal(setup, isGP) {
  const otherSetups = isGP ? (allSetupsData.all || []) : (allSetupsData.goldenPocket || []);
  // Look for setups with same symbol (ignoring timeframe for broader matching)
  const matches = otherSetups.filter(other =>
    other.symbol === setup.symbol &&
    other.state !== 'played_out' &&
    other.state !== 'watching'
  );
  if (matches.length === 0) return null;

  // Check if directions align or conflict
  const alignedMatch = matches.find(m => m.direction === setup.direction);
  const conflictMatch = matches.find(m => m.direction !== setup.direction);

  if (alignedMatch && conflictMatch) {
    return 'mixed'; // Both aligned and conflicting signals
  }
  if (alignedMatch) return 'align';
  if (conflictMatch) return 'conflict';
  return null;
}

function getCurrentDisplayedSetups() {
  let setups = [];
  if (currentSetupsTab === 'active') setups = allSetupsData.active || [];
  else if (currentSetupsTab === 'playedOut') setups = allSetupsData.playedOut || [];
  else if (currentSetupsTab === 'history') setups = allSetupsData.history || [];
  else if (currentSetupsTab === 'goldenPocket') {
    setups = (allSetupsData.goldenPocket || []).filter(s => gpStateFilters[s.state]);
  }
  else if (currentSetupsTab === 'savedList') {
    // Collect all setups that are in saved list
    const all = [...(allSetupsData.all || []), ...(allSetupsData.goldenPocket || [])];
    setups = all.filter(s => savedList.has(getSetupKey(s)));
  }
  else setups = allSetupsData.all || [];

  // Apply market filter
  if (appSettings.marketFilter === 'spot') {
    setups = setups.filter(s => s.marketType === 'spot');
  } else if (appSettings.marketFilter === 'futures') {
    setups = setups.filter(s => s.marketType === 'futures');
  }

  return setups;
}

// Market filter function
function setMarketFilter(filter) {
  appSettings.marketFilter = filter;
  persistSettings();
  renderSetupsWithTab();
  console.log('[Settings] Market filter changed to:', filter);
}

// GP filter state - which states to show
// V2 CHANGE: Default to actionable states only (watching is not tradeable)
let gpStateFilters = {
  watching: false,     // V2: OFF by default - not actionable
  triggered: true,     // Actionable - RSI just crossed threshold
  deep_extreme: true,  // Actionable - strong signal
  reversing: true,     // Might still catch the move
  played_out: false    // Hide played_out by default
};

// V2: Only show setups from allowed timeframes
const GP_ALLOWED_TIMEFRAMES = ['5m'];  // Match ALLOWED_TIMEFRAMES

// V2: Deduplicate GP setups - keep best one per symbol+timeframe+direction
function deduplicateGPSetups(setups) {
  const seen = new Map();
  for (const s of setups) {
    const key = s.symbol + '_' + s.timeframe + '_' + s.direction;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, s);
    } else {
      // Keep the one with more actionable state, or most recent update
      const stateRank = { 'triggered': 4, 'deep_extreme': 3, 'reversing': 2, 'watching': 1, 'played_out': 0 };
      const existingRank = stateRank[existing.state] || 0;
      const newRank = stateRank[s.state] || 0;
      if (newRank > existingRank || (newRank === existingRank && (s.lastUpdated || 0) > (existing.lastUpdated || 0))) {
        seen.set(key, s);
      }
    }
  }
  return Array.from(seen.values());
}

// Toggle to always show saved list items regardless of state filters
let showSavedInFilters = false;

function toggleGpFilter(state) {
  gpStateFilters[state] = !gpStateFilters[state];
  updateGpFilterButtons();
  renderSetupsWithTab();
}

function toggleShowSavedInFilters() {
  showSavedInFilters = !showSavedInFilters;
  updateShowSavedButton();
  renderSetupsWithTab();
}

function updateShowSavedButton() {
  const btn = document.getElementById('gpShowSavedToggle');
  if (btn) {
    btn.style.opacity = showSavedInFilters ? '1' : '0.4';
    btn.style.background = showSavedInFilters ? '#1c3a5e' : '#21262d';
  }
}

function updateGpFilterButtons() {
  ['watching', 'triggered', 'deep_extreme', 'reversing', 'played_out'].forEach(state => {
    const btn = document.getElementById('gpFilter_' + state);
    if (btn) {
      btn.style.opacity = gpStateFilters[state] ? '1' : '0.4';
      btn.style.textDecoration = gpStateFilters[state] ? 'none' : 'line-through';
    }
  });
}

function setSetupsTab(tab) {
  currentSetupsTab = tab;
  // Update tab button styles
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.style.background = '#21262d';
    btn.style.color = '#8b949e';
  });
  const activeBtn = document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (activeBtn) {
    const bgColor = tab === 'playedOut' ? '#6e7681' :
                    tab === 'history' ? '#8957e5' :
                    tab === 'goldenPocket' ? '#f0883e' :
                    tab === 'savedList' ? '#58a6ff' : '#238636';
    activeBtn.style.background = bgColor;
    activeBtn.style.color = 'white';
  }
  // Re-render setups table with current filter
  renderSetupsWithTab();
}

function renderSetupsWithTab() {
  let setups;
  if (currentSetupsTab === 'active') {
    // Filter out momentum_exhaustion — these are NOT real backburner setups
    setups = (allSetupsData.active || []).filter(s => s.signalClassification !== 'momentum_exhaustion');
  } else if (currentSetupsTab === 'playedOut') {
    setups = allSetupsData.playedOut;
  } else if (currentSetupsTab === 'history') {
    setups = allSetupsData.history;
  } else if (currentSetupsTab === 'goldenPocket') {
    // V2 CHANGE: Apply timeframe filter FIRST, dedupe, then state filters
    let tfFilteredSetups = (allSetupsData.goldenPocket || []).filter(s =>
      GP_ALLOWED_TIMEFRAMES.includes(s.timeframe)
    );
    // Deduplicate: one row per symbol+timeframe+direction (keep best state)
    let dedupedSetups = deduplicateGPSetups(tfFilteredSetups);
    // Apply GP state filters (with optional saved list override)
    let filteredSetups = dedupedSetups.filter(s =>
      gpStateFilters[s.state] || (showSavedInFilters && savedList.has(getSetupKey(s)))
    );
    document.getElementById('setupsTable').innerHTML = renderGoldenPocketTable(filteredSetups, dedupedSetups.length);
    return;
  } else if (currentSetupsTab === 'savedList') {
    // Show saved list items (both regular and GP setups)
    setups = getCurrentDisplayedSetups();
    document.getElementById('setupsTable').innerHTML = renderSavedListTable(setups);
    return;
  } else {
    setups = allSetupsData.all;
  }

  // Apply market filter (spot/futures/all)
  if (setups && appSettings.marketFilter === 'spot') {
    setups = setups.filter(s => s.marketType === 'spot');
  } else if (setups && appSettings.marketFilter === 'futures') {
    setups = setups.filter(s => s.marketType === 'futures');
  }

  document.getElementById('setupsTable').innerHTML = renderSetupsTable(setups, currentSetupsTab);
}

function renderGoldenPocketTable(setups, totalCount) {
  // Use shared getMexcUrl function (respects settings)

  // Filter bar
  let html = '<div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; align-items: center;">';
  html += '<span style="color: #8b949e; font-size: 11px; margin-right: 4px;">Filter:</span>';
  html += '<button id="gpFilter_watching" onclick="toggleGpFilter(\'watching\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #8b949e; background: #21262d; color: #8b949e; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.watching ? '1' : '0.4') + ';">watching</button>';
  html += '<button id="gpFilter_triggered" onclick="toggleGpFilter(\'triggered\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #3fb950; background: #21262d; color: #3fb950; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.triggered ? '1' : '0.4') + ';">triggered</button>';
  html += '<button id="gpFilter_deep_extreme" onclick="toggleGpFilter(\'deep_extreme\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #f0883e; background: #21262d; color: #f0883e; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.deep_extreme ? '1' : '0.4') + ';">deep</button>';
  html += '<button id="gpFilter_reversing" onclick="toggleGpFilter(\'reversing\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #58a6ff; background: #21262d; color: #58a6ff; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.reversing ? '1' : '0.4') + ';">reversing</button>';
  html += '<button id="gpFilter_played_out" onclick="toggleGpFilter(\'played_out\')" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #6e7681; background: #21262d; color: #6e7681; font-size: 10px; cursor: pointer; opacity: ' + (gpStateFilters.played_out ? '1' : '0.4') + ';">played out</button>';
  html += '<span style="color: #6e7681; margin: 0 6px;">|</span>';
  html += '<button id="gpShowSavedToggle" onclick="toggleShowSavedInFilters()" style="padding: 3px 8px; border-radius: 4px; border: 1px solid #58a6ff; background: ' + (showSavedInFilters ? '#1c3a5e' : '#21262d') + '; color: #58a6ff; font-size: 10px; cursor: pointer; opacity: ' + (showSavedInFilters ? '1' : '0.4') + ';" title="Always show saved list items regardless of state filters">📋 +List</button>';
  html += '<span style="color: #6e7681; font-size: 10px; margin-left: 8px;">(' + (setups?.length || 0) + '/' + (totalCount || 0) + ')</span>';
  html += '</div>';

  if (!setups || setups.length === 0) {
    return html + '<div class="empty-state">No Golden Pocket setups match filters</div>';
  }

  html += '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
  html += '<thead><tr style="border-bottom: 1px solid #30363d;">';
  html += '<th style="width: 30px; padding: 8px;"></th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Symbol</th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Dir</th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">State</th>';
  html += '<th style="text-align: center; padding: 8px; color: #8b949e;" title="Would bots trade this?">Trade?</th>';
  html += '<th style="text-align: right; padding: 8px; color: #8b949e;" title="Stop loss % from current price">SL%</th>';
  html += '<th style="text-align: right; padding: 8px; color: #8b949e;" title="Take profit % from current price">TP%</th>';
  html += '<th style="text-align: right; padding: 8px; color: #8b949e;" title="Reward:Risk ratio">R:R</th>';
  html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Entry</th>';
  html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Updated</th>';
  html += '</tr></thead><tbody>';

  for (const s of setups) {
    const dirColor = s.direction === 'long' ? '#3fb950' : '#f85149';
    const dirIcon = s.direction === 'long' ? '📈' : '📉';
    const stateColor = s.state === 'triggered' ? '#3fb950' :
                       s.state === 'deep_extreme' ? '#f0883e' :
                       s.state === 'reversing' ? '#58a6ff' : '#8b949e';
    const ticker = s.symbol.replace('USDT', '');
    const mexcUrl = getMexcUrl(s.symbol);
    const linkTitle = appSettings.linkDestination === 'bots' ? 'Open MEXC Trading Bots' : 'Open MEXC Futures';
    const lastUpdated = formatTimeAgo(s.lastUpdated || s.detectedAt);
    const key = getSetupKey(s);
    const isSelected = selectedSetups.has(key);
    const inList = savedList.has(key);

    // Calculate SL% and TP% from current price
    const currentPrice = s.currentPrice || 0;
    const stopPrice = s.stopPrice || 0;
    const tp1Price = s.tp1Price || 0;
    let slPercent = 0;
    let tpPercent = 0;
    if (currentPrice > 0) {
      if (s.direction === 'long') {
        // Long: SL is below entry, TP is above
        slPercent = ((currentPrice - stopPrice) / currentPrice) * 100;
        tpPercent = ((tp1Price - currentPrice) / currentPrice) * 100;
      } else {
        // Short: SL is above entry, TP is below
        slPercent = ((stopPrice - currentPrice) / currentPrice) * 100;
        tpPercent = ((currentPrice - tp1Price) / currentPrice) * 100;
      }
    }
    const rrRatio = slPercent > 0 ? (tpPercent / slPercent).toFixed(1) : '-';

    html += '<tr style="border-bottom: 1px solid #21262d;' + (inList ? ' background: #1c2128;' : '') + '">';
    html += '<td style="padding: 8px;"><input type="checkbox" data-setup-key="' + key + '" onclick="toggleSetupSelection(\'' + key + '\')" ' + (isSelected ? 'checked' : '') + ' style="cursor: pointer;">' + (inList ? '<span title="In list" style="color: #58a6ff; margin-left: 4px;">📋</span>' : '') + '</td>';
    html += '<td style="padding: 8px; font-weight: 600;"><a href="' + mexcUrl + '" target="_blank" style="color: #58a6ff; text-decoration: none;" title="' + linkTitle + '">' + ticker + '</a></td>';
    html += '<td style="padding: 8px; color: ' + dirColor + ';">' + dirIcon + ' ' + s.direction.toUpperCase() + '</td>';
    html += '<td style="padding: 8px; color: ' + stateColor + ';">' + s.state + '</td>';
    // Trade? column - V2: simplified, just needs actionable state (HTF/RSI filters removed)
    const isActionableState = s.state === 'triggered' || s.state === 'deep_extreme';
    let tradeHtml = '';
    if (isActionableState) {
      tradeHtml = '<span style="color: #3fb950;" title="Bots would trade: triggered or deep_extreme state">✓ YES</span>';
    } else {
      tradeHtml = '<span style="color: #6e7681;" title="Bots skip: state=' + s.state + ' (need triggered/deep_extreme)">✗ ' + s.state + '</span>';
    }
    html += '<td style="padding: 8px; text-align: center; font-size: 10px;">' + tradeHtml + '</td>';
    // SL%, TP%, R:R columns for manual trading
    html += '<td style="padding: 8px; text-align: right; color: #f85149; font-weight: 600;">' + slPercent.toFixed(1) + '%</td>';
    html += '<td style="padding: 8px; text-align: right; color: #3fb950; font-weight: 600;">' + tpPercent.toFixed(1) + '%</td>';
    const rrColor = parseFloat(rrRatio) >= 2 ? '#3fb950' : parseFloat(rrRatio) >= 1 ? '#d29922' : '#f85149';
    html += '<td style="padding: 8px; text-align: right; color: ' + rrColor + '; font-weight: 600;">' + rrRatio + '</td>';
    // Entry price (current price they would enter at)
    html += '<td style="padding: 8px; text-align: right; color: #8b949e;">' + (currentPrice ? currentPrice.toFixed(6) : '-') + '</td>';
    html += '<td style="padding: 8px; text-align: right; color: #8b949e;">' + lastUpdated + '</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

function renderSavedListTable(setups) {
  if (!setups || setups.length === 0) {
    return '<div class="empty-state">No setups in your saved list. Select setups and click "+ Add to List"</div>';
  }

  // Use shared getMexcUrl function (respects settings)

  let html = '<table style="width: 100%; border-collapse: collapse; font-size: 12px;">';
  html += '<thead><tr style="border-bottom: 1px solid #30363d;">';
  html += '<th style="width: 30px; padding: 8px;"></th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Symbol</th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Type</th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">Dir</th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">TF</th>';
  html += '<th style="text-align: left; padding: 8px; color: #8b949e;">State</th>';
  html += '<th style="text-align: right; padding: 8px; color: #8b949e;">Updated</th>';
  html += '</tr></thead><tbody>';

  for (const s of setups) {
    const dirColor = s.direction === 'long' ? '#3fb950' : '#f85149';
    const dirIcon = s.direction === 'long' ? '📈' : '📉';
    const stateColor = s.state === 'triggered' ? '#3fb950' :
                       s.state === 'deep_extreme' ? '#f0883e' :
                       s.state === 'reversing' ? '#58a6ff' : '#8b949e';
    const ticker = s.symbol.replace('USDT', '');
    const mexcUrl = getMexcUrl(s.symbol);
    const linkTitle = appSettings.linkDestination === 'bots' ? 'Open MEXC Trading Bots' : 'Open MEXC Futures';
    const lastUpdated = formatTimeAgo(s.lastUpdated || s.detectedAt);
    const key = getSetupKey(s);
    const isSelected = selectedSetups.has(key);
    const isGP = 'fibLevels' in s;

    html += '<tr style="border-bottom: 1px solid #21262d;">';
    html += '<td style="padding: 8px;"><input type="checkbox" data-setup-key="' + key + '" onclick="toggleSetupSelection(\'' + key + '\')" ' + (isSelected ? 'checked' : '') + ' style="cursor: pointer;"></td>';
    html += '<td style="padding: 8px; font-weight: 600;"><a href="' + mexcUrl + '" target="_blank" style="color: #58a6ff; text-decoration: none;" title="' + linkTitle + '">' + ticker + '</a></td>';
    html += '<td style="padding: 8px; color: ' + (isGP ? '#f0883e' : '#8b949e') + ';">' + (isGP ? '🎯 GP' : '🔥 BB') + '</td>';
    html += '<td style="padding: 8px; color: ' + dirColor + ';">' + dirIcon + ' ' + s.direction.toUpperCase() + '</td>';
    html += '<td style="padding: 8px;">' + s.timeframe + '</td>';
    html += '<td style="padding: 8px; color: ' + stateColor + ';">' + s.state + '</td>';
    html += '<td style="padding: 8px; text-align: right; color: #8b949e;">' + lastUpdated + '</td>';
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

// Browser notification helper
async function showBrowserNotification(title, body, tag) {
  // Check if notifications are enabled in settings
  if (!notificationsEnabled) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    // Try to request permission
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
  }
  try {
    new Notification(title, { body, tag, requireInteraction: false });
  } catch (e) {
    console.error('Notification error:', e);
  }
}

async function toggleBot(bot) {
  const newVisible = !botVisibility[bot];
  try {
    await fetch('/api/toggle-bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, visible: newVisible })
    });
    botVisibility[bot] = newVisible;
    updateBotVisibility();
  } catch (err) {
    console.error('Failed to toggle bot:', err);
  }
}

async function resetBots() {
  if (!confirm('Reset all paper trading bots to $' + currentInvestmentAmount + '? This will clear all positions and history.')) return;
  try {
    await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  } catch (err) {
    console.error('Failed to reset bots:', err);
  }
}

function updateBotVisibility() {
  // Helper to safely set display on elements
  const setDisplay = (ids, display) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = display;
    });
  };

  // Helper to update toggle button style
  const setToggle = (toggleId, active, color) => {
    const toggle = document.getElementById(toggleId);
    if (toggle) {
      toggle.style.opacity = active ? '1' : '0.5';
      const indicator = toggle.querySelector('.toggle-indicator');
      if (indicator) indicator.style.background = active ? color : '#30363d';
    }
  };

  // Fixed TP/SL bot (green)
  setDisplay(['fixedTPCard'], botVisibility.fixedTP ? 'block' : 'none');
  setToggle('toggleFixedTP', botVisibility.fixedTP, '#3fb950');

  // Fixed BE bot (lighter green)
  setDisplay(['fixedBECard'], botVisibility.fixedBE ? 'block' : 'none');
  setToggle('toggleFixedBE', botVisibility.fixedBE, '#2ea043');

  // Trailing 1% bot (purple)
  setDisplay(['trailing1pctCard'], botVisibility.trailing1pct ? 'block' : 'none');
  setToggle('toggleTrailing1pct', botVisibility.trailing1pct, '#a371f7');

  // Trailing 10% 10x bot (orange)
  setDisplay(['trailing10pct10xCard'], botVisibility.trailing10pct10x ? 'block' : 'none');
  setToggle('toggleTrailing10pct10x', botVisibility.trailing10pct10x, '#d29922');

  // Trailing 10% 20x bot (red)
  setDisplay(['trailing10pct20xCard'], botVisibility.trailing10pct20x ? 'block' : 'none');
  setToggle('toggleTrailing10pct20x', botVisibility.trailing10pct20x, '#f85149');

  // Trail Wide bot (blue)
  setDisplay(['trailWideCard'], botVisibility.trailWide ? 'block' : 'none');
  setToggle('toggleTrailWide', botVisibility.trailWide, '#58a6ff');

  // Confluence bot (cyan)
  setDisplay(['confluenceCard'], botVisibility.confluence ? 'block' : 'none');
  setToggle('toggleConfluence', botVisibility.confluence, '#39d4e8');

  // BTC Extreme bot (orange)
  setDisplay(['btcExtremeCard'], botVisibility.btcExtreme ? 'block' : 'none');
  setToggle('toggleBtcExtreme', botVisibility.btcExtreme, '#ff6b35');

  // BTC Trend bot (teal)
  setDisplay(['btcTrendCard'], botVisibility.btcTrend ? 'block' : 'none');
  setToggle('toggleBtcTrend', botVisibility.btcTrend, '#00d4aa');

  // Trend Override bot (magenta)
  setDisplay(['trendOverrideCard'], botVisibility.trendOverride ? 'block' : 'none');
  setToggle('toggleTrendOverride', botVisibility.trendOverride, '#e040fb');

  // Trend Flip bot (cyan)
  setDisplay(['trendFlipCard'], botVisibility.trendFlip ? 'block' : 'none');
  setToggle('toggleTrendFlip', botVisibility.trendFlip, '#00bcd4');

  // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md
}

function updateUI(state) {
  // Store state for history modal
  lastState = state;

  // Sync bot visibility from server
  if (state.botVisibility) {
    botVisibility = state.botVisibility;
    updateBotVisibility();
  }

  // Update symbol count
  document.getElementById('symbolCount').textContent = state.meta.eligibleSymbols + ' symbols';

  // Update status
  document.getElementById('statusDot').className = 'status-dot ' + (state.meta.isRunning ? 'active' : 'inactive');
  document.getElementById('statusText').textContent = state.meta.status;

  // Store setups data and update tab counts
  allSetupsData = {
    all: state.setups.all,
    active: state.setups.active,
    playedOut: state.setups.playedOut,
    history: state.setups.history || [],
    goldenPocket: state.setups.goldenPocket || [],
  };
  document.getElementById('activeCount').textContent = state.setups.active.filter(s => s.signalClassification !== 'momentum_exhaustion').length;
  document.getElementById('playedOutCount').textContent = state.setups.playedOut.length;
  document.getElementById('historyCount').textContent = (state.setups.history || []).length;
  document.getElementById('allCount').textContent = state.setups.all.length;
  // V2: Show only 5m timeframe GP setups in count
  document.getElementById('gpCount').textContent = (state.setups.goldenPocket || []).filter(s => GP_ALLOWED_TIMEFRAMES.includes(s.timeframe)).length;
  // Update saved list count (depends on current data, not just localStorage keys)
  updateSavedListCount();

  // Render setups table based on current tab
  renderSetupsWithTab();

  // Update Fixed TP/SL bot stats (Bot 1)
  const fixedStats = state.fixedTPBot.stats;
  const fixedUnreal = state.fixedTPBot.unrealizedPnL;
  document.getElementById('fixedBalance').textContent = formatCurrency(fixedStats.currentBalance);
  const fixedPnL = document.getElementById('fixedPnL');
  fixedPnL.textContent = formatCurrency(fixedStats.totalPnL);
  fixedPnL.className = fixedStats.totalPnL >= 0 ? 'positive' : 'negative';
  const fixedUnrealEl = document.getElementById('fixedUnrealPnL');
  fixedUnrealEl.textContent = formatCurrency(fixedUnreal);
  fixedUnrealEl.className = fixedUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('fixedWinRate').textContent = fixedStats.winRate.toFixed(0) + '%';
  document.getElementById('fixedTrades').textContent = fixedStats.totalTrades;
  document.getElementById('fixedCosts').textContent = formatCurrency(fixedStats.totalExecutionCosts || 0);

  // Update Fixed BE bot stats (Bot 1b)
  if (state.fixedBEBot) {
    const fixedBEStats = state.fixedBEBot.stats;
    const fixedBEUnreal = state.fixedBEBot.unrealizedPnL;
    document.getElementById('fixedBEBalance').textContent = formatCurrency(fixedBEStats.currentBalance);
    const fixedBEPnL = document.getElementById('fixedBEPnL');
    fixedBEPnL.textContent = formatCurrency(fixedBEStats.totalPnL);
    fixedBEPnL.className = fixedBEStats.totalPnL >= 0 ? 'positive' : 'negative';
    const fixedBEUnrealEl = document.getElementById('fixedBEUnrealPnL');
    fixedBEUnrealEl.textContent = formatCurrency(fixedBEUnreal);
    fixedBEUnrealEl.className = fixedBEUnreal >= 0 ? 'positive' : 'negative';
    document.getElementById('fixedBEWinRate').textContent = fixedBEStats.winRate.toFixed(0) + '%';
    document.getElementById('fixedBETrades').textContent = fixedBEStats.totalTrades;
    document.getElementById('fixedBECosts').textContent = formatCurrency(fixedBEStats.totalExecutionCosts || 0);
  }

  // Update Trailing 1% bot stats (Bot 2)
  const trail1pctStats = state.trailing1pctBot.stats;
  const trail1pctUnreal = state.trailing1pctBot.unrealizedPnL;
  document.getElementById('trail1pctBalance').textContent = formatCurrency(trail1pctStats.currentBalance);
  const trail1pctPnL = document.getElementById('trail1pctPnL');
  trail1pctPnL.textContent = formatCurrency(trail1pctStats.totalPnL);
  trail1pctPnL.className = trail1pctStats.totalPnL >= 0 ? 'positive' : 'negative';
  const trail1pctUnrealEl = document.getElementById('trail1pctUnrealPnL');
  trail1pctUnrealEl.textContent = formatCurrency(trail1pctUnreal);
  trail1pctUnrealEl.className = trail1pctUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('trail1pctWinRate').textContent = trail1pctStats.winRate.toFixed(0) + '%';
  document.getElementById('trail1pctTrades').textContent = trail1pctStats.totalTrades;
  document.getElementById('trail1pctCosts').textContent = formatCurrency(trail1pctStats.totalExecutionCosts || 0);

  // Update Trailing 10% 10x bot stats (Bot 3)
  const trail10pct10xStats = state.trailing10pct10xBot.stats;
  const trail10pct10xUnreal = state.trailing10pct10xBot.unrealizedPnL;
  document.getElementById('trail10pct10xBalance').textContent = formatCurrency(trail10pct10xStats.currentBalance);
  const trail10pct10xPnL = document.getElementById('trail10pct10xPnL');
  trail10pct10xPnL.textContent = formatCurrency(trail10pct10xStats.totalPnL);
  trail10pct10xPnL.className = trail10pct10xStats.totalPnL >= 0 ? 'positive' : 'negative';
  const trail10pct10xUnrealEl = document.getElementById('trail10pct10xUnrealPnL');
  trail10pct10xUnrealEl.textContent = formatCurrency(trail10pct10xUnreal);
  trail10pct10xUnrealEl.className = trail10pct10xUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('trail10pct10xWinRate').textContent = trail10pct10xStats.winRate.toFixed(0) + '%';
  document.getElementById('trail10pct10xTrades').textContent = trail10pct10xStats.totalTrades;
  document.getElementById('trail10pct10xCosts').textContent = formatCurrency(trail10pct10xStats.totalExecutionCosts || 0);

  // Update Trailing 10% 20x bot stats (Bot 4)
  const trail10pct20xStats = state.trailing10pct20xBot.stats;
  const trail10pct20xUnreal = state.trailing10pct20xBot.unrealizedPnL;
  document.getElementById('trail10pct20xBalance').textContent = formatCurrency(trail10pct20xStats.currentBalance);
  const trail10pct20xPnL = document.getElementById('trail10pct20xPnL');
  trail10pct20xPnL.textContent = formatCurrency(trail10pct20xStats.totalPnL);
  trail10pct20xPnL.className = trail10pct20xStats.totalPnL >= 0 ? 'positive' : 'negative';
  const trail10pct20xUnrealEl = document.getElementById('trail10pct20xUnrealPnL');
  trail10pct20xUnrealEl.textContent = formatCurrency(trail10pct20xUnreal);
  trail10pct20xUnrealEl.className = trail10pct20xUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('trail10pct20xWinRate').textContent = trail10pct20xStats.winRate.toFixed(0) + '%';
  document.getElementById('trail10pct20xTrades').textContent = trail10pct20xStats.totalTrades;
  document.getElementById('trail10pct20xCosts').textContent = formatCurrency(trail10pct20xStats.totalExecutionCosts || 0);

  // Update Trail Wide bot stats (Bot 5)
  const trailWideStats = state.trailWideBot.stats;
  const trailWideUnreal = state.trailWideBot.unrealizedPnL;
  document.getElementById('trailWideBalance').textContent = formatCurrency(trailWideStats.currentBalance);
  const trailWidePnL = document.getElementById('trailWidePnL');
  trailWidePnL.textContent = formatCurrency(trailWideStats.totalPnL);
  trailWidePnL.className = trailWideStats.totalPnL >= 0 ? 'positive' : 'negative';
  const trailWideUnrealEl = document.getElementById('trailWideUnrealPnL');
  trailWideUnrealEl.textContent = formatCurrency(trailWideUnreal);
  trailWideUnrealEl.className = trailWideUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('trailWideWinRate').textContent = trailWideStats.winRate.toFixed(0) + '%';
  document.getElementById('trailWideTrades').textContent = trailWideStats.totalTrades;
  document.getElementById('trailWideCosts').textContent = formatCurrency(trailWideStats.totalExecutionCosts || 0);

  // Update Confluence bot stats (Bot 6)
  const confluenceStats = state.confluenceBot.stats;
  const confluenceUnreal = state.confluenceBot.unrealizedPnL;
  document.getElementById('confluenceBalance').textContent = formatCurrency(confluenceStats.currentBalance);
  const confluencePnL = document.getElementById('confluencePnL');
  confluencePnL.textContent = formatCurrency(confluenceStats.totalPnL);
  confluencePnL.className = confluenceStats.totalPnL >= 0 ? 'positive' : 'negative';
  const confluenceUnrealEl = document.getElementById('confluenceUnrealPnL');
  confluenceUnrealEl.textContent = formatCurrency(confluenceUnreal);
  confluenceUnrealEl.className = confluenceUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('confluenceWinRate').textContent = confluenceStats.winRate.toFixed(0) + '%';
  document.getElementById('confluenceTrades').textContent = confluenceStats.totalTrades;
  document.getElementById('confluenceCosts').textContent = formatCurrency(confluenceStats.totalExecutionCosts || 0);

  // Update BTC Extreme bot stats
  const btcExtremeStats = state.btcExtremeBot.stats;
  const btcExtremeUnreal = state.btcExtremeBot.unrealizedPnL;
  document.getElementById('btcExtremeBalance').textContent = formatCurrency(btcExtremeStats.currentBalance);
  const btcExtremePnL = document.getElementById('btcExtremePnL');
  btcExtremePnL.textContent = formatCurrency(btcExtremeStats.totalPnL);
  btcExtremePnL.className = btcExtremeStats.totalPnL >= 0 ? 'positive' : 'negative';
  const btcExtremeUnrealEl = document.getElementById('btcExtremeUnrealPnL');
  btcExtremeUnrealEl.textContent = formatCurrency(btcExtremeUnreal);
  btcExtremeUnrealEl.className = btcExtremeUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('btcExtremeWinRate').textContent = btcExtremeStats.winRate.toFixed(0) + '%';
  document.getElementById('btcExtremeTrades').textContent = btcExtremeStats.totalTrades;
  document.getElementById('btcExtremeCosts').textContent = formatCurrency(btcExtremeStats.totalExecutionCosts || 0);

  // Update BTC Trend bot stats (Bot 9)
  const btcTrendStats = state.btcTrendBot.stats;
  const btcTrendUnreal = state.btcTrendBot.unrealizedPnL;
  document.getElementById('btcTrendBalance').textContent = formatCurrency(btcTrendStats.currentBalance);
  const btcTrendPnL = document.getElementById('btcTrendPnL');
  btcTrendPnL.textContent = formatCurrency(btcTrendStats.totalPnL);
  btcTrendPnL.className = btcTrendStats.totalPnL >= 0 ? 'positive' : 'negative';
  const btcTrendUnrealEl = document.getElementById('btcTrendUnrealPnL');
  btcTrendUnrealEl.textContent = formatCurrency(btcTrendUnreal);
  btcTrendUnrealEl.className = btcTrendUnreal >= 0 ? 'positive' : 'negative';
  document.getElementById('btcTrendWinRate').textContent = btcTrendStats.winRate.toFixed(0) + '%';
  document.getElementById('btcTrendTrades').textContent = btcTrendStats.totalTrades;
  document.getElementById('btcTrendCosts').textContent = formatCurrency(btcTrendStats.totalExecutionCosts || 0);

  // Update Trend Override bot stats (Bot 10)
  if (state.trendOverrideBot) {
    const trendOverrideStats = state.trendOverrideBot.stats;
    const trendOverrideUnreal = state.trendOverrideBot.unrealizedPnL;
    document.getElementById('trendOverrideBalance').textContent = formatCurrency(trendOverrideStats.currentBalance);
    const trendOverridePnL = document.getElementById('trendOverridePnL');
    trendOverridePnL.textContent = formatCurrency(trendOverrideStats.totalPnL);
    trendOverridePnL.className = trendOverrideStats.totalPnL >= 0 ? 'positive' : 'negative';
    const trendOverrideUnrealEl = document.getElementById('trendOverrideUnrealPnL');
    trendOverrideUnrealEl.textContent = formatCurrency(trendOverrideUnreal);
    trendOverrideUnrealEl.className = trendOverrideUnreal >= 0 ? 'positive' : 'negative';
    document.getElementById('trendOverrideWinRate').textContent = trendOverrideStats.winRate.toFixed(0) + '%';
    document.getElementById('trendOverrideTrades').textContent = trendOverrideStats.totalTrades;
    document.getElementById('trendOverrideCosts').textContent = formatCurrency(trendOverrideStats.totalExecutionCosts || 0);
  }

  // Update Trend Flip bot stats (Bot 11)
  if (state.trendFlipBot) {
    const trendFlipStats = state.trendFlipBot.stats;
    const trendFlipUnreal = state.trendFlipBot.unrealizedPnL;
    document.getElementById('trendFlipBalance').textContent = formatCurrency(trendFlipStats.currentBalance);
    const trendFlipPnL = document.getElementById('trendFlipPnL');
    trendFlipPnL.textContent = formatCurrency(trendFlipStats.totalPnL);
    trendFlipPnL.className = trendFlipStats.totalPnL >= 0 ? 'positive' : 'negative';
    const trendFlipUnrealEl = document.getElementById('trendFlipUnrealPnL');
    trendFlipUnrealEl.textContent = formatCurrency(trendFlipUnreal);
    trendFlipUnrealEl.className = trendFlipUnreal >= 0 ? 'positive' : 'negative';
    document.getElementById('trendFlipWinRate').textContent = trendFlipStats.winRate.toFixed(0) + '%';
    document.getElementById('trendFlipTrades').textContent = trendFlipStats.totalTrades;
    document.getElementById('trendFlipCosts').textContent = formatCurrency(trendFlipStats.totalExecutionCosts || 0);
  }

  // BTC Bias V1 bots REMOVED - see data/archived/BTC_BIAS_V1_EXPERIMENT.md

  // Update MEXC Simulation bots stats (Bots 20-25)
  if (state.mexcSimBots) {
    const mexcKeyMap = {
      'mexc-aggressive': 'mexcAggressive',
      'mexc-aggressive-2cb': 'mexcAggressive2cb',
      'mexc-wide': 'mexcWide',
      'mexc-wide-2cb': 'mexcWide2cb',
      'mexc-standard': 'mexcStandard',
      'mexc-standard-05cb': 'mexcStandard05cb',
    };
    for (const [key, elementId] of Object.entries(mexcKeyMap)) {
      const bot = state.mexcSimBots[key];
      if (bot) {
        const balEl = document.getElementById(elementId + 'Balance');
        const pnlEl = document.getElementById(elementId + 'PnL');
        const winRateEl = document.getElementById(elementId + 'WinRate');
        const trailingEl = document.getElementById(elementId + 'Trailing');
        const posCountEl = document.getElementById(elementId + 'PositionCount');
        if (balEl) balEl.textContent = formatCurrency(bot.balance);
        // Show unrealized if there are open positions, otherwise realized
        const hasOpenPositions = bot.openPositions && bot.openPositions.length > 0;
        const displayPnL = hasOpenPositions ? (bot.unrealizedPnL || 0) : bot.stats.totalPnL;
        if (pnlEl) {
          pnlEl.textContent = formatCurrency(displayPnL);
          pnlEl.className = displayPnL >= 0 ? 'positive' : 'negative';
        }
        if (winRateEl) winRateEl.textContent = bot.stats.winRate.toFixed(0) + '%';
        if (trailingEl) trailingEl.textContent = bot.stats.trailingActivatedCount || 0;
        if (posCountEl) posCountEl.textContent = (bot.openPositions || []).length;
      }
    }
  }

  // Update Golden Pocket bots stats (Bots 26-29)
  if (state.goldenPocketBots) {
    const gpKeyMap = {
      'gp-conservative': 'gpConservative',
      'gp-standard': 'gpStandard',
      'gp-aggressive': 'gpAggressive',
      'gp-yolo': 'gpYolo',
    };
    for (const [key, elementId] of Object.entries(gpKeyMap)) {
      const bot = state.goldenPocketBots[key];
      if (bot) {
        const balEl = document.getElementById(elementId + 'Balance');
        const pnlEl = document.getElementById(elementId + 'PnL');
        const unrealEl = document.getElementById(elementId + 'UnrealPnL');
        const winRateEl = document.getElementById(elementId + 'WinRate');
        const tp1RateEl = document.getElementById(elementId + 'TP1Rate');
        const posCountEl = document.getElementById(elementId + 'PositionCount');
        if (balEl) balEl.textContent = formatCurrency(bot.balance);
        if (pnlEl) {
          pnlEl.textContent = formatCurrency(bot.stats.totalPnL);
          pnlEl.className = bot.stats.totalPnL >= 0 ? 'positive' : 'negative';
        }
        if (unrealEl) {
          unrealEl.textContent = formatCurrency(bot.unrealizedPnL || 0);
          unrealEl.className = (bot.unrealizedPnL || 0) >= 0 ? 'positive' : 'negative';
        }
        if (winRateEl) winRateEl.textContent = bot.stats.winRate.toFixed(0) + '%';
        if (tp1RateEl) tp1RateEl.textContent = (bot.stats.tp1HitRate || 0).toFixed(0) + '%';
        if (posCountEl) posCountEl.textContent = (bot.openPositions || []).length;
      }
    }
    // Update GP Account Equity values
    const gpEquityMap = {
      'gp-conservative': 'gpConsEquity',
      'gp-standard': 'gpStdEquity',
      'gp-aggressive': 'gpAggEquity',
      'gp-yolo': 'gpYoloEquity',
    };
    for (const [key, eqId] of Object.entries(gpEquityMap)) {
      const bot = state.goldenPocketBots[key];
      if (bot) {
        const equity = bot.balance + (bot.unrealizedPnL || 0);
        const eqEl = document.getElementById(eqId);
        if (eqEl) {
          eqEl.textContent = formatCurrency(equity);
          eqEl.style.color = equity >= 2000 ? '#3fb950' : '#f85149';
        }
      }
    }
  }

  // Update Golden Pocket V2 bots stats (Bots 30-33)
  if (state.goldenPocketBotsV2) {
    const gp2KeyMap = {
      'gp2-conservative': 'gp2Conservative',
      'gp2-standard': 'gp2Standard',
      'gp2-aggressive': 'gp2Aggressive',
      'gp2-yolo': 'gp2Yolo',
    };
    for (const [key, elementId] of Object.entries(gp2KeyMap)) {
      const bot = state.goldenPocketBotsV2[key];
      if (bot) {
        const balEl = document.getElementById(elementId + 'Balance');
        const pnlEl = document.getElementById(elementId + 'PnL');
        const unrealEl = document.getElementById(elementId + 'UnrealPnL');
        const winRateEl = document.getElementById(elementId + 'WinRate');
        const tp1RateEl = document.getElementById(elementId + 'TP1Rate');
        const posCountEl = document.getElementById(elementId + 'PositionCount');
        if (balEl) balEl.textContent = formatCurrency(bot.balance);
        if (pnlEl) {
          pnlEl.textContent = formatCurrency(bot.stats.totalPnL);
          pnlEl.className = bot.stats.totalPnL >= 0 ? 'positive' : 'negative';
        }
        if (unrealEl) {
          unrealEl.textContent = formatCurrency(bot.unrealizedPnL || 0);
          unrealEl.className = (bot.unrealizedPnL || 0) >= 0 ? 'positive' : 'negative';
        }
        if (winRateEl) winRateEl.textContent = bot.stats.winRate.toFixed(0) + '%';
        if (tp1RateEl) tp1RateEl.textContent = (bot.stats.tp1HitRate || 0).toFixed(0) + '%';
        if (posCountEl) posCountEl.textContent = (bot.openPositions || []).length;
      }
    }
  }

  // Update BTC Bias V2 bots stats (Bots 34-41)
  if (state.btcBiasBotsV2) {
    const biasV2KeyMap = {
      'bias-v2-20x10-trail': 'biasV220x10trail',
      'bias-v2-20x20-trail': 'biasV220x20trail',
      'bias-v2-10x10-trail': 'biasV210x10trail',
      'bias-v2-10x20-trail': 'biasV210x20trail',
      'bias-v2-20x10-hard': 'biasV220x10hard',
      'bias-v2-20x20-hard': 'biasV220x20hard',
      'bias-v2-10x10-hard': 'biasV210x10hard',
      'bias-v2-10x20-hard': 'biasV210x20hard',
    };
    for (const [key, elementId] of Object.entries(biasV2KeyMap)) {
      const bot = state.btcBiasBotsV2[key];
      if (bot) {
        const balEl = document.getElementById(elementId + 'Balance');
        const pnlEl = document.getElementById(elementId + 'PnL');
        const statusEl = document.getElementById(elementId + 'Status');
        if (balEl) balEl.textContent = formatCurrency(bot.balance);
        const displayPnL = bot.position ? bot.unrealizedPnL : bot.stats.totalPnL;
        if (pnlEl) {
          pnlEl.textContent = formatCurrency(displayPnL);
          pnlEl.className = displayPnL >= 0 ? 'positive' : 'negative';
        }
        if (statusEl) {
          if (bot.position) {
            const dir = bot.position.direction.toUpperCase();
            const roiPct = bot.position.marginUsed > 0 ? (bot.unrealizedPnL / bot.position.marginUsed * 100).toFixed(1) : '0';
            statusEl.innerHTML = '<span style="color: ' + (bot.position.direction === 'long' ? '#3fb950' : '#f85149') + ';">' + dir + ' ' + roiPct + '% ROI</span>';
          } else if (bot.isStoppedOut) {
            statusEl.innerHTML = '<span style="color: #f85149;">Stopped (' + (bot.stoppedOutDirection || '-') + ')</span>';
          } else {
            statusEl.innerHTML = '<span style="color: #8b949e;">No position</span>';
          }
        }
      }
    }
  }

  // Update Fixed TP/SL positions (Bot 1)
  document.getElementById('fixedPositionCount').textContent = state.fixedTPBot.openPositions.length;
  document.getElementById('fixedPositionsTable').innerHTML = renderPositionsTable(state.fixedTPBot.openPositions, 'fixed');

  // Update Fixed BE positions (Bot 1b)
  if (state.fixedBEBot) {
    document.getElementById('fixedBEPositionCount').textContent = state.fixedBEBot.openPositions.length;
    document.getElementById('fixedBEPositionsTable').innerHTML = renderPositionsTable(state.fixedBEBot.openPositions, 'fixed-be');
  }

  // Update Trailing 1% positions (Bot 2)
  document.getElementById('trail1pctPositionCount').textContent = state.trailing1pctBot.openPositions.length;
  document.getElementById('trail1pctPositionsTable').innerHTML = renderTrailingPositionsTable(state.trailing1pctBot.openPositions);

  // Update Trailing 10% 10x positions (Bot 3)
  document.getElementById('trail10pct10xPositionCount').textContent = state.trailing10pct10xBot.openPositions.length;
  document.getElementById('trail10pct10xPositionsTable').innerHTML = renderTrailingPositionsTable(state.trailing10pct10xBot.openPositions);

  // Update Trailing 10% 20x positions (Bot 4)
  document.getElementById('trail10pct20xPositionCount').textContent = state.trailing10pct20xBot.openPositions.length;
  document.getElementById('trail10pct20xPositionsTable').innerHTML = renderTrailingPositionsTable(state.trailing10pct20xBot.openPositions);

  // Update Trail Wide positions (Bot 5)
  document.getElementById('trailWidePositionCount').textContent = state.trailWideBot.openPositions.length;
  document.getElementById('trailWidePositionsTable').innerHTML = renderTrailingPositionsTable(state.trailWideBot.openPositions);

  // Update Confluence positions (Bot 6)
  document.getElementById('confluencePositionCount').textContent = state.confluenceBot.openPositions.length;
  document.getElementById('confluencePositionsTable').innerHTML = renderTrailingPositionsTable(state.confluenceBot.openPositions);
  // Update confluence active triggers display
  const triggers = state.confluenceBot.activeTriggers || [];
  const triggersBox = document.getElementById('confluenceTriggersBox');
  if (triggers.length > 0) {
    triggersBox.innerHTML = triggers.map(t =>
      '<span style="margin-right: 8px; color: ' + (t.hasConfluence ? '#a371f7' : '#6e7681') + ';">' +
      t.symbol.replace('USDT', '') + ' ' + t.direction.toUpperCase() + ' [' + t.timeframes.join(',') + ']' +
      (t.hasConfluence ? ' ✓' : '') + '</span>'
    ).join('');
  } else {
    triggersBox.innerHTML = 'Waiting for multi-TF triggers...';
  }

  // Update history counts (for badge display in buttons)
  document.getElementById('fixedHistoryCount').textContent = state.fixedTPBot.closedPositions.length;
  document.getElementById('trail1pctHistoryCount').textContent = state.trailing1pctBot.closedPositions.length;
  document.getElementById('trail10pct10xHistoryCount').textContent = state.trailing10pct10xBot.closedPositions.length;
  document.getElementById('trail10pct20xHistoryCount').textContent = state.trailing10pct20xBot.closedPositions.length;
  document.getElementById('trailWideHistoryCount').textContent = state.trailWideBot.closedPositions.length;
  document.getElementById('confluenceHistoryCount').textContent = state.confluenceBot.closedPositions.length;
  document.getElementById('btcExtremeHistoryCount').textContent = state.btcExtremeBot.closedPositions.length;
  document.getElementById('btcTrendHistoryCount').textContent = state.btcTrendBot.closedPositions.length;

  // Update BTC position counts and tables (these bots have single positions, not arrays)
  const btcPos = state.btcExtremeBot.position;
  document.getElementById('btcExtremePositionCount').textContent = btcPos ? '1' : '0';
  document.getElementById('btcExtremePositionTable').innerHTML = renderBtcExtremePosition(btcPos);

  const btcTrendPos = state.btcTrendBot.position;
  document.getElementById('btcTrendPositionCount').textContent = btcTrendPos ? '1' : '0';
  document.getElementById('btcTrendPositionTable').innerHTML = renderBtcTrendPosition(btcTrendPos);

  // Update Trend Override positions (Bot 10)
  if (state.trendOverrideBot) {
    document.getElementById('trendOverridePositionCount').textContent = state.trendOverrideBot.openPositions.length;
    document.getElementById('trendOverridePositionTable').innerHTML = renderTrailingPositionsTable(state.trendOverrideBot.openPositions);
    document.getElementById('trendOverrideHistoryCount').textContent = state.trendOverrideBot.closedPositions.length;
  }

  // Update Trend Flip positions (Bot 11)
  if (state.trendFlipBot) {
    document.getElementById('trendFlipPositionCount').textContent = state.trendFlipBot.openPositions.length;
    document.getElementById('trendFlipPositionTable').innerHTML = renderTrailingPositionsTable(state.trendFlipBot.openPositions);
    document.getElementById('trendFlipHistoryCount').textContent = state.trendFlipBot.closedPositions.length;
  }

  // Update GP Bot Cards (positions and history)
  if (state.goldenPocketBots) {
    const gpCardMap = {
      'gp-conservative': { posCount: 'gpConsCardPositionCount', posTable: 'gpConsPositionsTable', histCount: 'gpConsHistoryCount' },
      'gp-standard': { posCount: 'gpStdCardPositionCount', posTable: 'gpStdPositionsTable', histCount: 'gpStdHistoryCount' },
      'gp-aggressive': { posCount: 'gpAggCardPositionCount', posTable: 'gpAggPositionsTable', histCount: 'gpAggHistoryCount' },
      'gp-yolo': { posCount: 'gpYoloCardPositionCount', posTable: 'gpYoloPositionsTable', histCount: 'gpYoloHistoryCount' },
    };
    for (const [key, ids] of Object.entries(gpCardMap)) {
      const bot = state.goldenPocketBots[key];
      if (bot) {
        document.getElementById(ids.posCount).textContent = (bot.openPositions || []).length;
        document.getElementById(ids.posTable).innerHTML = renderGPPositionsTable(bot.openPositions || []);
        document.getElementById(ids.histCount).textContent = (bot.closedPositions || []).length;
      }
    }
  }

  // Update Experimental Shadow Bots
  if (state.experimentalBots) {
    updateExperimentalBots(state.experimentalBots);
  }

  // Update performance summary panel
  updatePerformanceSummary(state);
}

function formatCurrency(value) {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value) {
  const sign = value >= 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '-';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

// Update Experimental Shadow Bots display
function updateExperimentalBots(expBots) {
  // Map bot IDs to HTML element ID prefixes
  const botMap = {
    'exp-bb-sysB': 'expBbSysB',
    'exp-bb-sysB-contrarian': 'expBbSysBContrarian',
    'exp-gp-sysA': 'expGpSysA',
    'exp-gp-sysB': 'expGpSysB',
    'exp-gp-regime': 'expGpRegime',
    'exp-gp-sysB-contrarian': 'expGpSysBContrarian',
  };

  let totalPnl = 0;
  let totalTrades = 0;

  // Collect bot data for ranking
  const botData = [];
  for (const [botId, prefix] of Object.entries(botMap)) {
    const bot = expBots[botId];
    if (!bot) continue;

    const stats = bot.stats || {};
    const balance = bot.balance || 2000;
    const unrealPnl = bot.unrealizedPnl || 0;
    const pnl = parseFloat(stats.totalPnl) || 0;
    const trades = stats.totalTrades || 0;
    const winRate = stats.winRate || '0%';
    const positions = (bot.openPositions || []).length;

    totalPnl += pnl;
    totalTrades += trades;

    botData.push({ botId, prefix, balance, unrealPnl, pnl, trades, winRate, positions });
  }

  // Sort by P&L descending
  botData.sort((a, b) => b.pnl - a.pnl);

  // Update DOM elements with rank
  for (let i = 0; i < botData.length; i++) {
    const { botId, prefix, balance, unrealPnl, pnl, trades, winRate, positions } = botData[i];
    const rank = i + 1;

    // Update DOM elements
    const balEl = document.getElementById(prefix + 'Balance');
    const pnlEl = document.getElementById(prefix + 'PnL');
    const unrealEl = document.getElementById(prefix + 'Unreal');
    const winRateEl = document.getElementById(prefix + 'WinRate');
    const tradesEl = document.getElementById(prefix + 'Trades');
    const posEl = document.getElementById(prefix + 'Positions');
    const rankEl = document.getElementById(prefix + 'Rank');

    if (balEl) balEl.textContent = formatCurrency(balance);
    if (pnlEl) {
      pnlEl.textContent = formatCurrency(pnl);
      pnlEl.className = pnl >= 0 ? 'positive' : 'negative';
    }
    if (unrealEl) {
      unrealEl.textContent = formatCurrency(unrealPnl);
      unrealEl.className = unrealPnl >= 0 ? 'positive' : 'negative';
    }
    if (winRateEl) winRateEl.textContent = winRate;
    if (tradesEl) tradesEl.textContent = trades;
    if (posEl) posEl.textContent = positions;

    // Update rank badge
    if (rankEl) {
      rankEl.textContent = rank === 1 ? '🏆 #1' : rank === 2 ? '🥈 #2' : rank === 3 ? '🥉 #3' : '#' + rank;
      rankEl.style.color = rank === 1 ? '#ffd700' : rank === 2 ? '#c0c0c0' : rank === 3 ? '#cd7f32' : '#6e7681';
    }
  }

  const bestBot = botData.length > 0 ? botData[0].botId : null;
  const bestPnl = botData.length > 0 ? botData[0].pnl : 0;

  // Update summary row
  const bestBotEl = document.getElementById('expBestBot');
  const bestPnlEl = document.getElementById('expBestPnL');
  const totalPnlEl = document.getElementById('expTotalPnL');
  const totalTradesEl = document.getElementById('expTotalTrades');

  if (bestBotEl && bestBot) {
    bestBotEl.textContent = bestBot;
  }
  if (bestPnlEl && bestBot) {
    bestPnlEl.textContent = formatCurrency(bestPnl);
    bestPnlEl.style.color = bestPnl >= 0 ? '#3fb950' : '#f85149';
  }
  if (totalPnlEl) {
    totalPnlEl.textContent = formatCurrency(totalPnl);
    totalPnlEl.style.color = totalPnl >= 0 ? '#3fb950' : '#f85149';
  }
  if (totalTradesEl) {
    totalTradesEl.textContent = totalTrades;
  }
}

function renderSetupsTable(setups, tabType) {
  if (setups.length === 0) {
    const msg = tabType === 'playedOut' ? 'No played out setups' :
                tabType === 'history' ? 'No removed setups in history' :
                tabType === 'all' ? 'No setups detected yet' : 'No active setups';
    return '<div class="empty-state">' + msg + '</div>';
  }

  // History tab has a 'Removed' column instead of 'Updated'
  const lastColHeader = tabType === 'history' ? 'Removed' : 'Updated';

  return '<table><thead><tr><th style="width: 30px;"></th><th>Mkt</th><th>Symbol</th><th>Dir</th><th>TF</th><th>State</th><th>RSI</th><th>HTF</th><th>Stop</th><th>Tier</th><th>Div</th><th>X-Sig</th><th>Price</th><th>Impulse</th><th>Triggered</th><th>' + lastColHeader + '</th></tr></thead><tbody>' +
    setups.map(s => {
      const stateClass = s.state === 'deep_extreme' ? 'deep' : s.state;
      const isExhaustion = s.signalClassification === 'momentum_exhaustion';
      const rowStyle = isExhaustion ? 'opacity: 0.45; background: #1c1c1c;' :
                        tabType === 'history' || s.state === 'played_out' ? 'opacity: 0.7;' : '';
      const impulseColor = s.impulsePercentMove >= 0 ? '#3fb950' : '#f85149';
      const impulseSign = s.impulsePercentMove >= 0 ? '+' : '';
      const rsiColor = s.currentRSI < 30 ? '#f85149' : s.currentRSI > 70 ? '#3fb950' : s.currentRSI < 40 ? '#d29922' : s.currentRSI > 60 ? '#58a6ff' : '#c9d1d9';
      const lastColTime = tabType === 'history' ? formatTimeAgo(s.removedAt) : formatTimeAgo(s.lastUpdated || s.detectedAt);
      const key = getSetupKey(s);
      const isSelected = selectedSetups.has(key);
      const inList = savedList.has(key);
      // Divergence display
      let divHtml = '-';
      if (s.divergence && s.divergence.type) {
        const divConfig = {
          'bullish': { label: '⬆', color: '#3fb950' },
          'bearish': { label: '⬇', color: '#f85149' },
          'hidden_bullish': { label: '⬆H', color: '#58a6ff' },
          'hidden_bearish': { label: '⬇H', color: '#ff7b72' }
        };
        const cfg = divConfig[s.divergence.type];
        if (cfg) {
          const strengthDots = s.divergence.strength === 'strong' ? '●●●' : s.divergence.strength === 'moderate' ? '●●○' : '●○○';
          divHtml = '<span style="color: ' + cfg.color + '; cursor: help;" title="' + (s.divergence.description || s.divergence.type) + '">' + cfg.label + ' ' + strengthDots + '</span>';
        }
      }
      // Exhaustion classification (momentum exhaustion signals)
      let xSigHtml = '-';
      if (s.signalClassification === 'momentum_exhaustion') {
        if (s.exhaustionDirection === 'extended_long') {
          xSigHtml = '<span style="color: #f85149; cursor: help; font-weight: bold;" title="NOT A BACKBURNER — Momentum Exhaustion (Extended Long).\nCoin pumped hard and is now overbought. This is NOT a \'bounce to fade\' — it\'s a strong uptrend that\'s overextended.\nBots will NOT trade this. Watch for reversal SHORT when momentum fades.">⚠️ EXT↑</span>';
        } else if (s.exhaustionDirection === 'extended_short') {
          xSigHtml = '<span style="color: #3fb950; cursor: help; font-weight: bold;" title="NOT A BACKBURNER — Momentum Exhaustion (Extended Short).\nCoin dumped hard and is now oversold. This is NOT a \'dip to buy\' — it\'s a strong downtrend that\'s overextended.\nBots will NOT trade this. Watch for reversal LONG when selling exhausts.">⚠️ EXT↓</span>';
        }
      } else {
        // Fall back to cross-strategy signal for backburner setups
        const xSig = getCrossStrategySignal(s, false);
        if (xSig === 'align') {
          xSigHtml = '<span style="color: #3fb950; cursor: help;" title="GP signal aligns (same direction)">🎯✓</span>';
        } else if (xSig === 'conflict') {
          xSigHtml = '<span style="color: #f85149; cursor: help;" title="GP signal conflicts (opposite direction)">🎯✗</span>';
        } else if (xSig === 'mixed') {
          xSigHtml = '<span style="color: #d29922; cursor: help;" title="GP has both aligned and conflicting signals">🎯⚠</span>';
        }
      }
      const mexcUrl = getMexcUrl(s.symbol);
      const linkTitle = appSettings.linkDestination === 'bots' ? 'Open MEXC Trading Bots' : 'Open MEXC Futures';
      // TCG-compliant columns
      const htfHtml = s.htfConfirmed === undefined ? '<span style="color: #6e7681;" title="No HTF data available (e.g., 4H has no daily context). Bots will NOT auto-trade this.">?</span>' :
                      s.htfConfirmed ? '<span style="color: #3fb950;" title="Higher timeframe trend CONFIRMS this setup direction.\nTCG: 5m oversold marks hourly higher low; 1h oversold marks daily higher low.\nBots CAN trade this.">✓</span>' :
                      '<span style="color: #f85149;" title="Higher timeframe trend OPPOSES this setup direction.\nTCG requires HTF alignment. Bots will NOT trade this.">✗</span>';
      const stopHtml = s.structureStopPrice ? '<span style="font-family: monospace; font-size: 11px; color: #d29922;" title="Structure-based stop (below pullback low)">' + formatPrice(s.structureStopPrice) + '</span>' : '<span style="color: #6e7681;">-</span>';
      const tierLabel = s.positionTier === 2 ? 'T2' : 'T1';
      const tierColor = s.positionTier === 2 ? '#a371f7' : '#8b949e';
      const addIcon = s.canAddPosition ? '<span style="color: #3fb950; margin-left: 2px;" title="RSI still worsening - safe to add">+</span>' : '';
      const tierHtml = '<span style="color: ' + tierColor + '; font-weight: 600;" title="Position tier: ' + (s.positionTier === 2 ? 'Deep extreme (RSI < 20 or > 80)' : 'Standard (RSI < 30 or > 70)') + '>' + tierLabel + '</span>' + addIcon;
      return `<tr style="${rowStyle}${inList ? ' background: #1c2128;' : ''}">
        <td><input type="checkbox" data-setup-key="${key}" onclick="toggleSetupSelection('${key}')" ${isSelected ? 'checked' : ''} style="cursor: pointer;">${inList ? '<span title="In list" style="color: #58a6ff; margin-left: 4px;">📋</span>' : ''}</td>
        <td><span class="badge badge-${s.marketType}">${s.marketType === 'futures' ? 'F' : 'S'}</span></td>
        <td><a href="${mexcUrl}" target="_blank" style="color: #58a6ff; text-decoration: none;" title="${linkTitle}"><strong>${s.symbol.replace('USDT', '')}</strong></a><br><span style="font-size: 10px; color: #6e7681;">${s.coinName || ''}</span></td>
        <td>${isExhaustion ? '<span style="color: #6e7681; font-size: 9px; text-decoration: line-through;" title="Not a real setup — momentum exhaustion">' + s.direction.toUpperCase() + '</span>' : '<span class="badge badge-' + s.direction + '">' + s.direction.toUpperCase() + '</span>'}</td>
        <td>${s.timeframe}</td>
        <td><span class="badge badge-${stateClass}">${s.state.replace('_', ' ')}</span></td>
        <td style="font-weight: 600; color: ${rsiColor}">${s.currentRSI.toFixed(1)}</td>
        <td style="text-align: center;">${htfHtml}</td>
        <td>${stopHtml}</td>
        <td style="text-align: center;">${tierHtml}</td>
        <td style="font-size: 11px;">${divHtml}</td>
        <td style="font-size: 11px;">${xSigHtml}</td>
        <td style="font-family: monospace; font-size: 12px;">${formatPrice(s.currentPrice)}</td>
        <td style="color: ${impulseColor}; font-weight: 500;">${impulseSign}${s.impulsePercentMove?.toFixed(1) || '?'}%</td>
        <td style="color: #8b949e; font-size: 11px;">${formatTimeAgo(s.triggeredAt || s.detectedAt)}</td>
        <td style="color: #6e7681; font-size: 11px;">${lastColTime}</td>
      </tr>`;
    }).join('') +
    '</tbody></table>';
}

function formatPrice(price) {
  if (!price) return '-';
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  return price.toPrecision(4);
}

function renderPositionsTable(positions, botType) {
  if (positions.length === 0) return '<div class="empty-state">No open positions</div>';

  return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Entry</th><th>Current</th><th>P&L</th><th>TP/SL</th></tr></thead><tbody>' +
    positions.map(p => `<tr>
      <td><strong>${p.symbol.replace('USDT', '')}</strong></td>
      <td>${p.timeframe || '?'}</td>
      <td><span class="badge badge-${p.direction}">${p.direction.toUpperCase()}</span></td>
      <td>${p.entryPrice.toPrecision(5)}</td>
      <td>${p.currentPrice.toPrecision(5)}</td>
      <td class="pnl ${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">${formatCurrency(p.unrealizedPnL)} (${formatPercent(p.unrealizedPnLPercent)})</td>
      <td>${p.takeProfitPrice?.toPrecision(4) || '∞'} / ${p.stopLossPrice.toPrecision(4)}</td>
    </tr>`).join('') +
    '</tbody></table>';
}

function renderGPPositionsTable(positions) {
  if (!positions || positions.length === 0) return '<div class="empty-state">No open positions</div>';

  return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Margin</th><th>Entry</th><th>TP1</th><th>TP2</th><th>SL</th><th>P&L</th><th>Status</th></tr></thead><tbody>' +
    positions.map(p => {
      const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;
      const statusColor = p.tp1Closed ? '#8bc34a' : (p.status === 'open' ? '#58a6ff' : '#8b949e');
      const statusText = p.tp1Closed ? 'TP1 Hit' : (p.status === 'open' ? 'Open' : p.status);
      return `<tr>
        <td><strong>${p.symbol.replace('USDT', '')}</strong></td>
        <td>${p.timeframe || '?'}</td>
        <td><span class="badge badge-${p.direction}">${p.direction.toUpperCase()}</span></td>
        <td style="color: #8b949e; font-size: 11px;">${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">${p.leverage}x</span></td>
        <td>${p.entryPrice.toPrecision(5)}</td>
        <td style="color: #4caf50;">${p.tp1Price.toPrecision(5)}</td>
        <td style="color: #8bc34a;">${p.tp2Price.toPrecision(5)}</td>
        <td style="color: #f44336;">${p.stopPrice.toPrecision(5)}</td>
        <td class="pnl ${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(${formatPercent(returnOnMargin)} ROI)</span></td>
        <td style="color: ${statusColor}; font-weight: 600;">${statusText}</td>
      </tr>`;
    }).join('') +
    '</tbody></table>';
}

function renderTrailingPositionsTable(positions) {
  if (positions.length === 0) return '<div class="empty-state">No open positions</div>';

  return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th></tr></thead><tbody>' +
    positions.map(p => {
      const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
      const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
      // Calculate return on margin (ROI) - this is what MEXC shows
      const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;
      return `<tr>
        <td><strong>${p.symbol.replace('USDT', '')}</strong></td>
        <td>${p.timeframe || '?'}</td>
        <td><span class="badge badge-${p.direction}">${p.direction.toUpperCase()}</span></td>
        <td style="color: #8b949e; font-size: 11px;">${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">${p.leverage}x</span></td>
        <td>${p.entryPrice.toPrecision(5)}</td>
        <td>${p.currentPrice.toPrecision(5)}</td>
        <td class="pnl ${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(${formatPercent(returnOnMargin)} ROI)</span></td>
        <td style="color: ${trailColor}; font-weight: 600;">${trailText}</td>
        <td>${p.currentStopLossPrice.toPrecision(4)}</td>
      </tr>`;
    }).join('') +
    '</tbody></table>';
}

function renderHistoryTable(trades) {
  if (trades.length === 0) return '<div class="empty-state">No trade history</div>';

  return '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Reason</th></tr></thead><tbody>' +
    trades.map(t => `<tr>
      <td><strong>${t.symbol.replace('USDT', '')}</strong></td>
      <td>${t.timeframe || '?'}</td>
      <td><span class="badge badge-${t.direction}">${t.direction.toUpperCase()}</span></td>
      <td>${t.entryPrice.toPrecision(5)}</td>
      <td>${t.exitPrice?.toPrecision(5) || '-'}</td>
      <td class="pnl ${(t.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">${formatCurrency(t.realizedPnL || 0)} (${formatPercent(t.realizedPnLPercent || 0)})</td>
      <td>${t.exitReason || '-'}</td>
    </tr>`).join('') +
    '</tbody></table>';
}

function renderTrailingHistoryTable(trades) {
  if (trades.length === 0) return '<div class="empty-state">No trade history</div>';

  // Calculate cost summary
  const totalCosts = trades.reduce((sum, t) => sum + (t.totalCosts || 0), 0);
  const totalFees = trades.reduce((sum, t) => sum + (t.entryCosts || 0) + (t.exitCosts || 0), 0);
  const totalFunding = trades.reduce((sum, t) => sum + (t.fundingPaid || 0), 0);
  const totalPnL = trades.reduce((sum, t) => sum + (t.realizedPnL || 0), 0);
  const rawPnL = trades.reduce((sum, t) => sum + (t.rawPnL || (t.realizedPnL || 0) + (t.totalCosts || 0)), 0);

  const costsSummary = totalCosts > 0 ? `
    <div style="display: flex; gap: 16px; margin-bottom: 12px; padding: 10px; background: #0d1117; border-radius: 6px; font-size: 12px;">
      <div><span style="color: #8b949e;">Total Fees:</span> <span style="color: #f85149;">${formatCurrency(totalFees)}</span></div>
      <div><span style="color: #8b949e;">Funding:</span> <span style="color: #f85149;">${formatCurrency(totalFunding)}</span></div>
      <div><span style="color: #8b949e;">Total Costs:</span> <span style="color: #f85149;">${formatCurrency(totalCosts)}</span></div>
      <div><span style="color: #8b949e;">Net P&L:</span> <span class="${totalPnL >= 0 ? 'positive' : 'negative'}">${formatCurrency(totalPnL)}</span></div>
      <div><span style="color: #8b949e;">Costs/Gross:</span> <span style="color: #d29922;">${rawPnL > 0 ? ((totalCosts / rawPnL) * 100).toFixed(1) : 0}%</span></div>
    </div>` : '';

  return costsSummary + '<table><thead><tr><th>Symbol</th><th>TF</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Exit</th><th>Gross</th><th>Costs</th><th>Net P&L</th><th>Trail</th><th>Reason</th></tr></thead><tbody>' +
    trades.map(t => {
      const trailColor = t.trailLevel > 0 ? '#a371f7' : '#8b949e';
      // Calculate return on margin (ROI)
      const returnOnMargin = t.marginUsed > 0 ? ((t.realizedPnL || 0) / t.marginUsed) * 100 : 0;
      const grossPnL = t.rawPnL || (t.realizedPnL || 0) + (t.totalCosts || 0);
      const costs = t.totalCosts || 0;
      return `<tr>
        <td><strong>${t.symbol.replace('USDT', '')}</strong></td>
        <td>${t.timeframe || '?'}</td>
        <td><span class="badge badge-${t.direction}">${t.direction.toUpperCase()}</span></td>
        <td style="color: #8b949e; font-size: 11px;">${formatCurrency(t.marginUsed || 0)}<br><span style="font-size: 10px;">${t.leverage || '?'}x</span></td>
        <td>${t.entryPrice.toPrecision(5)}</td>
        <td>${t.exitPrice?.toPrecision(5) || '-'}</td>
        <td class="pnl ${grossPnL >= 0 ? 'positive' : 'negative'}" style="font-size: 11px;">${formatCurrency(grossPnL)}</td>
        <td style="color: #f85149; font-size: 11px;">${costs > 0 ? '-' + formatCurrency(costs) : '-'}</td>
        <td class="pnl ${(t.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">${formatCurrency(t.realizedPnL || 0)}<br><span style="font-size: 10px;">(${formatPercent(returnOnMargin)} ROI)</span></td>
        <td style="color: ${trailColor}; font-weight: 600;">L${t.trailLevel || 0}</td>
        <td>${t.exitReason || '-'}</td>
      </tr>`;
    }).join('') +
    '</tbody></table>';
}

function renderBtcExtremePosition(position) {
  if (!position) return '<div class="empty-state">No open position</div>';

  const p = position;
  const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
  const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
  const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;

  return '<table><thead><tr><th>Symbol</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th><th>Reason</th></tr></thead><tbody>' +
    `<tr>
      <td><strong>₿ BTC</strong></td>
      <td><span class="badge badge-${p.direction}">${p.direction.toUpperCase()}</span></td>
      <td style="color: #8b949e; font-size: 11px;">${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">50x</span></td>
      <td>${p.entryPrice.toPrecision(5)}</td>
      <td>${p.currentPrice.toPrecision(5)}</td>
      <td class="pnl ${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(${formatPercent(returnOnMargin)} ROI)</span></td>
      <td style="color: ${trailColor}; font-weight: 600;">${trailText}</td>
      <td>${p.currentStopLossPrice.toPrecision(4)}</td>
      <td style="font-size: 11px; color: #6e7681;">${p.openReason || '-'}</td>
    </tr>` +
    '</tbody></table>';
}

function renderBtcTrendPosition(position) {
  if (!position) return '<div class="empty-state">No open position</div>';

  const p = position;
  const trailColor = p.trailLevel > 0 ? '#a371f7' : '#8b949e';
  const trailText = p.trailLevel > 0 ? 'L' + p.trailLevel + ' (' + ((p.trailLevel - 1) * 10) + '%+)' : 'Not yet';
  const returnOnMargin = p.marginUsed > 0 ? (p.unrealizedPnL / p.marginUsed) * 100 : 0;

  return '<table><thead><tr><th>Symbol</th><th>Dir</th><th>Margin</th><th>Entry</th><th>Current</th><th>P&L</th><th>Trail</th><th>SL</th><th>Reason</th></tr></thead><tbody>' +
    `<tr>
      <td><strong>₿ BTC</strong></td>
      <td><span class="badge badge-${p.direction}">${p.direction.toUpperCase()}</span></td>
      <td style="color: #8b949e; font-size: 11px;">${formatCurrency(p.marginUsed)}<br><span style="font-size: 10px;">50x</span></td>
      <td>${p.entryPrice.toPrecision(5)}</td>
      <td>${p.currentPrice.toPrecision(5)}</td>
      <td class="pnl ${p.unrealizedPnL >= 0 ? 'positive' : 'negative'}">${formatCurrency(p.unrealizedPnL)}<br><span style="font-size: 10px;">(${formatPercent(returnOnMargin)} ROI)</span></td>
      <td style="color: ${trailColor}; font-weight: 600;">${trailText}</td>
      <td>${p.currentStopLossPrice.toPrecision(4)}</td>
      <td style="font-size: 11px; color: #00d4aa;">${p.openReason || '-'}</td>
    </tr>` +
    '</tbody></table>';
}

function renderBtcExtremeHistoryTable(trades) {
  if (trades.length === 0) return '<div class="empty-state">No trade history</div>';

  return '<table><thead><tr><th>Dir</th><th>Margin</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Trail</th><th>Open</th><th>Close</th></tr></thead><tbody>' +
    trades.map(t => {
      const trailColor = t.trailLevel > 0 ? '#a371f7' : '#8b949e';
      const returnOnMargin = t.marginUsed > 0 ? ((t.realizedPnL || 0) / t.marginUsed) * 100 : 0;
      return `<tr>
        <td><span class="badge badge-${t.direction}">${t.direction.toUpperCase()}</span></td>
        <td style="color: #8b949e; font-size: 11px;">${formatCurrency(t.marginUsed || 0)}<br><span style="font-size: 10px;">50x</span></td>
        <td>${t.entryPrice.toPrecision(5)}</td>
        <td>${t.exitPrice?.toPrecision(5) || '-'}</td>
        <td class="pnl ${(t.realizedPnL || 0) >= 0 ? 'positive' : 'negative'}">${formatCurrency(t.realizedPnL || 0)}<br><span style="font-size: 10px;">(${formatPercent(returnOnMargin)} ROI)</span></td>
        <td style="color: ${trailColor}; font-weight: 600;">L${t.trailLevel || 0}</td>
        <td style="font-size: 11px; color: #6e7681;">${t.openReason || '-'}</td>
        <td style="font-size: 11px; color: #6e7681;">${t.closeReason || '-'}</td>
      </tr>`;
    }).join('') +
    '</tbody></table>';
}

function formatMarketCap(mcap) {
  if (!mcap) return 'N/A';
  if (mcap >= 1e9) return '$' + (mcap / 1e9).toFixed(1) + 'B';
  if (mcap >= 1e6) return '$' + (mcap / 1e6).toFixed(0) + 'M';
  return '$' + (mcap / 1e3).toFixed(0) + 'K';
}

// Momentum indicator colors
const tfColors = {
  '4h': '#f85149',
  '1h': '#d29922',
  '15m': '#3fb950',
  '5m': '#58a6ff',
  '1m': '#a371f7',
};

// Current bias system tab ('A' or 'B')
let currentBiasTab = 'A';

function switchBiasTab(tab) {
  currentBiasTab = tab;
  const tabA = document.getElementById('tabSystemA');
  const tabB = document.getElementById('tabSystemB');
  const panelA = document.getElementById('biasSystemA');
  const panelB = document.getElementById('biasSystemB');

  if (tab === 'A') {
    tabA.style.color = '#58a6ff';
    tabA.style.borderBottomColor = '#58a6ff';
    tabB.style.color = '#8b949e';
    tabB.style.borderBottomColor = 'transparent';
    panelA.style.display = 'block';
    panelB.style.display = 'none';
  } else {
    tabA.style.color = '#8b949e';
    tabA.style.borderBottomColor = 'transparent';
    tabB.style.color = '#58a6ff';
    tabB.style.borderBottomColor = '#58a6ff';
    panelA.style.display = 'none';
    panelB.style.display = 'block';
    // Fetch System B data
    refreshSystemB();
  }
}

async function refreshSystemB() {
  try {
    const res = await fetch('/api/bias-system-b');
    const data = await res.json();
    if (data.success && data.systemB) {
      updateSystemBDisplay(data.systemB);
    }
  } catch (err) {
    console.error('Failed to fetch System B bias:', err);
  }
}

function updateSystemBDisplay(sb) {
  // Update main bias display
  const biasLabel = document.getElementById('marketBiasLabelB');
  const biasReason = document.getElementById('marketBiasReasonB');
  const biasScore = document.getElementById('marketBiasScoreB');
  const biasBox = document.getElementById('marketBiasBoxB');

  const biasColors = {
    'strong_long': '#3fb950',
    'long': '#56d364',
    'neutral': '#8b949e',
    'short': '#f85149',
    'strong_short': '#da3633',
  };
  const biasLabels = {
    'strong_long': '🟢 STRONG LONG',
    'long': '📈 LONG',
    'neutral': '⚖️ NEUTRAL',
    'short': '📉 SHORT',
    'strong_short': '🔴 STRONG SHORT',
  };

  biasLabel.textContent = biasLabels[sb.bias] || sb.bias.toUpperCase();
  biasLabel.style.color = biasColors[sb.bias] || '#8b949e';
  biasReason.textContent = sb.reason;
  biasScore.textContent = 'Score: ' + sb.score + ' | Confidence: ' + sb.confidence + '%';
  biasBox.style.borderColor = biasColors[sb.bias] || '#30363d';

  // Update individual indicators
  const indicatorMap = {
    'RSI Multi-TF': 'indRSI',
    'Funding Rate': 'indFunding',
    'Open Interest': 'indOI',
    'Premium/Discount': 'indPremium',
    'Momentum': 'indMomentum',
  };

  const signalColors = {
    'bullish': '#3fb950',
    'bearish': '#f85149',
    'neutral': '#8b949e',
  };
  const signalLabels = {
    'bullish': '📈 Bullish',
    'bearish': '📉 Bearish',
    'neutral': '➖ Neutral',
  };

  for (const ind of sb.indicators || []) {
    const boxId = indicatorMap[ind.name];
    if (!boxId) continue;
    const box = document.getElementById(boxId);
    if (!box) continue;

    const children = box.children;
    children[1].textContent = signalLabels[ind.signal] || ind.signal;
    children[1].style.color = signalColors[ind.signal] || '#8b949e';
    children[2].textContent = ind.description || '';
    box.style.borderColor = signalColors[ind.signal] || '#30363d';
  }

  // Update market data summary
  if (sb.marketData) {
    document.getElementById('mdPrice').textContent = '$' + (sb.marketData.price?.toLocaleString() || '-');
    document.getElementById('mdFunding').textContent = sb.marketData.fundingRate || '-';
    document.getElementById('mdOI').textContent = sb.marketData.openInterest?.toLocaleString() || '-';
    document.getElementById('mdChange').textContent = sb.marketData.priceChange24h || '-';
  }
}

async function refreshBtcRsi() {
  const btn = document.getElementById('refreshRsiBtn');
  btn.textContent = '...';
  btn.disabled = true;

  try {
    const res = await fetch('/api/btc-rsi');
    const data = await res.json();
    updateBtcSignalSummary(data);
    updateMarketBias(data);
    updateMomentumIndicators(data);

    // Also refresh System B if that tab is active
    if (currentBiasTab === 'B') {
      refreshSystemB();
    }
  } catch (err) {
    console.error('Failed to fetch BTC RSI:', err);
  } finally {
    btn.textContent = 'Refresh';
    btn.disabled = false;
  }
}

function updateMomentumIndicators(data) {
  if (!data.momentum) return;
  const m = data.momentum;

  // BTC Price and changes
  const priceEl = document.getElementById('btcCurrentPrice');
  const change1h = document.getElementById('btcChange1h');
  const change4h = document.getElementById('btcChange4h');
  const change24h = document.getElementById('btcChange24h');

  if (m.price) {
    priceEl.textContent = '$' + m.price.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  if (m.change1h !== undefined) {
    const pct = m.change1h.toFixed(2);
    change1h.textContent = '1h: ' + (m.change1h >= 0 ? '+' : '') + pct + '%';
    change1h.style.color = m.change1h >= 0 ? '#3fb950' : '#f85149';
  }
  if (m.change4h !== undefined) {
    const pct = m.change4h.toFixed(2);
    change4h.textContent = '4h: ' + (m.change4h >= 0 ? '+' : '') + pct + '%';
    change4h.style.color = m.change4h >= 0 ? '#3fb950' : '#f85149';
  }
  if (m.change24h !== undefined) {
    const pct = m.change24h.toFixed(2);
    change24h.textContent = '24h: ' + (m.change24h >= 0 ? '+' : '') + pct + '%';
    change24h.style.color = m.change24h >= 0 ? '#3fb950' : '#f85149';
  }

  // Volatility
  const volEl = document.getElementById('btcVolatility');
  const volLabel = document.getElementById('btcVolatilityLabel');
  if (m.atrPercent !== undefined) {
    volEl.textContent = m.atrPercent.toFixed(2) + '%';
    let volLevel = 'Normal';
    let volColor = '#8b949e';
    if (m.atrPercent > 3) { volLevel = 'HIGH'; volColor = '#f85149'; }
    else if (m.atrPercent > 2) { volLevel = 'Elevated'; volColor = '#d29922'; }
    else if (m.atrPercent < 1) { volLevel = 'Low'; volColor = '#3fb950'; }
    volLabel.textContent = volLevel;
    volLabel.style.color = volColor;
    volEl.style.color = volColor;
  }

  // Volume ratio
  const volRatioEl = document.getElementById('btcVolumeRatio');
  const volRatioLabel = document.getElementById('btcVolumeLabel');
  if (m.volumeRatio !== undefined) {
    volRatioEl.textContent = m.volumeRatio.toFixed(1) + 'x';
    let volStatus = 'Average';
    let volStatusColor = '#8b949e';
    if (m.volumeRatio > 2) { volStatus = 'High Activity'; volStatusColor = '#3fb950'; }
    else if (m.volumeRatio > 1.5) { volStatus = 'Above Avg'; volStatusColor = '#58a6ff'; }
    else if (m.volumeRatio < 0.5) { volStatus = 'Low Activity'; volStatusColor = '#d29922'; }
    volRatioLabel.textContent = volStatus;
    volRatioLabel.style.color = volStatusColor;
  }

  // Range position
  const rangeEl = document.getElementById('btcRangePosition');
  const rangeLabel = document.getElementById('btcRangeLabel');
  if (m.rangePosition !== undefined) {
    rangeEl.textContent = m.rangePosition.toFixed(0) + '%';
    let rangeStatus = 'Mid Range';
    let rangeColor = '#8b949e';
    if (m.rangePosition > 80) { rangeStatus = 'Near 24h High'; rangeColor = '#3fb950'; }
    else if (m.rangePosition < 20) { rangeStatus = 'Near 24h Low'; rangeColor = '#f85149'; }
    else if (m.rangePosition > 60) { rangeStatus = 'Upper Range'; rangeColor = '#58a6ff'; }
    else if (m.rangePosition < 40) { rangeStatus = 'Lower Range'; rangeColor = '#d29922'; }
    rangeLabel.textContent = rangeStatus;
    rangeLabel.style.color = rangeColor;
  }

  // Choppy market warning
  const choppyEl = document.getElementById('perfChoppyWarning');
  if (m.isChoppy) {
    choppyEl.style.display = 'block';
  } else {
    choppyEl.style.display = 'none';
  }
}

function updatePerformanceSummary(state) {
  // GP Bots performance - data is in state.goldenPocketBots['gp-xxx']
  let gpPnL = 0, gpWins = 0, gpLosses = 0;
  if (state.goldenPocketBots) {
    for (const key of Object.keys(state.goldenPocketBots)) {
      const bot = state.goldenPocketBots[key];
      if (bot && bot.stats) {
        gpPnL += bot.stats.totalPnL || 0;
        gpWins += bot.stats.winningTrades || 0;
        gpLosses += bot.stats.losingTrades || 0;
      }
    }
  }

  const gpPnLEl = document.getElementById('perfGpPnL');
  gpPnLEl.textContent = formatCurrency(gpPnL);
  gpPnLEl.style.color = gpPnL >= 0 ? '#3fb950' : '#f85149';
  document.getElementById('perfGpWinRate').textContent = gpWins + 'W / ' + gpLosses + 'L';

  // Trailing Bots performance - data is in state.trailing1pctBot, etc.
  let trailPnL = 0, trailWins = 0, trailLosses = 0;
  const trailBotKeys = ['trailing1pctBot', 'trailing10pct10xBot', 'trailing10pct20xBot', 'trailWideBot'];
  for (const key of trailBotKeys) {
    const botState = state[key];
    if (botState && botState.stats) {
      trailPnL += botState.stats.totalPnL || 0;
      trailWins += botState.stats.wins || 0;
      trailLosses += botState.stats.losses || 0;
    }
  }

  const trailPnLEl = document.getElementById('perfTrailPnL');
  trailPnLEl.textContent = formatCurrency(trailPnL);
  trailPnLEl.style.color = trailPnL >= 0 ? '#3fb950' : '#f85149';
  document.getElementById('perfTrailWinRate').textContent = trailWins + 'W / ' + trailLosses + 'L';

  // Active positions and unrealized PnL
  let activeCount = 0, unrealizedPnL = 0;

  // Count from GP bots
  if (state.goldenPocketBots) {
    for (const key of Object.keys(state.goldenPocketBots)) {
      const bot = state.goldenPocketBots[key];
      if (bot && bot.openPositions) {
        activeCount += bot.openPositions.length;
        for (const pos of bot.openPositions) {
          unrealizedPnL += pos.unrealizedPnL || 0;
        }
      }
    }
  }

  // Count from trailing bots
  for (const key of trailBotKeys) {
    const botState = state[key];
    if (botState && botState.openPositions) {
      activeCount += botState.openPositions.length;
      for (const pos of botState.openPositions) {
        unrealizedPnL += pos.unrealizedPnL || 0;
      }
    }
  }

  document.getElementById('perfActiveCount').textContent = activeCount;
  const unrealEl = document.getElementById('perfUnrealizedPnL');
  unrealEl.textContent = 'Unreal: ' + formatCurrency(unrealizedPnL);
  unrealEl.style.color = unrealizedPnL >= 0 ? '#3fb950' : unrealizedPnL < 0 ? '#f85149' : '#6e7681';

  // Setup counts
  const gpSetups = (state.setups?.goldenPocket || []).length;
  const bbSetups = (state.setups?.active || []).length;
  document.getElementById('perfGpSetups').textContent = gpSetups + ' active';
  document.getElementById('perfBbSetups').textContent = bbSetups + ' active';
}

function updateBtcSignalSummary(data) {
  const tfs = ['4h', '1h', '15m', '5m', '1m'];
  for (const tf of tfs) {
    const tfData = data.timeframes[tf];
    if (!tfData) continue;

    const signalEl = document.getElementById('signal' + tf);
    const rsiEl = document.getElementById('rsi' + tf);
    const divEl = document.getElementById('div' + tf);

    const signal = tfData.current.signal;
    const rsi = tfData.current.rsi;
    const sma = tfData.current.sma;
    const divergence = tfData.divergence;

    signalEl.textContent = signal === 'bullish' ? '▲ BULL' : signal === 'bearish' ? '▼ BEAR' : '— NEUT';
    signalEl.style.color = signal === 'bullish' ? '#3fb950' : signal === 'bearish' ? '#f85149' : '#8b949e';
    rsiEl.textContent = rsi.toFixed(1) + ' / ' + sma.toFixed(1);

    // Update divergence display
    if (divEl) {
      if (divergence && divergence.type) {
        const divConfig = {
          'bullish': { label: '⬆ BULL DIV', color: '#3fb950' },
          'bearish': { label: '⬇ BEAR DIV', color: '#f85149' },
          'hidden_bullish': { label: '⬆ H.BULL', color: '#58a6ff' },
          'hidden_bearish': { label: '⬇ H.BEAR', color: '#ff7b72' }
        };
        const cfg = divConfig[divergence.type];
        if (cfg) {
          const strengthIcon = divergence.strength === 'strong' ? '●●●' : divergence.strength === 'moderate' ? '●●○' : '●○○';
          divEl.textContent = cfg.label + ' ' + strengthIcon;
          divEl.style.color = cfg.color;
          divEl.title = divergence.description || '';
        } else {
          divEl.textContent = '-';
          divEl.style.color = '#6e7681';
          divEl.title = '';
        }
      } else {
        divEl.textContent = '-';
        divEl.style.color = '#6e7681';
        divEl.title = '';
      }
    }

    // Update box border based on signal
    const box = signalEl.closest('.signal-box');
    if (box) {
      box.style.borderColor = signal === 'bullish' ? '#238636' : signal === 'bearish' ? '#da3633' : '#30363d';
    }
  }
}

function updateMarketBias(data) {
  if (!data.marketBias) return;

  const { bias, score, reason } = data.marketBias;
  const biasBox = document.getElementById('marketBiasBox');
  const biasLabel = document.getElementById('marketBiasLabel');
  const biasReason = document.getElementById('marketBiasReason');
  const biasScore = document.getElementById('marketBiasScore');
  const biasAdvice = document.getElementById('marketBiasAdvice');

  // Set label and colors based on bias
  const biasConfig = {
    'strong_long': { label: 'STRONG LONG', color: '#3fb950', border: '#238636', icon: '🟢' },
    'long': { label: 'FAVOR LONGS', color: '#3fb950', border: '#238636', icon: '🟢' },
    'neutral': { label: 'NEUTRAL', color: '#8b949e', border: '#30363d', icon: '⚪' },
    'short': { label: 'FAVOR SHORTS', color: '#f85149', border: '#da3633', icon: '🔴' },
    'strong_short': { label: 'STRONG SHORT', color: '#f85149', border: '#da3633', icon: '🔴' },
  };

  const config = biasConfig[bias] || biasConfig['neutral'];

  biasLabel.textContent = config.icon + ' ' + config.label;
  biasLabel.style.color = config.color;
  biasBox.style.borderColor = config.border;
  biasReason.textContent = reason;
  biasScore.textContent = 'Bias Score: ' + (score > 0 ? '+' : '') + score + '%';

  // Generate trading advice
  let advice = '';
  if (bias === 'strong_long') {
    advice = '✅ Ideal conditions for LONG trades. All timeframes aligned bullish.';
  } else if (bias === 'long') {
    advice = '👍 Conditions favor LONG trades. Consider avoiding shorts.';
  } else if (bias === 'strong_short') {
    advice = '✅ Ideal conditions for SHORT trades. All timeframes aligned bearish.';
  } else if (bias === 'short') {
    advice = '👍 Conditions favor SHORT trades. Consider avoiding longs.';
  } else {
    advice = '⚠️ Mixed signals. Trade with caution or wait for clearer alignment.';
  }
  biasAdvice.textContent = advice;
  biasAdvice.style.color = bias.includes('long') ? '#3fb950' : bias.includes('short') ? '#f85149' : '#d29922';
}

// Load BTC RSI on page load
setTimeout(refreshBtcRsi, 1000);

// Auto-refresh every 30 seconds (faster for BTC bots)
setInterval(refreshBtcRsi, 30000);

// ============================================================
// MEXC Live Execution Queue Functions
// ============================================================

let mexcCurrentMode = 'dry_run';
let mexcConnectionActive = false;

// Test MEXC API connection
async function testMexcConnection() {
  const statusEl = document.getElementById('mexcConnectionStatus');
  const balanceEl = document.getElementById('mexcBalance');
  const availableEl = document.getElementById('mexcAvailable');

  statusEl.textContent = 'Testing...';
  statusEl.style.background = '#d29922';

  try {
    const response = await fetch('/api/mexc/test-connection');
    const data = await response.json();

    if (data.success) {
      mexcConnectionActive = true;
      statusEl.textContent = 'Connected';
      statusEl.style.background = '#238636';
      balanceEl.textContent = '$' + (data.balance || 0).toFixed(2);
      availableEl.textContent = '$' + (data.available || 0).toFixed(2);
      showToast('MEXC connection successful!', 'success');
    } else {
      mexcConnectionActive = false;
      statusEl.textContent = 'Error';
      statusEl.style.background = '#f85149';
      showToast('MEXC connection failed: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    mexcConnectionActive = false;
    statusEl.textContent = 'Offline';
    statusEl.style.background = '#6e7681';
    showToast('MEXC API error: ' + err.message, 'error');
  }
}

// Sync positions from MEXC
async function syncMexcPositions() {
  const posCountEl = document.getElementById('mexcPositionCount');
  const unrealEl = document.getElementById('mexcUnrealizedPnL');

  try {
    const response = await fetch('/api/mexc/positions');
    const data = await response.json();

    if (data.success) {
      const positions = data.positions || [];
      posCountEl.textContent = positions.length;

      let totalUnreal = 0;
      positions.forEach(p => totalUnreal += p.unrealized || 0);

      unrealEl.textContent = '$' + totalUnreal.toFixed(2);
      unrealEl.className = totalUnreal >= 0 ? 'positive' : 'negative';

      showToast('Synced ' + positions.length + ' positions from MEXC', 'success');
    } else {
      showToast('Failed to sync positions: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('Error syncing positions: ' + err.message, 'error');
  }
}

// Set execution mode
async function setMexcMode(mode) {
  if (mode === 'live' && !confirm('⚠️ WARNING: Live mode will execute REAL trades with REAL money on MEXC!\\n\\nAre you absolutely sure you want to enable live trading?')) {
    return;
  }

  const buttons = {
    dry_run: document.getElementById('mexcModeDryRun'),
    shadow: document.getElementById('mexcModeShadow'),
    live: document.getElementById('mexcModeLive')
  };

  const warningEl = document.getElementById('liveModeWarning');

  // Reset all buttons
  Object.values(buttons).forEach(btn => {
    btn.style.background = '#21262d';
    btn.style.borderColor = '#30363d';
    btn.style.color = '#8b949e';
  });

  // Highlight selected
  const selectedBtn = buttons[mode];
  if (mode === 'dry_run') {
    selectedBtn.style.background = '#238636';
    selectedBtn.style.borderColor = '#238636';
    selectedBtn.style.color = 'white';
  } else if (mode === 'shadow') {
    selectedBtn.style.background = '#6e40c9';
    selectedBtn.style.borderColor = '#6e40c9';
    selectedBtn.style.color = 'white';
  } else if (mode === 'live') {
    selectedBtn.style.background = '#f85149';
    selectedBtn.style.borderColor = '#f85149';
    selectedBtn.style.color = 'white';
  }

  // Show/hide live warning
  warningEl.style.display = mode === 'live' ? 'block' : 'none';

  mexcCurrentMode = mode;

  // Notify server
  try {
    const body = { mode };
    if (mode === 'live') {
      body.confirmLive = 'I_UNDERSTAND_THIS_USES_REAL_MONEY';
    }

    const response = await fetch('/api/mexc/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.success) {
      const modeNames = { dry_run: 'Dry Run', shadow: 'Shadow', live: 'LIVE' };
      showToast('Execution mode set to ' + modeNames[mode], mode === 'live' ? 'warning' : 'success');
    }
  } catch (err) {
    console.error('Failed to set MEXC mode:', err);
  }
}

// Refresh execution queue
async function refreshMexcQueue() {
  const queueTable = document.getElementById('mexcQueueTable');

  try {
    const response = await fetch('/api/mexc/queue');
    const data = await response.json();

    if (!data.queue || data.queue.length === 0) {
      queueTable.innerHTML = '<div style="padding: 20px; text-align: center; color: #6e7681; font-size: 12px;">No pending orders. When a bot signals a trade, it will appear here for execution.</div>';
      return;
    }

    let html = '<table style="width: 100%; font-size: 11px;">';
    html += '<thead style="background: #161b22;"><tr>';
    html += '<th style="padding: 6px 8px; text-align: left; color: #8b949e;">Time</th>';
    html += '<th style="padding: 6px 8px; text-align: left; color: #8b949e;">Bot</th>';
    html += '<th style="padding: 6px 8px; text-align: left; color: #8b949e;">Symbol</th>';
    html += '<th style="padding: 6px 8px; text-align: left; color: #8b949e;">Side</th>';
    html += '<th style="padding: 6px 8px; text-align: right; color: #8b949e;">Size</th>';
    html += '<th style="padding: 6px 8px; text-align: center; color: #8b949e;">Status</th>';
    html += '<th style="padding: 6px 8px; text-align: center; color: #8b949e;">Actions</th>';
    html += '</tr></thead><tbody>';

    data.queue.forEach((order, idx) => {
      const sideColor = order.side === 'long' ? '#3fb950' : '#f85149';
      const sideIcon = order.side === 'long' ? '🟢' : '🔴';
      const statusColors = {
        pending: '#d29922',
        executing: '#58a6ff',
        executed: '#238636',
        failed: '#f85149',
        cancelled: '#6e7681'
      };

      html += '<tr style="border-bottom: 1px solid #21262d;">';
      html += '<td style="padding: 6px 8px; color: #8b949e;">' + new Date(order.timestamp).toLocaleTimeString() + '</td>';
      html += '<td style="padding: 6px 8px; color: #c9d1d9;">' + order.bot + '</td>';
      html += '<td style="padding: 6px 8px; color: #58a6ff; font-weight: 600;">' + order.symbol + '</td>';
      html += '<td style="padding: 6px 8px; color: ' + sideColor + ';">' + sideIcon + ' ' + order.side.toUpperCase() + '</td>';
      html += '<td style="padding: 6px 8px; text-align: right; color: #c9d1d9;">$' + order.size.toFixed(0) + '</td>';
      html += '<td style="padding: 6px 8px; text-align: center;"><span style="padding: 2px 6px; border-radius: 4px; background: ' + statusColors[order.status] + '; color: white; font-size: 10px;">' + order.status + '</span></td>';
      html += '<td style="padding: 6px 8px; text-align: center;">';
      if (order.status === 'pending') {
        html += '<button onclick="executeQueuedOrder(' + idx + ')" style="padding: 2px 8px; border-radius: 4px; border: none; background: #238636; color: white; font-size: 10px; cursor: pointer; margin-right: 4px;">Execute</button>';
        html += '<button onclick="cancelQueuedOrder(' + idx + ')" style="padding: 2px 8px; border-radius: 4px; border: none; background: #f85149; color: white; font-size: 10px; cursor: pointer;">Cancel</button>';
      }
      html += '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
    queueTable.innerHTML = html;

  } catch (err) {
    queueTable.innerHTML = '<div style="padding: 20px; text-align: center; color: #f85149; font-size: 12px;">Error loading queue: ' + err.message + '</div>';
  }
}

// Clear all queued orders
async function clearMexcQueue() {
  if (!confirm('Clear all pending orders from the queue?')) {
    return;
  }

  try {
    await fetch('/api/mexc/queue/clear', { method: 'POST' });
    showToast('Queue cleared', 'success');
    refreshMexcQueue();
  } catch (err) {
    showToast('Error clearing queue: ' + err.message, 'error');
  }
}

// Execute a specific queued order
async function executeQueuedOrder(index) {
  if (mexcCurrentMode !== 'live') {
    showToast('Cannot execute - not in live mode', 'warning');
    return;
  }

  try {
    const response = await fetch('/api/mexc/queue/execute/' + index, { method: 'POST' });
    const data = await response.json();

    if (data.success) {
      showToast('Order executed successfully!', 'success');
    } else {
      showToast('Execution failed: ' + (data.error || 'Unknown error'), 'error');
    }

    refreshMexcQueue();
  } catch (err) {
    showToast('Error executing order: ' + err.message, 'error');
  }
}

// Cancel a specific queued order
async function cancelQueuedOrder(index) {
  try {
    await fetch('/api/mexc/queue/cancel/' + index, { method: 'POST' });
    showToast('Order cancelled', 'success');
    refreshMexcQueue();
  } catch (err) {
    showToast('Error cancelling order: ' + err.message, 'error');
  }
}

// Emergency close all positions
async function emergencyCloseAll() {
  if (!confirm('⚠️ EMERGENCY CLOSE\\n\\nThis will close ALL open positions on MEXC immediately.\\n\\nAre you sure?')) {
    return;
  }

  try {
    const response = await fetch('/api/mexc/emergency-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'CLOSE_ALL_NOW' })
    });

    const data = await response.json();

    if (data.success) {
      showToast('Emergency close executed: ' + data.closed + ' positions closed', 'warning');
      syncMexcPositions();
    } else {
      showToast('Emergency close failed: ' + (data.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('Error during emergency close: ' + err.message, 'error');
  }
}

// Helper: show toast notification
function showToast(message, type = 'info') {
  // Check if toast container exists, create if not
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; display: flex; flex-direction: column; gap: 8px;';
    document.body.appendChild(container);
  }

  const colors = {
    success: '#238636',
    error: '#f85149',
    warning: '#d29922',
    info: '#58a6ff'
  };

  const toast = document.createElement('div');
  toast.style.cssText = 'padding: 12px 16px; border-radius: 6px; background: #161b22; border: 1px solid ' + colors[type] + '; color: #c9d1d9; font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); animation: slideIn 0.3s ease;';
  toast.innerHTML = '<span style="color: ' + colors[type] + '; margin-right: 8px;">' + (type === 'success' ? '✓' : type === 'error' ? '✗' : type === 'warning' ? '⚠' : 'ℹ') + '</span>' + message;

  container.appendChild(toast);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Add CSS animation for toasts
const toastStyles = document.createElement('style');
toastStyles.textContent = '@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } } @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }';
document.head.appendChild(toastStyles);

// Initialize MEXC section on page load
setTimeout(() => {
  testMexcConnection();
  refreshMexcQueue();
}, 2000);

// Auto-refresh MEXC data every 30 seconds
setInterval(() => {
  if (mexcConnectionActive) {
    syncMexcPositions();
    refreshMexcQueue();
  }
}, 30000);
