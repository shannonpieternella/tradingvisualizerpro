#!/bin/bash
echo "[x11vnc] Waiting for Xvfb on display :99..."
for i in $(seq 1 30); do
    if DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
        echo "[x11vnc] Xvfb is ready."
        break
    fi
    sleep 1
done

pkill -f "x11vnc" 2>/dev/null || true
sleep 1

exec /usr/bin/x11vnc \
    -display :99 \
    -nopw \
    -listen localhost \
    -rfbport 5902 \
    -forever \
    -shared \
    -noxdamage \
    -nocursor \
    -quiet
