#!/bin/bash
LOG_DIR="/opt/trading-assistant/logs"

for pidfile in api.pid dashboard.pid; do
  if [ -f "$LOG_DIR/$pidfile" ]; then
    PID=$(cat "$LOG_DIR/$pidfile")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID"
      echo "Stopped PID $PID ($pidfile)"
    fi
    rm "$LOG_DIR/$pidfile"
  fi
done

echo "Done."
