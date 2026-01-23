# Focus Mode Trade Copying - REMOVED

**Removed:** January 23, 2026

## What Was Removed

The "Focus Mode - Trade Copying" panel in the Screener tab's GUI has been removed. This feature was designed to allow manual copying of trades from a selected shadow bot to a real exchange account.

### Removed Components:
- **HTML Panel**: Focus Mode panel in web-server.ts (Screener tab)
- **API Endpoints**: `/api/focus/*` routes for enable/disable/config
- **JS Functions**: `updateFocusPositions`, `toggleFocusMode`, `checkFocusNotifications`, etc. in dashboard.js
- **Server Module**: `src/focus-mode.ts` (FocusModeManager class)
- **Route Module**: `src/routes/focus-mode.ts`

### Why Removed:
- Feature never functioned properly in production
- No longer aligned with the A/B testing strategy using shadow bots
- Replaced by per-bot notification controls in Settings

## What Remains

The following Focus Mode components are **NOT** removed and remain functional:

1. **Focus Mode Dashboard** (`/focus` route)
   - Standalone contrarian trading dashboard
   - Uses `src/focus-mode-dashboard.ts`
   - Client-side JS: `src/views/js/focus-mode.js`

2. **Focus Mode Shadow Bots**
   - Used for A/B testing different trading strategies
   - Uses `src/focus-mode-shadow-bot.ts`
   - Bots: `focus-baseline`, `focus-conservative`, `focus-aggressive`, etc.

3. **Per-Bot Notification Controls**
   - New replacement feature in Settings modal
   - Allows selective desktop notifications from any bot
   - User can choose which bot trades trigger notifications

## Migration Path

Users who want trade alerts should:
1. Go to Settings (gear icon)
2. Enable Desktop Notifications
3. Check the bots they want to receive alerts from

## Archived Files

- `focus-mode.ts.archived` - Original FocusModeManager class
