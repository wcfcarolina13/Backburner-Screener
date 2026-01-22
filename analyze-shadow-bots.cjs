const fs = require("fs");
const path = require("path");

const tradesDir = "data/trades";
const files = fs.readdirSync(tradesDir).filter(f => f.endsWith(".json"));

// Aggregate shadow bot trades
const shadowBots = {};

for (const file of files) {
  try {
    const trades = JSON.parse(fs.readFileSync(path.join(tradesDir, file), "utf-8"));
    for (const t of trades) {
      if (t.botId && t.botId.startsWith("shadow-")) {
        if (!shadowBots[t.botId]) {
          shadowBots[t.botId] = { wins: 0, losses: 0, totalPnl: 0, trades: [], openCount: 0 };
        }
        if (t.eventType === "open") {
          shadowBots[t.botId].openCount++;
        }
        if (t.eventType === "close" && t.realizedPnl !== undefined) {
          shadowBots[t.botId].trades.push(t);
          shadowBots[t.botId].totalPnl += t.realizedPnl;
          if (t.realizedPnl > 0) shadowBots[t.botId].wins++;
          else shadowBots[t.botId].losses++;
        }
      }
    }
  } catch (e) {}
}

console.log("=== LOCAL SHADOW BOT PERFORMANCE ===\n");

// Sort by stop loss %
const sorted = Object.entries(shadowBots).sort((a, b) => {
  const slA = parseInt(a[0].match(/sl(\d+)/)?.[1] || "0");
  const slB = parseInt(b[0].match(/sl(\d+)/)?.[1] || "0");
  return slA - slB;
});

for (const [botId, data] of sorted) {
  const total = data.wins + data.losses;
  const winRate = total > 0 ? ((data.wins / total) * 100).toFixed(1) : "0";
  const avgPnl = total > 0 ? (data.totalPnl / total).toFixed(2) : "0";
  console.log(botId + ":");
  console.log("  Opens: " + data.openCount + " | Closed: " + total + " (W:" + data.wins + " L:" + data.losses + ")");
  console.log("  Win Rate: " + winRate + "%");
  console.log("  Total PnL: $" + data.totalPnl.toFixed(2) + " | Avg: $" + avgPnl + "/trade");
  console.log("");
}

if (Object.keys(shadowBots).length === 0) {
  console.log("No shadow bot trades found.");
}
