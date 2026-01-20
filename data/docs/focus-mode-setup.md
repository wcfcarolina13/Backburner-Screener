# Focus Mode - Semi-Automated Trading Setup

## Quick Start

### Option 1: Dashboard (Recommended)
Run the Focus Mode dashboard that shows current regime and one-click MEXC links:

```bash
cd ~/Backburner
node dist/focus-mode-dashboard.js
```

Then open: **http://localhost:3847**

The dashboard:
- Shows current MACRO (24h) and MICRO (4h) regime
- Calculates the current quadrant (e.g., BULL+BEAR)
- Tells you exactly what to do: LONG, SHORT, or SKIP
- Provides one-click links to open MEXC at the right trading pair
- Auto-refreshes every 30 seconds

---

## The Strategy (10x Leveraged Contrarian)

Based on 7-day backtesting with **$2,377 profit** and 54.5% win rate:

| Quadrant | Action | Description | Confidence |
|----------|--------|-------------|------------|
| **NEU+BEAR** | 🟢 LONG | Contrarian - buy the dip | HIGH |
| **NEU+BULL** | 🔴 SHORT | Fade the rally | MEDIUM |
| **BEAR+BEAR** | 🟢 LONG | Deep contrarian long | MEDIUM |
| **BEAR+BULL** | ⛔ SKIP | BULL TRAP - never trade! | HIGH |
| **BULL+BULL** | 🔴 SHORT | Fade euphoria (BEST!) | HIGH |
| **BULL+BEAR** | 🟢 LONG | Buy macro-bull dip | MEDIUM |
| **BULL+NEU** | ⏸️ SKIP | Wait for signal | LOW |
| **BEAR+NEU** | ⏸️ SKIP | Wait for signal | LOW |
| **NEU+NEU** | ⏸️ SKIP | No clear regime | LOW |

### Key Insight
**Trade OPPOSITE to the micro regime, not with it!**
- When everyone is bullish (BULL+BULL) → SHORT
- When everyone is bearish (NEU+BEAR, BEAR+BEAR) → LONG

---

## Trade Execution Checklist

When the dashboard shows an actionable signal:

1. ✅ **Confirm quadrant** - Make sure it's not BEAR+BULL (bull trap)
2. ✅ **Click MEXC link** - Opens the right trading pair
3. ✅ **Set leverage** - Use 10x (recommended) or 5x (safer)
4. ✅ **Set position size** - Max 10% of your balance per trade
5. ✅ **Set stop loss** - 5% for 10x, 10% for 5x
6. ✅ **Set take profit** - 15% for 10x, 20% for 5x
7. ✅ **Execute** - Place the order

### Position Sizing
| Balance | 10% Position | With 10x Leverage |
|---------|--------------|-------------------|
| $100 | $10 | $100 exposure |
| $500 | $50 | $500 exposure |
| $1000 | $100 | $1000 exposure |

---

## API Access

The dashboard exposes a JSON API for integration with other tools:

```bash
curl http://localhost:3847/api/status
```

Response:
```json
{
  "timestamp": "2024-01-19T12:00:00Z",
  "macro": { "regime": "BULL", "longPct": 62, "shortPct": 38, "count": 45 },
  "micro": { "regime": "BULL", "longPct": 71, "shortPct": 29, "count": 12 },
  "quadrant": "BULL+BULL",
  "rule": { "action": "SHORT", "emoji": "🔴", "description": "Fade euphoria" },
  "actionableSignals": [...]
}
```

---

## Browser Notifications (Optional)

To get browser notifications when actionable signals appear, add this bookmarklet:

```javascript
javascript:(function(){setInterval(async()=>{const r=await fetch('http://localhost:3847/api/status').then(r=>r.json());if(r.rule.action!=='SKIP'&&r.actionableSignals.length>0){new Notification('🎯 Focus Mode',{body:`${r.quadrant}: ${r.rule.action} - ${r.actionableSignals.length} signals`})}},60000)})()
```

---

## Running as Background Service

To keep the dashboard running:

```bash
# Using PM2
pm2 start dist/focus-mode-dashboard.js --name focus-mode

# Or using nohup
nohup node dist/focus-mode-dashboard.js > focus-mode.log 2>&1 &
```

---

## Troubleshooting

**Dashboard shows "No signals"**
- Make sure the Backburner screener is running and collecting signals
- Check that `data/signals/` has recent .json files

**MEXC links don't work**
- You need to be logged into MEXC in the same browser
- Some symbols may not be available on MEXC futures

**Regime not updating**
- Dashboard auto-refreshes every 30 seconds
- Force refresh with Ctrl+R
