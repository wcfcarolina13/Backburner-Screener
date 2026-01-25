/**
 * Background service worker for MEXC Cookie Exporter
 *
 * Handles:
 * - Periodic cookie refresh via alarms
 * - Native messaging to update .env file
 * - Badge updates to show status
 */

const NATIVE_HOST = 'com.backburner.cookie_exporter';
const ALARM_NAME = 'mexc_cookie_refresh';
const REFRESH_INTERVAL_MINUTES = 30;
const MEXC_DOMAIN = '.mexc.com';

// Get all MEXC cookies
async function getMexcCookies() {
  const cookies = await chrome.cookies.getAll({ domain: MEXC_DOMAIN });

  // Also get www.mexc.com cookies
  const wwwCookies = await chrome.cookies.getAll({ domain: 'www.mexc.com' });

  // Also get futures.mexc.com cookies
  const futuresCookies = await chrome.cookies.getAll({ domain: 'futures.mexc.com' });

  // Merge and deduplicate
  const allCookies = [...cookies];
  const existingNames = new Set(cookies.map(c => c.name + c.domain));

  for (const cookie of [...wwwCookies, ...futuresCookies]) {
    const key = cookie.name + cookie.domain;
    if (!existingNames.has(key)) {
      allCookies.push(cookie);
      existingNames.add(key);
    }
  }

  return allCookies;
}

// Send cookies to native host
async function sendToNativeHost(cookies) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        { action: 'cookies', cookies },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}

// Refresh cookies and send to native host
async function refreshCookies() {
  try {
    const cookies = await getMexcCookies();

    if (cookies.length === 0) {
      console.log('No MEXC cookies found');
      updateBadge('!', '#FFA500');
      return { success: false, error: 'No cookies found' };
    }

    // Check for auth cookies
    const hasAuth = cookies.some(c => c.name === 'uc_token' || c.name === 'u_id');
    if (!hasAuth) {
      console.log('No auth cookies found - user may need to log in');
      updateBadge('!', '#FFA500');
      return { success: false, error: 'No auth cookies - please log in to MEXC' };
    }

    // Try to send to native host
    try {
      const response = await sendToNativeHost(cookies);
      console.log('Native host response:', response);
      updateBadge('✓', '#4CAF50');

      // Store last refresh time
      await chrome.storage.local.set({
        lastRefresh: Date.now(),
        lastCookieCount: cookies.length
      });

      return { success: true, count: cookies.length, response };
    } catch (nativeError) {
      // Native host not available - that's OK, extension still works manually
      console.log('Native host not available:', nativeError.message);
      updateBadge(String(cookies.length), '#2196F3');
      return { success: true, count: cookies.length, nativeHostError: nativeError.message };
    }
  } catch (error) {
    console.error('Error refreshing cookies:', error);
    updateBadge('X', '#f44336');
    return { success: false, error: error.message };
  }
}

// Update extension badge
function updateBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Set up alarm for periodic refresh
async function setupAlarm() {
  // Clear any existing alarm
  await chrome.alarms.clear(ALARM_NAME);

  // Create new alarm
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 1, // First run in 1 minute
    periodInMinutes: REFRESH_INTERVAL_MINUTES
  });

  console.log(`Alarm set: refresh every ${REFRESH_INTERVAL_MINUTES} minutes`);
}

// Listen for alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log('Alarm triggered, refreshing cookies...');
    refreshCookies();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'refresh') {
    refreshCookies().then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (message.action === 'getStatus') {
    chrome.storage.local.get(['lastRefresh', 'lastCookieCount']).then(sendResponse);
    return true;
  }

  if (message.action === 'setAutoRefresh') {
    if (message.enabled) {
      setupAlarm().then(() => sendResponse({ success: true }));
    } else {
      chrome.alarms.clear(ALARM_NAME).then(() => sendResponse({ success: true }));
    }
    return true;
  }
});

// Initialize on install/update
chrome.runtime.onInstalled.addListener(() => {
  console.log('MEXC Cookie Exporter installed/updated');
  setupAlarm();
  // Do initial refresh after a short delay
  setTimeout(() => refreshCookies(), 2000);
});

// Also refresh on startup
chrome.runtime.onStartup.addListener(() => {
  console.log('Browser started, refreshing cookies...');
  setupAlarm();
  refreshCookies();
});
