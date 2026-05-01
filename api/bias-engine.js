/**
 * BLACKBULL Autonomous Bias Engine
 * ─────────────────────────────────
 * Computes weekly/daily OHLC, detects equal highs/lows,
 * day-of-week patterns, and outputs a structured bias result.
 *
 * All timestamps are in seconds (Unix).
 * All price logic is for NAS100 by default (tolerance in points).
 */

// ── ET helpers ────────────────────────────────────────────────────────────────

export function getETInfo(ts) {
  const date = new Date(ts * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const get = type => parts.find(p => p.type === type)?.value;
  const h   = parseInt(get("hour"));
  const m   = parseInt(get("minute"));
  const day = get("weekday"); // Mon, Tue, Wed, Thu, Fri, Sat, Sun

  const DAY_MAP = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year:    parseInt(get("year")),
    month:   parseInt(get("month")),
    day:     parseInt(get("day")),
    hour:    h,
    minute:  m,
    weekday: DAY_MAP[day] ?? 0,
    weekdayName: day,
  };
}

// A "trading day" opens at 18:00 ET. The label of the day is the NEXT
// calendar day (e.g., the session opening Sunday 18:00 is called "Monday").
export function getTradingDayKey(ts) {
  const et = getETInfo(ts);
  if (et.hour >= 18) {
    // After 18:00 → belongs to next calendar day's session
    const next = new Date(ts * 1000 + 24 * 3600 * 1000);
    const np = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(next);
    const g = type => np.find(p => p.type === type)?.value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  }
  return `${et.year}-${String(et.month).padStart(2,"0")}-${String(et.day).padStart(2,"0")}`;
}

// Same but returns YYYY-WNN key (ISO-ish week within ET trading)
export function getTradingWeekKey(ts) {
  const et   = getETInfo(ts);
  let   dayTs = ts;
  if (et.hour >= 18) dayTs += 24 * 3600;
  const d2   = new Date(dayTs * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(d2);
  const g = type => parts.find(p => p.type === type)?.value;
  const wd = g("weekday");
  const WD_TO_OFFSET = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = WD_TO_OFFSET[wd] ?? 0;
  const monday = new Date(d2);
  monday.setDate(d2.getDate() - offset);
  const mp = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(monday);
  const gm = type => mp.find(p => p.type === type)?.value;
  return `${gm("year")}-W${gm("month")}-${gm("day")}`;
}

export function getTradingDayName(ts) {
  const et = getETInfo(ts);
  let useTs = ts;
  if (et.hour >= 18) useTs += 24 * 3600;
  const d = new Date(useTs * 1000);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "long",
  }).formatToParts(d);
  return p.find(x => x.type === "weekday")?.value ?? "Unknown";
}

// ── Candle aggregation ────────────────────────────────────────────────────────

/**
 * Aggregate 15-min candles into 1H candles by grouping every 4 candles
 * that fall within the same clock hour (ET). Produces always-fresh hourly
 * data without an extra MCP fetch — monitor already runs every 15 min.
 */
