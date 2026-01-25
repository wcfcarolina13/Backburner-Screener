#!/bin/bash
# Push MEXC cookie from local .env to Render
#
# Prerequisites:
# 1. Install Render CLI: brew install render
# 2. Login: render login
# 3. Get your service ID from Render dashboard URL
#
# Usage:
#   ./scripts/push-cookie-to-render.sh
#   ./scripts/push-cookie-to-render.sh --service-id srv-xxxxx

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

# Default service ID (update this with your actual Render service ID)
SERVICE_ID="${RENDER_SERVICE_ID:-}"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --service-id)
      SERVICE_ID="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

echo "=== Push MEXC Cookie to Render ==="
echo ""

# Check for .env file
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env file not found at $ENV_FILE"
  exit 1
fi

# Extract cookie from .env
COOKIE=$(grep "^MEXC_UID_COOKIE=" "$ENV_FILE" | cut -d'=' -f2)

if [ -z "$COOKIE" ] || [ "$COOKIE" = "WEB_your_uid_cookie_here" ]; then
  echo "Error: No valid MEXC_UID_COOKIE found in .env"
  exit 1
fi

echo "Cookie found: ${COOKIE:0:20}...${COOKIE: -10}"
echo ""

# Check if Render CLI is installed
if ! command -v render &> /dev/null; then
  echo "Render CLI not installed."
  echo ""
  echo "Option 1: Install Render CLI"
  echo "  brew install render"
  echo "  render login"
  echo ""
  echo "Option 2: Manual update"
  echo "  1. Go to https://dashboard.render.com"
  echo "  2. Select your 'backburner' service"
  echo "  3. Go to Environment tab"
  echo "  4. Update MEXC_UID_COOKIE to:"
  echo ""
  echo "     $COOKIE"
  echo ""
  exit 0
fi

# Check service ID
if [ -z "$SERVICE_ID" ]; then
  echo "No service ID provided."
  echo ""
  echo "Find your service ID:"
  echo "  1. Go to https://dashboard.render.com"
  echo "  2. Click on your 'backburner' service"
  echo "  3. Copy the ID from the URL (srv-xxxxx)"
  echo ""
  echo "Then run:"
  echo "  ./scripts/push-cookie-to-render.sh --service-id srv-xxxxx"
  echo ""
  echo "Or set RENDER_SERVICE_ID environment variable."
  echo ""
  echo "For now, manually update the cookie at:"
  echo "  https://dashboard.render.com"
  echo ""
  echo "Cookie value:"
  echo "  $COOKIE"
  exit 0
fi

echo "Updating Render service: $SERVICE_ID"

# Use Render API directly (CLI may not support env var updates)
# This requires RENDER_API_KEY to be set
if [ -z "$RENDER_API_KEY" ]; then
  echo ""
  echo "RENDER_API_KEY not set. Using manual instructions instead."
  echo ""
  echo "To automate this:"
  echo "  1. Go to https://dashboard.render.com/u/settings#api-keys"
  echo "  2. Create an API key"
  echo "  3. Set: export RENDER_API_KEY=rnd_xxxxx"
  echo ""
  echo "For now, manually update at:"
  echo "  https://dashboard.render.com"
  echo ""
  echo "Cookie value:"
  echo "  $COOKIE"
  exit 0
fi

# Update env var via Render API
echo "Updating MEXC_UID_COOKIE via Render API..."

RESPONSE=$(curl -s -X PUT \
  "https://api.render.com/v1/services/$SERVICE_ID/env-vars/MEXC_UID_COOKIE" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"value\": \"$COOKIE\"}")

if echo "$RESPONSE" | grep -q "error"; then
  echo "Error updating env var:"
  echo "$RESPONSE"
  exit 1
fi

echo "Cookie updated successfully!"
echo ""
echo "Note: You may need to trigger a redeploy for changes to take effect."
echo "  render services restart $SERVICE_ID"
