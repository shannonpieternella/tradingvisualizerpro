// Shared SL calculator — single source of truth for the sweep-window rule.
// Used by monitor.js (live entry-trigger + per-tick repair), weekly-backtest-v2.mjs,
// and any other code that places or validates stop-loss on sweep-sweep setups.
//
//   BUY  SL = lowest low  in window [step2Ts, entryTs] - buffer
//   SELL SL = highest high in window [step2Ts, entryTs] + buffer
//
// The window covers the ENTIRE sweep — from the moment the level was broken
// through to the entry candle — so the SL sits beneath the deepest point the
// sweep reached, not just the first candle that triggered step 2.

export function computeSweepSL({ direction, candles, step2Ts, entryTs, entryPrice, sweepPrice = null }) {
  const dec = entryPrice > 100 ? 1 : 5;
  const buf = entryPrice > 10000 ? 5 : entryPrice > 1000 ? 2 : entryPrice > 10 ? 0.5 : 0.0005;
  const win = (step2Ts && entryTs && candles?.length)
    ? candles.filter(c => c.timestamp >= step2Ts && c.timestamp <= entryTs)
    : [];
  if (direction === "BUY") {
    const base = win.length ? Math.min(...win.map(c => c.low)) : (sweepPrice ?? entryPrice);
    return +(base - buf).toFixed(dec);
  } else {
    const base = win.length ? Math.max(...win.map(c => c.high)) : (sweepPrice ?? entryPrice);
    return +(base + buf).toFixed(dec);
  }
}

// Strategy: TP1 at 1R, TP2 at 2R, TP3 at 10R (runner — SL trails to entry once
// TP2 is hit, so TP3 leg runs risk-free for the long-tail target).
// Outcome verification records which TP was reached first before SL:
//   SL before TP1 → LOSS
//   TP1 hit → WIN (rMulti=1); TP2 also hit → rMulti=2; TP3 also hit → rMulti=10
export function computeSweepTP(direction, entry, sl) {
  const dec = entry > 100 ? 1 : 5;
  const risk = Math.abs(entry - sl);
  return {
    tp1: +(direction === "BUY" ? entry + 1  * risk : entry - 1  * risk).toFixed(dec),
    tp2: +(direction === "BUY" ? entry + 2  * risk : entry - 2  * risk).toFixed(dec),
    tp3: +(direction === "BUY" ? entry + 10 * risk : entry - 10 * risk).toFixed(dec),
    risk: +risk.toFixed(dec),
  };
}

// Verify outcome against post-entry candles. Returns which target was reached:
//   { outcome: "WIN" | "LOSS" | null, rMulti: 1 | 2 | -1 | null, hitTs, hitPrice, tp1Hit, tp2Hit }
export function verifyOutcome({ direction, candles, entryTs, entry, sl, tp1, tp2 }) {
  const isBuy = direction === "BUY";
  const post = candles.filter(c => c.timestamp > entryTs);
  let tp1Hit = false, tp2Hit = false;
  let outcome = null, rMulti = null, hitTs = null, hitPrice = null;
  for (const c of post) {
    const slBroken  = isBuy ? c.low  <= sl  : c.high >= sl;
    const tp1Broken = isBuy ? c.high >= tp1 : c.low  <= tp1;
    const tp2Broken = isBuy ? c.high >= tp2 : c.low  <= tp2;
    if (slBroken && !tp1Hit) {
      return { outcome: "LOSS", rMulti: -1, hitTs: c.timestamp, hitPrice: sl, tp1Hit, tp2Hit };
    }
    if (tp1Broken && !tp1Hit) {
      tp1Hit = true; outcome = "WIN"; rMulti = 1; hitTs = c.timestamp; hitPrice = tp1;
    }
    if (tp2Broken && tp1Hit && !tp2Hit) {
      tp2Hit = true; rMulti = 2; hitTs = c.timestamp; hitPrice = tp2;
      break;
    }
  }
  return { outcome, rMulti, hitTs, hitPrice, tp1Hit, tp2Hit };
}
