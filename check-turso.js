import { createClient } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function check() {
  // Check tables
  console.log('=== TABLES ===');
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
  console.log(tables.rows);

  // Check trades table structure
  console.log('\n=== TRADES TABLE SCHEMA ===');
  try {
    const schema = await client.execute("PRAGMA table_info(trades)");
    console.log(schema.rows);
  } catch (e) {
    console.log('No trades table');
  }

  // Check trade_events table structure
  console.log('\n=== TRADE_EVENTS TABLE SCHEMA ===');
  try {
    const schema = await client.execute("PRAGMA table_info(trade_events)");
    console.log(schema.rows);
  } catch (e) {
    console.log('No trade_events table');
  }

  // Recent data from trades
  console.log('\n=== RECENT TRADES (if exists) ===');
  try {
    const recent = await client.execute("SELECT * FROM trades ORDER BY entry_time DESC LIMIT 5");
    console.log(recent.rows);
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Recent data from trade_events
  console.log('\n=== RECENT TRADE_EVENTS (if exists) ===');
  try {
    const recent = await client.execute("SELECT * FROM trade_events ORDER BY timestamp DESC LIMIT 5");
    console.log(recent.rows);
  } catch (e) {
    console.log('Error:', e.message);
  }

  // Count by bot_id
  console.log('\n=== COUNTS BY BOT_ID ===');
  try {
    const counts = await client.execute(`
      SELECT bot_id, COUNT(*) as count 
      FROM trades 
      GROUP BY bot_id 
      ORDER BY count DESC
    `);
    console.log(counts.rows);
  } catch (e) {
    try {
      const counts = await client.execute(`
        SELECT bot_id, COUNT(*) as count 
        FROM trade_events 
        GROUP BY bot_id 
        ORDER BY count DESC
      `);
      console.log(counts.rows);
    } catch (e2) {
      console.log('Error:', e2.message);
    }
  }
}

check().catch(console.error);
