/**
 * continuation_confirmation.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Detects continuation trend setups using 90-min cycles and 15-min swing H/L.
 *
 * BUY setup (3-stap sequence):
 *   1. 15-min 3-candle swing HIGH boven een 90-min cycle HIGH (buyside swept)
 *   2. Daarna prijs raakt LOW van enige 90-min cycle (sellside taken)
 *   3. Prijs breekt TERUG BOVEN swing high van stap 1 → BUY bevestigd
 *
 * SELL setup (omgekeerd):
 *   1. 15-min 3-candle swing LOW onder een 90-min cycle LOW (sellside swept)
 *   2. Daarna prijs raakt HIGH van enige 90-min cycle (buyside taken)
 *   3. Prijs breekt TERUG ONDER swing low van stap 1 → SELL bevestigd
 *
 * Entry windows: identiek aan hoofdstrategie
 *   C1 Phase 2: 19:30–21:00 ET  (90 min-cyclus 1)
 *   C2 Phase 2: 01:30–03:00 ET  (90 min-cyclus 5)
 *   C3 Phase 2: 07:30–09:00 ET  (90 min-cyclus 9)
 *   C4 Phase 2: 13:30–15:00 ET  (90 min-cyclus 13)
 */

// ── ET helper ─────────────────────────────────────────────────────────────────
function tsToETLabel(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── 90-min cycle boundaries ───────────────────────────────────────────────────
// 16 cycles per 24-uurs trading dag (18:00 ET → 18:00 ET volgende dag)
// Cycle i loopt van i*90 tot (i+1)*90 minuten in de trading dag.
//
// Cycle-index → ET starttijd:
//   0 = 18:00  1 = 19:30  2 = 21:00  3 = 22:30
//   4 = 00:00  5 = 01:30  6 = 03:00  7 = 04:30
//   8 = 06:00  9 = 07:30 10 = 09:00 11 = 10:30
//  12 = 12:00 13 = 13:30 14 = 15:00 15 = 16:30

function get90MinCycleIndex(minutesIntoDay) {
  if (minutesIntoDay < 0 || minutesIntoDay >= 1440) return null;
  return Math.floor(minutesIntoDay / 90);
}

function cycleLabel(idx, dayStartTs) {
  const startTs = dayStartTs + idx * 90 * 60;
  const endTs   = startTs + 90 * 60;
  return `${tsToETLabel(startTs)}–${tsToETLabel(endTs)}`;
}

// ── Bouw 90-min cycle objecten van 15-min candles ─────────────────────────────
export function build90MinCycles(candles, dayStartTs) {
  const nowTs  = Date.now() / 1000;
  const cycles = {};

  for (const c of candles) {
    const minsIntoDay = (c.timestamp - dayStartTs) / 60;
    const idx = get90MinCycleIndex(minsIntoDay);
    if (idx === null) continue;

    if (!cycles[idx]) {
      const startTs = dayStartTs + idx * 90 * 60;
      const endTs   = dayStartTs + (idx + 1) * 90 * 60;
      cycles[idx] = {
        index: idx,
        label: cycleLabel(idx, dayStartTs),
        startTs,
        endTs,
        startMin: idx * 90,
        endMin:   (idx + 1) * 90,
        // Een cycle is alleen "complete" als zijn eindtijd al voorbij is.
        // De huidige (nog-vormende) cycle telt NIET mee voor vergelijkingen.
        complete: endTs <= nowTs,
        high: -Infinity, highTs: null, highTime: null,
        low:   Infinity, lowTs:  null, lowTime:  null,
        candleCount: 0,
        hitHigh: null,
        hitLow:  null,
      };
    }

    const cyc = cycles[idx];
    cyc.candleCount++;
    if (c.high > cyc.high) { cyc.high = c.high; cyc.highTs = c.timestamp; cyc.highTime = tsToETLabel(c.timestamp); }
    if (c.low  < cyc.low)  { cyc.low  = c.low;  cyc.lowTs  = c.timestamp; cyc.lowTime  = tsToETLabel(c.timestamp); }
  }

  // Hit detection: alleen voor complete cycles
  const sortedCandles = [...candles].sort((a, b) => a.timestamp - b.timestamp);

  for (const cyc of Object.values(cycles)) {
    if (!cyc.complete || cyc.high === -Infinity) continue;

    const afterCandles = sortedCandles.filter(c => c.timestamp >= cyc.endTs);

    for (const c of afterCandles) {
      if (!cyc.hitHigh && c.high >= cyc.high) {
        cyc.hitHigh = { hitPrice: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      }
      if (!cyc.hitLow && c.low <= cyc.low) {
        cyc.hitLow = { hitPrice: c.low, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      }
      if (cyc.hitHigh && cyc.hitLow) break;
    }
  }

  return cycles;
}


// ── Phase-2 entry windows (identiek aan hoofdstrategie) ───────────────────────
const PHASE2 = {
  C1: { startMin:   90, endMin:  180, label: "19:30–21:00" },
  C2: { startMin:  450, endMin:  540, label: "01:30–03:00" },
  C3: { startMin:  810, endMin:  900, label: "07:30–09:00" },
  C4: { startMin: 1170, endMin: 1260, label: "13:30–15:00" },
};

function getEntryWindowForTs(triggerTs, dayStartTs) {
  const nowTs = Date.now() / 1000;
  const triggerMins = (triggerTs - dayStartTs) / 60;

  // Zoek het EERSTE Phase-2 window dat na het trigger-moment komt (of er al in zit)
  let best = null;
  for (const [cycle, p2] of Object.entries(PHASE2)) {
    if (p2.startMin < triggerMins) continue; // window al begonnen vóór trigger
    if (best && p2.startMin >= best.startMin) continue; // zoek dichtstbijzijnde

    const windowStartTs = dayStartTs + p2.startMin * 60;
    const windowEndTs   = dayStartTs + p2.endMin   * 60;

    let status;
    if (nowTs < windowStartTs)     status = "upcoming";
    else if (nowTs <= windowEndTs) status = "open";
    else                           status = "passed";

    best = { cycle, label: p2.label, startTs: windowStartTs, endTs: windowEndTs,
             startMin: p2.startMin, status };
  }
  return best;
}

// ── Hoofd-detectie functie ────────────────────────────────────────────────────
/**
 * Detecteert continuation trend setups op basis van 90-min cycles.
 *
 * @param {Array}  candles     - 15-min candles gesorteerd op timestamp (asc)
 * @param {number} dayStartTs  - Unix timestamp van 18:00 ET trading dag start
 * @returns {{ signals: Array, cycles90: Object }}
 *   signals  - array van gedetecteerde setups (confirmed + forming)
 *   cycles90 - alle 90-min cycle objecten (voor debug display)
 */
export function detectContinuationSignals(candles, dayStartTs) {
  if (!candles || candles.length < 3) return { signals: [], cycles90: {} };

  const nowTs = Date.now() / 1000;

  // ── Huidige tradingdag (18:00 ET vandaag → nu) ────────────────────────────
  const sortedToday = [...candles]
    .filter(c => c.timestamp >= dayStartTs - 60)
    .sort((a, b) => a.timestamp - b.timestamp);

  const cycles90 = build90MinCycles(sortedToday, dayStartTs);

  // ── Vorige tradingdag (18:00 ET gisteren → 18:00 ET vandaag) ─────────────
  // De vorige dag start 24 uur eerder. Zoek terug tot 4 dagen voor weekends/gaps.
  let prevDayCycles90 = {};
  for (let daysBack = 1; daysBack <= 4; daysBack++) {
    const prevDayStartTs = dayStartTs - daysBack * 24 * 3600;
    const prevDaySorted  = [...candles]
      .filter(c => c.timestamp >= prevDayStartTs && c.timestamp < prevDayStartTs + 24 * 3600)
      .sort((a, b) => a.timestamp - b.timestamp);

    if (prevDaySorted.length > 0) {
      // Bouw cycles met een offset zodat de index uniek blijft (prefix met 100*daysBack)
      const raw = build90MinCycles(prevDaySorted, prevDayStartTs);
      for (const [idx, cyc] of Object.entries(raw)) {
        // Alleen complete cycles van vorige dag — allemaal omdat endTs altijd < dayStartTs
        if (cyc.complete && cyc.high !== -Infinity && cyc.low !== Infinity) {
          const uniqueKey = `prev${daysBack}_${idx}`;
          prevDayCycles90[uniqueKey] = { ...cyc, prevDay: daysBack };
        }
      }
      break; // Eerste dag met data is genoeg
    }
  }

  // Combineer: alle complete cycles (vandaag + vorige dag) voor vergelijkingen
  const todayCycleList   = Object.values(cycles90).sort((a, b) => a.index - b.index);
  const prevCycleList    = Object.values(prevDayCycles90).sort((a, b) => a.startTs - b.startTs);
  const allCompleteCycles = [
    ...prevCycleList,
    ...todayCycleList.filter(c => c.complete && c.high !== -Infinity && c.low !== Infinity),
  ];

  // Alle candles vandaag + gisteren voor context
  const allSorted = [...candles]
    .filter(c => c.timestamp >= dayStartTs - 24 * 3600)
    .sort((a, b) => a.timestamp - b.timestamp);

  const signals = [];

  // ── Hulpfunctie: decimalen + SL buffer bepalen op basis van prijsniveau ──
  // forex (< 10): 5 decimalen, 5 pips buffer | indices/goud (>= 10): 2 decimalen, 5 pts buffer
  function priceDecimals(p) {
    return Math.abs(p) < 10 ? 5 : 2;
  }
  function slBuffer(p) {
    return Math.abs(p) < 10 ? 0.00050 : 5;
  }
  function roundP(p) { return +p.toFixed(priceDecimals(p)); }

  // ── Hulpfunctie: trade setup + progress berekenen ─────────────────────────
  function buildTradeSetup(entry, sl, breakC, side) {
    const dec  = priceDecimals(entry);
    const risk = Math.abs(entry - sl);
    const tp   = side === "BUY"
      ? +(entry + 2 * risk).toFixed(dec)
      : +(entry - 2 * risk).toFixed(dec);
    const setup = {
      entry: +entry.toFixed(dec),
      sl:    +sl.toFixed(dec),
      tp:    +tp,
      risk:  +risk.toFixed(dec),
      rr: 2,
      side,
    };

    const breakIdx   = allSorted.indexOf(breakC);
    const afterBreak = allSorted.slice(breakIdx + 1);
    const slCandle   = side === "BUY"
      ? afterBreak.find(c => c.low  <= sl)
      : afterBreak.find(c => c.high >= sl);
    const tpCandle   = side === "BUY"
      ? afterBreak.find(c => c.high >= tp)
      : afterBreak.find(c => c.low  <= tp);
    const lastCandle = afterBreak[afterBreak.length - 1];
    const curPrice   = lastCandle?.close ?? entry;
    const pnl        = +(side === "BUY"
      ? curPrice - entry
      : entry - curPrice).toFixed(dec);

    let outcome = "open";
    if (slCandle && tpCandle) {
      outcome = slCandle.timestamp <= tpCandle.timestamp ? "loss" : "win";
    } else if (slCandle) { outcome = "loss"; }
    else if (tpCandle)   { outcome = "win";  }

    const progress = {
      currentPrice: +curPrice.toFixed(dec),
      pnl,
      outcome,
      slHit: slCandle ? { time: tsToETLabel(slCandle.timestamp + 900), price: +sl.toFixed(dec) } : null,
      tpHit: tpCandle ? { time: tsToETLabel(tpCandle.timestamp + 900), price: +tp.toFixed(dec) } : null,
    };
    return { tradeSetup: setup, tradeProgress: progress };
  }

  // ── BUY setups ─────────────────────────────────────────────────────────────
  // Stap 1: Eerste candle van vandaag die boven de prev cycle HIGH breekt
  // Stap 2: Daarna eerste candle die de prev cycle LOW raakt (op dat moment)
  // Stap 3: Daarna eerste candle die de prev cycle HIGH raakt (op dat moment) → bevestigd
  for (let i = 1; i < allSorted.length; i++) {
    const c     = allSorted[i];
    const cPrev = allSorted[i - 1];

    // Alleen candles van vandaag
    if ((c.timestamp - dayStartTs) / 60 < 0) continue;

    // Prev cycle op dit moment
    const buysideCycle = allCompleteCycles.filter(cyc => cyc.endTs <= c.timestamp).at(-1);
    if (!buysideCycle) continue;

    // Stap 1: eerste break boven — vorige candle was niet boven, huidige wel
    if (!(c.high > buysideCycle.high && cPrev.high <= buysideCycle.high)) continue;

    // Stap 2: NA break, eerste candle die prev cycle LOW raakt (prev cycle op dat moment)
    let sellsideHit   = null;
    let sellsideCycle = null;
    for (let j = i + 1; j < allSorted.length; j++) {
      const c2  = allSorted[j];
      const pc2 = allCompleteCycles.filter(cyc => cyc.endTs <= c2.timestamp).at(-1);
      if (!pc2) continue;
      if (c2.low <= pc2.low) { sellsideHit = c2; sellsideCycle = pc2; break; }
    }
    if (!sellsideHit) continue;  // step 2 nog niet geraakt → geen signal

    // Stap 3: NA sellside, eerste candle die prev cycle HIGH raakt → bevestiging
    let confirmBuyside = null;
    let breakAbove     = null;
    const sellIdx = allSorted.indexOf(sellsideHit);
    for (let j = sellIdx + 1; j < allSorted.length; j++) {
      const c3  = allSorted[j];
      const pc3 = allCompleteCycles.filter(cyc => cyc.endTs <= c3.timestamp).at(-1);
      if (!pc3) continue;
      if (c3.high >= pc3.high) { confirmBuyside = pc3; breakAbove = c3; break; }
    }

    // Voor FORMING: meest recente 90m cycle die NA de sellside hit is gestart → live confirmation target.
    // Wordt elke monitor-run bijgewerkt zodat de confirmation HIGH meegroeit met nieuwe cycles.
    const allCyclesSorted = Object.values(cycles90).sort((a, b) => a.startTs - b.startTs);
    const nextBuyConfirmCycle = !breakAbove
      ? allCyclesSorted.filter(cyc => cyc.startTs > sellsideHit.timestamp && cyc.high !== -Infinity).at(-1)
      : null;

    const triggerTs = breakAbove ? breakAbove.timestamp : nowTs;
    const entryWin  = getEntryWindowForTs(triggerTs, dayStartTs);

    // SL = laagste candle LOW van stap-2 tot het BEGIN van het entry window
    // (of tot stap-3 als die AL BINNEN het window valt)
    const pullbackStart = sellsideHit.timestamp;
    const pullbackEnd   = (entryWin && breakAbove && breakAbove.timestamp >= entryWin.startTs)
      ? breakAbove.timestamp          // bevestiging zit in het window → stop bij bevestiging
      : (entryWin ? entryWin.startTs  // bevestiging voor window → stop bij window-start
        : (breakAbove ? breakAbove.timestamp : nowTs));
    let slCandle = null;
    for (const wc of allSorted) {
      if (wc.timestamp < pullbackStart || wc.timestamp >= pullbackEnd) continue;
      if (!slCandle || wc.low < slCandle.low) slCandle = wc;
    }
    if (!slCandle) slCandle = sellsideHit;

    let tradeSetup = null, tradeProgress = null;
    if (breakAbove && confirmBuyside) {
      ({ tradeSetup, tradeProgress } = buildTradeSetup(
        confirmBuyside.high, slCandle.low - slBuffer(slCandle.low), breakAbove, "BUY"
      ));
    }

    signals.push({
      type:             "BUY",
      confirmationType: "continuation",
      status:           breakAbove ? "confirmed" : "forming",

      // Stap 1 — buyside break
      buysideCycleIndex: buysideCycle.index,
      buysideCycleLabel: buysideCycle.label,
      buysideCycleHigh:  buysideCycle.high,
      buysideBreakTime:  tsToETLabel(c.timestamp + 900),  // close van break candle
      buysideBreakTs:    c.timestamp,

      // Stap 2 — sellside hit + laagste candle (= SL referentie)
      sellsideCycleIndex: sellsideCycle.index,
      sellsideCycleLabel: sellsideCycle.label,
      sellsideCycleLow:   sellsideCycle.low,
      sellsideHitPrice:   sellsideHit.low,
      sellsideHitTime:    tsToETLabel(sellsideHit.timestamp + 900),
      sellsideHitTs:      sellsideHit.timestamp,
      slPrice:            +(slCandle.low - slBuffer(slCandle.low)).toFixed(priceDecimals(slCandle.low)),  // laagste low - buffer
      slTime:             tsToETLabel(slCandle.timestamp + 900),   // tijdstip laagste candle

      // Stap 3 — buyside bevestiging
      // Confirmed: gebruik de cycle waarvan de HIGH daadwerkelijk gebroken is.
      // Forming: gebruik de meest recente 90m cycle NA de sellside hit (live, update elke run).
      confirmBuysideHigh:       confirmBuyside?.high  ?? nextBuyConfirmCycle?.high  ?? null,
      confirmBuysideLabel:      confirmBuyside?.label ?? nextBuyConfirmCycle?.label ?? null,
      confirmBuysideCycleIndex: confirmBuyside?.index ?? nextBuyConfirmCycle?.index ?? null,
      confirmBuysideIsLive:     !breakAbove && !!nextBuyConfirmCycle,  // true = forming, target update elke run
      breakConfirmedPrice: breakAbove ? breakAbove.high : null,
      breakConfirmedTime:  breakAbove ? tsToETLabel(breakAbove.timestamp + 900) : null,
      breakConfirmedTs:    breakAbove ? breakAbove.timestamp : null,

      tradeSetup,
      tradeProgress,
      entryWindow:  entryWin,
      windowStatus: entryWin?.status ?? "none",
    });
  }

  // ── SELL setups ────────────────────────────────────────────────────────────
  // Stap 1: Eerste candle van vandaag die onder de prev cycle LOW breekt
  // Stap 2: Daarna eerste candle die de prev cycle HIGH raakt (op dat moment)
  // Stap 3: Daarna eerste candle die de prev cycle LOW raakt (op dat moment) → bevestigd
  for (let i = 1; i < allSorted.length; i++) {
    const c     = allSorted[i];
    const cPrev = allSorted[i - 1];

    if ((c.timestamp - dayStartTs) / 60 < 0) continue;

    const sellsideCycle = allCompleteCycles.filter(cyc => cyc.endTs <= c.timestamp).at(-1);
    if (!sellsideCycle) continue;

    // Stap 1: eerste break onder — vorige candle was niet onder, huidige wel
    if (!(c.low < sellsideCycle.low && cPrev.low >= sellsideCycle.low)) continue;

    // Stap 2: NA break, eerste candle die prev cycle HIGH raakt
    let buysideHit   = null;
    let buysideCycle = null;
    for (let j = i + 1; j < allSorted.length; j++) {
      const c2  = allSorted[j];
      const pc2 = allCompleteCycles.filter(cyc => cyc.endTs <= c2.timestamp).at(-1);
      if (!pc2) continue;
      if (c2.high >= pc2.high) { buysideHit = c2; buysideCycle = pc2; break; }
    }
    if (!buysideHit) continue;

    // Stap 3: NA buyside, eerste candle die prev cycle LOW raakt → bevestiging
    let confirmSellside = null;
    let breakBelow      = null;
    const buyIdx = allSorted.indexOf(buysideHit);
    for (let j = buyIdx + 1; j < allSorted.length; j++) {
      const c3  = allSorted[j];
      const pc3 = allCompleteCycles.filter(cyc => cyc.endTs <= c3.timestamp).at(-1);
      if (!pc3) continue;
      if (c3.low <= pc3.low) { confirmSellside = pc3; breakBelow = c3; break; }
    }

    // Voor FORMING: meest recente 90m cycle NA de buyside hit → live confirmation target.
    const allCyclesSortedS = Object.values(cycles90).sort((a, b) => a.startTs - b.startTs);
    const nextSellConfirmCycle = !breakBelow
      ? allCyclesSortedS.filter(cyc => cyc.startTs > buysideHit.timestamp && cyc.low !== Infinity).at(-1)
      : null;

    const triggerTs = breakBelow ? breakBelow.timestamp : nowTs;
    const entryWin  = getEntryWindowForTs(triggerTs, dayStartTs);

    // SL = hoogste candle HIGH van stap-2 tot het BEGIN van het entry window
    // (of tot stap-3 als die AL BINNEN het window valt)
    const pullbackStart = buysideHit.timestamp;
    const pullbackEnd   = (entryWin && breakBelow && breakBelow.timestamp >= entryWin.startTs)
      ? breakBelow.timestamp
      : (entryWin ? entryWin.startTs
        : (breakBelow ? breakBelow.timestamp : nowTs));
    let slCandle = null;
    for (const wc of allSorted) {
      if (wc.timestamp < pullbackStart || wc.timestamp >= pullbackEnd) continue;
      if (!slCandle || wc.high > slCandle.high) slCandle = wc;
    }
    if (!slCandle) slCandle = buysideHit;

    let tradeSetup = null, tradeProgress = null;
    if (breakBelow && confirmSellside) {
      ({ tradeSetup, tradeProgress } = buildTradeSetup(
        confirmSellside.low, slCandle.high + slBuffer(slCandle.high), breakBelow, "SELL"
      ));
    }

    signals.push({
      type:             "SELL",
      confirmationType: "continuation",
      status:           breakBelow ? "confirmed" : "forming",

      // Stap 1 — sellside break
      sellsideCycleIndex: sellsideCycle.index,
      sellsideCycleLabel: sellsideCycle.label,
      sellsideCycleLow:   sellsideCycle.low,
      sellsideBreakTime:  tsToETLabel(c.timestamp + 900),
      sellsideBreakTs:    c.timestamp,

      // Stap 2 — buyside hit + hoogste candle (= SL referentie)
      buysideCycleIndex: buysideCycle.index,
      buysideCycleLabel: buysideCycle.label,
      buysideCycleHigh:  buysideCycle.high,
      buysideHitPrice:   buysideHit.high,
      buysideHitTime:    tsToETLabel(buysideHit.timestamp + 900),
      buysideHitTs:      buysideHit.timestamp,
      slPrice:           +(slCandle.high + slBuffer(slCandle.high)).toFixed(priceDecimals(slCandle.high)),  // hoogste high + buffer
      slTime:            tsToETLabel(slCandle.timestamp + 900),   // tijdstip hoogste candle

      // Stap 3 — sellside bevestiging
      // Confirmed: cycle waarvan de LOW daadwerkelijk gebroken is.
      // Forming: meest recente 90m cycle NA de buyside hit (live, update elke run).
      confirmSellsideLow:          confirmSellside?.low   ?? nextSellConfirmCycle?.low   ?? null,
      confirmSellsideLabel:        confirmSellside?.label ?? nextSellConfirmCycle?.label ?? null,
      confirmSellsideCycleIndex:   confirmSellside?.index ?? nextSellConfirmCycle?.index ?? null,
      confirmSellsideIsLive:       !breakBelow && !!nextSellConfirmCycle,
      breakConfirmedPrice:  breakBelow ? breakBelow.low : null,
      breakConfirmedTime:   breakBelow ? tsToETLabel(breakBelow.timestamp + 900) : null,
      breakConfirmedTs:     breakBelow ? breakBelow.timestamp : null,

      tradeSetup,
      tradeProgress,
      entryWindow:  entryWin,
      windowStatus: entryWin?.status ?? "none",
    });
  }

  // Dedupliceer: per (type, entryWindow.cycle) behoud de meest recente break
  const deduped = [];
  const seen    = new Map();

  for (const s of signals) {
    const breakTs = s.type === "BUY" ? s.buysideBreakTs : s.sellsideBreakTs;
    const key     = `${s.type}-${s.entryWindow?.cycle ?? "none"}`;
    const prev    = seen.get(key);
    const prevTs  = prev ? (prev.type === "BUY" ? prev.buysideBreakTs : prev.sellsideBreakTs) : -1;
    if (!prev || breakTs > prevTs) seen.set(key, s);
  }
  for (const s of seen.values()) deduped.push(s);

  // Sorteer: meest relevante setup BOVENAAN
  // Prioriteit: open window > upcoming > actieve trade (open outcome) > gesloten trade > forming
  // Binnen zelfde prioriteit: meest recente window eerst (hoogste startMin)
  function signalPriority(s) {
    const ws      = s.windowStatus;
    const outcome = s.tradeProgress?.outcome ?? "open";
    if (ws === "open")                                      return 0; // window nu actief
    if (ws === "upcoming")                                  return 1; // window komt eraan
    if (s.status === "confirmed" && outcome === "open")     return 2; // actieve trade loopt
    if (s.status === "confirmed" && outcome !== "open")     return 3; // afgeronde trade
    return 4;                                                         // forming / rest
  }
  deduped.sort((a, b) => {
    const pa = signalPriority(a);
    const pb = signalPriority(b);
    if (pa !== pb) return pa - pb;
    // Zelfde prioriteit: meest recente window eerst (C4 > C3 > C2 > C1)
    return (b.entryWindow?.startMin ?? 0) - (a.entryWindow?.startMin ?? 0);
  });

  return { signals: deduped, cycles90 };
}
