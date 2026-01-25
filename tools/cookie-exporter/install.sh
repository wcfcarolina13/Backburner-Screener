#!/bin/bash
# Install MEXC Cookie Exporter native messaging host
#
# Run this after loading the extension in Chrome to enable
# automatic cookie updates to the .env file.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.backburner.cookie_exporter"

echo "=== MEXC Cookie Exporter - Native Host Installer ==="
echo ""

# Check if extension ID was provided
if [ -z "$1" ]; then
    echo "Usage: ./install.sh <extension-id>"
    echo ""
    echo "To find your extension ID:"
    echo "1. Go to chrome://extensions/"
    echo "2. Enable 'Developer mode' (top right)"
    echo "3. Find 'MEXC Cookie Exporter'"
    echo "4. Copy the ID (looks like: abcdefghijklmnopqrstuvwxyz123456)"
    echo ""
    echo "Then run: ./install.sh <your-extension-id>"
    exit 1
fi

EXTENSION_ID="$1"
echo "Extension ID: $EXTENSION_ID"

# Create native messaging host manifest
MANIFEST_PATH="$SCRIPT_DIR/$HOST_NAME.json"
cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "Native messaging host for MEXC cookie export",
  "path": "$SCRIPT_DIR/native-host.js",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Created manifest: $MANIFEST_PATH"

# Install to Chrome's native messaging hosts directory
CHROME_HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$CHROME_HOST_DIR"

INSTALL_PATH="$CHROME_HOST_DIR/$HOST_NAME.json"
cp "$MANIFEST_PATH" "$INSTALL_PATH"

echo "Installed to: $INSTALL_PATH"

# Make native host executable
chmod +x "$SCRIPT_DIR/native-host.js"

echo ""
echo "=== Installation Complete ==="
echo ""
echo "The extension will now automatically update your .env file"
echo "with fresh MEXC cookies every 30 minutes."
echo ""
echo "To test: Click the extension icon and press 'Refresh Now'"
echo "Check logs: tail -f $SCRIPT_DIR/../../.mexc-cookie-refresh.log"
