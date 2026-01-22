const fs = require("fs");
const path = require("path");

const tradesDir = "data/trades";
const files = fs.readdirSync(tradesDir).filter(f => f.endsWith(".json"));

// Aggregate all bot trades
const allBots = {};

for (const file of files) {
  try {
    const trades = JSON.parse(fs.readFileSync(path.join(tradesDir, file), "utf-8"));
    for (const t of trades) {
      if (t.botId) {
        if (!allBots[t.botId]) {
          allBots[t.botId] = { wins: 0, losses: 0, totalPnl: 0, openCount: 0, closeCount: 0 };
        }
        if (t.eventType === "open") {
          allBots[t.botId].openCount++;
        }
        if (t.eventType === "close") {
          allBots[t.botId].closeCount++;
          // Check both capitalizations
          const pnl = t.realizedPnL !== undefined ? t.realizedPnL : t.realizedPnl;
          if (pnl !== undefined) {
            allBots[t.botId].totalPnl += pnl;
            if (pnl > 0) allBots[t.botId].wins++;
            else allBots[t.botId].losses++;
          }
        }
      }
    }
  } catch (e) {}
}

console.log("=== ALL BOT PERFORMANCE (Local) ===\n");
console.log("Bot ID".padEnd(30) + "Opens".padStart(8) + "Closed".padStart(8) + "W".padStart(6) + "L".padStart(6) + "Win%".padStart(8) + "PnL".padStart(12));
console.log("-".repeat(78));

// Sort by PnL descending
const sorted = Object.entries(allBots).sort((a, b) => b[1].totalPnl - a[1].totalPnl);

for (const [botId, data] of sorted) {
  const total = data.wins + data.losses;
  const winRate = total > 0 ? ((data.wins / total) * 100).toFixed(1) : "-";
  console.log(
    botId.padEnd(30) +
    String(data.openCount).padStart(8) +
    String(data.closeCount).padStart(8) +
    String(data.wins).padStart(6) +
    String(data.losses).padStart(6) +
    (winRate + "%").padStart(8) +
    ("$" + data.totalPnl.toFixed(2)).padStart(12)
  );
}

// Summary
console.log("\n=== SUMMARY ===");
const totalPnl = Object.values(allBots).reduce((sum, b) => sum + b.totalPnl, 0);
const totalWins = Object.values(allBots).reduce((sum, b) => sum + b.wins, 0);
const totalLosses = Object.values(allBots).reduce((sum, b) => sum + b.losses, 0);
const overallWinRate = (totalWins + totalLosses) > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1) : 0;
console.log("Total PnL: $" + totalPnl.toFixed(2));
console.log("Total Closed: " + (totalWins + totalLosses) + " (W:" + totalWins + " L:" + totalLosses + ")");
console.log("Win Rate: " + overallWinRate + "%");
