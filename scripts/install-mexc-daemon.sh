#!/bin/bash
# Install MEXC Cookie Refresh Daemon as a macOS LaunchAgent
#
# This creates a background service that refreshes the MEXC cookie every 30 minutes.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.backburner.mexc-cookie.plist"
PLIST_SRC="$SCRIPT_DIR/$PLIST_NAME"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "=== MEXC Cookie Daemon Installer ==="
echo ""

# Check if already installed
if [ -f "$PLIST_DST" ]; then
    echo "Daemon is already installed. Unloading..."
    launchctl unload "$PLIST_DST" 2>/dev/null
fi

# First, run setup if no state exists
if [ ! -f "$PROJECT_DIR/.mexc-browser-state.json" ]; then
    echo "No browser state found. Running initial setup..."
    echo "A browser window will open - please log in to MEXC."
    echo ""
    cd "$PROJECT_DIR" && npx tsx scripts/mexc-cookie-daemon.ts --setup

    if [ $? -ne 0 ]; then
        echo "Setup failed. Please try again."
        exit 1
    fi
fi

# Update paths in plist to match current system
echo "Updating plist paths..."
sed -i '' "s|/Users/roti/.claude-worktrees/Backburner/nifty-lewin|$PROJECT_DIR|g" "$PLIST_SRC"

# Find npx location
NPX_PATH=$(which npx)
if [ -z "$NPX_PATH" ]; then
    echo "Error: npx not found in PATH"
    exit 1
fi
sed -i '' "s|/opt/homebrew/bin/npx|$NPX_PATH|g" "$PLIST_SRC"

# Copy plist to LaunchAgents
echo "Installing daemon..."
cp "$PLIST_SRC" "$PLIST_DST"

# Load the daemon
echo "Loading daemon..."
launchctl load "$PLIST_DST"

echo ""
echo "=== Installation Complete ==="
echo ""
echo "The daemon is now running and will refresh your MEXC cookie every 30 minutes."
echo ""
echo "Useful commands:"
echo "  Check status:  launchctl list | grep mexc"
echo "  View logs:     tail -f $PROJECT_DIR/.mexc-daemon.log"
echo "  Stop daemon:   launchctl unload $PLIST_DST"
echo "  Start daemon:  launchctl load $PLIST_DST"
echo "  Uninstall:     rm $PLIST_DST"
echo ""
