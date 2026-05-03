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

          const pd6H  = ref6H  ? computePD(ref6H.high,  ref6H.low,  price) : null;
          const pdDay = refDay ? computePD(refDay.high, refDay.low, price) : null;

          // Direction used for golden-alignment: prefer the active setup's
          // direction when present; fall back to the dashboard's allowedDirection
          // (admin bias / lock direction) so we still mark "favorable" zones
          // even before a setup has formed.
          const alignDirection = d.activeSetup?.direction
            ?? d.allowedDirection
            ?? null;

          // If BOTH zones agree with the direction the trader is pursuing it
          // is the strongest signal — call that out separately from per-row golden.
          const fullStack = alignDirection
            && pd6H && pdDay
            && isAligned(alignDirection, pd6H.zone)
            && isAligned(alignDirection, pdDay.zone);

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
                {fullStack && <span className="pdp-stack-tag">⭐ STACKED GOLDEN — Daily + 6H aligned</span>}
              </div>

              <ZoneRow label="DAILY (18:00 ET → now)" pd={pdDay} alignDirection={alignDirection} />
              <ZoneRow label="6H (ref cycle)"          pd={pd6H}  alignDirection={alignDirection} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
