import { createClient } from '@libsql/client';

const client = createClient({
  url: 'libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io',
  authToken: process.env.TURSO_AUTH_TOKEN!
});

async function check() {
  // Get recent INITUSDT signals
  const result = await client.execute(`
    SELECT timestamp, state, direction, timeframe, rsi, price, impulse_percent, data_json
    FROM signal_events
    WHERE symbol = 'INITUSDT'
    ORDER BY timestamp DESC
    LIMIT 15
  `);

  console.log('Recent INITUSDT Signals:');
  console.log('='.repeat(100));
  for (const row of result.rows) {
    const time = String(row.timestamp).split('T')[1]?.substring(0, 8);
    const date = String(row.timestamp).split('T')[0];
    console.log(`${date} ${time} | ${String(row.state).padEnd(12)} | ${String(row.direction).padEnd(6)} | ${row.timeframe} | RSI: ${Number(row.rsi || 0).toFixed(1).padStart(5)} | Price: ${row.price} | Impulse: ${row.impulse_percent}%`);
  }

  client.close();
}

check().catch(console.error);
