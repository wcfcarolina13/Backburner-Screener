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

    // Also push cookie to Render if configured
    pushCookieToRender(envContent, updates['MEXC_UID_COOKIE']);
  }

  return updated;
}

// Push the updated cookie to Render deployment via API
function pushCookieToRender(envContent, cookieValue) {
  if (!cookieValue) return;

  // Read RENDER_API_KEY and RENDER_SERVICE_ID from the .env content
  const apiKeyMatch = envContent.match(/^RENDER_API_KEY=(.+)$/m);
  const serviceIdMatch = envContent.match(/^RENDER_SERVICE_ID=(.+)$/m);

  const apiKey = apiKeyMatch?.[1]?.trim();
  const serviceId = serviceIdMatch?.[1]?.trim();

  if (!apiKey || !serviceId) {
    log('Render push skipped: RENDER_API_KEY or RENDER_SERVICE_ID not configured');
    return;
  }

  log(`Pushing cookie to Render service ${serviceId}...`);

  // Use dynamic import for https (ESM compatible)
  import('https').then(({ default: https }) => {
    const data = JSON.stringify({ value: cookieValue });

    const req = https.request({
      hostname: 'api.render.com',
      path: `/v1/services/${serviceId}/env-vars/MEXC_UID_COOKIE`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`Render push success (${res.statusCode}): cookie updated`);
          // Trigger a deploy so the running service picks up the new env var
          // (restart alone does NOT load new env vars on Render)
          triggerRenderDeploy(https, apiKey, serviceId);
        } else {
          log(`Render push failed (${res.statusCode}): ${body}`);
        }
      });
    });

    req.on('error', (err) => {
      log(`Render push error: ${err.message}`);
    });

    req.write(data);
    req.end();
  }).catch((err) => {
    log(`Render push import error: ${err.message}`);
  });
}

// Trigger a new deploy on Render so it picks up the updated env var
function triggerRenderDeploy(https, apiKey, serviceId) {
  log(`Triggering Render deploy for service ${serviceId}...`);

  const req = https.request({
    hostname: 'api.render.com',
    path: `/v1/services/${serviceId}/deploys`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        log(`Render deploy triggered (${res.statusCode}): service will restart with new cookie`);
      } else {
        log(`Render deploy failed (${res.statusCode}): ${body}`);
      }
    });
  });

  req.on('error', (err) => {
    log(`Render deploy error: ${err.message}`);
  });

  req.end();
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
