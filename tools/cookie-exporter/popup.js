let cookieData = null;

// Format relative time
function formatRelativeTime(timestamp) {
  if (!timestamp) return '-';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return new Date(timestamp).toLocaleDateString();
}

// Update status display
async function updateStatus() {
  const statusEl = document.getElementById('status');
  const lastRefreshEl = document.getElementById('lastRefresh');
  const cookieCountEl = document.getElementById('cookieCount');

  try {
    // Get stored status
    const data = await chrome.storage.local.get(['lastRefresh', 'lastCookieCount']);

    if (data.lastRefresh) {
      lastRefreshEl.textContent = formatRelativeTime(data.lastRefresh);
    }
    if (data.lastCookieCount) {
      cookieCountEl.textContent = data.lastCookieCount;
    }

    // Check for auth cookies
    const cookies = await chrome.cookies.getAll({ domain: '.mexc.com' });
    const hasAuth = cookies.some(c => c.name === 'uc_token' || c.name === 'u_id');

    if (hasAuth) {
      statusEl.textContent = 'Authenticated';
      statusEl.className = 'value success';
    } else {
      statusEl.textContent = 'Not logged in';
      statusEl.className = 'value warning';
    }
  } catch (error) {
    statusEl.textContent = 'Error';
    statusEl.className = 'value error';
  }
}

// Refresh cookies
async function refreshCookies() {
  const refreshBtn = document.getElementById('refreshBtn');
  const statusEl = document.getElementById('status');
  const copyBtn = document.getElementById('copyBtn');
  const output = document.getElementById('output');

  refreshBtn.disabled = true;
  refreshBtn.textContent = '⏳ Refreshing...';

  try {
    // Send message to background script
    const response = await chrome.runtime.sendMessage({ action: 'refresh' });

    if (response.success) {
      statusEl.textContent = 'Refreshed!';
      statusEl.className = 'value success';

      // Also get cookies for display
      const cookies = await chrome.cookies.getAll({ domain: '.mexc.com' });
      cookieData = JSON.stringify(cookies, null, 2);

      output.style.display = 'block';
      output.textContent = `${cookies.length} cookies fetched.\n\n`;

      // Show key cookies
      const keyCookies = cookies.filter(c =>
        ['uc_token', 'u_id', 'x-mxc-fingerprint'].includes(c.name)
      );
      for (const c of keyCookies) {
        output.textContent += `${c.name}: ${c.value.slice(0, 20)}...\n`;
      }

      if (response.nativeHostError) {
        output.textContent += `\n⚠️ Native host: ${response.nativeHostError}`;
      } else {
        output.textContent += `\n✅ Sent to trading system`;
      }

      copyBtn.style.display = 'block';
    } else {
      statusEl.textContent = response.error || 'Failed';
      statusEl.className = 'value error';
    }

    await updateStatus();
  } catch (error) {
    statusEl.textContent = 'Error';
    statusEl.className = 'value error';
    console.error('Refresh error:', error);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '🔄 Refresh Now';
  }
}

// Copy cookies to clipboard
async function copyToClipboard() {
  if (!cookieData) return;

  try {
    await navigator.clipboard.writeText(cookieData);

    const copyBtn = document.getElementById('copyBtn');
    const originalText = copyBtn.textContent;
    copyBtn.textContent = '✅ Copied!';
    setTimeout(() => {
      copyBtn.textContent = originalText;
    }, 2000);
  } catch (error) {
    console.error('Copy failed:', error);
  }
}

// Toggle auto-refresh
async function toggleAutoRefresh() {
  const checkbox = document.getElementById('autoRefresh');
  await chrome.runtime.sendMessage({
    action: 'setAutoRefresh',
    enabled: checkbox.checked
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  updateStatus();

  document.getElementById('refreshBtn').addEventListener('click', refreshCookies);
  document.getElementById('copyBtn').addEventListener('click', copyToClipboard);
  document.getElementById('autoRefresh').addEventListener('change', toggleAutoRefresh);

  // Check alarm status
  chrome.alarms.get('mexc_cookie_refresh', (alarm) => {
    document.getElementById('autoRefresh').checked = !!alarm;
  });
});
