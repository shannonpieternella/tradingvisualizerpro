import React from "react";
import "./AllSignalsView.css";

const MARKET_LABELS = { NAS100: "NAS100", XAUUSD: "XAU/USD", GBPUSD: "GBP/USD" };

function fmtPrice(p) {
  if (p == null) return "—";
  if (p > 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return p.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

// Returns 0–100: how far price has moved from entry toward TP1 (positive = good)
// negative = moved toward SL
function calcProgress(s, price) {
  if (price == null || s.entry == null) return null;
  const isLong = s.type === "LONG";

  // Distance from entry toward TP direction
  const toTP  = s.tp1 != null ? Math.abs(s.tp1 - s.entry) : null;
  const toSL  = s.sl  != null ? Math.abs(s.sl  - s.entry) : null;

  const moved = isLong ? price - s.entry : s.entry - price; // positive = moving in right direction

  return { moved, toTP, toSL };
}

export default function AllSignalsView({ marketsData }) {
  const markets = Object.entries(marketsData).filter(([, v]) => v != null);

  // Active = entry window open RIGHT NOW
  // Upcoming = window hasn't started yet
  const windowOpen  = [];  // truly open now → trade
  const windowSoon  = [];  // upcoming

  for (const [key, v] of markets) {
    const sig   = v.signal ?? {};
    const price = v.currentPrice;
    const trade = v.activeTrade;

    for (const s of sig.active ?? [])   windowOpen.push({ ...s, market: key, price, trade });
    for (const s of sig.upcoming ?? []) windowSoon.push({ ...s, market: key });
  }

  const hasOpen = windowOpen.length > 0;
  const hasSoon = windowSoon.length > 0;

  if (!hasOpen && !hasSoon) {
    return (
      <div className="asv-empty card">
        <span className="asv-empty-dot" />
        <span className="asv-empty-label">STANDBY · Alle markten</span>
        <span className="asv-empty-sub">Geen open entry windows · Monitor wacht op setup</span>
      </div>
    );
  }

  return (
    <div className="asv-wrap">
      {hasOpen && (
        <div className="asv-section">
          <div className="asv-section-title">
            <span className="asv-live-dot" />
            ENTRY WINDOW OPEN — HANDEL NU
          </div>
          <div className="asv-cards">
            {windowOpen.map((s, i) => <ActiveSignalCard key={i} s={s} />)}
          </div>
        </div>
      )}

      {hasSoon && (
        <div className="asv-section">
          <div className="asv-section-title asv-title-soon">
            <span className="asv-soon-dot" />
            BINNENKORT — ENTRY WINDOW NADERT
          </div>
          <div className="asv-cards">
            {windowSoon.map((s, i) => <UpcomingSignalCard key={i} s={s} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveSignalCard({ s }) {
  const isLong  = s.type === "LONG";
  const price   = s.price;
  const prog    = price != null ? calcProgress(s, price) : null;
  const moved   = prog?.moved ?? 0;
  const toTP    = prog?.toTP;
  const toSL    = prog?.toSL;

  // Gauge: -100 = at SL, 0 = at entry, 100 = at TP1
  let gaugeVal = 0;
  if (moved > 0 && toTP) gaugeVal = Math.min(100, (moved / toTP) * 100);
  if (moved < 0 && toSL) gaugeVal = Math.max(-100, (moved / toSL) * 100);

  const inProfit   = moved > 0;
  const inDrawdown = moved < 0;
  const atEntry    = Math.abs(moved) < (s.entry > 100 ? 2 : 0.0002);

  const pips = s.entry > 100
    ? Math.abs(moved).toFixed(1) + " pts"
    : (Math.abs(moved) * 10000).toFixed(1) + " pips";

  return (
    <div className={`asv-active-card ${isLong ? "asc-long" : "asc-short"}`}>
      {/* Top row */}
      <div className="asc-top">
        <div className="asc-left">
          <div className="asc-type-row">
            {s.windowStatus === "open"
              ? <span className="asc-badge-live">LIVE</span>
              : <span className="asc-badge-active">ACTIEF</span>
            }
            <span className={`asc-direction ${isLong ? "asc-dir-long" : "asc-dir-short"}`}>
              {isLong ? "▲ LONG" : "▼ SHORT"}
            </span>
            <span className="asc-market">{MARKET_LABELS[s.market] ?? s.market}</span>
            <span className="asc-cycle">{s.cycle}</span>
          </div>
          {s.windowStatus === "open"
            ? <div className="asc-window">Window open t/m <strong>{s.until} ET</strong></div>
            : <div className="asc-window asc-window-passed">Entry window gesloten · wacht op nieuw setup</div>
          }
        </div>
        <div className="asc-right">
          <div className="asc-price-now">{fmtPrice(price)}</div>
          <div className="asc-price-label">live prijs</div>
        </div>
      </div>

      {/* Levels row */}
      <div className="asc-levels">
        <div className="asc-level-item">
          <span className="asc-lbl">SL</span>
          <span className="asc-val asc-sl">{s.sl != null ? fmtPrice(s.sl) : "TBD"}</span>
        </div>
        <div className="asc-level-item">
          <span className="asc-lbl">ENTRY</span>
          <span className="asc-val asc-entry">{fmtPrice(s.entry)}</span>
        </div>
        <div className="asc-level-item">
          <span className="asc-lbl">TP1</span>
          <span className="asc-val asc-tp">{s.tp1 != null ? fmtPrice(s.tp1) : "—"}</span>
        </div>
        <div className="asc-level-item">
          <span className="asc-lbl">TP2</span>
          <span className="asc-val asc-tp">{s.tp2 != null ? fmtPrice(s.tp2) : "—"}</span>
        </div>
      </div>

      {/* Drawdown / profit gauge */}
      <div className="asc-gauge-wrap">
        <div className="asc-gauge-track">
          {/* SL zone (left) */}
          <div className="asc-gauge-sl-zone" />
          {/* Entry center line */}
          <div className="asc-gauge-center" />
          {/* TP zone (right) */}
          <div className="asc-gauge-tp-zone" />
          {/* Fill bar */}
          {gaugeVal !== 0 && (
            <div
              className={`asc-gauge-fill ${gaugeVal > 0 ? "gf-profit" : "gf-loss"}`}
              style={{
                left:  gaugeVal > 0 ? "50%" : `${50 + gaugeVal / 2}%`,
                width: `${Math.abs(gaugeVal) / 2}%`,
              }}
            />
          )}
          {/* Price cursor */}
          <div
            className={`asc-gauge-cursor ${inProfit ? "gc-profit" : inDrawdown ? "gc-loss" : "gc-neutral"}`}
            style={{ left: `${50 + gaugeVal / 2}%` }}
          />
        </div>
        <div className="asc-gauge-labels">
          <span className="agl-sl">← SL</span>
          <span className={`agl-status ${atEntry ? "s-at" : inProfit ? "s-profit" : "s-dd"}`}>
            {atEntry
              ? "● AT ENTRY"
              : inProfit
              ? `+${pips} winst`
              : `-${pips} drawdown`}
          </span>
          <span className="agl-tp">TP1 →</span>
        </div>
      </div>
    </div>
  );
}

function UpcomingSignalCard({ s }) {
  const isLong = s.type === "LONG";
  return (
    <div className={`asv-soon-card ${isLong ? "sc-long" : "sc-short"}`}>
      <span className={`sc-arrow ${isLong ? "sca-long" : "sca-short"}`}>{isLong ? "▲" : "▼"}</span>
      <div className="sc-body">
        <div className="sc-type-row">
          <span className="sc-type">{s.type}</span>
          <span className="sc-market">{MARKET_LABELS[s.market] ?? s.market}</span>
          <span className="sc-cycle">{s.cycle}</span>
        </div>
        <div className="sc-window">Window: <strong>{s.window} ET</strong></div>
      </div>
      <div className="sc-level-wrap">
        <div className="sc-level-lbl">TRIGGER</div>
        <div className="sc-level mono">{fmtPrice(s.level)}</div>
      </div>
    </div>
  );
}