export function aggregate15ToHourly(candles15) {
  if (!candles15?.length) return [];
  const map = new Map();
  for (const c of candles15) {
    const et  = getETInfo(c.timestamp);
    const key = `${et.year}-${String(et.month).padStart(2,"0")}-${String(et.day).padStart(2,"0")}-${String(et.hour).padStart(2,"0")}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const hourly = [];
  for (const [, cs] of map) {
    const sorted = cs.sort((a, b) => a.timestamp - b.timestamp);
    hourly.push({
      timestamp: sorted[0].timestamp,
      time_et:   sorted[0].time_et,
      open:      sorted[0].open,
      high:      Math.max(...sorted.map(x => x.high)),
      low:       Math.min(...sorted.map(x => x.low)),
      close:     sorted[sorted.length - 1].close,
      volume:    sorted.reduce((s, x) => s + (x.volume ?? 0), 0),
    });
  }
  return hourly.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Candle grouping ───────────────────────────────────────────────────────────

export function groupCandlesByDay(candles) {
  const map = new Map();
  for (const c of candles) {
    const key = getTradingDayKey(c.timestamp);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const days = [];
  for (const [key, cs] of map) {
    const sorted = cs.sort((a, b) => a.timestamp - b.timestamp);
    // C3 = 06:00–12:00 ET
    const c3Candles = sorted.filter(c => {
      const h = getETInfo(c.timestamp).hour;
      return h >= 6 && h < 12;
    });
    days.push({
      key,
      dayName:   getTradingDayName(sorted[0].timestamp),
      open:      sorted[0].open,
      high:      Math.max(...sorted.map(c => c.high)),
      low:       Math.min(...sorted.map(c => c.low)),
      close:     sorted[sorted.length - 1].close,
      volume:    sorted.reduce((s, c) => s + (c.volume ?? 0), 0),
      candles:   sorted,
      startTs:   sorted[0].timestamp,
      endTs:     sorted[sorted.length - 1].timestamp,
      // 15-min: >20 candles means full day. Daily/1h: 1 candle = complete day (already OHLC).
      isComplete: sorted.length > 20 || (sorted.length <= 6 && sorted.length > 0 && sorted[0].volume > 0),
      // C3 session high/low (06:00–12:00 ET) — order flow reference
      c3High:    c3Candles.length ? Math.max(...c3Candles.map(c => c.high)) : null,
      c3Low:     c3Candles.length ? Math.min(...c3Candles.map(c => c.low))  : null,
      c3Candles: c3Candles.length,
    });
  }
  return days.sort((a, b) => a.startTs - b.startTs);
}

export function groupCandlesByWeek(candles) {
  const map = new Map();
  for (const c of candles) {
    const key = getTradingWeekKey(c.timestamp);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const weeks = [];
  for (const [key, cs] of map) {
    const sorted = cs.sort((a, b) => a.timestamp - b.timestamp);
    weeks.push({
      key,
      open:    sorted[0].open,
      high:    Math.max(...sorted.map(c => c.high)),
      low:     Math.min(...sorted.map(c => c.low)),
      close:   sorted[sorted.length - 1].close,
      candles: sorted,
      startTs: sorted[0].timestamp,
      endTs:   sorted[sorted.length - 1].timestamp,
    });
  }
  return weeks.sort((a, b) => a.startTs - b.startTs);
}

// ── Current cycle helper ──────────────────────────────────────────────────────

export function getCurrentCycle() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  const etH = h + m / 60;
  // Trading day: C1=18-24, C2=0-6, C3=6-12, C4=12-18
  if (etH >= 18) return "C1";
  if (etH >= 12) return "C4";
  if (etH >= 6)  return "C3";
  return "C2";
}

// ── Equal High / Low detection ────────────────────────────────────────────────

/**
 * Find "equal" (sloppy) highs across daily candles.
 * Two highs are "equal" if they are within `tolerancePct` % of each other.
 * We only flag them if price has NOT already swept above both.
 */
export function findEqualHighs(days, tolerancePct = 0.3, currentPrice = null) {
  const results = [];
  const useDays = days.filter(d => d.isComplete || d === days[days.length - 1]);

  for (let i = 0; i < useDays.length - 1; i++) {
    for (let j = i + 1; j < useDays.length; j++) {
      const h1 = useDays[i].high;
      const h2 = useDays[j].high;
      const diffPct = Math.abs(h1 - h2) / h1 * 100;
      if (diffPct > tolerancePct) continue;

      const level = Math.max(h1, h2);
      // Check if already swept (any candle after j went above level + small buffer)
      const afterCandles = days.slice(j + 1).flatMap(d => d.candles);
      const swept = afterCandles.some(c => c.high > level + level * 0.001);

      if (!swept) {
        results.push({
          level:    +level.toFixed(2),
          highA:    +h1.toFixed(2),
          highB:    +h2.toFixed(2),
          dayA:     useDays[i].dayName,
          dayB:     useDays[j].dayName,
          dateA:    useDays[i].key,
          dateB:    useDays[j].key,
          diffPct:  +diffPct.toFixed(3),
          swept:    false,
          type:     "EQH",
          // Price relative to level
          priceDistance: currentPrice ? +(level - currentPrice).toFixed(2) : null,
        });
      }
    }
  }
  // Deduplicate: keep only unique levels (within 5 points of each other)
  return dedupLevels(results, "level", 5);
}

export function findEqualLows(days, tolerancePct = 0.3, currentPrice = null) {
  const results = [];
  const useDays = days.filter(d => d.isComplete || d === days[days.length - 1]);

  for (let i = 0; i < useDays.length - 1; i++) {
    for (let j = i + 1; j < useDays.length; j++) {
      const l1 = useDays[i].low;
      const l2 = useDays[j].low;
      const diffPct = Math.abs(l1 - l2) / l1 * 100;
      if (diffPct > tolerancePct) continue;

      const level = Math.min(l1, l2);
      const afterCandles = days.slice(j + 1).flatMap(d => d.candles);
      const swept = afterCandles.some(c => c.low < level - level * 0.001);

      if (!swept) {
        results.push({
          level:    +level.toFixed(2),
          lowA:     +l1.toFixed(2),
          lowB:     +l2.toFixed(2),
          dayA:     useDays[i].dayName,
          dayB:     useDays[j].dayName,
          dateA:    useDays[i].key,
          dateB:    useDays[j].key,
          diffPct:  +diffPct.toFixed(3),
          swept:    false,
          type:     "EQL",
          priceDistance: currentPrice ? +(currentPrice - level).toFixed(2) : null,
        });
      }
    }
  }
  return dedupLevels(results, "level", 5);
}

function dedupLevels(items, key, threshold) {
  const kept = [];
  for (const item of items) {
    const dup = kept.find(k => Math.abs(k[key] - item[key]) < threshold);
    if (!dup) kept.push(item);
    else if (item.diffPct < dup.diffPct) Object.assign(dup, item);
  }
  return kept;
}

// ── Expanding week detection ──────────────────────────────────────────────────

export function detectExpandingWeek(currentWeek, previousWeek) {
  if (!previousWeek) return { isExpanding: false, side: null };
  const highBreak = currentWeek.high > previousWeek.high;
  const lowBreak  = currentWeek.low  < previousWeek.low;
  if (highBreak && lowBreak) return { isExpanding: true, side: "BOTH" };
  if (highBreak) return { isExpanding: true, side: "HIGH" };
  if (lowBreak)  return { isExpanding: true, side: "LOW" };
  return { isExpanding: false, side: null };
}

// ── Order Flow analysis (PRIMARY BIAS SIGNAL) ─────────────────────────────────
//
// Bullish order flow: prevDay C3 high broken by the next day → bulls activated.
//   Stays bullish as long as each subsequent day's low > prevDay's low (higher lows = structure intact).
// Bearish order flow: prevDay C3 low broken → bears activated.
//   Stays bearish as long as each subsequent day's high < prevDay's high (lower highs = structure intact).
//
// We scan the last N completed days to find the active OF direction.
export function analyzeOrderFlow(days) {
  // Need at least 2 days
  const completed = days.filter(d => d.isComplete);
  if (completed.length < 2) return { direction: "NEUTRAL", reason: "Te weinig data", confidence: 50 };

  // Walk forward through recent days to determine current OF state
  let ofDirection  = "NEUTRAL";
  let ofConfidence = 50;
  let structureIntact = true;
  let activatedOn  = null;
  let prevDay      = null;
  let structureBreaks = 0;

  // Use last 6 completed days max (current week + spillover)
  const window = completed.slice(-6);

  for (let i = 0; i < window.length; i++) {
    const day  = window[i];
    const prev = window[i - 1];
    if (!prev) { prevDay = day; continue; }

    const c3HighBroken = prev.c3High != null && day.high > prev.c3High;
    const c3LowBroken  = prev.c3Low  != null && day.low  < prev.c3Low;

    if (c3HighBroken && !c3LowBroken) {
      // Bullish activation / continuation
      ofDirection = "BULLISH";
      ofConfidence = 72;
      activatedOn = day.dayName;
      structureIntact = true;
      structureBreaks = 0;
    } else if (c3LowBroken && !c3HighBroken) {
      // Bearish activation / continuation
      ofDirection = "BEARISH";
      ofConfidence = 72;
      activatedOn = day.dayName;
      structureIntact = true;
      structureBreaks = 0;
    } else if (ofDirection === "BULLISH") {
      // Check structure: is current day's low > prevDay's low?
      if (day.low < prev.low) {
        structureBreaks++;
        if (structureBreaks >= 2) {
          ofDirection = "NEUTRAL";
          ofConfidence = 50;
          activatedOn = null;
        } else {
          structureIntact = false;
          ofConfidence = Math.max(50, ofConfidence - 12);
        }
      } else {
        // Higher low → structure still intact, add confidence
        ofConfidence = Math.min(92, ofConfidence + 6);
      }
    } else if (ofDirection === "BEARISH") {
      // Check structure: is current day's high < prevDay's high?
      if (day.high > prev.high) {
        structureBreaks++;
        if (structureBreaks >= 2) {
          ofDirection = "NEUTRAL";
          ofConfidence = 50;
          activatedOn = null;
        } else {
          structureIntact = false;
          ofConfidence = Math.max(50, ofConfidence - 12);
        }
      } else {
        // Lower high → structure intact, add confidence
        ofConfidence = Math.min(92, ofConfidence + 6);
      }
    }

    prevDay = day;
  }

  // For today (possibly partial day), also check live price against prevDay C3 high/low
  const lastCompleted = window[window.length - 1];
  const todayPartial  = days[days.length - 1];
  const todayIsPartial = todayPartial && !todayPartial.isComplete;

  if (todayIsPartial && lastCompleted) {
    const liveC3HighBreak = lastCompleted.c3High != null && todayPartial.high > lastCompleted.c3High;
    const liveC3LowBreak  = lastCompleted.c3Low  != null && todayPartial.low  < lastCompleted.c3Low;

    if (liveC3HighBreak && !liveC3LowBreak && ofDirection !== "BULLISH") {
      ofDirection = "BULLISH";
      ofConfidence = 68;
      activatedOn = "vandaag (live)";
      structureIntact = true;
    } else if (liveC3LowBreak && !liveC3HighBreak && ofDirection !== "BEARISH") {
      ofDirection = "BEARISH";
      ofConfidence = 68;
      activatedOn = "vandaag (live)";
      structureIntact = true;
    } else if (ofDirection === "BULLISH") {
      // Live structure check: has today's low undercut prevDay's low?
      if (todayPartial.low < lastCompleted.low) {
        ofConfidence = Math.max(50, ofConfidence - 10);
        structureIntact = false;
      }
    } else if (ofDirection === "BEARISH") {
      if (todayPartial.high > lastCompleted.high) {
        ofConfidence = Math.max(50, ofConfidence - 10);
        structureIntact = false;
      }
    }
  }

  // Build human-readable reason
  let reason = "";
  if (ofDirection === "BULLISH") {
    reason = `C3 high vorige dag doorbroken${activatedOn ? ` (${activatedOn})` : ""} → bullish order flow`;
    if (!structureIntact) reason += " — structuur licht verzwakt (lower low)";
    else reason += " — hogere lows bevestigen";
  } else if (ofDirection === "BEARISH") {
    reason = `C3 low vorige dag doorbroken${activatedOn ? ` (${activatedOn})` : ""} → bearish order flow`;
    if (!structureIntact) reason += " — structuur licht verzwakt (higher high)";
    else reason += " — lagere highs bevestigen";
  } else {
    reason = "Geen duidelijke order flow richting";
  }

  return {
    direction: ofDirection,
    confidence: +ofConfidence.toFixed(0),
    structureIntact,
    activatedOn,
    reason,
    prevC3High: lastCompleted?.c3High ?? null,
    prevC3Low:  lastCompleted?.c3Low  ?? null,
  };
}

// ── Wednesday analysis ────────────────────────────────────────────────────────

export function analyzeWednesday(days, currentWeekDays) {
  const wed = currentWeekDays.find(d => d.dayName === "Wednesday");
  if (!wed) return { analyzed: false };

  const tue = currentWeekDays.find(d => d.dayName === "Tuesday");
  const thu = currentWeekDays.find(d => d.dayName === "Thursday");

  // Reversal: Wed makes high of week then closes strongly down
  // OR Wed makes low of week then closes strongly up
  const weekHigh = Math.max(...currentWeekDays.map(d => d.high));
  const weekLow  = Math.min(...currentWeekDays.map(d => d.low));
  const wedIsWeekHigh = Math.abs(wed.high - weekHigh) < weekHigh * 0.001;
  const wedIsWeekLow  = Math.abs(wed.low  - weekLow)  < weekLow  * 0.001;

  const wedBody   = wed.close - wed.open;
  const wedRange  = wed.high - wed.low;
  const rejectionRatio = wedRange > 0 ? Math.abs(wedBody) / wedRange : 0;

  // Strong reversal: made extreme high/low but closed in opposite direction
  const isBearishReversal = wedIsWeekHigh && wed.close < wed.open && rejectionRatio < 0.4;
  const isBullishReversal = wedIsWeekLow  && wed.close > wed.open && rejectionRatio < 0.4;

  // Equal high on Wednesday: Wed high is within 0.3% of Tuesday high
  const hasEqualHighWithTue = tue ? Math.abs(wed.high - tue.high) / tue.high * 100 < 0.3 : false;
  const hasEqualLowWithTue  = tue ? Math.abs(wed.low  - tue.low)  / tue.low  * 100 < 0.3 : false;

  // If Wednesday left an equal/sloppy high → trend NOT done, expect continuation
  const eqHighContinuation = hasEqualHighWithTue && !isBearishReversal;
  const eqLowContinuation  = hasEqualLowWithTue  && !isBullishReversal;

  return {
    analyzed:           true,
    isWeekHigh:         wedIsWeekHigh,
    isWeekLow:          wedIsWeekLow,
    isBearishReversal,
    isBullishReversal,
    isReversal:         isBearishReversal || isBullishReversal,
    hasEqualHighWithTue,
    hasEqualLowWithTue,
    eqHighContinuation,
    eqLowContinuation,
    open: wed.open, high: wed.high, low: wed.low, close: wed.close,
  };
}

// ── Friday analysis ───────────────────────────────────────────────────────────

/**
 * Friday range-reversion logic:
 * If the whole week expanded strongly in one direction → Friday is high-probability
 * COUNTER-TREND trade back into the weekly range (mean reversion).
 *
 * Criteria for "whole week went up":
 *  - Week close > week open (bullish week body)
 *  - Thursday close is near week high (expansion continued through Thursday)
 *  - Price is in PREMIUM zone (top 25% of weekly range)
 *  - Week range is meaningful (> 0.5% move from open)
 *
 * Same logic inverted for bearish expansion week.
 */
export function analyzeFriday(currentWeekDays, currentWeek, priceZone) {
  const todayName = getTradingDayName(Date.now() / 1000);
  const isToday   = todayName === "Friday";

  if (!currentWeek || currentWeekDays.length < 3) {
    return { applicable: false, isToday };
  }

  const mon = currentWeekDays.find(d => d.dayName === "Monday");
  const tue = currentWeekDays.find(d => d.dayName === "Tuesday");
  const wed = currentWeekDays.find(d => d.dayName === "Wednesday");
  const thu = currentWeekDays.find(d => d.dayName === "Thursday");
  const fri = currentWeekDays.find(d => d.dayName === "Friday");

  const weekOpen  = currentWeek.open;
  const weekHigh  = currentWeek.high;
  const weekLow   = currentWeek.low;
  const weekRange = weekHigh - weekLow;
  const weekRangePct = weekRange / weekOpen * 100;

  // Need at least a 0.4% weekly range to be meaningful
  if (weekRangePct < 0.4) return { applicable: false, isToday, reason: "Weekly range te klein" };

  // How many days closed bullish vs bearish (use all available Mon-Thu days)
  const completedDays = [mon, tue, wed, thu].filter(Boolean);
  const bullDays = completedDays.filter(d => d.close > d.open).length;
  const bearDays = completedDays.filter(d => d.close < d.open).length;
  const availableDays = completedDays.length;

  // Thursday's close position in the weekly range
  // Use most recent completed day if Thursday is missing
  const lastDay = thu ?? wed ?? tue ?? mon;
  const thuCloseInRange = lastDay && weekRange > 0
    ? (lastDay.close - weekLow) / weekRange
    : 0.5;

  // "Whole week bullish": 75%+ of available days bullish AND last day closed high in range
  // Works even with partial week data (e.g. only Tue-Thu available)
  const bullRatio = availableDays > 0 ? bullDays / availableDays : 0;
  const bearRatio = availableDays > 0 ? bearDays / availableDays : 0;

  // Also check if net week move confirms direction
  const latestCloseForCheck = (fri ?? thu ?? wed ?? tue)?.close ?? currentWeek.close;
  const weekNetPctCheck = (latestCloseForCheck - weekOpen) / weekOpen * 100;

  const wholeWeekBullish = bullRatio >= 0.6 && thuCloseInRange >= 0.65 && priceZone === "PREMIUM"
                        && weekNetPctCheck > 1.0; // week must have moved up > 1%

  const wholeWeekBearish = bearRatio >= 0.6 && thuCloseInRange <= 0.35 && priceZone === "DISCOUNT"
                        && weekNetPctCheck < -1.0; // week must have moved down > 1%

  // Net move of the week so far
  const latestClose = (fri ?? thu)?.close ?? currentWeek.close;
  const weekNetPct  = (latestClose - weekOpen) / weekOpen * 100;

  // Friday reversion target: back toward the weekly midpoint (50% of range)
  const weekMid     = weekLow + weekRange * 0.5;
  const reversionTarget = +weekMid.toFixed(2);

  // Confidence scales with how extreme the expansion is
  let reversionConfidence = 0;
  if (wholeWeekBullish) {
    reversionConfidence = Math.min(85, 55 + (bullDays - 2) * 10 + (thuCloseInRange - 0.7) * 50);
  } else if (wholeWeekBearish) {
    reversionConfidence = Math.min(85, 55 + (bearDays - 2) * 10 + (0.3 - thuCloseInRange) * 50);
  }

  const isHighProbReversion = wholeWeekBullish || wholeWeekBearish;
  const reversionDirection  = wholeWeekBullish ? "BEARISH" : wholeWeekBearish ? "BULLISH" : null;

  // Reversion is only ACTIVE from C3 onwards (06:00 ET Friday)
  // In C1/C2 the trend is still running — bias stays with the week direction
  const currentCycle   = getCurrentCycle();
  const reversionActive = isHighProbReversion && (currentCycle === "C3" || currentCycle === "C4");

  // Pre-C3 bias: stays with the week trend (opposite of the reversion)
  const preTrendDirection = wholeWeekBullish ? "BULLISH" : wholeWeekBearish ? "BEARISH" : null;

  return {
    applicable:          true,
    isToday,
    currentCycle,
    wholeWeekBullish,
    wholeWeekBearish,
    isHighProbReversion,
    reversionActive,          // true only when C3/C4 — this is what the bias engine should use
    reversionDirection,
    preTrendDirection,        // bias before C3: still with the week trend
    reversionTarget,
    reversionConfidence: +reversionConfidence.toFixed(0),
    weekNetPct:          +weekNetPct.toFixed(2),
    bullDays,
    bearDays,
    weekRangePct:        +weekRangePct.toFixed(2),
    thuCloseInRange:     +thuCloseInRange.toFixed(2),
    advice: isHighProbReversion
      ? wholeWeekBullish
        ? `Hele week omhoog gegaan (${bullDays}/4 dagen bullish, prijs in premium). Vrijdag hoge kans op range reversion → BEARISH trade richting weekmidden (${reversionTarget}).`
        : `Hele week omlaag gegaan (${bearDays}/4 dagen bearish, prijs in discount). Vrijdag hoge kans op range reversion → BULLISH trade richting weekmidden (${reversionTarget}).`
      : "Geen duidelijke full-week expansie. Vrijdag sluit de week, observeer richting.",
  };
}

// ── Thursday analysis ─────────────────────────────────────────────────────────

export function analyzeThursday(currentWeekDays, weekBias) {
  const thu = currentWeekDays.find(d => d.dayName === "Thursday");
  const wed = currentWeekDays.find(d => d.dayName === "Wednesday");

  const todayName = getTradingDayName(Date.now() / 1000);
  const isToday = todayName === "Thursday";

  if (!wed) return { applicable: false };

  // Thursday pullback: after Wednesday expansion, Thu should pull back
  const wedExpanded = wed.high > (currentWeekDays.find(d => d.dayName === "Tuesday")?.high ?? 0)
                   || wed.low  < (currentWeekDays.find(d => d.dayName === "Tuesday")?.low  ?? Infinity);

  // After Wednesday high is broken by Thursday → upside potential, Friday reversal likely
  const thuBrokeWedHigh = thu ? thu.high > wed.high : false;

  return {
    applicable:           true,
    isToday,
    pullbackExpected:     wedExpanded,
    bestEntry:            "C4",
    bestEntryLabel:       "C4 (13:30–15:00 ET)",
    reducedProbCycles:    ["C1", "C2", "C3"],
    thuBrokeWedHigh,
    fridayReversalExpected: thuBrokeWedHigh,
    advice: isToday
      ? wedExpanded
        ? "Donderdag pullback verwacht. Wacht op C4 entry (13:30–15:00 ET). Lagere kans voor C1/C2/C3."
        : "Geen duidelijke Wednesday expansie. Observeer richting, C4 blijft beste entry."
      : null,
  };
}

// ── Premium / Discount zone ───────────────────────────────────────────────────

export function getPriceZone(price, weekHigh, weekLow) {
  if (!weekHigh || !weekLow || weekHigh === weekLow) return "NEUTRAL";
  const range  = weekHigh - weekLow;
  const pct    = (price - weekLow) / range;
  if (pct >= 0.75) return "PREMIUM";
  if (pct <= 0.25) return "DISCOUNT";
  return "EQUILIBRIUM";
}

// ── Daily Structure Order Flow ────────────────────────────────────────────────
//
// ── Order Flow Lock State Machine ────────────────────────────────────────────
// Scans the FULL move sequence (HIGH/LOW events) to determine if order flow
// is locked in a direction.
//
// BULLISH LOCK:  H → L(s) → H  where final H >= starting H
//   - Multiple LOWs between the two HIGHs = fine (double/triple pullback)
//   - Once locked: every LOW = pullback within lock = BUY opportunity
//   - Lock remains until BEARISH LOCK forms
//
// BEARISH LOCK:  L → H(s) → L  where final L <= starting L
//   - The HIGH(s) = buyside sweep/trap that failed
//   - Once locked: every HIGH = pullback within lock = SELL opportunity
//
// Lock SWITCH: a BEARISH lock can only form if the final LOW goes BELOW the
// starting LOW (lower low). If final LOW > starting LOW → higher low = bullish
// pullback, NOT a reversal. This prevents false bearish signals inside a
// bullish locked structure.
//
// This is the same fractal pattern at every timeframe: weekly, daily, cycle.
export function detectOrderFlowLock(moves) {
  // Expand BOTH moves: a day that hit BOTH prev high AND prev low is treated as
  // LOW then HIGH (swept SSL then broke BSL = bullish sweep). This lets the lock
  // detector find BSL→SSL(BOTH day)→BSL sequences.
  const raw = moves.filter(m => m.type === "HIGH" || m.type === "LOW" || m.type === "BOTH");
  const sig = [];
  for (const m of raw) {
    if (m.type === "BOTH") {
      sig.push({ ...m, type: "LOW"  }); // swept sellside first
      sig.push({ ...m, type: "HIGH" }); // then broke buyside
    } else {
      sig.push(m);
    }
  }
  if (sig.length < 3) return null;

  let locked    = null; // "BULLISH" | "BEARISH" | null
  let strength  = 0;
  let lockNote  = "";
  let lockLevels = null; // { bslLevel, sslLevel, pullbackLevel, lockLabel, sweepLabel }

  // Format a move's date into "Mon Apr 14" style
  function fmtMoveDate(dateStr) {
    if (!dateStr) return null;
    const [y, mo, d] = dateStr.split("-").map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
  // Format weekKey "2026-W04-14" → "W Apr 14"
  function fmtWeekKey(wk) {
    if (!wk) return "?";
    const parts = wk.split("-"); // ["2026","W04","14"]
    const mo = parts[1] ? parseInt(parts[1].replace("W","")) : 0;
    const d  = parts[2] ? parseInt(parts[2]) : 0;
    if (!mo || !d) return wk;
    const year = parseInt(parts[0]);
    const dt = new Date(Date.UTC(year, mo - 1, d));
    return "W " + dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }

  const lbl = m => {
    if (m.date) {
      // Daily move: "Thu Apr 17"
      return fmtMoveDate(m.date) ?? m.dayName ?? "?";
    }
    if (m.dayKey) {
      // Cycle move: "Thu-C3 Apr 17"
      const d = fmtMoveDate(m.dayKey);
      return d ? `${m.name ?? m.cycle ?? ""} ${d}` : (m.name ?? "?");
    }
    if (m.weekKey) return fmtWeekKey(m.weekKey);
    return m.dayName ?? m.name ?? "?";
  };

  for (let i = 2; i < sig.length; i++) {
    const cur = sig[i];

    if (cur.type === "HIGH") {
      let j = i - 1;
      while (j >= 0 && sig[j].type === "LOW") j--;
      if (j >= 0 && sig[j].type === "HIGH" && j < i - 1) {
        const startH = sig[j];
        if (cur.high >= startH.high * 0.9990) {
          if (locked !== "BULLISH") strength = 0;
          locked   = "BULLISH";
          strength = Math.min(6, strength + 1);
          lockNote = `BSL(${lbl(startH)}) → SSL pullback(${lbl(sig[j+1])}) → BSL(${lbl(cur)}) → BULLISH ORDER FLOW LOCKED`;
          lockLevels = {
            bslLevel:      startH.high,
            sslLevel:      sig[j+1].low,
            pullbackLabel: lbl(sig[j+1]),
            lockLevel:     cur.high,
            lockLabel:     lbl(cur),
            sweepLabel:    lbl(startH),
          };
        }
      }
    }

    if (cur.type === "LOW") {
      let j = i - 1;
      while (j >= 0 && sig[j].type === "HIGH") j--;
      if (j >= 0 && sig[j].type === "LOW" && j < i - 1) {
        const startL = sig[j];
        if (cur.low <= startL.low * 1.0010) {
          if (locked !== "BEARISH") strength = 0;
          locked   = "BEARISH";
          strength = Math.min(6, strength + 1);
          lockNote = `SSL(${lbl(startL)}) → BSL sweep(${lbl(sig[j+1])}) → SSL(${lbl(cur)}) → BEARISH ORDER FLOW LOCKED`;
          lockLevels = {
            sslLevel:      startL.low,
            bslLevel:      sig[j+1].high,
            pullbackLabel: lbl(sig[j+1]),
            lockLevel:     cur.low,
            lockLabel:     lbl(cur),
            sweepLabel:    lbl(startL),
          };
        }
      }
    }
  }

  if (!locked) return null;

  const last = sig[sig.length - 1];
  let currentOpportunity = null;
  if (locked === "BULLISH" && last.type === "LOW")  currentOpportunity = "BUY";
  if (locked === "BEARISH" && last.type === "HIGH") currentOpportunity = "SELL";

  // Most recent pullback level (where price pulled back TO, creating the opportunity)
  const pullbackMove = last.type === "LOW"  ? last
                     : last.type === "HIGH" ? last
                     : null;
  const pullbackPrice = locked === "BULLISH" ? last.low : last.high;

  return {
    locked: true, direction: locked, strength, currentOpportunity, note: lockNote,
    levels: lockLevels ? { ...lockLevels, currentPullback: pullbackPrice, pullbackLabel: lbl(last) } : null,
  };
}

// Analyzes daily candles (OHLC per day) to determine market structure.
// Uses detectOrderFlowLock() on the full move sequence as the primary signal.
// Simple last-3-moves pattern used only when no lock is detected.
//
// Move types per day:
//   HIGH  = today.high > prev.high  → buyside liquidity taken (BSL)
//   LOW   = today.low  < prev.low   → sellside liquidity taken (SSL)
//   BOTH  = both broken             → expansion
//   RANGE = inside day              → consolidation, holds current bias
//
// Bias rules:
//   BULLISH LOCK:  H → L(s) → H  (BSL → SSL pullback → BSL) = locked bullish
//     Each subsequent LOW = pullback (BUY opportunity), not a reversal.
//   BEARISH LOCK:  L → H(s) → L  where final L <= starting L
//     Each subsequent HIGH = buyside sweep/trap (SELL opportunity).
//   FALSE reversal guard: LOW → HIGH → LOW is ONLY bearish if final LOW < starting LOW.
//     If final LOW > starting LOW = higher low = still bullish (pullback within lock).
//
// @param {Array} days  — output of groupCandlesByDay(), sorted oldest→newest
//                        (works best with 15+ completed days for weekly context)
export function analyzeDailyStructure(days) {
  const completed = days.filter(d => d.isComplete);
  if (completed.length < 3) {
    return {
      direction: "NEUTRAL", confidence: 50, structure: "INSUFFICIENT_DATA",
      trend: "NEUTRAL", weeklyBias: "NEUTRAL", currentOpportunity: null,
      moves: [], note: "Te weinig dagdata voor daily structuur analyse",
    };
  }

  // ── Build move sequence ──────────────────────────────────────────────────
  const moves = [];
  for (let i = 1; i < completed.length; i++) {
    const day  = completed[i];
    const prev = completed[i - 1];
    const hitHigh = day.high > prev.high;
    const hitLow  = day.low  < prev.low;
    let type;
    if      (hitHigh && hitLow)  type = "BOTH";
    else if (hitHigh)            type = "HIGH";
    else if (hitLow)             type = "LOW";
    else                         type = "RANGE";
    moves.push({
      type,
      dayName:   day.dayName,
      date:      day.key,
      high:      day.high,
      low:       day.low,
      open:      day.open,
      close:     day.close,
      prevHigh:  prev.high,
      prevLow:   prev.low,
      bullishDay: day.close > day.open,
    });
  }

  // ── Weekly context ───────────────────────────────────────────────────────
  // Group completed days into ISO weeks and score each week
  const weekGroups = new Map();
  for (const d of completed) {
    const wk = getTradingWeekKey(d.startTs);
    if (!weekGroups.has(wk)) weekGroups.set(wk, []);
    weekGroups.get(wk).push(d);
  }
  const weeks = [...weekGroups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, ds]) => ({
      key,
      open:  ds[0].open,
      close: ds[ds.length - 1].close,
      high:  Math.max(...ds.map(d => d.high)),
      low:   Math.min(...ds.map(d => d.low)),
      bullish: ds[ds.length - 1].close > ds[0].open,
    }));

  // Score recent weeks (last 4)
  const recentWeeks = weeks.slice(-4);
  const bullishWeeks = recentWeeks.filter(w => w.bullish).length;
  const bearishWeeks = recentWeeks.filter(w => !w.bullish).length;
  let weeklyBias = "NEUTRAL";
  let weeklyConfidenceBonus = 0;
  if (recentWeeks.length >= 2) {
    if (bullishWeeks >= Math.ceil(recentWeeks.length * 0.6)) {
      weeklyBias = "BULLISH";
      weeklyConfidenceBonus = Math.min(10, (bullishWeeks - bearishWeeks) * 4);
    } else if (bearishWeeks >= Math.ceil(recentWeeks.length * 0.6)) {
      weeklyBias = "BEARISH";
      weeklyConfidenceBonus = Math.min(10, (bearishWeeks - bullishWeeks) * 4);
    }
  }

  // ── Structural trend from recent moves (last 10 days) ────────────────────
  const recentMoves = moves.slice(-10);

  // Count meaningful moves (exclude RANGE/BOTH from trend score)
  const highMoves = recentMoves.filter(m => m.type === "HIGH").length;
  const lowMoves  = recentMoves.filter(m => m.type === "LOW").length;
  const totalMeaningful = highMoves + lowMoves;

  // Check for higher highs / higher lows (bullish structure)
  const significantDays = completed.slice(-8); // last 8 days for HH/HL check
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < significantDays.length; i++) {
    if (significantDays[i].high > significantDays[i-1].high) higherHighs++;
    else lowerHighs++;
    if (significantDays[i].low > significantDays[i-1].low) higherLows++;
    else lowerLows++;
  }
  const hhhlScore = (higherHighs + higherLows) - (lowerHighs + lowerLows);

  // ── Determine base trend ──────────────────────────────────────────────────
  let trend = "NEUTRAL";
  if (totalMeaningful >= 2) {
    const highRatio = highMoves / totalMeaningful;
    if (highRatio >= 0.6 || hhhlScore >= 3) trend = "BULLISH";
    else if (highRatio <= 0.4 || hhhlScore <= -3) trend = "BEARISH";
  }

  // ── Recent pattern (last 3 moves) — determines current situation ──────────
  const last  = moves[moves.length - 1];
  const prev1 = moves.length >= 2 ? moves[moves.length - 2] : null;
  const prev2 = moves.length >= 3 ? moves[moves.length - 3] : null;

  let direction          = "NEUTRAL";
  let confidence         = 50;
  let structure          = "UNKNOWN";
  let currentOpportunity = null; // "BUY", "SELL", or null
  let note               = "";

  if (!last) {
    return {
      direction: trend === "NEUTRAL" ? "NEUTRAL" : trend,
      confidence: 50, structure: "INSUFFICIENT_MOVES",
      trend, weeklyBias, currentOpportunity: null,
      moves, note: "Te weinig bewegingen om te analyseren",
      higherHighs, higherLows, lowerHighs, lowerLows,
      bullishWeeks, bearishWeeks,
    };
  }

  // ── Order Flow Lock (primary signal) ────────────────────────────────────────
  // Run the full-sequence lock state machine FIRST.
  // Lock overrides simple last-3-moves pattern matching.
  const lockState = detectOrderFlowLock(moves);

  if (lockState) {
    direction          = lockState.direction;
    confidence         = Math.min(88, 65 + lockState.strength * 5);
    currentOpportunity = lockState.currentOpportunity ?? null;
    note               = lockState.note;
    structure = lockState.direction === "BULLISH"
      ? (lockState.currentOpportunity === "BUY"  ? "BULLISH_LOCK_PULLBACK"  : "BULLISH_LOCKED")
      : (lockState.currentOpportunity === "SELL" ? "BEARISH_LOCK_PULLBACK"  : "BEARISH_LOCKED");
  } else {
    // ── Fallback: simple last-3-moves pattern ──────────────────────────────
    if (last.type === "HIGH") {
      direction  = "BULLISH"; confidence = 68; structure = "BULLISH_IMPULSE";
      note = `${last.dayName} brak vorige dag high (${last.prevHigh.toFixed(0)}) → buyside genomen`;
      if (prev1?.type === "LOW" || prev1?.type === "RANGE") {
        confidence = 74; structure = "BULLISH_CONTINUATION";
        note = `Pullback (${prev1.dayName}) → ${last.dayName} pakt buyside → bullish continuation`;
      }
      if (prev1?.type === "HIGH") {
        confidence = 78; structure = "BULLISH_MOMENTUM";
        note = `${prev1.dayName} + ${last.dayName} beide buyside → bullish momentum`;
      }
    } else if (last.type === "LOW") {
      if (prev1?.type === "HIGH") {
        if (trend === "BULLISH" || weeklyBias === "BULLISH" || hhhlScore >= 2) {
          direction = "BULLISH"; confidence = 64; structure = "BULLISH_PULLBACK";
          currentOpportunity = "BUY";
          note = `${last.dayName} sellside (${last.prevLow.toFixed(0)}) na bullish impuls — historische trend bullish → buy opportunity`;
        } else {
          direction = "NEUTRAL"; confidence = 52; structure = "REVERSAL_WATCH";
          note = `${last.dayName} sellside na high — trend niet duidelijk, observeer`;
        }
      } else if (prev1?.type === "LOW") {
        direction = "BEARISH"; confidence = 74; structure = "BEARISH_MOMENTUM";
        note = `${prev1.dayName} + ${last.dayName} beide sellside → bearish structuur`;
      } else {
        direction = trend === "BULLISH" ? "BULLISH" : "BEARISH"; confidence = 55;
        structure = trend === "BULLISH" ? "BULLISH_PULLBACK" : "BEARISH_MOVE";
        currentOpportunity = trend === "BULLISH" ? "BUY" : null;
        note = `Sellside geraakt — trend is ${trend}`;
      }
      // Bearish reversal: LOW → HIGH (buyside sweep) → LOW
      // GUARD: only fires if final LOW is a LOWER LOW than starting LOW
      // (if final LOW > starting LOW = higher low = bullish pullback, NOT reversal)
      if (prev1?.type === "HIGH" && prev2?.type === "LOW") {
        if (last.low < prev2.low) {
          direction = "BEARISH"; confidence = 80; structure = "BEARISH_REVERSAL_CONFIRMED";
          currentOpportunity = "SELL";
          note = `LOW(${prev2.dayName}) → HIGH sweep(${prev1.dayName}) → LOWER LOW(${last.dayName}) = bearish bevestigd`;
        } else {
          // final low > starting low = higher low = still bullish
          direction = "BULLISH"; confidence = 68; structure = "BULLISH_HIGHER_LOW";
          currentOpportunity = "BUY";
          note = `LOW(${prev2.dayName}) → HIGH(${prev1.dayName}) → HIGHER LOW(${last.dayName}) = bullish pullback, hogere bodem`;
        }
      }
    } else if (last.type === "RANGE") {
      if (trend === "BULLISH" || prev1?.type === "HIGH") {
        direction = "BULLISH"; confidence = 60; structure = "BULLISH_CONSOLIDATION";
        note = `Inside dag (${last.dayName}) → consolidatie, bullish bias`;
      } else if (trend === "BEARISH" || prev1?.type === "LOW") {
        direction = "BEARISH"; confidence = 60; structure = "BEARISH_CONSOLIDATION";
        note = `Inside dag (${last.dayName}) → consolidatie, bearish bias`;
      } else {
        direction = "NEUTRAL"; confidence = 50; structure = "RANGE_NEUTRAL";
        note = `Inside dag — geen duidelijke richting`;
      }
      if (prev1?.type === "LOW" && prev2?.type === "HIGH" && trend === "BULLISH") {
        confidence = 68; structure = "BULLISH_PULLBACK_COMPLETE"; currentOpportunity = "BUY";
        note = `HIGH(${prev2.dayName}) → LOW(${prev1.dayName}) → range dag = pullback klaar, buy`;
      }
    } else {
      direction = "NEUTRAL"; confidence = 50; structure = "EXPANSION";
      note = `${last.dayName} expansiedag → wacht op richting`;
    }
  }

  // ── Apply weekly confidence bonus ────────────────────────────────────────
  if (weeklyBias === direction && direction !== "NEUTRAL") {
    confidence = Math.min(92, confidence + weeklyConfidenceBonus);
    note += ` (${bullishWeeks}/${recentWeeks.length} weken bevestigen)`;
  } else if (weeklyBias !== "NEUTRAL" && weeklyBias !== direction && direction !== "NEUTRAL") {
    confidence = Math.max(45, confidence - 6);
    note += ` (⚠ weekly bias ${weeklyBias} conflicteert)`;
  }

  // ── Apply HH/HL structural bonus ─────────────────────────────────────────
  if (direction === "BULLISH" && hhhlScore >= 4) {
    confidence = Math.min(92, confidence + 6);
  } else if (direction === "BEARISH" && hhhlScore <= -4) {
    confidence = Math.min(92, confidence + 6);
  }

  return {
    direction,
    confidence: +confidence.toFixed(0),
    structure,
    trend,
    weeklyBias,
    currentOpportunity,
    note,
    lockState: lockState ?? null,
    moves: moves.slice(-5), // last 5 for display
    last,
    prev1,
    prev2,
    higherHighs, higherLows, lowerHighs, lowerLows,
    hhhlScore,
    bullishWeeks,
    bearishWeeks,
    totalWeeksAnalyzed: recentWeeks.length,
    weekDetails: recentWeeks.map(w => ({
      key: w.key,
      bullish: w.bullish,
      open: +w.open.toFixed(0),
      close: +w.close.toFixed(0),
    })),
  };
}

// ── Weekly Structure Analysis ─────────────────────────────────────────────────
// Same HIGH/LOW/RANGE logic as daily, but applied to weekly candles.
// Uses groupCandlesByWeek output.
export function analyzeWeeklyStructure(weeks) {
  const completed = weeks.filter(w => w.candles?.length > 20 || w.startTs);
  if (completed.length < 3) {
    return { direction: "NEUTRAL", confidence: 50, structure: "INSUFFICIENT_DATA",
             moves: [], note: "Te weinig weekdata" };
  }
  const window = completed.slice(-8); // last 8 weeks
  const moves = [];
  for (let i = 1; i < window.length; i++) {
    const w    = window[i];
    const prev = window[i - 1];
    const hitHigh = w.high  > prev.high;
    const hitLow  = w.low   < prev.low;
    let type;
    if      (hitHigh && hitLow)  type = "BOTH";
    else if (hitHigh)            type = "HIGH";
    else if (hitLow)             type = "LOW";
    else                         type = "RANGE";
    moves.push({ type, weekKey: w.key, high: w.high, low: w.low,
                 open: w.open, close: w.close,
                 bullishWeek: w.close > w.open, prevHigh: prev.high, prevLow: prev.low });
  }

  const last  = moves[moves.length - 1];
  const prev1 = moves.length >= 2 ? moves[moves.length - 2] : null;
  const prev2 = moves.length >= 3 ? moves[moves.length - 3] : null;

  const highCount = moves.slice(-5).filter(m => m.type === "HIGH").length;
  const lowCount  = moves.slice(-5).filter(m => m.type === "LOW").length;

  let direction = "NEUTRAL", confidence = 50, structure = "UNKNOWN", note = "";

  if (!last) return { direction: "NEUTRAL", confidence: 50, structure: "NO_MOVES", moves, note: "" };

  // ── Order Flow Lock (primary) ────────────────────────────────────────────────
  const lockState = detectOrderFlowLock(moves);

  if (lockState) {
    direction  = lockState.direction;
    confidence = Math.min(88, 65 + lockState.strength * 5);
    note       = lockState.note;
    structure  = lockState.direction === "BULLISH"
      ? (lockState.currentOpportunity === "BUY"  ? "WEEKLY_LOCK_PULLBACK" : "WEEKLY_BULLISH_LOCKED")
      : (lockState.currentOpportunity === "SELL" ? "WEEKLY_LOCK_PULLBACK_SELL" : "WEEKLY_BEARISH_LOCKED");
  } else {
    // Fallback: last-3-moves
    if (last.type === "HIGH") {
      direction = "BULLISH"; confidence = 68; structure = "WEEKLY_BULLISH_IMPULSE";
      note = `Week brak vorige week high (${last.prevHigh.toFixed(0)}) → bullish weekly structuur`;
      if (prev1?.type === "HIGH") { confidence = 78; structure = "WEEKLY_BULLISH_MOMENTUM"; }
      if (prev1?.type === "LOW")  { confidence = 74; structure = "WEEKLY_BULLISH_CONTINUATION"; }
    } else if (last.type === "LOW") {
      if (prev1?.type === "HIGH") {
        const bullishWeekCount = moves.slice(-5).filter(m => m.type === "HIGH" || m.bullishWeek).length;
        if (bullishWeekCount >= 3 || highCount > lowCount) {
          direction = "BULLISH"; confidence = 62; structure = "WEEKLY_PULLBACK";
          note = `Week raakte sellside na bullish weken — pullback zone`;
        } else {
          direction = "BEARISH"; confidence = 65; structure = "WEEKLY_BEARISH_START";
          note = `Week brak low na high — mogelijke wekelijkse reversal`;
        }
      } else if (prev2?.type === "HIGH" && prev1?.type === "LOW") {
        // LOW → HIGH → LOW: only bearish if final low <= starting low
        if (last.low <= prev2.low * 1.001) {
          direction = "BEARISH"; confidence = 80; structure = "WEEKLY_BEARISH_CONFIRMED";
          note = `Weekly: LOW → HIGH sweep → LOWER LOW = bearish bevestigd`;
        } else {
          direction = "BULLISH"; confidence = 66; structure = "WEEKLY_HIGHER_LOW";
          note = `Weekly: LOW → HIGH → HIGHER LOW = hogere bodem, bullish`;
        }
      } else if (prev1?.type === "LOW") {
        direction = "BEARISH"; confidence = 76; structure = "WEEKLY_BEARISH_MOMENTUM";
        note = `Twee opeenvolgende weekly lows → bearish`;
      } else {
        direction = "BEARISH"; confidence = 60; structure = "WEEKLY_BEARISH_MOVE";
        note = `Weekly low doorbroken`;
      }
    } else if (last.type === "RANGE") {
      direction  = highCount > lowCount ? "BULLISH" : lowCount > highCount ? "BEARISH" : "NEUTRAL";
      confidence = 55; structure = "WEEKLY_CONSOLIDATION";
      note = `Inside week — ${direction.toLowerCase()} bias`;
    } else {
      direction = "NEUTRAL"; confidence = 50; structure = "WEEKLY_EXPANSION";
      note = "Expansie week — wacht op richting";
    }
    if (highCount >= 3 && direction === "BULLISH") confidence = Math.min(88, confidence + 6);
    if (lowCount  >= 3 && direction === "BEARISH") confidence = Math.min(88, confidence + 6);
  }

  return { direction, confidence: +confidence.toFixed(0), structure, moves: moves.slice(-4), note,
           highCount, lowCount, lockState: lockState ?? null };
}

// ── 6-Hour Cycle Structure Analysis ──────────────────────────────────────────
// Applies the same HIGH/LOW/RANGE logic to consecutive 6-hour cycles.
// Cycles within and across days: C1→C2→C3→C4→C1(next day)→…
// Analyzes last ~12 cycles (≈3 days) for intraday trend direction.
export function analyzeCycleStructure(days) {
  // Build flat list of all 6-hour cycles from recent days
  const recentDays = days.filter(d => d.isComplete || d === days[days.length - 1]);
  const allCycles = [];

  for (const day of recentDays.slice(-5)) {
    for (const cycleName of ["C1","C2","C3","C4"]) {
      const etStart = cycleName === "C1" ? 18 : cycleName === "C2" ? 0 : cycleName === "C3" ? 6 : 12;
      const etEnd   = etStart + 6;
      const cc = day.candles.filter(c => {
        const h = getETInfo(c.timestamp).hour;
        // C1 spans 18-24 (next calendar day midnight)
        if (cycleName === "C1") return h >= 18;
        return h >= etStart && h < etEnd;
      });
      if (cc.length < 2) continue;
      allCycles.push({
        name:    `${day.dayName.slice(0,3)}-${cycleName}`,
        cycle:   cycleName,
        dayName: day.dayName,
        dayKey:  day.key,
        high:    Math.max(...cc.map(c => c.high)),
        low:     Math.min(...cc.map(c => c.low)),
        open:    cc[0].open,
        close:   cc[cc.length - 1].close,
        ts:      cc[0].timestamp,
      });
    }
  }

  if (allCycles.length < 3) {
    return { direction: "NEUTRAL", confidence: 50, structure: "INSUFFICIENT_DATA",
             moves: [], note: "Te weinig cycle data" };
  }

  const moves = [];
  for (let i = 1; i < allCycles.length; i++) {
    const cy   = allCycles[i];
    const prev = allCycles[i - 1];
    const hitHigh = cy.high > prev.high;
    const hitLow  = cy.low  < prev.low;
    let type;
    if      (hitHigh && hitLow)  type = "BOTH";
    else if (hitHigh)            type = "HIGH";
    else if (hitLow)             type = "LOW";
    else                         type = "RANGE";
    moves.push({ type, name: cy.name, cycle: cy.cycle, dayName: cy.dayName,
                 dayKey: cy.dayKey,
                 high: cy.high, low: cy.low, prevHigh: prev.high, prevLow: prev.low });
  }

  const recentMoves = moves.slice(-6);
  const last  = recentMoves[recentMoves.length - 1];
  const prev1 = recentMoves.length >= 2 ? recentMoves[recentMoves.length - 2] : null;
  const prev2 = recentMoves.length >= 3 ? recentMoves[recentMoves.length - 3] : null;

  const highCount = recentMoves.filter(m => m.type === "HIGH").length;
  const lowCount  = recentMoves.filter(m => m.type === "LOW").length;

  let direction = "NEUTRAL", confidence = 50, structure = "UNKNOWN", currentOpportunity = null, note = "";

  if (!last) return { direction: "NEUTRAL", confidence: 50, structure: "NO_MOVES", moves: recentMoves, note: "" };

  // ── Order Flow Lock (primary) ────────────────────────────────────────────────
  const lockState = detectOrderFlowLock(moves); // run on full moves, not just recentMoves

  if (lockState) {
    direction          = lockState.direction;
    confidence         = Math.min(86, 63 + lockState.strength * 5);
    currentOpportunity = lockState.currentOpportunity ?? null;
    note               = lockState.note;
    structure          = lockState.direction === "BULLISH"
      ? (lockState.currentOpportunity === "BUY"  ? "CYCLE_LOCK_PULLBACK"      : "CYCLE_BULLISH_LOCKED")
      : (lockState.currentOpportunity === "SELL" ? "CYCLE_LOCK_PULLBACK_SELL"  : "CYCLE_BEARISH_LOCKED");
  } else {
    // Fallback: last-3-moves
    if (last.type === "HIGH") {
      direction = "BULLISH"; confidence = 66; structure = "CYCLE_BULLISH_IMPULSE";
      note = `${last.name} brak vorige cycle high → bullish intraday`;
      if (prev1?.type === "LOW")  { confidence = 72; structure = "CYCLE_BULLISH_CONT"; note = `Pullback (${prev1.name}) + high (${last.name}) → cycle bullish`; }
      if (prev1?.type === "HIGH") { confidence = 76; structure = "CYCLE_BULLISH_MOMENTUM"; }
    } else if (last.type === "LOW") {
      if (prev2?.type === "LOW" && prev1?.type === "HIGH") {
        // LOW → HIGH → LOW: only bearish if final low <= starting low
        if (last.low <= prev2.low * 1.001) {
          direction = "BEARISH"; confidence = 78; structure = "CYCLE_BEARISH_CONFIRMED";
          currentOpportunity = "SELL";
          note = `Cycle: LOW → HIGH sweep (${prev1.name}) → LOWER LOW (${last.name}) = bearish`;
        } else {
          direction = "BULLISH"; confidence = 66; structure = "CYCLE_HIGHER_LOW";
          currentOpportunity = "BUY";
          note = `Cycle: LOW → HIGH → HIGHER LOW (${last.name}) = hogere bodem, bullish`;
        }
      } else if (prev1?.type === "HIGH") {
        const localTrend = highCount > lowCount ? "BULLISH" : "BEARISH";
        if (localTrend === "BULLISH") {
          direction = "BULLISH"; confidence = 63; structure = "CYCLE_PULLBACK";
          currentOpportunity = "BUY";
          note = `Cycle pullback (${last.name}) na high — trend bullish → buy`;
        } else {
          direction = "BEARISH"; confidence = 64; structure = "CYCLE_BEARISH_START";
          note = `Cycle low na high in bearish structuur`;
        }
      } else if (prev1?.type === "LOW") {
        direction = "BEARISH"; confidence = 74; structure = "CYCLE_BEARISH_MOMENTUM";
        note = `Twee cycle lows → bearish momentum`;
      } else {
        direction = "BEARISH"; confidence = 58; structure = "CYCLE_LOW";
        note = `Cycle low gebroken`;
      }
    } else if (last.type === "RANGE") {
      direction  = highCount > lowCount ? "BULLISH" : lowCount > highCount ? "BEARISH" : "NEUTRAL";
      confidence = 55; structure = "CYCLE_CONSOLIDATION";
      if (prev1?.type === "LOW" && highCount >= lowCount) { currentOpportunity = "BUY"; }
      note = `Inside cycle — ${direction.toLowerCase()} bias`;
    } else {
      direction = "NEUTRAL"; confidence = 50; structure = "CYCLE_EXPANSION";
      note = "Expansie cycle — wacht op richting";
    }
    if (highCount >= 4 && direction === "BULLISH") confidence = Math.min(88, confidence + 8);
    if (lowCount  >= 4 && direction === "BEARISH") confidence = Math.min(88, confidence + 8);
  }

  return { direction, confidence: +confidence.toFixed(0), structure, currentOpportunity,
           moves: recentMoves, note, highCount, lowCount, lockState: lockState ?? null };
}

// ── Top-Down Analysis ─────────────────────────────────────────────────────────
// Combines weekly, daily, and cycle structure into one coherent top-down bias.
//
// Alignment scoring:
//   3/3 aligned = premium confidence (+15)
//   2/3 aligned = normal confidence (+5)
//   1/3 or 0/3  = reduce confidence (−8), signal conflict
//
// The hierarchy: weekly > daily > cycle
//   - Weekly sets the macro direction
//   - Daily confirms and shows where to look for entries
//   - Cycle gives the precise timing / entry zone
export function analyzeTopDown(weeklyDS, dailyDS, cycleDS) {
  const layers = [
    { name: "Weekly",  ds: weeklyDS, weight: 3 },
    { name: "Daily",   ds: dailyDS,  weight: 2 },
    { name: "Cycle",   ds: cycleDS,  weight: 1 },
  ];

  // Score each direction
  let bullScore = 0, bearScore = 0, totalWeight = 0;
  for (const { ds, weight } of layers) {
    if (!ds || ds.direction === "NEUTRAL") continue;
    totalWeight += weight;
    if (ds.direction === "BULLISH") bullScore += weight;
    else if (ds.direction === "BEARISH") bearScore += weight;
  }

  const maxWeight = layers.reduce((s, l) => s + l.weight, 0); // 6
  const dominantDir  = bullScore > bearScore ? "BULLISH" : bearScore > bullScore ? "BEARISH" : "NEUTRAL";
  const dominantScore = Math.max(bullScore, bearScore);
  const alignmentPct = maxWeight > 0 ? dominantScore / maxWeight : 0;

  // Aligned count
  const aligned = layers.filter(l => l.ds?.direction === dominantDir).length;
  const conflict = layers.filter(l => l.ds?.direction !== "NEUTRAL" && l.ds?.direction !== dominantDir).length;

  // Base confidence: average of aligned layers
  const alignedLayers = layers.filter(l => l.ds?.direction === dominantDir);
  const baseConf = alignedLayers.length > 0
    ? alignedLayers.reduce((s, l) => s + (l.ds.confidence ?? 50), 0) / alignedLayers.length
    : 50;

  let confidence = baseConf;
  let alignmentLabel = "";

  if (aligned === 3) {
    confidence = Math.min(92, confidence + 15);
    alignmentLabel = "FULL_ALIGNMENT";
  } else if (aligned === 2) {
    confidence = Math.min(88, confidence + 5);
    alignmentLabel = "PARTIAL_ALIGNMENT";
  } else {
    confidence = Math.max(45, confidence - 8);
    alignmentLabel = "CONFLICT";
  }

  // Determine current opportunity
  // Priority: cycle opportunity → daily opportunity
  const cycleOpp  = cycleDS?.currentOpportunity;
  const dailyOpp  = dailyDS?.currentOpportunity;
  let currentOpportunity = null;
  if (cycleOpp && dominantDir === (cycleOpp === "BUY" ? "BULLISH" : "BEARISH")) {
    currentOpportunity = cycleOpp;
  } else if (dailyOpp && dominantDir === (dailyOpp === "BUY" ? "BULLISH" : "BEARISH")) {
    currentOpportunity = dailyOpp;
  }

  // Build human-readable note
  const layerSummary = layers.map(l => {
    if (!l.ds || l.ds.direction === "NEUTRAL") return `${l.name}: neutraal`;
    const icon = l.ds.direction === "BULLISH" ? "▲" : "▼";
    return `${l.name}: ${icon} ${l.ds.direction} (${l.ds.confidence}%)`;
  }).join(" | ");

  const note = aligned === 3
    ? `Volledige top-down alignment: ${layerSummary}`
    : aligned === 2
      ? `Gedeeltelijke alignment: ${layerSummary}`
      : `Conflictsignalen: ${layerSummary}`;

  return {
    direction: dominantDir,
    confidence: +confidence.toFixed(0),
    alignmentLabel,
    aligned,
    conflict,
    currentOpportunity,
    note,
    bullScore,
    bearScore,
    weekly:  { direction: weeklyDS?.direction ?? "NEUTRAL", confidence: weeklyDS?.confidence ?? 50, structure: weeklyDS?.structure, note: weeklyDS?.note, lockState: weeklyDS?.lockState ?? null },
    daily:   { direction: dailyDS?.direction  ?? "NEUTRAL", confidence: dailyDS?.confidence  ?? 50, structure: dailyDS?.structure,  note: dailyDS?.note,  lockState: dailyDS?.lockState  ?? null, opportunity: dailyDS?.currentOpportunity },
    cycle:   { direction: cycleDS?.direction  ?? "NEUTRAL", confidence: cycleDS?.confidence  ?? 50, structure: cycleDS?.structure,  note: cycleDS?.note,  lockState: cycleDS?.lockState  ?? null, opportunity: cycleDS?.currentOpportunity },
  };
}

// ── Fractal Signal Generator ──────────────────────────────────────────────────
// Converts each timeframe's lock state into an actionable signal with entry timing.
// Each signal is INDEPENDENT — they don't need to align to be valid.
//
// Weekly BUY signal:  weekly locked BULLISH + last move was LOW (pullback)
//   → entry from TUESDAY of current week
// Daily BUY signal:   daily locked BULLISH + last move was LOW (pullback)
//   → entry NEXT DAY C3 open (06:00 ET)
// Cycle BUY signal:   cycle locked BULLISH + last cycle was LOW (pullback)
//   → entry NEXT CYCLE, 1:30–3:00 hours in
// (Symmetric for SELL)
export function getFractalSignals(weeklyDS, dailyDS, cycleDS) {
  // Compute actual ET datetimes for entry windows
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etDow = etNow.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const etHour = etNow.getHours();

  // Format a date object to "Mon Apr 21 @ HH:MM ET"
  function fmtDatetime(d, hour = null, minute = 0) {
    const dateStr = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
    if (hour === null) return dateStr;
    const hh = String(hour).padStart(2, "0");
    const mm = String(minute).padStart(2, "0");
    return `${dateStr} @ ${hh}:${mm} ET`;
  }

  // Advance date past weekends (Sat/Sun) to next Monday
  function skipWeekend(d) {
    const dow = d.getDay(); // in local ET
    if (dow === 6) d.setDate(d.getDate() + 2); // Sat → Mon
    if (dow === 0) d.setDate(d.getDate() + 1); // Sun → Mon
    return d;
  }

  // Next trading Tuesday (for weekly entry)
  function nextTuesdayDate() {
    const d = new Date(etNow);
    const daysUntilTue = (2 - etDow + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilTue);
    return fmtDatetime(d, 6, 0); // C3 open 06:00 ET
  }

  // Next trading day C3 open (06:00 ET), skipping weekends
  function nextDayC3() {
    const d = new Date(etNow);
    d.setDate(d.getDate() + 1);
    skipWeekend(d);
    return fmtDatetime(d, 6, 0);
  }

  // Next 6H cycle start time (ET)
  // Cycles: C1=18:00, C2=00:00, C3=06:00, C4=12:00
  function nextCycleEntry() {
    const cycleStarts = [
      { name: "C2", hour: 0  },
      { name: "C3", hour: 6  },
      { name: "C4", hour: 12 },
      { name: "C1", hour: 18 },
    ];
    // Find next cycle start after current ET hour
    const next = cycleStarts.find(c => c.hour > etHour);
    const d = new Date(etNow);
    if (next) {
      // Same day, later cycle
      return { cycle: next.name, label: fmtDatetime(d, next.hour, 0) };
    } else {
      // C1 already passed, next is C2 tomorrow
      d.setDate(d.getDate() + 1);
      skipWeekend(d);
      return { cycle: "C2", label: fmtDatetime(d, 0, 0) };
    }
  }

  function mkSignal(ds, tf) {
    if (!ds) return { type: null, direction: "NEUTRAL", confidence: 0, entryWindow: null, entryTime: null, note: "", levels: null };
    const lock = ds.lockState;
    const type = lock?.currentOpportunity ?? null; // "BUY", "SELL", or null

    let entryWindow = null;
    let entryTime   = null;
    if (type === "BUY" || type === "SELL") {
      if (tf === "weekly") {
        const tue = nextTuesdayDate();
        entryWindow = `Dinsdag C3 open — ${tue}`;
        entryTime   = tue;
      } else if (tf === "daily") {
        const nxt = nextDayC3();
        entryWindow = `Volgende dag C3 — ${nxt}`;
        entryTime   = nxt;
      } else if (tf === "cycle") {
        const nxt = nextCycleEntry();
        entryWindow = `${nxt.cycle} open — ${nxt.label} (1:30–3:00h in)`;
        entryTime   = nxt.label;
      }
    }

    return {
      type,
      direction:    ds.direction,
      confidence:   ds.confidence,
      structure:    ds.structure,
      entryWindow,
      entryTime,
      lockStrength: lock?.strength ?? 0,
      note:         lock ? lock.note : ds.note,
      levels:       lock?.levels ?? null,
    };
  }

  const weekly = mkSignal(weeklyDS, "weekly");
  const daily  = mkSignal(dailyDS,  "daily");
  const cycle  = mkSignal(cycleDS,  "cycle");

  // Summary: how many active signals right now
  const activeSignals = [weekly, daily, cycle].filter(s => s.type !== null);
  const allSameDir    = activeSignals.length > 1 &&
    activeSignals.every(s => s.type === activeSignals[0].type);

  return { weekly, daily, cycle, activeSignals: activeSignals.length, allAligned: allSameDir };
}

// ── Main bias computation ─────────────────────────────────────────────────────

/**
 * Main function: computes full weekly bias from 15-min candles.
 * @param {Array}  candles   - Array of {timestamp, open, high, low, close, volume}
 * @param {Object} override  - Optional {direction, reason} manual override
 */
// computeBias accepts optional multi-timeframe candles for better historical depth:
//   extraTF.daily   — daily (1D) candles: used for weekly + daily structure (months of history)
//   extraTF.hourly  — 1h candles: used for 6h cycle structure (weeks of history)
// Falls back to 15-min candles for all levels when not provided.
export function computeBias(candles, override = null, extraTF = {}) {
  if (!candles?.length) return { bias: "NEUTRAL", confidence: 0, reason: "Geen candles", error: true };

  // Use last known close even if stale (currentPrice = 0 when market closed)
  const lastClose = candles[candles.length - 1].close;
  const currentPrice = lastClose || candles.reduce((p, c) => c.close > 0 ? c.close : p, 0);
  const nowTs        = Date.now() / 1000;
  const todayName    = getTradingDayName(nowTs);

  // ── Build day / week structures ──────────────────────────────────────────
  // If daily candles provided: use them for weekly/daily analysis (much more history)
  // If hourly candles provided: use them for cycle analysis (better resolution per cycle)
  const dailyCandles  = extraTF.daily?.length  >= 10 ? extraTF.daily  : null;
  // Prefer explicit 1H file; otherwise derive from 15-min (always fresh, monitor runs every 15 min)
  const hourlyCandles = extraTF.hourly?.length >= 20
    ? extraTF.hourly
    : (candles.length >= 20 ? aggregate15ToHourly(candles) : null);

  const days  = groupCandlesByDay(hourlyCandles ?? candles);   // for cycle analysis
  const daysForDaily = dailyCandles ? groupCandlesByDay(dailyCandles) : groupCandlesByDay(candles);
  const weeks = dailyCandles ? groupCandlesByWeek(dailyCandles) : groupCandlesByWeek(candles);

  const currentWeek = weeks[weeks.length - 1];
  const prevWeek    = weeks[weeks.length - 2] ?? null;

  const currentWeekDays = daysForDaily.filter(d => getTradingWeekKey(d.startTs) === currentWeek?.key);
  const prevWeekDays    = daysForDaily.filter(d => getTradingWeekKey(d.startTs) === prevWeek?.key);

  // ── Order Flow (C3-based, intraday) ──────────────────────────────────────
  const orderFlow = analyzeOrderFlow(days);

  // ── Top-Down Structure Analysis (#1 SIGNAAL) ──────────────────────────────
  // Weekly → Daily → Cycle structure (same H/L logic per timeframe)
  const weeklyStructure = analyzeWeeklyStructure(weeks);
  const dailyStructure  = analyzeDailyStructure(daysForDaily);
  const cycleStructure  = analyzeCycleStructure(days);
  const topDown         = analyzeTopDown(weeklyStructure, dailyStructure, cycleStructure);

  // ── Equal Highs / Lows (BEVESTIGING — #2 SIGNAAL) ─────────────────────────
  const recentDays = daysForDaily.slice(-8);
  const equalHighs = findEqualHighs(recentDays, 0.3, currentPrice);
  const equalLows  = findEqualLows(recentDays, 0.3, currentPrice);

  const primaryEQH = equalHighs.length ? equalHighs[equalHighs.length - 1] : null;
  const primaryEQL = equalLows.length  ? equalLows[equalLows.length  - 1]  : null;

  // ── Weekly expansion ──────────────────────────────────────────────────────
  const expansion = detectExpandingWeek(currentWeek, prevWeek);

  // ── Wednesday / Thursday / Friday analysis ───────────────────────────────
  const wedAnalysis = analyzeWednesday(daysForDaily, currentWeekDays);
  const thuAnalysis = analyzeThursday(currentWeekDays, null);

  // ── Price zone ────────────────────────────────────────────────────────────
  const priceZone = getPriceZone(currentPrice, currentWeek?.high, currentWeek?.low);

  const friAnalysis = analyzeFriday(currentWeekDays, currentWeek, priceZone);

  // ── Bias logic ────────────────────────────────────────────────────────────
  let bias       = "NEUTRAL";
  let confidence = 50;
  const reasons  = [];
  let primarySignal = null;

  // 1. TOP-DOWN STRUCTUUR — primair signaal (weekly + daily + cycle aligned)
  if (topDown.direction !== "NEUTRAL") {
    bias          = topDown.direction;
    confidence    = topDown.confidence;
    const opp     = topDown.currentOpportunity;
    primarySignal = topDown.alignmentLabel === "FULL_ALIGNMENT"
      ? (bias === "BULLISH" ? (opp === "BUY" ? "TOPDOWN_FULL_BUY" : "TOPDOWN_FULL_BULLISH") : (opp === "SELL" ? "TOPDOWN_FULL_SELL" : "TOPDOWN_FULL_BEARISH"))
      : (bias === "BULLISH" ? (opp === "BUY" ? "TOPDOWN_BUY" : "TOPDOWN_BULLISH") : (opp === "SELL" ? "TOPDOWN_SELL" : "TOPDOWN_BEARISH"));
    reasons.push(topDown.note);
  }

  // 1b. C3 ORDER FLOW — bevestigt of overschrijft top-down indien sterk conflict
  if (orderFlow.direction !== "NEUTRAL") {
    if (orderFlow.direction === bias) {
      confidence = Math.min(92, confidence + 6);
      reasons.push(orderFlow.reason);
    } else if (bias === "NEUTRAL") {
      bias          = orderFlow.direction;
      confidence    = orderFlow.confidence;
      primarySignal = orderFlow.direction === "BULLISH" ? "ORDER_FLOW_BULLISH" : "ORDER_FLOW_BEARISH";
      reasons.push(orderFlow.reason);
    } else if (orderFlow.confidence > confidence + 12) {
      bias          = orderFlow.direction;
      confidence    = orderFlow.confidence;
      primarySignal = orderFlow.direction === "BULLISH" ? "ORDER_FLOW_BULLISH" : "ORDER_FLOW_BEARISH";
      reasons.push(`C3 order flow (sterk) overschrijft top-down: ${orderFlow.reason}`);
    } else {
      reasons.push(`⚠ C3 order flow (${orderFlow.direction}) conflicteert — top-down dominant`);
    }
  }

  // 2. EQH / EQL — bevestiging of override van OF
  if (primaryEQH && primaryEQL) {
    const eqhDist = Math.abs(currentPrice - primaryEQH.level);
    const eqlDist = Math.abs(currentPrice - primaryEQL.level);
    if (eqhDist < eqlDist) {
      if (bias !== "BULLISH") { bias = "BULLISH"; confidence = 72; primarySignal = "EQH_PENDING"; }
      else confidence = Math.min(92, confidence + 8);
      reasons.push(`EQH @ ${primaryEQH.level} (${primaryEQH.dayA}/${primaryEQH.dayB}) niet geswept → bevestigt bullish`);
    } else {
      if (bias !== "BEARISH") { bias = "BEARISH"; confidence = 72; primarySignal = "EQL_PENDING"; }
      else confidence = Math.min(92, confidence + 8);
      reasons.push(`EQL @ ${primaryEQL.level} (${primaryEQL.dayA}/${primaryEQL.dayB}) niet geswept → bevestigt bearish`);
    }
  } else if (primaryEQH) {
    if (bias === "BULLISH") {
      confidence = Math.min(92, confidence + 8);
      reasons.push(`EQH @ ${primaryEQH.level} (${primaryEQH.dayA}/${primaryEQH.dayB}) niet geswept → bevestigt bullish OF`);
    } else if (bias === "NEUTRAL") {
      bias = "BULLISH"; confidence = 72; primarySignal = "EQH_PENDING";
      reasons.push(`EQH @ ${primaryEQH.level} (${primaryEQH.dayA}/${primaryEQH.dayB}) niet geswept → bullish`);
    } else {
      // EQH against bearish OF — note conflict
      reasons.push(`EQH @ ${primaryEQH.level} (${primaryEQH.dayA}/${primaryEQH.dayB}) aanwezig maar bearish OF domineert`);
    }
  } else if (primaryEQL) {
    if (bias === "BEARISH") {
      confidence = Math.min(92, confidence + 8);
      reasons.push(`EQL @ ${primaryEQL.level} (${primaryEQL.dayA}/${primaryEQL.dayB}) niet geswept → bevestigt bearish OF`);
    } else if (bias === "NEUTRAL") {
      bias = "BEARISH"; confidence = 72; primarySignal = "EQL_PENDING";
      reasons.push(`EQL @ ${primaryEQL.level} (${primaryEQL.dayA}/${primaryEQL.dayB}) niet geswept → bearish`);
    } else {
      reasons.push(`EQL @ ${primaryEQL.level} (${primaryEQL.dayA}/${primaryEQL.dayB}) aanwezig maar bullish OF domineert`);
    }
  }

  // 3. Wednesday reversal — alleen als OF NEUTRAAL is, of als OF en reversal gelijk lopen
  // Een verse EQH/EQL (Thu/Fri) overschrijft de Wednesday reversal
  const LATE_DAYS = new Set(["Thursday", "Friday"]);
  const eqhIsFresh = primaryEQH && (LATE_DAYS.has(primaryEQH.dayA) || LATE_DAYS.has(primaryEQH.dayB));
  const eqlIsFresh = primaryEQL && (LATE_DAYS.has(primaryEQL.dayA) || LATE_DAYS.has(primaryEQL.dayB));

  if (wedAnalysis.analyzed && wedAnalysis.isReversal) {
    if (wedAnalysis.isBearishReversal) {
      if (eqhIsFresh || orderFlow.direction === "BULLISH") {
        reasons.push("Woensdag bearish reversal geprobeerd maar prijs keerde terug → order flow/EQH overschrijft");
      } else if (bias !== "BULLISH") {
        bias = "BEARISH";
        confidence = Math.max(confidence, 75);
        primarySignal = "WEDNESDAY_REVERSAL_BEARISH";
        reasons.push("Woensdag bearish reversal (week high + afwijzing)");
      }
    } else if (wedAnalysis.isBullishReversal) {
      if (eqlIsFresh || orderFlow.direction === "BEARISH") {
        reasons.push("Woensdag bullish reversal geprobeerd maar prijs keerde terug → order flow/EQL overschrijft");
      } else if (bias !== "BEARISH") {
        bias = "BULLISH";
        confidence = Math.max(confidence, 75);
        primarySignal = "WEDNESDAY_REVERSAL_BULLISH";
        reasons.push("Woensdag bullish reversal (week low + afwijzing)");
      }
    }
  }

  // 4. Wednesday EQ continuation (bevestiging)
  if (wedAnalysis.analyzed && wedAnalysis.eqHighContinuation && bias === "BULLISH") {
    confidence = Math.min(95, confidence + 8);
    reasons.push("Woensdag liet equal high achter → trend gaat door, bullish bevestigd");
  }
  if (wedAnalysis.analyzed && wedAnalysis.eqLowContinuation && bias === "BEARISH") {
    confidence = Math.min(95, confidence + 8);
    reasons.push("Woensdag liet equal low achter → trend gaat door, bearish bevestigd");
  }

  // 5. Expanding week (bevestiging)
  if (expansion.isExpanding) {
    if (expansion.side === "HIGH" && bias !== "BEARISH") {
      confidence = Math.min(95, confidence + 8);
      reasons.push("Expanding week (hoge kant) → bullish bevestiging");
    } else if (expansion.side === "LOW" && bias !== "BULLISH") {
      confidence = Math.min(95, confidence + 8);
      reasons.push("Expanding week (lage kant) → bearish bevestiging");
    }
  }

  // 6. Friday range-reversion (only active from C3 onwards — C1/C2 still follow week trend)
  if (todayName === "Friday" && friAnalysis.isHighProbReversion) {
    if (friAnalysis.reversionActive) {
      // C3/C4: reversion is live — flip to counter-trend
      bias          = friAnalysis.reversionDirection;
      confidence    = Math.max(confidence, friAnalysis.reversionConfidence);
      primarySignal = friAnalysis.wholeWeekBullish
        ? "FRIDAY_REVERSION_BEARISH"
        : "FRIDAY_REVERSION_BULLISH";
      reasons.unshift(
        friAnalysis.wholeWeekBullish
          ? `Vrijdag C3+ reversion actief: hele week bullish → bearish richting weekmidden ${friAnalysis.reversionTarget}`
          : `Vrijdag C3+ reversion actief: hele week bearish → bullish richting weekmidden ${friAnalysis.reversionTarget}`
      );
    } else {
      // C1/C2: trend loopt nog door — houd wekelijkse bias, markeer reversion als "coming"
      // bias blijft ongewijzigd (wekelijkse trend), maar voeg waarschuwing toe
      confidence    = Math.min(95, confidence + 5);
      primarySignal = primarySignal ?? (friAnalysis.wholeWeekBullish ? "EQH_PENDING" : "EQL_PENDING");
      reasons.push(
        friAnalysis.wholeWeekBullish
          ? `Vrijdag C1/C2: trend loopt nog door (bullish). Reversion START pas bij C3 (06:00 ET) → target ${friAnalysis.reversionTarget}`
          : `Vrijdag C1/C2: trend loopt nog door (bearish). Reversion START pas bij C3 (06:00 ET) → target ${friAnalysis.reversionTarget}`
      );
    }
  }

  // 6b. Day-of-week adjustments
  const dowAdvice = getDayOfWeekAdvice(todayName, bias, priceZone, wedAnalysis, thuAnalysis, friAnalysis);

  // 7. Price zone penalty/bonus
  if (priceZone === "PREMIUM" && bias === "BULLISH") {
    confidence = Math.max(40, confidence - 8);
    reasons.push("Prijs in premium zone — hogere risk voor bullish entries");
  }
  if (priceZone === "DISCOUNT" && bias === "BEARISH") {
    confidence = Math.max(40, confidence - 8);
    reasons.push("Prijs in discount zone — hogere risk voor bearish entries");
  }

  // ── Override ────────────────────────────────────────────────────────────────
  if (override?.direction) {
    const origBias = bias;
    bias = override.direction;
    confidence = 100;
    reasons.unshift(`HANDMATIGE OVERRIDE: ${override.direction} (${override.reason ?? "geen reden"})`);
    primarySignal = "MANUAL_OVERRIDE";
  }

  // ── Build weekly candle display data ───────────────────────────────────────
  const weeklyCandles = weeks.slice(-4).map(w => ({
    key:   w.key, open: w.open, high: w.high, low: w.low, close: w.close,
    startTs: w.startTs, endTs: w.endTs,
    direction: w.close >= w.open ? "BULL" : "BEAR",
  }));

  const dailyCandlesDisplay = daysForDaily.slice(-10).map(d => ({
    key:       d.key, dayName: d.dayName,
    open: d.open, high: d.high, low: d.low, close: d.close,
    startTs: d.startTs, endTs: d.endTs,
    isToday:   d.key === getTradingDayKey(nowTs),
    direction: d.close >= d.open ? "BULL" : "BEAR",
    volume:    d.volume,
    isComplete: d.isComplete,
  }));

  return {
    bias,
    confidence:   +confidence.toFixed(0),
    primarySignal,
    reasons,
    orderFlow,
    topDown,
    weeklyStructure,
    dailyStructure,
    cycleStructure,
    equalHighs:   equalHighs.slice(-4),
    equalLows:    equalLows.slice(-4),
    primaryEQH,
    primaryEQL,
    weeklyOHLC: currentWeek ? {
      open: currentWeek.open, high: currentWeek.high,
      low:  currentWeek.low,  close: currentWeek.close,
      direction: currentWeek.close >= currentWeek.open ? "BULL" : "BEAR",
    } : null,
    prevWeeklyOHLC: prevWeek ? {
      open: prevWeek.open, high: prevWeek.high,
      low:  prevWeek.low,  close: prevWeek.close,
    } : null,
    dailyOHLC: dailyCandlesDisplay,
    weeklyCandles,
    todayName,
    priceZone,
    currentPrice,
    expansion,
    wednesday:  wedAnalysis,
    thursday:   thuAnalysis,
    friday:     friAnalysis,
    dowAdvice,
    overridden: !!override?.direction,
    override:   override ?? null,
    computedAt: nowTs,
    fractalSignals: getFractalSignals(weeklyStructure, dailyStructure, cycleStructure),
    orderFlowMoves: {
      daily:  dailyStructure.moves  ?? [],
      weekly: weeklyStructure.moves ?? [],
      cycle:  cycleStructure.moves  ?? [],
    },
  };
}

// ── Day-of-week advice ────────────────────────────────────────────────────────

function getDayOfWeekAdvice(dayName, bias, priceZone, wedAnalysis, thuAnalysis, friAnalysis) {
  const biasLabel = bias === "BULLISH" ? "bullish" : bias === "BEARISH" ? "bearish" : "neutraal";

  switch (dayName) {
    case "Monday":
      return {
        phase:       "Low forming",
        description: "Maandag vormt vaak de low van de week. C1/C2 zijn observatie — markt maakt keerpunten pas vanaf C3.",
        entryAdvice: "C3 is de vroegste entry. Wacht op bevestiging, beste entry dag is dinsdag.",
        highProb:    ["C3"],
        lowProb:     ["C1","C2","C4"],
        note:        "C1/C2 geen entries — markt zoekt nog richting",
        highlight:   "OBSERVE",
      };
    case "Tuesday":
      return {
        phase:       "Best entry day",
        description: "Dinsdag bevestigt de wekelijkse richting. Keerpunten en continuation starten vanaf C3.",
        entryAdvice: `Bias is ${biasLabel}. C3 is de primaire entry — markt toont richting pas na C2.`,
        highProb:    ["C3"],
        lowProb:     ["C1","C2"],
        note:        "C3 is primair, C4 als continuation bevestigd",
        highlight:   "ENTRY",
      };
    case "Wednesday":
      if (wedAnalysis?.isReversal) {
        return {
          phase:       "Midweek reversal",
          description: "Woensdag reversal gedetecteerd. Markt draait om — keerpunt verwacht vanaf C3.",
          entryAdvice: "C3 is de entry voor de reversal. C1/C2 zijn te vroeg — wacht op bevestiging.",
          highProb:    ["C3"],
          lowProb:     ["C1","C2"],
          note:        "Reversal begint pas C3 — niet te vroeg instappen",
          highlight:   "REVERSAL",
        };
      }
      return {
        phase:       "Midweek continuation / reversal check",
        description: wedAnalysis?.eqHighContinuation
          ? "Woensdag liet equal high achter → trend gaat door. Continuation entry C3."
          : "Woensdag: check equal high/low. Keerpunten en continuation starten vanaf C3.",
        entryAdvice: "C3 is de primaire sessie voor continuation of reversal vandaag. C1/C2 te vroeg.",
        highProb:    ["C3"],
        lowProb:     ["C1","C2"],
        note:        "C3 = keerpunt of continuation — C1/C2 lagere kans",
        highlight:   "CONTINUATION",
      };
    case "Thursday":
      return {
        phase:       "Pullback day — C4 entry",
        description: thuAnalysis?.thuBrokeWedHigh
          ? "Donderdag brak Wednesday high → upside potential. Vrijdag reversal verwacht. C4 beste entry."
          : "Donderdag: pullback na Wednesday expansie. C4 is de beste continuation entry.",
        entryAdvice: "C4 (13:30–15:00 ET) is de hoogste kans entry. C1/C2/C3 hebben lagere kans vandaag.",
        highProb:    ["C4"],
        lowProb:     ["C1","C2","C3"],
        note:        "Uitzondering: donderdag is C4 ipv C3 de beste sessie",
        highlight:   "C4_ENTRY",
      };
    case "Friday": {
      const inC3orC4 = friAnalysis?.currentCycle === "C3" || friAnalysis?.currentCycle === "C4";
      if (friAnalysis?.isHighProbReversion) {
        const dir    = friAnalysis.reversionDirection;
        const target = friAnalysis.reversionTarget;
        if (inC3orC4) {
          // Reversion is live
          return {
            phase:       `Vrijdag Reversion ACTIEF (${friAnalysis.currentCycle})`,
            description: friAnalysis.wholeWeekBullish
              ? `C3 gestart — reversion actief. Bearish richting weekmidden (${target}).`
              : `C3 gestart — reversion actief. Bullish richting weekmidden (${target}).`,
            entryAdvice: `Zoek ${dir === "BEARISH" ? "SHORT" : "LONG"} entry nu (${friAnalysis.currentCycle}). Target: ${target}.`,
            highProb:    ["C3","C4"],
            lowProb:     [],
            note:        "Reversion is actief — bias omgedraaid t.o.v. weektrend",
            highlight:   "FRIDAY_REVERSION",
            reversionTarget:     target,
            reversionDirection:  dir,
            reversionConfidence: friAnalysis.reversionConfidence,
          };
        } else {
          // C1/C2 — trend loopt nog, reversion komt eraan
          const trendDir = friAnalysis.wholeWeekBullish ? "BULLISH" : "BEARISH";
          return {
            phase:       `Vrijdag C1/C2 — trend loopt nog (reversion start C3)`,
            description: friAnalysis.wholeWeekBullish
              ? `Hele week bullish. In C1/C2 loopt trend nog door. Reversion (BEARISH) begint pas bij C3 (06:00 ET).`
              : `Hele week bearish. In C1/C2 loopt trend nog door. Reversion (BULLISH) begint pas bij C3 (06:00 ET).`,
            entryAdvice: `Bias is nog ${trendDir} (pre-C3). Wacht op C3 voor reversion entry richting ${target}.`,
            highProb:    [],
            lowProb:     ["C1","C2"],
            note:        `C3 start (06:00 ET) = reversion naar ${dir} — nu nog niet`,
            highlight:   "FRIDAY_WAIT_C3",
            reversionTarget:     target,
            reversionDirection:  dir,
            reversionConfidence: friAnalysis.reversionConfidence,
          };
        }
      }
      return {
        phase:       "Vrijdag — C3 keerpunt of continuation",
        description: "Vrijdag: markt maakt keerpunten of continuations pas vanaf C3. C1/C2 zijn geen entries.",
        entryAdvice: "Wacht op C3 (06:00–12:00 ET) voor eventuele entry. C1/C2 overslaan.",
        highProb:    ["C3"],
        lowProb:     ["C1","C2"],
        note:        "C4 mogelijk als continuation na C3 bevestiging",
        highlight:   "FRIDAY_C3",
      };
    }
    default:
      return {
        phase: "Weekend", description: "Markt gesloten.", entryAdvice: "", highProb: [], lowProb: [], highlight: "CLOSED",
      };
  }
}

// ── 3-Day Order Flow Analysis ─────────────────────────────────────────────────
//
// Enhanced version of analyzeOrderFlow that looks back 3 completed days:
//   Day 3 (anchor) = stable baseline — must stay respected for bias to hold
//   Day 2          = may be broken once (liquidity hunt / gap fill)
//   Day 1          = yesterday = direct reference
//
// Rule: if Day 1 broke Day 2's C3 level but Day 1's close returned back,
// AND Day 3's C3 is still being respected → Day 2 was a liquidity hunt,
// OF direction is anchored to Day 3.
export function analyzeOrderFlow3Day(days) {
  const completed = days.filter(d => d.isComplete);
  if (completed.length < 2) {
    return { direction: "NEUTRAL", confidence: 50, structureIntact: true,
             note: "Te weinig data", isLiquidityHunt: false, activatedOn: null };
  }

  const day1 = completed[completed.length - 1]; // yesterday
  const day2 = completed.length >= 2 ? completed[completed.length - 2] : null;
  const day3 = completed.length >= 3 ? completed[completed.length - 3] : null;

  // -- Primary: did day1 break day2's C3 high/low? --
  let direction   = "NEUTRAL";
  let confidence  = 50;
  let isLiquidityHunt = false;
  let activatedOn = null;
  let note        = "";
  let anchorDay   = null;

  if (day2 && day2.c3High != null && day2.c3Low != null) {
    const broke1High = day1.high > day2.c3High;
    const broke1Low  = day1.low  < day2.c3Low;

    if (broke1High && !broke1Low) {
      direction   = "BULLISH";
      confidence  = 72;
      activatedOn = day1.dayName;
      anchorDay   = day2;
      note        = `Day1 (${day1.dayName}) brak C3 high (${day2.c3High}) van Day2 (${day2.dayName}) → bullish OF`;
    } else if (broke1Low && !broke1High) {
      direction   = "BEARISH";
      confidence  = 72;
      activatedOn = day1.dayName;
      anchorDay   = day2;
      note        = `Day1 (${day1.dayName}) brak C3 low (${day2.c3Low}) van Day2 (${day2.dayName}) → bearish OF`;
    } else if (!broke1High && !broke1Low) {
      // Day1 did NOT break day2's C3 — check if day2 broke day3's C3 (day3 is anchor)
      if (day3 && day3.c3High != null && day3.c3Low != null) {
        const broke2High = day2.high > day3.c3High;
        const broke2Low  = day2.low  < day3.c3Low;

        // Detect liquidity hunt: day2 broke a level but closed back the other side
        const day2LiqHuntBull = broke2Low  && day2.close > day3.c3Low;  // swept below but closed above
        const day2LiqHuntBear = broke2High && day2.close < day3.c3High; // swept above but closed below

        if (day2LiqHuntBull) {
          // Day2 was a bearish liquidity hunt — anchor is day3's bullish OF
          // Valid if day1 is still above day3.c3High (higher lows held)
          if (day1.low > day3.c3Low) {
            direction       = "BULLISH";
            confidence      = 68;
            isLiquidityHunt = true;
            activatedOn     = day3.dayName;
            anchorDay       = day3;
            note = `Day2 (${day2.dayName}) was liquidity hunt (swept C3 low ${day3.c3Low} maar sloot boven) — OF bullish vanuit Day3 (${day3.dayName})`;
          }
        } else if (day2LiqHuntBear) {
          // Day2 was a bullish liquidity hunt — anchor is day3's bearish OF
          if (day1.high < day3.c3High) {
            direction       = "BEARISH";
            confidence      = 68;
            isLiquidityHunt = true;
            activatedOn     = day3.dayName;
            anchorDay       = day3;
            note = `Day2 (${day2.dayName}) was liquidity hunt (swept C3 high ${day3.c3High} maar sloot onder) — OF bearish vanuit Day3 (${day3.dayName})`;
          }
        } else if (broke2High && !broke2Low && day1.high > day3.c3High) {
          // Day2 broke day3 C3 high cleanly, day1 confirms (still above) → continuation bullish
          direction   = "BULLISH";
          confidence  = 65;
          activatedOn = day2.dayName;
          anchorDay   = day3;
          note = `Day2 (${day2.dayName}) brak C3 high van Day3 (${day3.dayName}), Day1 bevestigt → bullish OF gecontinueerd`;
        } else if (broke2Low && !broke2High && day1.low < day3.c3Low) {
          direction   = "BEARISH";
          confidence  = 65;
          activatedOn = day2.dayName;
          anchorDay   = day3;
          note = `Day2 (${day2.dayName}) brak C3 low van Day3 (${day3.dayName}), Day1 bevestigt → bearish OF gecontinueerd`;
        } else {
          note = "Geen duidelijke 3-day OF structuur gevonden";
        }
      } else {
        note = "Day1 brak C3 van Day2 niet — te weinig data voor 3-day check";
      }
    }
  }

  // Structure check: if direction is known, verify it's still holding
  let structureIntact = true;
  if (direction === "BULLISH" && day1.low < (anchorDay?.c3Low ?? -Infinity)) {
    structureIntact = false;
    confidence = Math.max(50, confidence - 10);
    note += " (⚠ lagere low — structuur licht verzwakt)";
  }
  if (direction === "BEARISH" && day1.high > (anchorDay?.c3High ?? Infinity)) {
    structureIntact = false;
    confidence = Math.max(50, confidence - 10);
    note += " (⚠ hogere high — structuur licht verzwakt)";
  }

  return {
    direction,
    confidence: +confidence.toFixed(0),
    structureIntact,
    isLiquidityHunt,
    activatedOn,
    anchorDay: anchorDay ? { dayName: anchorDay.dayName, c3High: anchorDay.c3High, c3Low: anchorDay.c3Low } : null,
    note,
    day1: { dayName: day1.dayName, c3High: day1.c3High, c3Low: day1.c3Low },
    day2: day2 ? { dayName: day2.dayName, c3High: day2.c3High, c3Low: day2.c3Low } : null,
    day3: day3 ? { dayName: day3.dayName, c3High: day3.c3High, c3Low: day3.c3Low } : null,
  };
}

// ── Backtest V2 — full trade simulation with SL/TP ───────────────────────────
//
// Simulates autonomous entries based on bias with:
//   - Entry: first C3 candle open (06:00 ET), except Thursday → C4 (12:00 ET)
//   - SL: previous cycle (C2 for most days, C3 for Thursday) extreme
//   - TP: 1:2 RR (TP = entry ± 2 * SL distance)
//   - Exit: first candle that hits SL or TP, else close at session end
export function runBacktestV2(candles, options = {}) {
  const {
    startDate = null,
    endDate   = null,
    rrRatio   = 2,
    use3DayOF = true,
  } = options;

  const days = groupCandlesByDay(candles);
  if (days.length < 4) return { trades: [], insights: null };

  const results = [];

  for (let i = 3; i < days.length; i++) {
    const day = days[i];

    // Skip non-trading days
    if (!["Monday","Tuesday","Wednesday","Thursday","Friday"].includes(day.dayName)) continue;
    if (!day.isComplete) continue;
    if (startDate && day.key < startDate) continue;
    if (endDate   && day.key > endDate)   continue;

    // Build candle slice up to the START of this day for bias computation
    const candlesUpTo = candles.filter(c => c.timestamp < day.startTs);
    if (candlesUpTo.length < 20) continue;

    // Compute bias
    const biasResult = computeBias(candlesUpTo);
    const bias = biasResult.bias;
    if (bias === "NEUTRAL") {
      // Still record neutral as no-trade
      results.push({
        date: day.key, dayName: day.dayName, bias: "NEUTRAL",
        confidence: biasResult.confidence,
        primarySignal: biasResult.primarySignal ?? null,
        ofDirection: "NEUTRAL", ofNote: "Geen bias — geen trade",
        entryType: null, entryPrice: null, entryTime: null,
        sl: null, tp: null, slDist: null,
        exitPrice: null, exitTime: null, exitCycle: null,
        pnl: null, rr: null, outcome: "NO_TRADE",
        reasons: biasResult.reasons.slice(0, 3),
        isLiquidityHunt: false,
      });
      continue;
    }

    // Top-down structure analysis at the time of this day
    const recentDaysForDS  = days.slice(Math.max(0, i - 15), i);
    const weeksForDS       = groupCandlesByWeek(candlesUpTo).slice(-8);
    const wkDS  = analyzeWeeklyStructure(weeksForDS);
    const dayDS = analyzeDailyStructure(recentDaysForDS);
    const cyDS  = analyzeCycleStructure(recentDaysForDS);
    const tdDS  = analyzeTopDown(wkDS, dayDS, cyDS);

    // 3-Day OF analysis
    const recentDaysForOF = days.slice(Math.max(0, i - 4), i);
    const ofAnalysis = use3DayOF ? analyzeOrderFlow3Day(recentDaysForOF) : biasResult.orderFlow;

    // Current opportunity from top-down
    const dsOpportunity = tdDS.currentOpportunity; // "BUY", "SELL", or null

    // Entry session: C4 on Thursday, else C3
    const isThursday   = day.dayName === "Thursday";
    const entryEtStart = isThursday ? 12 : 6;
    const entryEtEnd   = isThursday ? 18 : 12;
    const prevEtEnd    = isThursday ? 12 : 6; // previous session for SL

    const entryCandleList = day.candles.filter(c => {
      const h = getETInfo(c.timestamp).hour;
      return h >= entryEtStart && h < entryEtEnd;
    });
    if (!entryCandleList.length) continue;

    const entryCandle = entryCandleList[0];
    const entryPrice  = +entryCandle.open.toFixed(2);
    const entryTime   = entryCandle.timestamp;
    const isLong      = bias === "BULLISH";

    // SL: previous session (C2 for C3 entries, C3 for C4/Thursday entries)
    const prevSessionCandles = day.candles.filter(c => {
      const h = getETInfo(c.timestamp).hour;
      return h >= prevEtEnd - 6 && h < prevEtEnd;
    });

    let sl;
    if (prevSessionCandles.length >= 3) {
      sl = isLong
        ? +Math.min(...prevSessionCandles.map(c => c.low)).toFixed(2)
        : +Math.max(...prevSessionCandles.map(c => c.high)).toFixed(2);
    } else {
      // Fallback: use 0.3% of entry price
      sl = isLong
        ? +(entryPrice * 0.997).toFixed(2)
        : +(entryPrice * 1.003).toFixed(2);
    }

    const slDist = +Math.abs(entryPrice - sl).toFixed(2);
    if (slDist < 1) continue; // skip if SL is too tight (bad data)

    const tp = isLong
      ? +(entryPrice + slDist * rrRatio).toFixed(2)
      : +(entryPrice - slDist * rrRatio).toFixed(2);

    // Simulate trade through remaining candles of the day
    const afterEntry = day.candles.filter(c => c.timestamp >= entryTime);
    let outcome   = "OPEN";
    let exitPrice = null;
    let exitTime  = null;
    let exitCycle = null;

    for (const c of afterEntry) {
      const h = getETInfo(c.timestamp).hour;
      const cycle = h >= 18 ? "C1" : h >= 12 ? "C4" : h >= 6 ? "C3" : "C2";

      if (isLong) {
        if (c.low <= sl) {
          outcome = "LOSS"; exitPrice = sl; exitTime = c.timestamp; exitCycle = cycle; break;
        }
        if (c.high >= tp) {
          outcome = "WIN";  exitPrice = tp; exitTime = c.timestamp; exitCycle = cycle; break;
        }
      } else {
        if (c.high >= sl) {
          outcome = "LOSS"; exitPrice = sl; exitTime = c.timestamp; exitCycle = cycle; break;
        }
        if (c.low <= tp) {
          outcome = "WIN";  exitPrice = tp; exitTime = c.timestamp; exitCycle = cycle; break;
        }
      }
    }

    // If open at day end → close at last candle
    if (outcome === "OPEN") {
      const last = day.candles[day.candles.length - 1];
      exitPrice = +last.close.toFixed(2);
      exitTime  = last.timestamp;
      exitCycle = "EOD";
      const pnlRaw = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
      outcome = pnlRaw > 0 ? "WIN" : pnlRaw < 0 ? "LOSS" : "NEUTRAL";
    }

    const pnl = isLong
      ? +(exitPrice - entryPrice).toFixed(2)
      : +(entryPrice - exitPrice).toFixed(2);
    const rr  = slDist > 0 ? +(pnl / slDist).toFixed(2) : 0;

    results.push({
      date:          day.key,
      dayName:       day.dayName,
      bias,
      confidence:    biasResult.confidence,
      primarySignal: biasResult.primarySignal ?? null,
      ofDirection:   ofAnalysis.direction,
      ofNote:        ofAnalysis.note ?? ofAnalysis.reason ?? "",
      isLiquidityHunt: ofAnalysis.isLiquidityHunt ?? false,
      // Top-down structure fields
      tdAlignment:    tdDS.alignmentLabel,
      tdWeekly:       wkDS.direction,
      tdDaily:        dayDS.direction,
      tdCycle:        cyDS.direction,
      dsOpportunity,
      dsNote:         tdDS.note,
      entryType:     isLong ? "LONG" : "SHORT",
      entryPrice,
      entryTime,
      entryTimeLabel: _tsToETLabel(entryTime),
      sl,
      tp,
      slDist,
      exitPrice,
      exitTime,
      exitTimeLabel: _tsToETLabel(exitTime),
      exitCycle,
      pnl,
      rr,
      outcome,
      reasons:       biasResult.reasons.slice(0, 3),
    });
  }

  const insights = generateBacktestInsights(results);
  return { trades: results, insights };
}

function _tsToETLabel(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// ── Backtest Insights Generator ───────────────────────────────────────────────
export function generateBacktestInsights(trades) {
  const actual = trades.filter(t => t.outcome !== "NO_TRADE" && t.entryType !== null);
  if (actual.length < 3) return { summary: "Te weinig trades voor analyse.", patterns: [], improvements: [] };

  const wins   = actual.filter(t => t.outcome === "WIN").length;
  const losses = actual.filter(t => t.outcome === "LOSS").length;
  const total  = actual.length;
  const winRate = +(wins / total * 100).toFixed(1);
  const totalPnl  = +actual.reduce((s, t) => s + (t.pnl ?? 0), 0).toFixed(2);
  const avgRR     = +actual.filter(t => t.rr != null).reduce((s, t, _, a) => s + t.rr / a.length, 0).toFixed(2);
  const avgConf   = +actual.reduce((s, t, _, a) => s + t.confidence / a.length, 0).toFixed(1);

  // By day of week
  const byDay = {};
  for (const t of actual) {
    if (!byDay[t.dayName]) byDay[t.dayName] = { win: 0, loss: 0, total: 0, pnl: 0 };
    byDay[t.dayName].total++;
    byDay[t.dayName].pnl += t.pnl ?? 0;
    if (t.outcome === "WIN")  byDay[t.dayName].win++;
    if (t.outcome === "LOSS") byDay[t.dayName].loss++;
  }

  // By primary signal
  const bySignal = {};
  for (const t of actual) {
    const sig = t.primarySignal ?? "UNKNOWN";
    if (!bySignal[sig]) bySignal[sig] = { win: 0, loss: 0, total: 0 };
    bySignal[sig].total++;
    if (t.outcome === "WIN")  bySignal[sig].win++;
    if (t.outcome === "LOSS") bySignal[sig].loss++;
  }

  // Liquidity hunt trades
  const liqHuntTrades = actual.filter(t => t.isLiquidityHunt);
  const liqWinRate = liqHuntTrades.length
    ? +(liqHuntTrades.filter(t => t.outcome === "WIN").length / liqHuntTrades.length * 100).toFixed(1)
    : null;

  // By top-down alignment
  const byAlignment = {};
  for (const t of actual) {
    const al = t.tdAlignment ?? "UNKNOWN";
    if (!byAlignment[al]) byAlignment[al] = { win: 0, loss: 0, total: 0, pnl: 0 };
    byAlignment[al].total++;
    byAlignment[al].pnl = +(byAlignment[al].pnl + (t.pnl ?? 0)).toFixed(2);
    if (t.outcome === "WIN")  byAlignment[al].win++;
    if (t.outcome === "LOSS") byAlignment[al].loss++;
  }

  // High-confidence trades (>= 75%)
  const highConf = actual.filter(t => t.confidence >= 75);
  const highConfWR = highConf.length
    ? +(highConf.filter(t => t.outcome === "WIN").length / highConf.length * 100).toFixed(1)
    : null;

  // Pattern detection
  const patterns = [];

  // Best day
  const dayEntries = Object.entries(byDay);
  if (dayEntries.length) {
    const bestDay = dayEntries.sort((a, b) => (b[1].win / b[1].total) - (a[1].win / a[1].total))[0];
    const worstDay = dayEntries.sort((a, b) => (a[1].win / a[1].total) - (b[1].win / b[1].total))[0];
    if (bestDay[1].total >= 2) {
      const wr = +(bestDay[1].win / bestDay[1].total * 100).toFixed(0);
      patterns.push({ type: "BEST_DAY", label: `${bestDay[0]}: beste dag (${wr}% win rate, ${bestDay[1].total} trades)`, positive: true });
    }
    if (worstDay[1].total >= 2) {
      const wr = +(worstDay[1].win / worstDay[1].total * 100).toFixed(0);
      if (wr < 40) patterns.push({ type: "WORST_DAY", label: `${worstDay[0]}: slechtste dag (${wr}% win rate, ${worstDay[1].total} trades) — overweeg te skippen`, positive: false });
    }
  }

  // Top-down alignment insight
  const fullAl = byAlignment["FULL_ALIGNMENT"];
  const partAl = byAlignment["PARTIAL_ALIGNMENT"];
  const confAl = byAlignment["CONFLICT"];
  if (fullAl && fullAl.total >= 2) {
    const wr = +(fullAl.win / fullAl.total * 100).toFixed(1);
    patterns.push({ type: "FULL_ALIGN", label: `FULL ALIGNMENT (W+D+C): ${wr}% win rate (${fullAl.total} trades)`, positive: wr >= 55 });
  }
  if (partAl && partAl.total >= 2) {
    const wr = +(partAl.win / partAl.total * 100).toFixed(1);
    patterns.push({ type: "PARTIAL_ALIGN", label: `PARTIAL ALIGNMENT (2/3): ${wr}% win rate (${partAl.total} trades)`, positive: wr >= 55 });
  }
  if (confAl && confAl.total >= 2) {
    const wr = +(confAl.win / confAl.total * 100).toFixed(1);
    patterns.push({ type: "CONFLICT", label: `CONFLICT (W/D/C tegenstrijdig): ${wr}% win rate (${confAl.total} trades) — vermijd conflict entries`, positive: wr >= 55 });
  }

  // Liquidity hunt insight
  if (liqHuntTrades.length >= 2) {
    patterns.push({
      type: "LIQ_HUNT",
      label: `${liqHuntTrades.length} liquidity hunt trades gevonden: ${liqWinRate}% win rate`,
      positive: liqWinRate >= 50,
    });
  }

  // High confidence insight
  if (highConf.length >= 2) {
    patterns.push({
      type: "HIGH_CONF",
      label: `Trades met confidence ≥75%: ${highConfWR}% win rate (${highConf.length} trades)`,
      positive: highConfWR >= 60,
    });
  }

  // Signal breakdown
  const sigEntries = Object.entries(bySignal).filter(([, s]) => s.total >= 2);
  for (const [sig, s] of sigEntries) {
    const wr = +(s.win / s.total * 100).toFixed(0);
    if (wr >= 70) patterns.push({ type: "GOOD_SIGNAL", label: `${sig.replace(/_/g," ")}: ${wr}% win rate (${s.total} trades) ✓`, positive: true });
    else if (wr <= 35) patterns.push({ type: "BAD_SIGNAL", label: `${sig.replace(/_/g," ")}: ${wr}% win rate (${s.total} trades) — signaal zwak`, positive: false });
  }

  // Improvements
  const improvements = [];

  if (winRate < 50) {
    improvements.push("Win rate onder 50% — overweeg hogere confidence threshold (bijv. ≥70%) als filter");
  }
  if (avgRR < 1) {
    improvements.push("Gemiddelde RR onder 1:1 — SL's worden vaker geraakt dan TP's. Overweeg ruimere SL of minder agressieve entries");
  }
  const mondayData = byDay["Monday"];
  if (mondayData && mondayData.total >= 2 && mondayData.win / mondayData.total < 0.4) {
    improvements.push("Maandag: lage win rate — strategie adviseert al maandag te skippen voor entries (C1/C2/C4 zijn lage kans)");
  }
  if (liqWinRate !== null && liqWinRate >= 55) {
    improvements.push(`3-day liquidity hunt herkenning werkt goed (${liqWinRate}% WR) — behoud deze logica`);
  } else if (liqWinRate !== null && liqWinRate < 45) {
    improvements.push(`Liquidity hunt detectie levert ${liqWinRate}% WR — aanpassen: mogelijk conservatievere definitie nodig`);
  }
  if (highConfWR !== null && highConfWR - winRate > 10) {
    improvements.push(`Filter op confidence ≥75% verbetert WR met ${(highConfWR - winRate).toFixed(1)}% — overweeg minimum confidence threshold`);
  }

  return {
    summary: `${total} trades | ${wins}W/${losses}L | Win rate: ${winRate}% | Gemiddelde RR: ${avgRR} | Totaal P&L: ${totalPnl > 0 ? "+" : ""}${totalPnl} pts`,
    winRate, wins, losses, total, totalPnl, avgRR, avgConf,
    byDay, bySignal, byAlignment,
    liqHuntStats: liqHuntTrades.length ? { total: liqHuntTrades.length, winRate: liqWinRate } : null,
    highConfStats: highConf.length ? { total: highConf.length, winRate: highConfWR } : null,
    patterns,
    improvements,
  };
}

// ── Level hit scanner ─────────────────────────────────────────────────────────
// Finds the exact candle (and ET label) when price first crosses a level.
function findLevelHit(candles15, level, dir, startTs = 0, endTs = Infinity) {
  for (const c of candles15) {
    if (c.timestamp < startTs || c.timestamp > endTs) continue;
    if (dir === "below" && c.low  <= level) return { ts: c.timestamp, price: +c.low.toFixed(2),  label: _tsToETLabel(c.timestamp) };
    if (dir === "above" && c.high >= level) return { ts: c.timestamp, price: +c.high.toFixed(2), label: _tsToETLabel(c.timestamp) };
  }
  return null;
}

// ── Fractal Order Flow Lock Backtest ─────────────────────────────────────────
// Lock sets trend direction (BULLISH = HH formation, BEARISH = LL formation).
// Trigger: price touches SSL (BULLISH) or BSL (BEARISH) during the session.
// Entry:   7:30 AM ET (F2 = 1:30h into C3 — sweet spot).
// SL:      beyond SSL/BSL level. TP: lock level or 2R.
// Only actual trades (WIN/LOSS) — no observation rows.
export function runFractalLockBacktest(candles, options = {}) {
  const { startDate = null, endDate = null, candles15 = null, raw15 = null, allowWeekend = false } = options;
  const TRADING_DAYS = allowWeekend
    ? ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]
    : ["Monday","Tuesday","Wednesday","Thursday","Friday"];
  const allDays   = groupCandlesByDay(candles);
  const allWeeks  = groupCandlesByWeek(candles);
  if (allDays.length < 5) return { daily: [], cycle: [], insights: null };
  // For cycle backtest use 15-min candles if provided, else fall back to the main candles
  const cycleCandles = candles15 ?? candles;

  const dailyTrades = [];
  const cycleTrades = [];

  // ── DAILY FRACTAL BACKTEST ────────────────────────────────────────────────
  for (let i = 4; i < allDays.length; i++) {
    const day = allDays[i];
    if (!day.isComplete) continue;
    if (!TRADING_DAYS.includes(day.dayName)) continue;
    if (startDate && day.key < startDate) continue;
    if (endDate   && day.key > endDate)   continue;

    // Compute daily structure using candles up to END of previous day
    const prevDay = allDays[i - 1];
    const candlesUpTo = candles.filter(c => c.timestamp < day.startTs);
    if (candlesUpTo.length < 20) continue;

    const recentDays = allDays.slice(Math.max(0, i - 20), i);
    const ds = analyzeDailyStructure(recentDays);
    const lock = ds.lockState;

    // Need an active lock with known levels
    if (!lock?.locked) continue;
    const lv = lock.levels;
    if (!lv) continue;

    const isBuy = lock.direction === "BULLISH";

    // Use raw 15-min candles (covers overnight; hourly often doesn't)
    const intra15src = raw15 ?? cycleCandles;
    const intraday15 = (intra15src && intra15src !== candles)
      ? intra15src.filter(c => getTradingDayKey(c.timestamp) === day.key)
      : day.candles;

    // C3 candles for entry + exit simulation
    const c3Candles = intraday15.filter(c => { const h = getETInfo(c.timestamp).hour; return h >= 6 && h < 12; });
    if (!c3Candles.length) continue;

    // Prev day high/low (daily BSL/SSL)
    const pd = allDays[i - 1];
    if (!pd) continue;
    const prevHigh = +pd.high.toFixed(2);
    const prevLow  = +pd.low.toFixed(2);

    // Candles BEFORE 7:30 ET (C2 overnight + C3 F1) — the sweep window
    const preEntryCandles = intraday15.filter(c => {
      const et = getETInfo(c.timestamp);
      return et.hour < 7 || (et.hour === 7 && et.minute < 30);
    });

    // Trigger: BULLISH lock = higher highs in effect (BSL swept structurally)
    //          SSL today = pre-entry dips to/below prev day low before 7:30
    // BEARISH: BSL today = pre-entry pumps to/above prev day high before 7:30
    const sslTodayCandle = preEntryCandles.find(c => c.low  < prevLow);   // strictly below prev day low
    const bslTodayCandle = preEntryCandles.find(c => c.high > prevHigh);  // strictly above prev day high

    if (isBuy  && !sslTodayCandle) continue;   // BULLISH: need pre-entry SSL dip
    if (!isBuy && !bslTodayCandle) continue;   // BEARISH: need pre-entry BSL pump

    // Display: buyside = prev day high, sellside = prev day low hit time
    const sweptSide    = isBuy ? "BSL" : "SSL";
    const sweptLevel   = isBuy ? prevHigh : prevLow;  // prev day high (BSL) or low (SSL)
    const sweptLabel   = pd.dayName.slice(0, 3);
    const sweepHitTime = null;
    const sslHitTime   = isBuy
      ? _tsToETLabel(sslTodayCandle.timestamp)
      : _tsToETLabel(bslTodayCandle.timestamp);

    // Entry: first candle at or after 7:30 AM ET (F2)
    const entryCandle = c3Candles.find(c => {
      const et = getETInfo(c.timestamp);
      return et.hour > 7 || (et.hour === 7 && et.minute >= 30);
    }) ?? c3Candles[c3Candles.length - 1];
    const entryPrice = +entryCandle.open.toFixed(2);
    const entryTime  = entryCandle.timestamp;

    // SL: low of the sellside hit candle (BUY) or high of the buyside hit candle (SELL)
    const preEntryLow  = sslTodayCandle ? +sslTodayCandle.low.toFixed(2)  : prevLow;
    const preEntryHigh = bslTodayCandle ? +bslTodayCandle.high.toFixed(2) : prevHigh;
    const sl = isBuy ? preEntryLow : preEntryHigh;
    const slDist = +Math.abs(entryPrice - sl).toFixed(2);
    if (slDist < 1 || slDist > entryPrice * 0.05) continue;

    // TP: lock level only if it's in the right direction AND far enough; else 2R
    const lockTpValid = isBuy ? lv.lockLevel > entryPrice : lv.lockLevel < entryPrice;
    const naturalDist = Math.abs(lv.lockLevel - entryPrice);
    const tp = (lockTpValid && naturalDist >= slDist)
      ? +lv.lockLevel.toFixed(2)
      : +(isBuy ? entryPrice + slDist * 2 : entryPrice - slDist * 2).toFixed(2);

    // Simulate trade on 15-min candles (more accurate than 1 daily bar)
    const afterEntry = intraday15.length
      ? intraday15.filter(c => c.timestamp >= entryTime)
      : day.candles.filter(c => c.timestamp >= entryTime);
    let outcome = "OPEN", exitPrice = null, exitTime = null, exitCycle = null;

    for (const c of afterEntry) {
      const h = getETInfo(c.timestamp).hour;
      const cyc = h >= 18 ? "C1" : h >= 12 ? "C4" : h >= 6 ? "C3" : "C2";
      if (isBuy) {
        if (c.low  <= sl) { outcome = "LOSS"; exitPrice = sl; exitTime = c.timestamp; exitCycle = cyc; break; }
        if (c.high >= tp) { outcome = "WIN";  exitPrice = tp; exitTime = c.timestamp; exitCycle = cyc; break; }
      } else {
        if (c.high >= sl) { outcome = "LOSS"; exitPrice = sl; exitTime = c.timestamp; exitCycle = cyc; break; }
        if (c.low  <= tp) { outcome = "WIN";  exitPrice = tp; exitTime = c.timestamp; exitCycle = cyc; break; }
      }
    }
    if (outcome === "OPEN") {
      const last = (afterEntry.length ? afterEntry : day.candles)[((afterEntry.length ? afterEntry : day.candles).length - 1)];
      exitPrice = +last.close.toFixed(2);
      exitTime  = last.timestamp;
      exitCycle = "EOD";
      const raw = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
      outcome = raw > 0 ? "WIN" : raw < 0 ? "LOSS" : "NEUTRAL";
    }

    const pnl = +(isBuy ? exitPrice - entryPrice : entryPrice - exitPrice).toFixed(2);
    const rr  = slDist > 0 ? +(pnl / slDist).toFixed(2) : 0;

    dailyTrades.push({
      date: day.key, dayName: day.dayName,
      lockDirection: lock.direction, lockStrength: lock.strength,
      type: isBuy ? "BUY" : "SELL",
      lockNote: lock.note,
      sweptSide,
      bslLevel: sweptLevel?.toString(),
      sweepLabel: sweptLabel,
      sweepHitTime,                          // time BSL (or SSL for SELL) was swept
      sslLevel: preEntryLow?.toString() ?? prevLow?.toFixed(2) ?? null,
      pullbackLabel: day.dayName?.slice(0,3) ?? null,
      lockLevel: lv?.lockLevel?.toFixed(2) ?? null, lockLabel: lv?.lockLabel ?? null,
      sslHitTime,                            // time SSL (or BSL for SELL) was swept after
      entryPrice, entryTime, entryTimeLabel: _tsToETLabel(entryTime),
      sl, tp, slDist, exitPrice, exitTime, exitTimeLabel: _tsToETLabel(exitTime), exitCycle,
      pnl, rr, outcome,
    });
  }

  // ── CYCLE FRACTAL BACKTEST ────────────────────────────────────────────────
  const CYCLE_HOURS = { C1: [18, 0], C2: [0, 6], C3: [6, 12], C4: [12, 18] };
  const CYCLE_ORDER_BT = ["C1","C2","C3","C4"];

  // Build flat list of 6h cycle objects
  const cycleDays = cycleCandles !== candles ? groupCandlesByDay(cycleCandles) : allDays;
  const allCycles = [];
  for (const day of cycleDays) {
    for (const [name, [start]] of Object.entries(CYCLE_HOURS)) {
      const cyc = day.candles.filter(c => {
        const h = getETInfo(c.timestamp).hour;
        return name === "C1" ? h >= 18 : h >= start && h < start + 6;
      });
      if (cyc.length < 2) continue;
      allCycles.push({
        name, dayName: day.dayName, dayKey: day.key,
        candles: cyc,
        high: Math.max(...cyc.map(c => c.high)),
        low:  Math.min(...cyc.map(c => c.low)),
        startTs: cyc[0].timestamp,
      });
    }
  }

  for (let i = 6; i < allCycles.length; i++) {
    const prevCycles = allCycles.slice(Math.max(0, i - 20), i);
    if (prevCycles.length < 5) continue;
    if (startDate && allCycles[i].dayKey < startDate) continue;
    if (endDate   && allCycles[i].dayKey > endDate)   continue;

    // Use daily lock as bias source (same as daily + 90-min sections)
    const recentDaysForCyc = allDays.filter(d => d.key < allCycles[i].dayKey).slice(-20);
    if (recentDaysForCyc.length < 5) continue;
    const ds = analyzeDailyStructure(recentDaysForCyc);
    const lock = ds.lockState;

    // Need an active lock with known levels
    if (!lock?.locked) continue;
    const lv = lock.levels;
    if (!lv) continue;

    const thisCyc = allCycles[i];
    if (!thisCyc?.candles?.length || thisCyc.candles.length < 4) continue;

    // Only trade C3 (06:00–12:00 ET)
    if (thisCyc.name !== "C3") continue;

    // Previous cycle = C2 (00:00–06:00) direct voor deze C3
    const prevCyc = allCycles.slice(0, i).reverse().find(c => c.startTs < thisCyc.startTs);
    const prevCycHigh = prevCyc ? +prevCyc.high.toFixed(2) : null;
    const prevCycLow  = prevCyc ? +prevCyc.low.toFixed(2)  : null;

    // Scan volledige C3 voor volgorde van BSL/SSL sweeps
    const cyc15 = raw15
      ? raw15.filter(c => getTradingDayKey(c.timestamp) === thisCyc.dayKey &&
          getETInfo(c.timestamp).hour >= 6 && getETInfo(c.timestamp).hour < 12)
      : thisCyc.candles;

    const bslHitC3 = prevCycHigh != null ? cyc15.find(c => c.high > prevCycHigh) : null;
    const sslHitC3 = prevCycLow  != null ? cyc15.find(c => c.low  < prevCycLow)  : null;

    // Beide sweeps vereist
    if (!bslHitC3 || !sslHitC3) continue;

    // Richting = volgorde: BSL eerst → BUY, SSL eerst → SELL
    const isBuy = bslHitC3.timestamp <= sslHitC3.timestamp;
    const secondHitCandle = isBuy ? sslHitC3 : bslHitC3;

    // Full day 15-min candles (entry window can be in C4, outside C3)
    const day15 = raw15
      ? raw15.filter(c => getTradingDayKey(c.timestamp) === thisCyc.dayKey)
      : thisCyc.candles;

    // SL = low/high van candle direct NA de tweede sweep
    const afterSecondAll = day15.filter(c => c.timestamp > secondHitCandle.timestamp);
    if (!afterSecondAll.length) continue;
    const slCandle = afterSecondAll[0];
    const sl = +(isBuy ? slCandle.low : slCandle.high).toFixed(2);

    // Entry = eerste entry window (01:30/07:30/13:30/19:30 ET) NA de tweede sweep
    const ENTRY_WINDOWS_BT = [{h:1,m:30},{h:7,m:30},{h:13,m:30},{h:19,m:30}];
    const entryCandle = day15.find(c => {
      if (c.timestamp <= secondHitCandle.timestamp) return false;
      const et = getETInfo(c.timestamp);
      return ENTRY_WINDOWS_BT.some(w => et.hour === w.h && et.minute === w.m);
    });
    if (!entryCandle) continue;
    const entryPrice  = +entryCandle.open.toFixed(2);
    const entryTime   = entryCandle.timestamp;

    const slDist = +Math.abs(entryPrice - sl).toFixed(2);
    if (slDist < 0.5 || slDist > entryPrice * 0.03) continue;

    // TP = lock level (als geldig) anders 2R
    const lockTpValidCyc = isBuy ? lv.lockLevel > entryPrice : lv.lockLevel < entryPrice;
    const natDist = Math.abs(lv.lockLevel - entryPrice);
    const tp = (lockTpValidCyc && natDist >= slDist)
      ? +lv.lockLevel.toFixed(2)
      : +(isBuy ? entryPrice + slDist * 2 : entryPrice - slDist * 2).toFixed(2);

    const afterEntry = day15.filter(c => c.timestamp >= entryTime);
    let outcome = "OPEN", exitPrice = null, exitTime = null;
    for (const c of afterEntry) {
      if (isBuy) {
        if (c.low  <= sl) { outcome = "LOSS"; exitPrice = sl; exitTime = c.timestamp; break; }
        if (c.high >= tp) { outcome = "WIN";  exitPrice = tp; exitTime = c.timestamp; break; }
      } else {
        if (c.high >= sl) { outcome = "LOSS"; exitPrice = sl; exitTime = c.timestamp; break; }
        if (c.low  <= tp) { outcome = "WIN";  exitPrice = tp; exitTime = c.timestamp; break; }
      }
    }
    if (outcome === "OPEN") {
      const last = day15[day15.length - 1];
      exitPrice = +last.close.toFixed(2);
      exitTime  = last.timestamp;
      const raw = isBuy ? exitPrice - entryPrice : entryPrice - exitPrice;
      outcome   = raw > 0 ? "WIN" : raw < 0 ? "LOSS" : "NEUTRAL";
    }

    const pnl = +(isBuy ? exitPrice - entryPrice : entryPrice - exitPrice).toFixed(2);
    const rr  = slDist > 0 ? +(pnl / slDist).toFixed(2) : 0;

    cycleTrades.push({
      date: thisCyc.dayKey, dayName: thisCyc.dayName, cycle: thisCyc.name,
      lockDirection: lock.direction, lockStrength: lock.strength,
      type: isBuy ? "BUY" : "SELL",
      lockNote: lock.note,
      bslLevel:  prevCycHigh?.toString() ?? null,
      sslLevel:  prevCycLow?.toString()  ?? null,
      sweepLabel: prevCyc ? `${prevCyc.name} ${prevCyc.dayName.slice(0,3)}` : null,
      pullbackLabel: thisCyc.dayName?.slice(0, 3) ?? null,
      lockLevel: lv?.lockLevel?.toFixed(2) ?? null, lockLabel: lv?.lockLabel ?? null,
      bslHitTime: _tsToETLabel(bslHitC3.timestamp),
      sslHitTime: _tsToETLabel(sslHitC3.timestamp),
      firstSweep:  isBuy ? "BSL" : "SSL",
      secondSweep: isBuy ? "SSL" : "BSL",
      entryPrice, entryTime, entryTimeLabel: _tsToETLabel(entryTime),
      sl, tp, slDist, exitPrice, exitTime, exitTimeLabel: _tsToETLabel(exitTime),
      pnl, rr, outcome,
    });
  }

  // ── 90-MIN CYCLE BACKTEST ────────────────────────────────────────────────
  // Pattern: BSL→SSL on consecutive 90-min cycles → entry at F2 (7:30 ET)
  //   C0  = 4:30–6:00 ET: sweeps above prev 90-min high  → BSL hit
  //   F1  = 6:00–7:30 ET: sweeps below C0 low            → SSL hit
  //   F2  = 7:30–9:00 ET: entry open
  //   SL  = F1 low (BUY) / F1 high (SELL)
  //   TP  = C0 high (BUY = next BSL target) / C0 low (SELL)
  // For SELL: mirror — C0 sweeps below prev low (SSL), F1 sweeps above C0 high (BSL)
  const ninetyMinTrades = [];
  const c15source = raw15 ?? (cycleCandles !== candles ? cycleCandles : null);

  function getET90Period(ts) {
    // Returns the 90-min period index based on ET time: 0=0:00-1:30, 1=1:30-3:00, ... 4=6:00-7:30 (F1), 5=7:30-9:00 (F2)
    const { hour, minute } = getETInfo(ts);
    return Math.floor((hour * 60 + minute) / 90);
  }

  if (c15source) {
    for (let i = 4; i < allDays.length; i++) {
      const day = allDays[i];
      if (!day.isComplete) continue;
      if (!TRADING_DAYS.includes(day.dayName)) continue;
      if (startDate && day.key < startDate) continue;
      if (endDate   && day.key > endDate)   continue;

      // Lock check
      const recentDays = allDays.slice(Math.max(0, i - 20), i);
      const ds90 = analyzeDailyStructure(recentDays);
      const lock90 = ds90.lockState;
      if (!lock90?.locked) continue;
      const lv90 = lock90.levels;
      if (!lv90) continue;
      const isBuy90 = lock90.direction === "BULLISH";

      // 15-min candles for this trading day
      const day15 = c15source.filter(c => getTradingDayKey(c.timestamp) === day.key);

      // 90-min periods: C0_prev=period 2 (3:00-4:30 ET), C0=period 3 (4:30-6:00 ET),
      //                 F1=period 4 (6:00-7:30 ET), F2+=period 5+ (7:30 ET onward)
      const c0prevC = day15.filter(c => getET90Period(c.timestamp) === 2);
      const c0C     = day15.filter(c => getET90Period(c.timestamp) === 3);
      const f1C     = day15.filter(c => getET90Period(c.timestamp) === 4);
      const f2restC = day15.filter(c => getET90Period(c.timestamp) >= 5 && getETInfo(c.timestamp).hour < 12);

      if (!c0prevC.length || !c0C.length || !f1C.length || !f2restC.length) continue;

      const c0prevHigh = Math.max(...c0prevC.map(c => c.high));
      const c0prevLow  = Math.min(...c0prevC.map(c => c.low));
      const c0High     = +Math.max(...c0C.map(c => c.high)).toFixed(2);
      const c0Low      = +Math.min(...c0C.map(c => c.low)).toFixed(2);
      const f1High     = +Math.max(...f1C.map(c => c.high)).toFixed(2);
      const f1Low      = +Math.min(...f1C.map(c => c.low)).toFixed(2);

      // BSL→SSL for BUY: C0 sweeps above C0_prev high, then F1 sweeps below C0 low
      // SSL→BSL for SELL: C0 sweeps below C0_prev low, then F1 sweeps above C0 high
      const bslHit90 = isBuy90 ? c0High > c0prevHigh : c0Low  < c0prevLow;
      const sslHit90 = isBuy90 ? f1Low  < c0Low      : f1High > c0High;
      if (!bslHit90 || !sslHit90) continue;

      // Entry: first candle of F2 (7:30 ET open)
      const entryCandle90 = f2restC[0];
      if (!entryCandle90) continue;
      const entryPrice90 = +entryCandle90.open.toFixed(2);
      const entryTime90  = entryCandle90.timestamp;

      // SL = ultimate low/high between F1 and F2 open (includes first F2 candle wick)
      const ultimateLow90  = +Math.min(f1Low,  entryCandle90.low).toFixed(2);
      const ultimateHigh90 = +Math.max(f1High, entryCandle90.high).toFixed(2);
      const sl90     = isBuy90 ? ultimateLow90 : ultimateHigh90;
      const slDist90 = +Math.abs(entryPrice90 - sl90).toFixed(2);
      if (slDist90 < 0.5 || slDist90 > entryPrice90 * 0.02) continue;

      // TP = C0 high (BUY) / C0 low (SELL) — the 90-min BSL as target
      const bslTarget = isBuy90 ? c0High : c0Low;
      const tpValid90 = isBuy90 ? bslTarget > entryPrice90 : bslTarget < entryPrice90;
      const natDist90 = Math.abs(bslTarget - entryPrice90);
      const tp90 = (tpValid90 && natDist90 >= slDist90)
        ? bslTarget
        : +(isBuy90 ? entryPrice90 + slDist90 * 2 : entryPrice90 - slDist90 * 2).toFixed(2);

      // Exit simulation through F2–F4 (7:30–12:00 ET)
      let outcome90 = "OPEN", exitPrice90 = null, exitTime90 = null;
      for (const c of f2restC) {
        if (c.timestamp < entryTime90) continue;
        if (isBuy90) {
          if (c.low  <= sl90) { outcome90 = "LOSS"; exitPrice90 = sl90; exitTime90 = c.timestamp; break; }
          if (c.high >= tp90) { outcome90 = "WIN";  exitPrice90 = tp90; exitTime90 = c.timestamp; break; }
        } else {
          if (c.high >= sl90) { outcome90 = "LOSS"; exitPrice90 = sl90; exitTime90 = c.timestamp; break; }
          if (c.low  <= tp90) { outcome90 = "WIN";  exitPrice90 = tp90; exitTime90 = c.timestamp; break; }
        }
      }
      if (outcome90 === "OPEN") {
        const last = f2restC[f2restC.length - 1];
        exitPrice90 = +last.close.toFixed(2);
        exitTime90  = last.timestamp;
        const raw = isBuy90 ? exitPrice90 - entryPrice90 : entryPrice90 - exitPrice90;
        outcome90 = raw > 0 ? "WIN" : raw < 0 ? "LOSS" : "NEUTRAL";
      }

      const pnl90 = +(isBuy90 ? exitPrice90 - entryPrice90 : entryPrice90 - exitPrice90).toFixed(2);
      const rr90  = slDist90 > 0 ? +(pnl90 / slDist90).toFixed(2) : 0;

      // BSL hit time: first C0 candle that swept above C0_prev high (BUY) or below C0_prev low (SELL)
      const bslHitCandle90 = isBuy90
        ? c0C.find(c => c.high > c0prevHigh)
        : c0C.find(c => c.low  < c0prevLow);
      const bslHitTime90 = bslHitCandle90 ? _tsToETLabel(bslHitCandle90.timestamp) : null;

      // SSL hit time: first F1 candle that swept below C0 low (BUY) or above C0 high (SELL)
      const sslHitCandle90 = isBuy90
        ? f1C.find(c => c.low  < c0Low)
        : f1C.find(c => c.high > c0High);
      const sslHitTime90 = sslHitCandle90 ? _tsToETLabel(sslHitCandle90.timestamp) : null;

      ninetyMinTrades.push({
        date: day.key, dayName: day.dayName, session: "F2",
        lockDirection: lock90.direction, lockStrength: lock90.strength,
        type: isBuy90 ? "BUY" : "SELL",
        bslLevel: (isBuy90 ? c0High : c0Low).toString(),
        sweepLabel: "04:30–06:00",
        sweepHitTime: bslHitTime90,
        sslLevel: (isBuy90 ? ultimateLow90 : ultimateHigh90).toString(),
        pullbackLabel: "F1 06:00–07:30",
        sslHitTime: sslHitTime90,
        lockLevel: lv90.lockLevel?.toFixed(2) ?? null, lockLabel: lv90.lockLabel ?? null,
        f1Low: f1Low.toString(), f1High: f1High.toString(),
        entryPrice: entryPrice90, entryTime: entryTime90, entryTimeLabel: _tsToETLabel(entryTime90),
        sl: sl90, tp: tp90, slDist: slDist90,
        exitPrice: exitPrice90, exitTime: exitTime90, exitTimeLabel: _tsToETLabel(exitTime90),
        pnl: pnl90, rr: rr90, outcome: outcome90,
      });
    }
  }

  // ── Insights from both timeframes ────────────────────────────────────────
  function mkStats(trades) {
    const actual = trades.filter(t => t.outcome !== "NEUTRAL" && t.outcome !== "OPEN");
    if (!actual.length) return null;
    const wins = actual.filter(t => t.outcome === "WIN").length;
    const total = actual.length;
    const winRate = +(wins / total * 100).toFixed(1);
    const totalPnl = +actual.reduce((s, t) => s + (t.pnl ?? 0), 0).toFixed(2);
    const avgRR    = +actual.reduce((s, t, _, a) => s + t.rr / a.length, 0).toFixed(2);

    // By lock strength
    const byStrength = {};
    for (const t of actual) {
      const k = `×${t.lockStrength}`;
      if (!byStrength[k]) byStrength[k] = { win: 0, total: 0, pnl: 0 };
      byStrength[k].total++;
      byStrength[k].pnl += t.pnl ?? 0;
      if (t.outcome === "WIN") byStrength[k].win++;
    }

    // By day of week
    const byDay = {};
    for (const t of actual) {
      if (!byDay[t.dayName]) byDay[t.dayName] = { win: 0, total: 0 };
      byDay[t.dayName].total++;
      if (t.outcome === "WIN") byDay[t.dayName].win++;
    }

    // By direction
    const buys  = actual.filter(t => t.type === "BUY");
    const sells = actual.filter(t => t.type === "SELL");
    const buyWR  = buys.length  ? +(buys.filter(t => t.outcome === "WIN").length / buys.length * 100).toFixed(1) : null;
    const sellWR = sells.length ? +(sells.filter(t => t.outcome === "WIN").length / sells.length * 100).toFixed(1) : null;

    // Learnings
    const learnings = [];

    // Strength filter
    const strongTrades = actual.filter(t => t.lockStrength >= 3);
    const strongWR = strongTrades.length
      ? +(strongTrades.filter(t => t.outcome === "WIN").length / strongTrades.length * 100).toFixed(1)
      : null;
    if (strongWR !== null && strongWR - winRate > 5 && strongTrades.length >= 3) {
      learnings.push({ type: "improvement", text: `Lock strength ≥3 geeft ${strongWR}% WR vs ${winRate}% overall — overweeg minimum strength filter` });
    }
    if (strongWR !== null && Math.abs(strongWR - winRate) < 3) {
      learnings.push({ type: "neutral", text: `Lock strength maakt weinig verschil in WR — signaal kwaliteit zit elders` });
    }

    // Day filter
    const dayEntries = Object.entries(byDay).filter(([, v]) => v.total >= 2);
    for (const [day, v] of dayEntries) {
      const wr = +(v.win / v.total * 100).toFixed(0);
      if (wr >= 70) learnings.push({ type: "positive", text: `${day}: ${wr}% WR (${v.total} trades) — sterk dag voor fractal entries` });
      if (wr <= 30) learnings.push({ type: "negative", text: `${day}: ${wr}% WR (${v.total} trades) — overweeg te skippen` });
    }

    // Direction asymmetry
    if (buyWR !== null && sellWR !== null && Math.abs(buyWR - sellWR) > 15) {
      const better = buyWR > sellWR ? "BUY" : "SELL";
      const worse  = buyWR > sellWR ? "SELL" : "BUY";
      const betterWR = buyWR > sellWR ? buyWR : sellWR;
      const worseWR  = buyWR > sellWR ? sellWR : buyWR;
      learnings.push({ type: "improvement", text: `${better} signalen (${betterWR}% WR) werken veel beter dan ${worse} (${worseWR}% WR) — overweeg richting filter` });
    }

    return { wins, losses: total - wins, total, winRate, totalPnl, avgRR, byStrength, byDay, buyWR, sellWR, learnings };
  }

  const dailyStats = mkStats(dailyTrades);
  const cycleStats = mkStats(cycleTrades);

  // Logic improvement suggestions based on combined learnings
  const logicImprovements = [];
  if (dailyStats) {
    if (dailyStats.winRate >= 55) {
      logicImprovements.push({ priority: "high", text: `Dagelijkse fractal lock werkt (${dailyStats.winRate}% WR) — logica is solide` });
    } else {
      logicImprovements.push({ priority: "medium", text: `Dagelijkse WR ${dailyStats.winRate}% — controleer of SL te strak is aan SSL/BSL niveaus` });
    }
    if (dailyStats.buyWR !== null && dailyStats.sellWR !== null) {
      const diff = Math.abs(dailyStats.buyWR - dailyStats.sellWR);
      if (diff > 20) {
        logicImprovements.push({ priority: "high", text: `Sterke asymmetrie BUY/SELL — bias filter toevoegen of weak direction skippen` });
      }
    }
  }
  if (cycleStats) {
    if (cycleStats.winRate >= 55) {
      logicImprovements.push({ priority: "high", text: `Cycle fractal lock werkt (${cycleStats.winRate}% WR) — entry timing op 1:30h bevestigd` });
    } else {
      logicImprovements.push({ priority: "medium", text: `Cycle WR ${cycleStats.winRate}% — probeer entry op 2:00h in cycle (meer confirmatie)` });
    }
  }

  return {
    daily:      dailyTrades,
    cycle:      cycleTrades,
    ninetyMin:  ninetyMinTrades,
    insights: {
      daily:  dailyStats,
      cycle:  cycleStats,
      ninetyMin: mkStats(ninetyMinTrades),
      logicImprovements,
    },
  };
}

// ── Backtest helpers ──────────────────────────────────────────────────────────

/**
 * Simulate the bias logic week by week on historical data.
 * Returns an array of simulated decisions with outcome tracking.
 */
export function runBacktest(candles) {
  const weeks = groupCandlesByWeek(candles);
  if (weeks.length < 2) return [];

  const results = [];

  for (let i = 1; i < weeks.length; i++) {
    const weekCandles = weeks[i].candles;
    const prevWeekCandles = weeks[i-1].candles;

    // Simulate bias as of each day within the week
    const days = groupCandlesByDay(weekCandles);

    for (const day of days) {
      if (!["Tuesday","Wednesday","Thursday"].includes(day.dayName)) continue;

      // Build "candles up to this day" for bias computation
      const candlesUpTo = [...prevWeekCandles, ...weekCandles.filter(c => c.timestamp < day.endTs)];
      if (candlesUpTo.length < 20) continue;

      const biasResult = computeBias(candlesUpTo);
      const bias = biasResult.bias;

      // Determine outcome: did price move in bias direction after this day?
      const afterCandles = weekCandles.filter(c => c.timestamp > day.endTs);
      if (!afterCandles.length) continue;

      const priceAtEntry = day.close;
      const highAfter    = Math.max(...afterCandles.map(c => c.high));
      const lowAfter     = Math.min(...afterCandles.map(c => c.low));
      const closeAfter   = afterCandles[afterCandles.length - 1].close;

      const bullishMove = (highAfter - priceAtEntry) / priceAtEntry * 100;
      const bearishMove = (priceAtEntry - lowAfter)  / priceAtEntry * 100;

      let outcome = "NEUTRAL";
      if (bias === "BULLISH" && bullishMove > 0.3) outcome = "WIN";
      else if (bias === "BEARISH" && bearishMove > 0.3) outcome = "WIN";
      else if (bias !== "NEUTRAL") outcome = "LOSS";

      results.push({
        weekKey:       weeks[i].key,
        date:          day.key,
        dayName:       day.dayName,
        bias,
        confidence:    biasResult.confidence,
        primarySignal: biasResult.primarySignal,
        priceAtEntry,
        highAfter:     +highAfter.toFixed(2),
        lowAfter:      +lowAfter.toFixed(2),
        closeAfter:    +closeAfter.toFixed(2),
        bullishMove:   +bullishMove.toFixed(2),
        bearishMove:   +bearishMove.toFixed(2),
        outcome,
        reasons:       biasResult.reasons.slice(0, 2),
      });
    }
  }

  return results;
}

// ── Live Fractal Signals (realtime, doordeweeks) ──────────────────────────────
// Zelfde logica als runFractalLockBacktest maar voor vandaag live.
// Geeft voor elk van de 3 timeframes de huidige status terug.
export function getLiveFractalSignals(candles15, options = {}) {
  const { daily: dailyCandles, hourly } = options;
  const nowTs = Math.floor(Date.now() / 1000);
  const todayKey = getTradingDayKey(nowTs);

  const allDays = groupCandlesByDay(candles15);
  const todayIdx = allDays.findIndex(d => d.key === todayKey);
  if (todayIdx < 4) return { daily: null, cycle: null, ninetyMin: null };

  const today15 = candles15.filter(c => getTradingDayKey(c.timestamp) === todayKey);
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etTotalMin = etNow.getHours() * 60 + etNow.getMinutes();
  const past730 = etTotalMin >= 7 * 60 + 30;
  const past600 = etTotalMin >= 6 * 60;

  function simulateOutcome(afterEntry15, isBuy, sl, tp) {
    for (const c of afterEntry15) {
      if (isBuy) {
        if (c.low  <= sl) return "LOSS";
        if (c.high >= tp) return "WIN";
      } else {
        if (c.high >= sl) return "LOSS";
        if (c.low  <= tp) return "WIN";
      }
    }
    return "OPEN";
  }

  // ── DAILY SIGNAL ────────────────────────────────────────────────────────────
  // Use 1D candles for structure (500 days of history) when available,
  // fall back to grouped 15min days. This ensures we always find the nearest lock.
  let dailySignal = null;
  let dailyLockDir = null;
  try {
    const structureDays = dailyCandles?.length >= 20
      ? (() => {
          const dDays = groupCandlesByDay(dailyCandles);
          const dTodayIdx = dDays.findIndex(d => d.key === todayKey);
          const end = dTodayIdx >= 0 ? dTodayIdx : dDays.length;
          return dDays.slice(Math.max(0, end - 20), end);
        })()
      : allDays.slice(Math.max(0, todayIdx - 20), todayIdx);
    const ds = analyzeDailyStructure(structureDays);
    const lock = ds.lockState;
    if (lock?.locked) dailyLockDir = lock.direction;
    if (lock?.locked && lock.levels) {
      const isBuy = lock.direction === "BULLISH";
      const prevDay = allDays[todayIdx - 1];
      const prevHigh = prevDay ? +prevDay.high.toFixed(2) : null;
      const prevLow  = prevDay ? +prevDay.low.toFixed(2)  : null;

      const preEntry15 = today15.filter(c => {
        const et = getETInfo(c.timestamp);
        return et.hour < 7 || (et.hour === 7 && et.minute < 30);
      });

      const sslSweptCandle = preEntry15.find(c => prevLow  != null && c.low  < prevLow);
      const bslSweptCandle = preEntry15.find(c => prevHigh != null && c.high > prevHigh);
      const sweepCandle = isBuy ? sslSweptCandle : bslSweptCandle;
      const triggered   = !!sweepCandle;

      const c3Candles = today15.filter(c => { const h = getETInfo(c.timestamp).hour; return h >= 6 && h < 12; });
      const entryCandle = c3Candles.find(c => {
        const et = getETInfo(c.timestamp);
        return et.hour > 7 || (et.hour === 7 && et.minute >= 30);
      });

      const entryPrice = entryCandle ? +entryCandle.open.toFixed(2) : null;
      const sl = sweepCandle ? +(isBuy ? sweepCandle.low : sweepCandle.high).toFixed(2) : null;
      const slDist = (entryPrice && sl) ? +Math.abs(entryPrice - sl).toFixed(2) : null;
      const lv = lock.levels;
      const lockTpValid = lv && (isBuy ? lv.lockLevel > (entryPrice ?? 0) : lv.lockLevel < (entryPrice ?? Infinity));
      const tp = (entryPrice && slDist)
        ? (lockTpValid && Math.abs(lv.lockLevel - entryPrice) >= slDist
          ? +lv.lockLevel.toFixed(2)
          : +(isBuy ? entryPrice + slDist * 2 : entryPrice - slDist * 2).toFixed(2))
        : null;

      let status = triggered
        ? (past730 ? "entry_active" : "swept")
        : "watching";

      let outcome = null;
      if (entryCandle && sl && tp && past730) {
        const afterEntry = today15.filter(c => c.timestamp >= entryCandle.timestamp);
        outcome = simulateOutcome(afterEntry, isBuy, sl, tp);
      }

      dailySignal = {
        type: isBuy ? "BUY" : "SELL",
        status,
        triggered,
        lockDirection: lock.direction,
        lockStrength:  lock.strength,
        bslLevel:  (isBuy ? prevHigh : prevLow)?.toString() ?? null,
        sslLevel:  (isBuy ? prevLow  : prevHigh)?.toString() ?? null,
        sweepLevel: sweepCandle ? +(isBuy ? sweepCandle.low : sweepCandle.high).toFixed(2) : null,
        sweepTime:  sweepCandle ? _tsToETLabel(sweepCandle.timestamp) : null,
        prevDayHigh: prevHigh, prevDayLow: prevLow,
        entryPrice, sl, tp, slDist, outcome,
        entryTimeLabel: entryCandle ? _tsToETLabel(entryCandle.timestamp) : (past730 ? null : "7:30 ET"),
        lockLevel: lv?.lockLevel?.toFixed(2) ?? null,
        lockLabel: lv?.lockLabel ?? null,
      };
    }
  } catch {}

  // ── 6H CYCLE SIGNAL (C3) ─────────────────────────────────────────────────────
  // Strategie: kijk in C3 naar de VOLGORDE van C2 BSL/SSL sweeps.
  //   BSL eerst → SSL daarna = BUY
  //   SSL eerst → BSL daarna = SELL
  // Entry = eerste 15-min candle NA de tweede sweep.
  // Lock vereist als hogere timeframe context.
  let cycleSignal = null;
  let cycleLockDir = null;
  try {
    const cycleCandles = (hourly?.length ?? 0) >= 20 ? hourly : candles15;
    const cycleDays = groupCandlesByDay(cycleCandles);
    const cycleTodayIdx = cycleDays.findIndex(d => d.key === todayKey);
    if (cycleTodayIdx >= 4) {
      const lock = (() => {
        if (dailyCandles?.length >= 20) {
          const dDays = groupCandlesByDay(dailyCandles);
          const dTodayIdx = dDays.findIndex(d => d.key === todayKey);
          const end = dTodayIdx >= 0 ? dTodayIdx : dDays.length;
          return analyzeDailyStructure(dDays.slice(Math.max(0, end - 20), end)).lockState;
        }
        return analyzeDailyStructure(allDays.slice(Math.max(0, todayIdx - 20), todayIdx)).lockState;
      })();
      if (lock?.locked) cycleLockDir = lock.direction;
      if (lock?.locked && lock.levels) {
        // C2 = 00:00-06:00 ET → BSL/SSL referentie
        const c2Candles = today15.filter(c => { const h = getETInfo(c.timestamp).hour; return h >= 0 && h < 6; });
        const prevCycHigh = c2Candles.length ? +Math.max(...c2Candles.map(c => c.high)).toFixed(2) : null;
        const prevCycLow  = c2Candles.length ? +Math.min(...c2Candles.map(c => c.low)).toFixed(2)  : null;

        // Scan volledige C3 (06:00-12:00 ET) voor sweep volgorde
        const c3All = today15.filter(c => { const h = getETInfo(c.timestamp).hour; return h >= 6 && h < 12; });
        const bslHitCandle = prevCycHigh != null ? c3All.find(c => c.high > prevCycHigh) : null;
        const sslHitCandle = prevCycLow  != null ? c3All.find(c => c.low  < prevCycLow)  : null;

        // Richting = volgorde van sweeps (onafhankelijk van lock richting)
        let isBuy = null;
        let firstHitCandle = null, secondHitCandle = null;
        if (bslHitCandle && sslHitCandle) {
          isBuy = bslHitCandle.timestamp <= sslHitCandle.timestamp; // BSL eerst = BUY
          firstHitCandle  = isBuy ? bslHitCandle : sslHitCandle;
          secondHitCandle = isBuy ? sslHitCandle : bslHitCandle;
        } else if (bslHitCandle) {
          isBuy = true;  // BSL geraakt, wachten op SSL → verwachte BUY
          firstHitCandle = bslHitCandle;
        } else if (sslHitCandle) {
          isBuy = false; // SSL geraakt, wachten op BSL → verwachte SELL
          firstHitCandle = sslHitCandle;
        }

        const triggered = !!(bslHitCandle && sslHitCandle);

        // SL = low/high van candle direct NA de tweede sweep
        const afterSecondAll = (triggered && secondHitCandle)
          ? today15.filter(c => c.timestamp > secondHitCandle.timestamp)
          : [];
        const slCandle = afterSecondAll[0] ?? null;
        const sl = slCandle ? +(isBuy ? slCandle.low : slCandle.high).toFixed(2) : null;

        // Entry = eerste entry window (01:30/07:30/13:30/19:30 ET) NA de tweede sweep
        const ENTRY_WINDOWS = [{h:1,m:30},{h:7,m:30},{h:13,m:30},{h:19,m:30}];
        let entryCandle = null;
        if (triggered && secondHitCandle) {
          entryCandle = today15.find(c => {
            if (c.timestamp <= secondHitCandle.timestamp) return false;
            const et = getETInfo(c.timestamp);
            return ENTRY_WINDOWS.some(w => et.hour === w.h && et.minute === w.m);
          });
        }

        const entryPrice = entryCandle ? +entryCandle.open.toFixed(2) : null;
        const slDist = (entryPrice && sl) ? +Math.abs(entryPrice - sl).toFixed(2) : null;

        const lv = lock.levels;
        const lockTpValid = lv && isBuy != null && (isBuy ? lv.lockLevel > (entryPrice ?? 0) : lv.lockLevel < (entryPrice ?? Infinity));
        const tp = (entryPrice && slDist)
          ? (lockTpValid && Math.abs(lv.lockLevel - entryPrice) >= slDist
            ? +lv.lockLevel.toFixed(2)
            : +(isBuy ? entryPrice + slDist * 2 : entryPrice - slDist * 2).toFixed(2))
          : null;

        // Status: watching → bsl_swept / ssl_swept → entry_active
        const status = triggered ? "entry_active"
          : bslHitCandle         ? "bsl_swept"
          : sslHitCandle         ? "ssl_swept"
          : "watching";

        let outcome = null;
        if (entryCandle && sl && tp) {
          const afterEntry = today15.filter(c => c.timestamp >= entryCandle.timestamp);
          outcome = simulateOutcome(afterEntry, isBuy, sl, tp);
        }

        if (isBuy !== null) {
          cycleSignal = {
            type: isBuy ? "BUY" : "SELL",
            status,
            triggered,
            lockDirection: lock.direction,
            lockStrength:  lock.strength,
            bslLevel:  prevCycHigh?.toString() ?? null,
            sslLevel:  prevCycLow?.toString()  ?? null,
            bslHitTime: bslHitCandle ? _tsToETLabel(bslHitCandle.timestamp) : null,
            sslHitTime: sslHitCandle ? _tsToETLabel(sslHitCandle.timestamp) : null,
            firstSweep:  firstHitCandle  ? (isBuy ? "BSL" : "SSL") : null,
            secondSweep: secondHitCandle ? (isBuy ? "SSL" : "BSL") : null,
            c2High: prevCycHigh, c2Low: prevCycLow,
            entryPrice, sl, tp, slDist, outcome,
            entryTimeLabel: entryCandle ? _tsToETLabel(entryCandle.timestamp) : null,
            lockLevel: lv?.lockLevel?.toFixed(2) ?? null,
            lockLabel: lv?.lockLabel ?? null,
          };
        }
      }
    }
  } catch {}

  // ── 90-MIN SIGNAL (C0→F1→F2) ─────────────────────────────────────────────────
  let ninetyMinSignal = null;
  try {
    const structureDays90 = dailyCandles?.length >= 20
      ? (() => {
          const dDays = groupCandlesByDay(dailyCandles);
          const dTodayIdx = dDays.findIndex(d => d.key === todayKey);
          const end = dTodayIdx >= 0 ? dTodayIdx : dDays.length;
          return dDays.slice(Math.max(0, end - 20), end);
        })()
      : allDays.slice(Math.max(0, todayIdx - 20), todayIdx);
    const ds90 = analyzeDailyStructure(structureDays90);
    const lock90 = ds90.lockState;
    if (lock90?.locked && lock90.levels) {
      const isBuy = lock90.direction === "BULLISH";

      function getET90Period(ts) {
        const { hour, minute } = getETInfo(ts);
        return Math.floor((hour * 60 + minute) / 90);
      }

      const c0prevC = today15.filter(c => getET90Period(c.timestamp) === 2); // 3:00-4:30
      const c0C     = today15.filter(c => getET90Period(c.timestamp) === 3); // 4:30-6:00
      const f1C     = today15.filter(c => getET90Period(c.timestamp) === 4); // 6:00-7:30
      const f2C     = today15.filter(c => getET90Period(c.timestamp) >= 5 && getETInfo(c.timestamp).hour < 12);

      const c0prevHigh = c0prevC.length ? Math.max(...c0prevC.map(c => c.high)) : null;
      const c0prevLow  = c0prevC.length ? Math.min(...c0prevC.map(c => c.low))  : null;
      const c0High = c0C.length ? +Math.max(...c0C.map(c => c.high)).toFixed(2) : null;
      const c0Low  = c0C.length ? +Math.min(...c0C.map(c => c.low)).toFixed(2)  : null;
      const f1High = f1C.length ? +Math.max(...f1C.map(c => c.high)).toFixed(2) : null;
      const f1Low  = f1C.length ? +Math.min(...f1C.map(c => c.low)).toFixed(2)  : null;

      const bslHit = c0C.length && c0prevHigh != null && (isBuy ? c0High > c0prevHigh : c0Low < c0prevLow);
      const sslHit = f1C.length && (isBuy ? (f1Low  != null && c0Low  != null && f1Low  < c0Low)
                                          : (f1High != null && c0High != null && f1High > c0High));

      const bslHitCandle = isBuy
        ? c0C.find(c => c0prevHigh != null && c.high > c0prevHigh)
        : c0C.find(c => c0prevLow  != null && c.low  < c0prevLow);
      const sslHitCandle = isBuy
        ? f1C.find(c => c0Low  != null && c.low  < c0Low)
        : f1C.find(c => c0High != null && c.high > c0High);

      const entryCandle90 = f2C[0] ?? null;
      const entryPrice90  = entryCandle90 ? +entryCandle90.open.toFixed(2) : null;

      const ultimateLow  = (f1Low  != null && entryCandle90) ? +Math.min(f1Low,  entryCandle90.low).toFixed(2)  : f1Low;
      const ultimateHigh = (f1High != null && entryCandle90) ? +Math.max(f1High, entryCandle90.high).toFixed(2) : f1High;
      const sl90  = isBuy ? ultimateLow : ultimateHigh;
      const slDist90 = (entryPrice90 && sl90) ? +Math.abs(entryPrice90 - sl90).toFixed(2) : null;
      const bslTarget = isBuy ? c0High : c0Low;
      const tpValid = bslTarget != null && entryPrice90 != null && (isBuy ? bslTarget > entryPrice90 : bslTarget < entryPrice90);
      const tp90 = (entryPrice90 && slDist90)
        ? (tpValid && Math.abs(bslTarget - entryPrice90) >= slDist90
          ? bslTarget
          : +(isBuy ? entryPrice90 + slDist90 * 2 : entryPrice90 - slDist90 * 2).toFixed(2))
        : null;

      let status90 = "watching";
      if (bslHit && !sslHit) status90 = "bsl_swept";
      if (bslHit && sslHit && !past730) status90 = "swept";
      if (bslHit && sslHit && past730) status90 = "entry_active";

      let outcome90 = null;
      if (entryCandle90 && sl90 && tp90 && past730) {
        const afterEntry = f2C.filter(c => c.timestamp >= entryCandle90.timestamp);
        outcome90 = simulateOutcome(afterEntry, isBuy, sl90, tp90);
      }

      ninetyMinSignal = {
        type: isBuy ? "BUY" : "SELL",
        status: status90,
        bslHit, sslHit,
        lockDirection: lock90.direction,
        lockStrength:  lock90.strength,
        c0High, c0Low,
        f1High, f1Low,
        bslLevel:   (isBuy ? c0High : c0Low)?.toString() ?? null,
        sslLevel:   (isBuy ? c0Low  : c0High)?.toString() ?? null,
        bslHitTime: bslHitCandle ? _tsToETLabel(bslHitCandle.timestamp) : null,
        sslHitTime: sslHitCandle ? _tsToETLabel(sslHitCandle.timestamp) : null,
        entryPrice: entryPrice90,
        sl: sl90, tp: tp90, slDist: slDist90, outcome: outcome90,
        entryTimeLabel: entryCandle90 ? _tsToETLabel(entryCandle90.timestamp) : (past730 ? null : "7:30 ET"),
        lockLevel: lock90.levels?.lockLevel?.toFixed(2) ?? null,
        lockLabel: lock90.levels?.lockLabel ?? null,
      };
    }
  } catch {}

  return { daily: dailySignal, cycle: cycleSignal, ninetyMin: ninetyMinSignal, dailyLockDir, cycleLockDir };
}
