#!/bin/bash
# Wrapper script for native messaging host
# Chrome on macOS requires a shell script, not a direct node invocation

DIR="$(cd "$(dirname "$0")" && pwd)"
exec /opt/homebrew/bin/node "$DIR/native-host.js"
