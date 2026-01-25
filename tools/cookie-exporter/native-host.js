#!/usr/bin/env node
/**
 * Native Messaging Host for Cookie Exporter Chrome Extension
 *
 * This script receives cookie data from the Chrome extension and updates the .env file.
 * It communicates via stdin/stdout using Chrome's native messaging protocol.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');
const ENV_PATH = join(PROJECT_ROOT, '.env');
const LOG_PATH = join(PROJECT_ROOT, '.mexc-cookie-refresh.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    appendFileSync(LOG_PATH, logLine);
  } catch (e) {
    // Ignore log errors
  }
}

// Write a message to Chrome (native messaging protocol)
function writeMessage(message) {
  const json = JSON.stringify(message);
  const buffer = Buffer.alloc(4 + json.length);
  buffer.writeUInt32LE(json.length, 0);
  buffer.write(json, 4);
  process.stdout.write(buffer);
}

// Update .env file with new cookie values
function updateEnvFile(cookies) {
  let envContent = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';

  const cookieMap = {};
  for (const cookie of cookies) {
    cookieMap[cookie.name] = cookie.value;
  }

  const updates = {
    'MEXC_UC_TOKEN': cookieMap['uc_token'],
    'MEXC_U_ID': cookieMap['u_id'],
    'MEXC_FINGERPRINT': cookieMap['x-mxc-fingerprint'],
    'MEXC_UID_COOKIE': cookieMap['uc_token'], // Legacy alias
  };

  let updated = false;
  for (const [key, value] of Object.entries(updates)) {
    if (value) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
      updated = true;
    }
  }

  if (updated) {
    writeFileSync(ENV_PATH, envContent);
    log(`Updated .env with cookies: ${Object.keys(updates).filter(k => updates[k]).join(', ')}`);
  }

  return updated;
}

function processMessage(buffer) {
  if (buffer.length < 4) {
    log(`Error: message too short (${buffer.length} bytes)`);
    writeMessage({ success: false, error: 'Message too short' });
    process.exit(1);
  }

  // Read message length (first 4 bytes, little-endian)
  const messageLength = buffer.readUInt32LE(0);
  log(`Message length: ${messageLength}, buffer length: ${buffer.length}`);

  if (buffer.length < 4 + messageLength) {
    log(`Error: incomplete message (expected ${messageLength}, got ${buffer.length - 4})`);
    writeMessage({ success: false, error: 'Incomplete message' });
    process.exit(1);
  }

  // Parse JSON message
  const messageStr = buffer.slice(4, 4 + messageLength).toString('utf-8');
  log(`Received: ${messageStr.slice(0, 200)}...`);

  const message = JSON.parse(messageStr);

  if (message.action === 'cookies' && message.cookies) {
    const updated = updateEnvFile(message.cookies);
    writeMessage({ success: true, updated, count: message.cookies.length });
    log(`Processed ${message.cookies.length} cookies, updated=${updated}`);
  } else if (message.action === 'ping') {
    writeMessage({ success: true, pong: true });
    log('Responded to ping');
  } else {
    writeMessage({ success: false, error: 'Unknown action' });
    log(`Unknown action: ${message.action}`);
  }

  process.exit(0);
}

async function main() {
  log('Native host started, reading stdin...');

  let buffer = Buffer.alloc(0);
  let messageLength = null;

  process.stdin.on('readable', () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      buffer = Buffer.concat([buffer, chunk]);

      // Once we have 4 bytes, read the message length
      if (messageLength === null && buffer.length >= 4) {
        messageLength = buffer.readUInt32LE(0);
        log(`Expected message length: ${messageLength}`);
      }

      // Once we have the full message, process it
      if (messageLength !== null && buffer.length >= 4 + messageLength) {
        try {
          processMessage(buffer);
        } catch (error) {
          log(`Error processing message: ${error.message}`);
          writeMessage({ success: false, error: error.message });
          process.exit(1);
        }
      }
    }
  });

  process.stdin.on('error', (err) => {
    log(`stdin error: ${err.message}`);
    process.exit(1);
  });

  // Timeout after 30 seconds
  setTimeout(() => {
    log('Timeout waiting for message');
    writeMessage({ success: false, error: 'Timeout' });
    process.exit(1);
  }, 30000);
}

main();
