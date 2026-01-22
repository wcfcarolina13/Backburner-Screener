const fs = require("fs");
const path = require("path");

const tradesDir = "data/trades";
const files = fs.readdirSync(tradesDir).filter(f => f.endsWith(".json"));

// Aggregate shadow bot trades with detailed stats
const shadowBots = {};

for (const file of files) {
  try {
    const trades = JSON.parse(fs.readFileSync(path.join(tradesDir, file), "utf-8"));
    for (const t of trades) {
      if (t.botId && t.botId.startsWith("shadow-")) {
        if (!shadowBots[t.botId]) {
          shadowBots[t.botId] = {
            wins: 0, losses: 0, totalPnl: 0, openCount: 0,
            avgWin: 0, avgLoss: 0, winPnls: [], lossPnls: [],
            stopLossPct: parseInt(t.botId.match(/sl(\d+)/)?.[1] || "0")
          };
        }
        if (t.eventType === "open") {
          shadowBots[t.botId].openCount++;
        }
        if (t.eventType === "close") {
          const pnl = t.realizedPnL !== undefined ? t.realizedPnL : t.realizedPnl;
          if (pnl !== undefined) {
            shadowBots[t.botId].totalPnl += pnl;
            if (pnl > 0) {
              shadowBots[t.botId].wins++;
              shadowBots[t.botId].winPnls.push(pnl);
            } else {
              shadowBots[t.botId].losses++;
              shadowBots[t.botId].lossPnls.push(pnl);
            }
          }
        }
      }
    }
  } catch (e) {}
}

console.log("=== SHADOW BOT PERFORMANCE ANALYSIS ===\n");
console.log("Purpose: Find optimal stop-loss percentage\n");

// Sort by stop loss %
const sorted = Object.entries(shadowBots).sort((a, b) => a[1].stopLossPct - b[1].stopLossPct);

console.log("SL%".padStart(5) + "  " + "Trades".padStart(7) + "  " + "W".padStart(4) + "  " + "L".padStart(4) + "  " + "Win%".padStart(7) + "  " + "Avg Win".padStart(10) + "  " + "Avg Loss".padStart(10) + "  " + "PnL".padStart(12));
console.log("-".repeat(75));

for (const [botId, data] of sorted) {
  const total = data.wins + data.losses;
  const winRate = total > 0 ? ((data.wins / total) * 100).toFixed(1) : "-";
  const avgWin = data.winPnls.length > 0 ? (data.winPnls.reduce((a,b) => a+b, 0) / data.winPnls.length) : 0;
  const avgLoss = data.lossPnls.length > 0 ? (data.lossPnls.reduce((a,b) => a+b, 0) / data.lossPnls.length) : 0;

  console.log(
    (data.stopLossPct + "%").padStart(5) + "  " +
    String(total).padStart(7) + "  " +
    String(data.wins).padStart(4) + "  " +
    String(data.losses).padStart(4) + "  " +
    (winRate + "%").padStart(7) + "  " +
    ("$" + avgWin.toFixed(2)).padStart(10) + "  " +
    ("$" + avgLoss.toFixed(2)).padStart(10) + "  " +
    ("$" + data.totalPnl.toFixed(2)).padStart(12)
  );
}

console.log("\n=== KEY INSIGHTS ===\n");

// Find best performer
const byPnl = sorted.slice().sort((a, b) => b[1].totalPnl - a[1].totalPnl);
const best = byPnl[0];
const worst = byPnl[byPnl.length - 1];

console.log("Best PnL:  " + best[0] + " (" + best[1].stopLossPct + "% SL) = $" + best[1].totalPnl.toFixed(2));
console.log("Worst PnL: " + worst[0] + " (" + worst[1].stopLossPct + "% SL) = $" + worst[1].totalPnl.toFixed(2));

// Find best win rate (min 10 trades)
const byWinRate = sorted.filter(([_, d]) => (d.wins + d.losses) >= 5)
  .sort((a, b) => {
    const wrA = a[1].wins / (a[1].wins + a[1].losses);
    const wrB = b[1].wins / (b[1].wins + b[1].losses);
    return wrB - wrA;
  });

if (byWinRate.length > 0) {
  const bestWR = byWinRate[0];
  const wr = ((bestWR[1].wins / (bestWR[1].wins + bestWR[1].losses)) * 100).toFixed(1);
  console.log("Best Win Rate: " + bestWR[0] + " (" + bestWR[1].stopLossPct + "% SL) = " + wr + "%");
}

console.log("\n=== RECOMMENDATION ===\n");

// Calculate expected value per trade for each
for (const [botId, data] of sorted) {
  const total = data.wins + data.losses;
  if (total >= 5) {
    const avgWin = data.winPnls.length > 0 ? (data.winPnls.reduce((a,b) => a+b, 0) / data.winPnls.length) : 0;
    const avgLoss = data.lossPnls.length > 0 ? Math.abs(data.lossPnls.reduce((a,b) => a+b, 0) / data.lossPnls.length) : 0;
    const winRate = data.wins / total;
    const ev = (winRate * avgWin) - ((1 - winRate) * avgLoss);
    console.log(data.stopLossPct + "% SL: EV = $" + ev.toFixed(2) + "/trade (based on " + total + " trades)");
  }
}
