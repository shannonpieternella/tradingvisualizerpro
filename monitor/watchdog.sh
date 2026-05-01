#!/bin/bash
# Watchdog: alert on Discord if market_data files haven't been updated in 5+ minutes.
# Runs every 5 minutes via cron, 7 days a week.
#
# Canary strategy:
#   Mon-Fri  -> check NAS100 + ETHUSD (both should be live)
#   Sat-Sun  -> check ETHUSD only (crypto is 24/7, US markets closed)

DISCORD_WEBHOOK="https://discord.com/api/webhooks/1490817002556755979/PNFk3zeUmTTTyYtKUzM1dyOrsgKMwR3J4o09aqz3-KoGCjxbdXShdq6fWV7LcW7qZWSt"
DATA_DIR="/opt/trading-assistant/monitor"
MAX_AGE_SECS=300   # 5 minutes
ALERT_COOLDOWN_FILE="/tmp/watchdog_alert_sent"
COOLDOWN_SECS=1800 # only alert once per 30 min

DOW=$(date +%u)   # 1=Mon ... 7=Sun
NOW=$(date +%s)

# Build canary list based on day
if [ "$DOW" -le 5 ]; then
  CANARIES=("NAS100" "ETHUSD")
else
  CANARIES=("ETHUSD")
fi

STALE=false
STALE_MARKETS=()   # human-friendly market names that are stale
LOG_REASON=""      # detailed reason for the local log only
FRESHEST_AGE_MIN=""

for MK in "${CANARIES[@]}"; do
  FILE="$DATA_DIR/market_data_${MK}.json"
  if [ ! -f "$FILE" ]; then
    STALE=true
    STALE_MARKETS+=("$MK")
    LOG_REASON="${LOG_REASON}${MK} missing; "
    continue
  fi
  AGE=$(( NOW - $(date -r "$FILE" +%s) ))
  if [ "$AGE" -gt "$MAX_AGE_SECS" ]; then
    STALE=true
    STALE_MARKETS+=("$MK")
    LOG_REASON="${LOG_REASON}${MK} ${AGE}s old; "
  else
    FRESHEST_AGE_MIN=$(( AGE / 60 ))
  fi
done
LOG_REASON="${LOG_REASON%; }"

# Comma-join market names for the Discord message ("NAS100, ETHUSD")
STALE_LIST=$(printf '%s, ' "${STALE_MARKETS[@]}")
STALE_LIST="${STALE_LIST%, }"

if [ "$STALE" = "true" ]; then
  if [ -f "$ALERT_COOLDOWN_FILE" ]; then
    LAST_ALERT=$(cat "$ALERT_COOLDOWN_FILE")
    SINCE=$(( NOW - LAST_ALERT ))
    [ "$SINCE" -lt "$COOLDOWN_SECS" ] && exit 0
  fi

  echo "$NOW" > "$ALERT_COOLDOWN_FILE"

  MSG="⏸ **${STALE_LIST} niet live op dit moment** — geen verse data sinds 5+ min.\\nMogelijk markt gesloten of korte storing. Neo checkt automatisch."

  curl -s -X POST "$DISCORD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"${MSG}\"}"

  echo "[watchdog] Alert sent: $LOG_REASON"
else
  if [ -f "$ALERT_COOLDOWN_FILE" ]; then
    curl -s -X POST "$DISCORD_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"content\": \"✅ **Markt weer live** — data binnen.\"}"
    rm -f "$ALERT_COOLDOWN_FILE"
    echo "[watchdog] Recovery posted"
  else
    echo "[watchdog] OK — canaries fresh (${FRESHEST_AGE_MIN}m)"
  fi
fi
