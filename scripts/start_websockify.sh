#!/bin/bash
echo "[websockify] Waiting for x11vnc on port 5900..."
for i in $(seq 1 30); do
    if nc -z localhost 5902 2>/dev/null; then
        echo "[websockify] x11vnc is ready."
        break
    fi
    sleep 1
done

NOVNC_DIR="/usr/share/novnc"

exec websockify \
    --web="$NOVNC_DIR" \
    --heartbeat=30 \
    6082 localhost:5902
