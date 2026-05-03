import React from "react";
import { useLiveData } from "../contexts/LiveDataContext.jsx";
import "./PremiumDiscountPanel.css";

const MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];

function fp(p) {
  if (p == null) return "—";
  if (p > 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return p.toFixed(5);
}

// Premium / Discount zone calculation.
//   eq   = (high + low) / 2
//   < eq → DISCOUNT (favors BUY)
//   > eq → PREMIUM  (favors SELL)
// Display-only — no setup filtering. When the active setup direction aligns
// with the zone we surface it as a "GOLDEN" alignment indicator.
function computePD(high, low, currentPrice) {
  if (high == null || low == null || currentPrice == null) return null;
  const range = high - low;
  if (range <= 0) return null;
  const raw = ((currentPrice - low) / range) * 100;
  const pct = Math.max(0, Math.min(100, raw));
  return {
    pct,
    eq:   (high + low) / 2,
    high,
    low,
    zone: raw < 50 ? "DISCOUNT" : "PREMIUM",
  };
}

// Pick the most-recent completed 6H cycle as the reference range. Same shape
// as build6HSignal in LiveSignals — keeps the two views consistent so a
// "GOLDEN" tag here corresponds to the same cycle the card uses.
function ref6HCycle(cycles6H) {
  if (!cycles6H?.length) return null;
  const completed = [...cycles6H]
    .filter(c => c.status === "complete" && c.high != null && c.low != null)
    .reverse();
  return completed[0] ?? null;
}

// Daily reference = today's running high/low. Monitor.js exposes dailyLevels[]
// where the entry with isToday=true tracks the current trading day from the
// 18:00 ET session boundary onward — exactly what the user asked for.
function refDailyToday(dailyLevels) {
  return (dailyLevels ?? []).find(d => d?.isToday) ?? null;
}

// Weekly reference = aggregate high/low over the current trading week.
// Walks back from today's entry until it hits a Sunday (ICT trading week
// starts at the Sunday 18:00 ET session open). Falls back to rolling 7d if
// no Sunday boundary is present in the data window.
function refWeeklyRange(dailyLevels) {
  if (!dailyLevels?.length) return null;
  const todayIdx = dailyLevels.findIndex(d => d?.isToday);
  if (todayIdx < 0) return null;

  let startIdx = Math.max(0, todayIdx - 6);  // rolling 7d default
  for (let i = todayIdx; i >= Math.max(0, todayIdx - 7); i--) {
    if (dailyLevels[i]?.date?.startsWith("Sun")) { startIdx = i; break; }
  }

  const slice = dailyLevels.slice(startIdx, todayIdx + 1);
  const highs = slice.filter(d => d.high != null).map(d => d.high);
  const lows  = slice.filter(d => d.low  != null).map(d => d.low);
  if (!highs.length || !lows.length) return null;
  return {
    high:    Math.max(...highs),
    low:     Math.min(...lows),
    days:    slice.length,
    fromDay: slice[0]?.date,
  };
}

function isAligned(direction, zone) {
  if (!direction || !zone) return false;
  return (direction === "BUY"  && zone === "DISCOUNT")
      || (direction === "SELL" && zone === "PREMIUM");
}

function ZoneRow({ label, pd, alignDirection }) {
  if (!pd) {
    return (
      <div className="pdp-zone pdp-empty">
        <span className="pdp-zone-label">{label}</span>
        <span className="pdp-no-data">geen data</span>
      </div>
    );
  }
  const aligned = isAligned(alignDirection, pd.zone);
  const cls = pd.zone === "DISCOUNT" ? "discount" : "premium";
  return (
    <div className={`pdp-zone pdp-${cls} ${aligned ? "pdp-golden" : ""}`}>
      <span className="pdp-zone-label">{label}</span>
      <span className="pdp-zone-bar" aria-hidden>
        <span className="pdp-zone-bar-fill" style={{ width: `${pd.pct}%` }} />
        <span className="pdp-zone-bar-eq" />
      </span>
      <span className="pdp-zone-pct">{pd.pct.toFixed(0)}%</span>
      <span className="pdp-zone-tag">{pd.zone}</span>
      <span className="pdp-zone-levels">
        <span title="High">H {fp(pd.high)}</span>
        <span title="Equilibrium 50%" className="pdp-eq">EQ {fp(pd.eq)}</span>
        <span title="Low">L {fp(pd.low)}</span>
      </span>
      {aligned && <span className="pdp-golden-tag">⭐ GOLDEN</span>}
    </div>
  );
}

export default function PremiumDiscountPanel({ activeMarket = null }) {
  const { markets } = useLiveData();
  const marketsToShow = activeMarket ? [activeMarket] : MARKETS;

  return (
    <div className="pdp-wrap">
      <div className="pdp-header">
        <span className="pdp-title">⚖ Premium / Discount Zones</span>
        <span className="pdp-subtitle">
          Daily &amp; 6H — koers t.o.v. equilibrium (50%). Geen filter; alignment = ⭐ GOLDEN.
        </span>
      </div>

      <div className="pdp-grid">
        {marketsToShow.map(mk => {
          const d = markets[mk];
          if (!d) {
            return (
              <div key={mk} className="pdp-card pdp-card-empty">
                <span className="pdp-mk">{mk}</span>
                <span className="pdp-no-data">geen data</span>
              </div>
            );
          }

          const price = d.currentPrice;
          const ref6H   = ref6HCycle(d.cycles6H);
          const refDay  = refDailyToday(d.dailyLevels);
          const refWeek = refWeeklyRange(d.dailyLevels);

          const pd6H   = ref6H   ? computePD(ref6H.high,   ref6H.low,   price) : null;
          const pdDay  = refDay  ? computePD(refDay.high,  refDay.low,  price) : null;
          const pdWeek = refWeek ? computePD(refWeek.high, refWeek.low, price) : null;

          // Direction used for golden-alignment: prefer the active setup's
          // direction when present; fall back to the dashboard's allowedDirection
          // (admin bias / lock direction) so we still mark "favorable" zones
          // even before a setup has formed.
          const alignDirection = d.activeSetup?.direction
            ?? d.allowedDirection
            ?? null;

          // Stacked golden = ALL three available zones agree with the
          // direction the trader is pursuing — strongest confluence.
          const presentZones = [pdWeek, pdDay, pd6H].filter(Boolean);
          const fullStack = !!(alignDirection
            && presentZones.length >= 2
            && presentZones.every(pd => isAligned(alignDirection, pd.zone)));

          const weekLabel = refWeek
            ? `WEEKLY (${refWeek.days}d range, vanaf ${refWeek.fromDay ?? "—"})`
            : "WEEKLY (7d range)";

          return (
            <div key={mk} className={`pdp-card ${fullStack ? "pdp-stacked-golden" : ""}`}>
              <div className="pdp-card-head">
                <span className="pdp-mk">{mk}</span>
                <span className="pdp-price">{fp(price)}</span>
                {alignDirection && (
                  <span className={`pdp-dir ${alignDirection === "BUY" ? "buy" : "sell"}`}>
                    {alignDirection === "BUY" ? "▲ BUY bias" : "▼ SELL bias"}
                  </span>
                )}
                {fullStack && <span className="pdp-stack-tag">⭐ STACKED GOLDEN — Weekly + Daily + 6H aligned</span>}
              </div>

              <ZoneRow label={weekLabel}              pd={pdWeek} alignDirection={alignDirection} />
              <ZoneRow label="DAILY (18:00 ET → now)" pd={pdDay}  alignDirection={alignDirection} />
              <ZoneRow label="6H (ref cycle)"         pd={pd6H}   alignDirection={alignDirection} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
