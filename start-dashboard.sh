#!/bin/bash
# Start BLACKBULL API server and React dashboard
set -e

LOG_DIR="/opt/trading-assistant/logs"
mkdir -p "$LOG_DIR"

echo "Starting BLACKBULL API server (port 3001)..."
nohup node /opt/trading-assistant/api/server.js >> "$LOG_DIR/api.log" 2>&1 &
API_PID=$!
echo "API PID: $API_PID"

sleep 2

echo "Starting React dashboard (port 5173)..."
cd /opt/trading-assistant/dashboard
nohup npx vite preview --host 0.0.0.0 --port 5173 >> "$LOG_DIR/dashboard.log" 2>&1 &
DASH_PID=$!
echo "Dashboard PID: $DASH_PID"

echo "$API_PID" > "$LOG_DIR/api.pid"
echo "$DASH_PID" > "$LOG_DIR/dashboard.pid"

echo ""
echo "✓ BLACKBULL Dashboard running:"
echo "  API:       http://0.0.0.0:3001"
echo "  Dashboard: http://0.0.0.0:5173"
echo ""
echo "Stop with: ./stop-dashboard.sh"
