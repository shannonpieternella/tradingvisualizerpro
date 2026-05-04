#!/bin/bash
LOCKFILE=/tmp/blackbull_monitor.lock
# Max runtime per tick. If monitor.js hangs (MCP/Mongo network stall), we
# don't want to block future cron ticks — SIGKILL and release the lock.
MAX_SEC=300
# If an existing lock's owner has been running longer than MAX_SEC, it's hung.
# Kill the tree and take the lock ourselves.
if [ -f "$LOCKFILE" ]; then
    pid=$(cat "$LOCKFILE")
    if kill -0 "$pid" 2>/dev/null; then
        age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
        if [ -n "$age" ] && [ "$age" -gt "$MAX_SEC" ]; then
            echo "[$(date)] Stale lock — pid $pid running ${age}s > ${MAX_SEC}s, killing." >> /opt/trading-assistant/logs/monitor.log
            pkill -9 -P "$pid" 2>/dev/null
            kill -9 "$pid" 2>/dev/null
            rm -f "$LOCKFILE"
        else
            echo "[$(date)] Monitor already running (pid $pid, ${age}s), skipping." >> /opt/trading-assistant/logs/monitor.log
            exit 0
        fi
    else
        rm -f "$LOCKFILE"
    fi
fi

echo $$ > "$LOCKFILE"
trap "rm -f $LOCKFILE" EXIT

cd /opt/trading-assistant/monitor
# timeout ensures monitor.js itself never runs longer than MAX_SEC.
timeout --kill-after=10s "${MAX_SEC}s" /usr/bin/node monitor.js >> /opt/trading-assistant/logs/monitor.log 2>&1
rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "[$(date)] Monitor timed out after ${MAX_SEC}s — killed." >> /opt/trading-assistant/logs/monitor.log
fi
