#!/bin/bash
# Watchdog: detect stale market data, auto-restart chromium, alert if persistent.
# Runs every 5 minutes via cron, 7 days a week.
#
# Canary strategy (mirrors monitor.js isMarketOpen):
#   Mo–Th, Fr<17:00 ET, Su≥18:00 ET → check NAS100 + ETHUSD (forex/futures open)
#   Otherwise (Sa, Fr≥17:00 ET, Su<18:00 ET) → check ETHUSD only (crypto 24/7)
#
# Recovery flow:
#   stale + no recent restart → supervisorctl restart chromium + trading-app,
#     mark restart timestamp, exit (no alert yet — give it time to recover)
#   stale + restart already attempted recently (<15min) → fire Discord alert
#     (real problem: restart didn't help)
#   not stale → clear flags, post recovery message if needed

# Watchdog alerts (data-stale / recovery) gaan naar Morpheus — NIET naar Neo.
# Neo channel ontvangt alleen handelsignalen (entry, TP, SL, setup) via monitor.js.
DISCORD_WEBHOOK="${MORPHEUS_WEBHOOK:-$(grep -E '^MORPHEUS_WEBHOOK=' /opt/trading-assistant/.env 2>/dev/null | cut -d= -f2-)}"
DISCORD_WEBHOOK="${DISCORD_WEBHOOK:-https://discord.com/api/webhooks/1499721149699854416/FYxLPre7PJ4m8CytRq94u40Od4LsV1AWswvZV0qgXWcPN9xMeP_olNvHiAuACZL4C6SB}"
DATA_DIR="/opt/trading-assistant/monitor"
MAX_AGE_SECS=300   # 5 minutes
ALERT_COOLDOWN_FILE="/tmp/watchdog_alert_sent"
RESTART_FLAG_FILE="/tmp/watchdog_restart_attempted"
COOLDOWN_SECS=1800     # only alert once per 30 min
RESTART_COOLDOWN_SECS=900  # auto-restart at most once per 15 min (avoid restart loops)

NOW=$(date +%s)

# ET-aware market-open check (mirrors monitor.js:isMarketOpen).
ET_DOW=$(TZ="America/New_York" date +%u)   # 1=Mon ... 7=Sun
ET_HOUR=$(TZ="America/New_York" date +%H)
ET_DOW_INT=$((10#$ET_DOW))
ET_HOUR_INT=$((10#$ET_HOUR))

forex_futures_open=true
if [ "$ET_DOW_INT" -eq 6 ]; then
  forex_futures_open=false                                # Saturday all day
elif [ "$ET_DOW_INT" -eq 7 ] && [ "$ET_HOUR_INT" -lt 18 ]; then
  forex_futures_open=false                                # Sunday before 18:00 ET
elif [ "$ET_DOW_INT" -eq 5 ] && [ "$ET_HOUR_INT" -ge 17 ]; then
  forex_futures_open=false                                # Friday after 17:00 ET
fi

if [ "$forex_futures_open" = "true" ]; then
  CANARIES=("NAS100" "ETHUSD")
else
  CANARIES=("ETHUSD")
fi

STALE=false
STALE_MARKETS=()
LOG_REASON=""
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

STALE_LIST=$(printf '%s, ' "${STALE_MARKETS[@]}")
STALE_LIST="${STALE_LIST%, }"

if [ "$STALE" = "true" ]; then
  # Check whether we recently auto-restarted. If so, give it time to recover
  # before alerting; if too long ago to count, treat this as a fresh incident.
  RECENTLY_RESTARTED=false
  if [ -f "$RESTART_FLAG_FILE" ]; then
    LAST_RESTART=$(cat "$RESTART_FLAG_FILE")
    SINCE_RESTART=$(( NOW - LAST_RESTART ))
    if [ "$SINCE_RESTART" -lt "$RESTART_COOLDOWN_SECS" ]; then
      RECENTLY_RESTARTED=true
    fi
  fi

  if [ "$RECENTLY_RESTARTED" = "false" ]; then
    # Fresh incident — try auto-restart first, no alert yet.
    echo "$NOW" > "$RESTART_FLAG_FILE"
    echo "[watchdog] Stale data detected ($LOG_REASON) — auto-restarting chromium + trading-app"
    supervisorctl -c /etc/supervisor/supervisord.conf restart \
      trading-assistant:chromium trading-assistant:trading-app \
      >> /opt/trading-assistant/logs/chrome_restart.log 2>&1
    exit 0
  fi

  # Restart already attempted recently. If alert cooldown not active, the
  # restart didn't help → escalate to Discord.
  if [ -f "$ALERT_COOLDOWN_FILE" ]; then
    LAST_ALERT=$(cat "$ALERT_COOLDOWN_FILE")
    SINCE_ALERT=$(( NOW - LAST_ALERT ))
    [ "$SINCE_ALERT" -lt "$COOLDOWN_SECS" ] && exit 0
  fi

  echo "$NOW" > "$ALERT_COOLDOWN_FILE"
  MSG="⏸ **${STALE_LIST} niet live** — auto-restart van chromium probeerde te herstellen maar data is nog steeds 5+ min oud. Mogelijk grotere storing — handmatige check aanbevolen."
  curl -s -X POST "$DISCORD_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"${MSG}\"}"
  echo "[watchdog] Alert sent (post-restart still stale): $LOG_REASON"
else
  # Healthy. Clear restart flag; post recovery if we previously alerted.
  rm -f "$RESTART_FLAG_FILE"
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
