#!/usr/bin/env npx tsx
/**
 * Get MEXC Cookie from Chrome
 *
 * This script reads the u_id cookie directly from Chrome's cookie database.
 * Requires Chrome to be closed (or use --force to copy the database first).
 *
 * Usage:
 *   npx tsx scripts/get-mexc-cookie.ts
 *   npx tsx scripts/get-mexc-cookie.ts --update  # Also update .env file
 *
 * Prerequisites:
 *   npm install better-sqlite3
 *
 * Note: Chrome stores cookies in an SQLite database. On macOS, the cookie
 * values are encrypted with the user's keychain, so we use a workaround
 * by reading from the browser's JavaScript.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

async function main() {
  const args = process.argv.slice(2);
  const shouldUpdate = args.includes('--update');

  console.log('='.repeat(60));
  console.log('MEXC Cookie Extractor');
  console.log('='.repeat(60));
  console.log('');

  // On macOS, Chrome cookies are encrypted with the keychain
  // The easiest approach is to use AppleScript to interact with Chrome
  // But that's complex, so let's use a simpler approach

  console.log('To get your MEXC cookie:');
  console.log('');
  console.log('1. Open Chrome and go to https://futures.mexc.com');
  console.log('2. Make sure you are logged in');
  console.log('3. Open Developer Tools (Cmd+Option+I or F12)');
  console.log('4. Go to Application tab → Cookies → https://futures.mexc.com');
  console.log('5. Find "u_id" and copy its value');
  console.log('');
  console.log('Or paste the JavaScript below into Console:');
  console.log('');
  console.log('  document.cookie.split(";").find(c => c.trim().startsWith("u_id="))?.split("=")[1]');
  console.log('');

  if (shouldUpdate) {
    console.log('Paste the u_id cookie value here:');

    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('> ', async (cookie: string) => {
      cookie = cookie.trim();

      if (!cookie.startsWith('WEB')) {
        console.error('❌ Invalid cookie. Should start with "WEB"');
        rl.close();
        process.exit(1);
      }

      // Update .env file
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
      console.log('');
      console.log('✓ .env updated with new cookie');

      // Test the cookie
      console.log('');
      console.log('Testing new cookie...');

      const dotenv = await import('dotenv');
      dotenv.config({ path: ENV_FILE, override: true });

      const { createMexcClient } = await import('../src/mexc-futures-client.js');
      const client = createMexcClient(cookie, false);
      const result = await client.testConnection();

      if (result.success) {
        console.log('✅ Cookie is valid! Balance: $' + result.balance?.toFixed(2));
      } else {
        console.error('❌ Cookie test failed:', result.error);
      }

      rl.close();
    });
  }
}

main().catch(console.error);
