---
task: Fix MEXC API failures on Render deployment - 0 symbols loading
test_command: "cd /Users/roti/gemini_projects/Backburner && npm run build"
---

# Task: Fix MEXC API Failures on Render

The Backburner dashboard deploys successfully to Render but shows "0 symbols" because MEXC API calls are failing.

## Problem Evidence

From Render logs:
```
Failed to fetch page 1 after retries
Failed to fetch page 2 after retries
Failed to fetch page 3 after retries
Failed to fetch page 4 after retries
[STATE] Monitoring 0S + 0F symbols | 0 active | 0 played out
0 symbols
```

The self-ping mechanism IS working:
```
[PING] Self-ping OK
```

## Requirements

1. Investigate why MEXC API calls fail on Render but work locally
2. Implement a solution that allows symbol data to load on Render
3. Ensure the dashboard displays symbols correctly on the hosted version

## Success Criteria

1. [ ] **Diagnose API failure**: Identify root cause (IP blocking, rate limiting, geo-restriction, etc.)
2. [ ] **Research MEXC API**: Check if MEXC blocks cloud IPs or requires authentication
3. [ ] **Implement fallback/fix**: Either proxy requests, use different endpoint, or cache data
4. [ ] **Verify on Render**: Dashboard shows symbols and data on https://backburner-screener-1.onrender.com
5. [ ] **All tests pass**: Run `npm run build` successfully with no errors
6. [ ] **Code is committed**: All fixes committed with descriptive messages

## Technical Context

### Current Architecture
- `src/screener.ts` - BackburnerScreener class fetches MEXC symbols
- `src/mexc-api.ts` - MEXC API wrapper for fetching exchange data
- Pagination: Fetches symbols in 4 pages (likely ~500 symbols each)

### Potential Causes
1. **IP Blocking**: MEXC may block requests from known cloud provider IPs (AWS, GCP, Render)
2. **Geo-restrictions**: Render's Oregon datacenter may be in a blocked region
3. **Rate Limiting**: Cloud IPs may have stricter rate limits
4. **Missing Headers**: User-Agent or other headers may be required

### Potential Solutions
1. **Proxy Service**: Route API calls through a proxy that isn't blocked
2. **CORS Proxy**: Use a public CORS proxy for the requests
3. **Data Caching**: Pre-fetch symbol data and include it in the build
4. **Alternative API**: Use a different data source (CoinGecko, etc.)
5. **Server-side Proxy**: Set up a simple proxy endpoint

---

## Ralph Instructions

1. Work on the next incomplete criterion (marked `[ ]`)
2. Check off completed criteria (change `[ ]` to `[x]`)
3. Run the test_command after changes
4. Commit your changes frequently with descriptive messages
5. Update `.ralph/progress.md` with what you accomplished
6. When ALL criteria are `[x]`, say: **"RALPH COMPLETE - all criteria satisfied"**
7. If stuck 3+ times on same issue, say: **"RALPH GUTTER - need fresh context"**
