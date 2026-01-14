#!/bin/bash
#
# Setup script for daily summary auto-generation
#
# This creates a launchd job on macOS to run the daily summary at 11:55 PM
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.backburner.daily-summary"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
LOG_DIR="$PROJECT_DIR/logs"

echo "========================================="
echo "Backburner Daily Summary Setup"
echo "========================================="
echo ""
echo "Project directory: $PROJECT_DIR"
echo "Plist path: $PLIST_PATH"
echo ""

# Create logs directory
mkdir -p "$LOG_DIR"

# Create the plist file
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>npx</string>
        <string>tsx</string>
        <string>${PROJECT_DIR}/scripts/daily-summary.ts</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>23</integer>
        <key>Minute</key>
        <integer>55</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/daily-summary.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/daily-summary-error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
EOF

echo "Created plist at: $PLIST_PATH"
echo ""

# Unload if already loaded
launchctl unload "$PLIST_PATH" 2>/dev/null

# Load the new plist
launchctl load "$PLIST_PATH"

if [ $? -eq 0 ]; then
    echo "SUCCESS: Daily summary scheduled for 11:55 PM daily"
    echo ""
    echo "To check status:"
    echo "  launchctl list | grep backburner"
    echo ""
    echo "To run manually:"
    echo "  cd $PROJECT_DIR && npm run summary"
    echo ""
    echo "To uninstall:"
    echo "  launchctl unload $PLIST_PATH"
    echo "  rm $PLIST_PATH"
    echo ""
    echo "Logs will be written to:"
    echo "  $LOG_DIR/daily-summary.log"
else
    echo "ERROR: Failed to load plist"
    exit 1
fi
