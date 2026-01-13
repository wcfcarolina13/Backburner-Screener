---
task: Fix Backburner web UI issues - dropdowns, background sessions, and server accessibility
test_command: "cd /Users/roti/gemini_projects/Backburner && npm run build"
---

# Task: Fix Backburner Web UI Issues

Fix three main issues with the Backburner trading dashboard:

## Requirements

1. Dropdowns/collapsible sections should toggle properly (expand/collapse)
2. Background sessions should be trackable and terminable
3. Web server should be accessible at http://localhost:3000 and update properly

## Success Criteria

1. [x] **Fix dropdown collapse**: Collapsible sections (altcoinBots, btcBiasBots, btcBiasStats, mexcSim, goldenPocket) should properly expand and collapse when clicked
2. [x] **Debug section toggle**: Add console logging to toggleSection() to verify it's being called and state is updating
3. [x] **Fix event propagation**: Ensure onclick events on section headers don't conflict with child element events
4. [x] **Server startup verification**: Add startup logging and ensure server binds to port 3000 correctly
5. [x] **Process management**: Add graceful shutdown handling (SIGINT/SIGTERM) to clean up any spawned processes
6. [x] **Hot reload setup**: Ensure `npm run dev` properly watches files and restarts on changes
7. [x] **All tests pass**: Run `npm run build` successfully with no errors
8. [ ] **Code is committed**: All fixes committed with descriptive messages

## Technical Context

The web server is in `src/web-server.ts` - a large file (~3500+ lines) containing:
- Express server setup
- SSE (Server-Sent Events) for real-time updates
- Multiple trading bot instances
- Inline HTML/CSS/JS template for the dashboard UI

The collapsible sections use:
- `sectionState` object to track expanded/collapsed state
- `toggleSection(sectionId)` function to toggle
- Elements: `{sectionId}Content` (the content div) and `{sectionId}Toggle` (the arrow indicator)

Known section IDs: altcoinBots, btcBiasBots, btcBiasStats, mexcSim, goldenPocket

## Current Issues

1. **Dropdowns not collapsing**: The `toggleSection` function exists but sections may not be toggling due to:
   - Event bubbling/propagation issues (onclick on both header and toggle span)
   - CSS display property not being applied correctly
   - Initial state not matching DOM state

2. **Background sessions**: Notifications appearing suggests processes are running but not tracked

3. **Server not accessible**: Could be port conflict, binding issue, or crash on startup

---

## Ralph Instructions

1. Work on the next incomplete criterion (marked `[ ]`)
2. Check off completed criteria (change `[ ]` to `[x]`)
3. Run the test_command after changes
4. Commit your changes frequently with descriptive messages
5. Update `.ralph/progress.md` with what you accomplished
6. When ALL criteria are `[x]`, say: **"RALPH COMPLETE - all criteria satisfied"**
7. If stuck 3+ times on same issue, say: **"RALPH GUTTER - need fresh context"**
