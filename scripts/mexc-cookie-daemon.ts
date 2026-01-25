#!/usr/bin/env npx tsx
/**
 * MEXC Cookie Refresh Daemon
 *
 * Runs in the background and automatically refreshes the MEXC cookie before it expires.
 *
 * Setup (first time only):
 *   npx tsx scripts/mexc-cookie-daemon.ts --setup
 *   (This opens a browser for you to log in manually)
 *
 * Run daemon:
 *   npx tsx scripts/mexc-cookie-daemon.ts
 *
 * The daemon will:
 * 1. Check cookie validity every 30 minutes
 * 2. Refresh the browser session if needed
 * 3. Update .env with the new cookie
 * 4. Log all activity to .mexc-daemon.log
 */

import { chromium, BrowserContext } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');
const STATE_FILE = path.join(PROJECT_ROOT, '.mexc-browser-state.json');
const LOG_FILE = path.join(PROJECT_ROOT, '.mexc-daemon.log');

// How often to check/refresh (in minutes)
const CHECK_INTERVAL_MINUTES = 30;

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function getCookieFromContext(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies('https://futures.mexc.com');
  const uidCookie = cookies.find(c => c.name === 'u_id');
  return uidCookie?.value || null;
}

async function updateEnvFile(cookie: string) {
  let envContent = '';
  if (fs.existsSync(ENV_FILE)) {
    envContent = fs.readFileSync(ENV_FILE, 'utf8');
  }

  if (envContent.includes('MEXC_UID_COOKIE=')) {
    envContent = envContent.replace(/MEXC_UID_COOKIE=.*/g, `MEXC_UID_COOKIE=${cookie}`);
  } else {
    envContent += `\nMEXC_UID_COOKIE=${cookie}\n`;
  }

  fs.writeFileSync(ENV_FILE, envContent);
}

async function testCookie(cookie: string): Promise<boolean> {
  try {
    const { createMexcClient } = await import('../src/mexc-futures-client.js');
    const client = createMexcClient(cookie, false);
    const result = await client.getUsdtBalance();
    return result.success;
  } catch {
    return false;
  }
}

async function setupMode() {
  log('=== MEXC Cookie Daemon Setup ===');
  log('Opening browser for manual login...');
  log('');

  const browser = await chromium.launch({
    headless: false, // Show browser for login
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  await page.goto('https://futures.mexc.com');

  log('Please log in to MEXC in the browser window.');
  log('After logging in, the page should show the futures trading interface.');
  log('');
  log('Press Enter here when you are logged in...');

  // Wait for user input
  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
  });

  // Check for cookie
  const cookie = await getCookieFromContext(context);

  if (!cookie || !cookie.startsWith('WEB')) {
    log('❌ Could not find u_id cookie. Make sure you are logged in.');
    await browser.close();
    process.exit(1);
  }

  // Test the cookie
  log('Testing cookie...');
  const isValid = await testCookie(cookie);

  if (!isValid) {
    log('❌ Cookie test failed. Please try logging in again.');
    await browser.close();
    process.exit(1);
  }

  // Save browser state for future sessions
  await context.storageState({ path: STATE_FILE });
  log('✓ Browser state saved to ' + STATE_FILE);

  // Update .env
  await updateEnvFile(cookie);
  log('✓ Cookie saved to .env');

  await browser.close();

  log('');
  log('=== Setup Complete ===');
  log('You can now run the daemon:');
  log('  npx tsx scripts/mexc-cookie-daemon.ts');
  log('');
  log('Or run it in the background:');
  log('  nohup npx tsx scripts/mexc-cookie-daemon.ts > /dev/null 2>&1 &');
}

async function refreshCookie(): Promise<string | null> {
  log('Refreshing cookie...');

  if (!fs.existsSync(STATE_FILE)) {
    log('❌ No browser state found. Run with --setup first.');
    return null;
  }

  const browser = await chromium.launch({
    headless: true, // Run headless for background refresh
  });

  try {
    const context = await browser.newContext({
      storageState: STATE_FILE,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Navigate to futures page - this should refresh the session
    await page.goto('https://futures.mexc.com', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait a bit for cookies to be set
    await page.waitForTimeout(3000);

    // Get the cookie
    const cookie = await getCookieFromContext(context);

    if (!cookie || !cookie.startsWith('WEB')) {
      log('❌ No valid cookie found after refresh');

      // Save updated state anyway (might have partial session)
      await context.storageState({ path: STATE_FILE });
      await browser.close();
      return null;
    }

    // Test the cookie
    const isValid = await testCookie(cookie);

    if (!isValid) {
      log('❌ Cookie is invalid. Session may have expired. Run --setup again.');
      await browser.close();
      return null;
    }

    // Save updated state
    await context.storageState({ path: STATE_FILE });

    await browser.close();
    return cookie;
  } catch (error) {
    log(`❌ Error during refresh: ${error}`);
    await browser.close();
    return null;
  }
}

async function daemonLoop() {
  log('=== MEXC Cookie Daemon Started ===');
  log(`Checking every ${CHECK_INTERVAL_MINUTES} minutes`);

  while (true) {
    try {
      // Read current cookie
      let currentCookie = '';
      if (fs.existsSync(ENV_FILE)) {
        const envContent = fs.readFileSync(ENV_FILE, 'utf8');
        const match = envContent.match(/MEXC_UID_COOKIE=(.+)/);
        currentCookie = match?.[1] || '';
      }

      // Test current cookie
      const isValid = currentCookie ? await testCookie(currentCookie) : false;

      if (isValid) {
        log('✓ Cookie is valid');
      } else {
        log('⚠ Cookie invalid or expired, refreshing...');

        const newCookie = await refreshCookie();

        if (newCookie) {
          await updateEnvFile(newCookie);
          log('✓ Cookie refreshed and saved');
        } else {
          log('❌ Failed to refresh cookie. Manual intervention required.');
          log('   Run: npx tsx scripts/mexc-cookie-daemon.ts --setup');
        }
      }
    } catch (error) {
      log(`❌ Error in daemon loop: ${error}`);
    }

    // Wait for next check
    await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MINUTES * 60 * 1000));
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--setup')) {
    await setupMode();
  } else if (args.includes('--once')) {
    // Just refresh once and exit (useful for cron)
    const cookie = await refreshCookie();
    if (cookie) {
      await updateEnvFile(cookie);
      log('✓ Cookie refreshed');
      process.exit(0);
    } else {
      log('❌ Failed to refresh');
      process.exit(1);
    }
  } else {
    // Run daemon
    if (!fs.existsSync(STATE_FILE)) {
      log('No browser state found. Running setup first...');
      await setupMode();
    }
    await daemonLoop();
  }
}

main().catch(error => {
  log(`Fatal error: ${error}`);
  process.exit(1);
});
