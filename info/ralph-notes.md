# Backburner Project Info

## Render Server
- **URL:** https://backburner.onrender.com/

## Turso Database
- **URL:** libsql://backburner-wcfcarolina13.aws-us-east-1.turso.io
- **Database Name:** backburner-trades

## Useful Queries

```sql
-- Bot performance (last 24h)
SELECT bot_id, COUNT(*) as trades, 
  SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(SUM(realized_pnl), 2) as total_pnl
FROM trade_events 
WHERE event_type = 'close' AND timestamp > datetime('now', '-24 hours')
GROUP BY bot_id ORDER BY total_pnl DESC;

-- Check Focus Mode Shadow Bots
SELECT bot_id, event_type, COUNT(*) as count
FROM trade_events 
WHERE bot_id LIKE 'focus-%'
GROUP BY bot_id, event_type;

-- Most recent trades
SELECT bot_id, event_type, timestamp, symbol
FROM trade_events ORDER BY timestamp DESC LIMIT 10;
```

