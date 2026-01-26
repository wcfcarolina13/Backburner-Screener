---
task: Futures-Only Asset Discovery & Commodity Screening
test_command: "npm run build"
---

# Task: Futures-Only Asset Discovery & Commodity Screening

**Priority**: Medium
**Status**: Complete

**Context**: Screener was missing viable trading opportunities on futures-only assets (no MEXC spot pair). Assets like SILVER_USDT (silver/XAG, $527M/day) and PAXG_USDT (gold, $155M/day) have active futures contracts but were invisible to the screener because:
1. Main discovery loop requires a spot pair
2. Futures-only loop blocked by CoinGecko market cap check (commodities aren't tracked)
3. Futures-only loop was missing exclude pattern checks (STOCK tokens could slip through)

---

## Success Criteria

1. [x] **Add FUTURES_WHITELIST to config.ts**
   - Conservative list of manually verified futures-only assets
   - SILVER_USDT and PAXG_USDT added

2. [x] **Add exclude patterns to futures-only discovery loop**
   - Futures-only loop in screener.ts now checks excludePatterns
   - STOCK tokens, stablecoins, etc. properly blocked
   - Uses contract.baseCoin for pattern matching

3. [x] **Add whitelist bypass for CoinGecko market cap check**
   - Whitelisted symbols bypass hasMarketCapData() requirement
   - Non-whitelisted futures-only symbols still need CoinGecko data

4. [x] **Add logging for futures-only discovery**
   - Logs count of futures-only symbols added and how many were whitelisted

5. [x] **Build passes**
   - `npm run build` succeeds with no TypeScript errors

6. [x] **Exclude tokenized stocks**
   - `/STOCK$/i` pattern in excludePatterns blocks AAPLSTOCK, JPMSTOCK, etc.
   - Added in previous commit (0e95826)

---

## Technical Notes

### Key Findings
- 287 eligible symbols currently tracked (spot+futures pairs)
- 123 futures-only contracts exist on MEXC (commodities, forex, stocks, crypto)
- `apiAllowed: false` on 741/742 contracts — NOT a restriction for cookie-based API
- Zero symbol name mismatches between spot↔futures conversion
- XAUT (Tether Gold) already tracked via spot pair + CoinGecko rank #50
- Screener already uses `getFuturesKlines()` for all eligible symbols (not spot-only)

### Files Modified
- `src/config.ts` — Added FUTURES_WHITELIST, STOCK exclude pattern
- `src/screener.ts` — Updated futures-only loop with exclude patterns + whitelist bypass

---

## Commits
- 0e95826 "fix: Exclude tokenized stock futures from screener"
- (pending) "feat: Add futures-only commodity whitelist for SILVER/PAXG screening"
