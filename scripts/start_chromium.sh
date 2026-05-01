#!/bin/bash
# Load env for CHROME_BIN override
[[ -f /opt/trading-assistant/.env ]] && source /opt/trading-assistant/.env

CHROME="${CHROME_BIN:-google-chrome}"

echo "[chrome] Waiting for Xvfb on display :99..."
for i in $(seq 1 30); do
    if DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
        echo "[chrome] Xvfb ready. Starting Chrome..."
        break
    fi
    sleep 1
done

export DISPLAY=:99

# Kill any existing Chrome instance
pkill -f "remote-debugging-port=9222" 2>/dev/null || true
sleep 2

exec "$CHROME" \
    --remote-debugging-port=9222 \
    --remote-allow-origins=* \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-infobars \
    --disable-notifications \
    --disable-popup-blocking \
    --disable-extensions \
    --disable-translate \
    --no-first-run \
    --no-default-browser-check \
    --window-size=1280,900 \
    --start-maximized \
    --user-data-dir=/tmp/chrome-trading \
    "https://www.tradingview.com/chart/"
