#!/bin/bash
# Kill any existing Xvfb on :99
pkill -f "Xvfb :99" 2>/dev/null || true
sleep 1
exec /usr/bin/Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset
