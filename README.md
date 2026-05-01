# BLACKBULL · Trading Visualizer Pro

Live multi-market sweep-setup intelligence dashboard with broker copy-trading
via MetaApi CopyFactory. Generates fractal cycle-aligned signals on NAS100,
US500, US30, XAUUSD, GBPUSD, BTCUSD and ETHUSD; fans them out as external
signals to subscriber MT4/MT5 accounts.

## Layout

| Path | What |
|---|---|
| `monitor/` | Per-minute cron runner. Detects sweeps, triggers entries, manages SL/TP, posts signals to CopyFactory. Source of truth for setup lifecycle. |
| `api/` | Express service on `:3001`. Auth, broker connect/management, journal, admin analytics. |
| `dashboard/` | Vite/React SPA — live signals, journal, broker page, admin. Built into `dashboard/dist/`, served by nginx. |
| `app/` | Python helpers (MCP server, scheduler, agent). |
| `cron/` | Cron job definitions. |
| `scripts/` | One-off ops scripts. |

## Setup

```bash
# 1. Clone
git clone https://github.com/shannonpieternella/tradingvisualizerpro.git
cd tradingvisualizerpro

# 2. Configure env
cp .env.example .env
# fill in secrets (Anthropic, MongoDB, MetaApi token, JWT secret, …)

# 3. Install deps
(cd api       && npm install)
(cd dashboard && npm install && npm run build)
(cd monitor   && npm install)

# 4. Wire systemd / cron
# - api: a `trading-api.service` running `node api/server.js`
# - monitor: cron entry `* * * * * /opt/trading-assistant/monitor/run.sh`
# - nginx: serve dashboard/dist on :8082, proxy /api/ → :3001
```

## Signal flow

```
TradingView (MCP browser)
    ↓ candles every minute
monitor.js
    ↓ detects sweep + entry candle
copyfactory-bridge.js
    ↓ PUT external-signal × 2 (TP1 + TP2 leg)
MetaApi CopyFactory strategy "BLBL"
    ↓ fan-out per subscriber (symbolFilter, riskScaling)
Subscriber MT4/MT5 account → broker fills order
```

Subscribers manage their own market filter and risk preferences via the
`/broker` page in the dashboard. The master/PROVIDER account anchors the
strategy and does not auto-trade.

## Operational notes

- **Paper-mode by default** (`COPY_LIVE=false`). Flip to `true` after end-to-end
  verification on a demo subscriber.
- Monitor changes take effect at the next cron tick (≤60s).
- API code changes require `systemctl restart trading-api`.
- Dashboard changes require `(cd dashboard && npm run build)`; nginx serves the
  static bundle from `dist/`.

## License

Private — not for redistribution.
