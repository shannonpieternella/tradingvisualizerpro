// Standalone, self-contained Order-Flow Lock detector.
// Extracted from monitor.js so the journal backfill + API can run the same
// detection without spinning up the full monitor. Behaviour mirrors
// monitor.js's daily-lock path (18:00-ET trading-day aggregation, BSL→SSL→BSL
// chronological validation, no level-reclaim requirement on step 3).

const LOCK_STALENESS_EXPIRE = 14;
const LOCK_STALENESS_DECAY  = 7;
const LOCK_MAX_STRENGTH     = 6;

function tsToETHours(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts * 1000));
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return h + m / 60;
}

function tsToETDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });
}

function tsToETLabel(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  });
}

// 18:00-ET trading day buckets. Each candle is binned by its trading-day start.
// hitHigh/hitLow record the FIRST candle after the day's end that swept the
// day's high or low — same convention as monitor.js.
export function buildDailyStructure(candles, anchorTs = null) {
  const dayMap = new Map();
  for (const c of candles) {
    const etH = tsToETHours(c.timestamp);
    const approxDayStart = etH >= 18
      ? c.timestamp - (etH - 18) * 3600
      : c.timestamp - (etH + 6) * 3600;
    const key = Math.round(approxDayStart / 3600) * 3600;
    if (!dayMap.has(key)) dayMap.set(key, { startTs: key, high: -Infinity, low: Infinity });
    const d = dayMap.get(key);
    if (c.high > d.high) d.high = c.high;
    if (c.low  < d.low)  d.low  = c.low;
  }
  const days = [...dayMap.values()]
    .filter(d => d.high !== -Infinity && d.low !== Infinity)
    .sort((a, b) => a.startTs - b.startTs);

  const allSorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

  // Today-detection uses the supplied anchor (= the trade's entry timestamp
  // for backfill, or "now" for live). The trading-day containing the anchor is
  // marked isToday so callers can exclude it from sig moves (incomplete day).
  const anchor = anchorTs ?? Math.floor(Date.now() / 1000);
  const anchorEtH = tsToETHours(anchor);
  const anchorDayStart = anchorEtH >= 18
    ? anchor - (anchorEtH - 18) * 3600
    : anchor - (anchorEtH + 6) * 3600;
  const anchorKey = Math.round(anchorDayStart / 3600) * 3600;

  for (const day of days) {
    day.hitHigh = null;
    day.hitLow  = null;
    const endTs = day.startTs + 24 * 3600;
    for (const c of allSorted) {
      if (c.timestamp < endTs) continue;
      if (!day.hitHigh && c.high >= day.high)
        day.hitHigh = { price: c.high, date: tsToETDate(c.timestamp), time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!day.hitLow && c.low <= day.low)
        day.hitLow  = { price: c.low,  date: tsToETDate(c.timestamp), time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (day.hitHigh && day.hitLow) break;
    }
    day.date    = tsToETDate(day.startTs + 6 * 3600);
    day.isToday = Math.abs(day.startTs - anchorKey) < 7200;
  }

  return days.slice(-30);
}

// BSL → SSL → BSL chronology check (mirrored for bearish). Step-3's level need
// NOT reclaim step-1's; any post-SSL-grab BSL that itself gets later swept
// counts as a continuation BOS.
function validateBOS(m1, m2, m3, isBullish) {
  const t1 = isBullish ? m1.hitHigh?.ts : m1.hitLow?.ts;
  const t2 = isBullish ? m2.hitLow?.ts  : m2.hitHigh?.ts;
  const t3 = isBullish ? m3.hitHigh?.ts : m3.hitLow?.ts;
  if (!t1 || !t2 || !t3) return null;
  if (!(t1 < t2 && t2 < t3)) return null;
  return { t1, t2, t3 };
}

function findLockPatterns(sig, isBullish) {
  const patterns = [];
  const aType = isBullish ? "HIGH" : "LOW";
  const bType = isBullish ? "LOW"  : "HIGH";
  let i = 0;
  while (i < sig.length - 2) {
    const a = sig[i];
    if (a.type !== aType && a.type !== "BOTH") { i++; continue; }
    let matched = false;
    for (let j = i + 1; j < sig.length; j++) {
      if (sig[j].type === bType || sig[j].type === "BOTH") {
        for (let k = j + 1; k < sig.length; k++) {
          if (sig[k].type === aType || sig[k].type === "BOTH") {
            const bos = validateBOS(a, sig[j], sig[k], isBullish);
            if (bos) {
              patterns.push({ moves: [a, sig[j], sig[k]], bos, endIdx: k });
              i = k;
              matched = true;
            }
            break;
          }
          if (sig[k].type === bType) break;
        }
        break;
      }
      if (sig[j].type === aType) break;
    }
    if (!matched) i++;
  }
  return patterns;
}

export function detectOrderFlowLock(moves) {
  const sig = moves.filter(m => m.type !== "RANGE");
  if (sig.length < 3) return null;

  const bullish = findLockPatterns(sig, true);
  const bearish = findLockPatterns(sig, false);
  if (!bullish.length && !bearish.length) return null;

  const latestBull = bullish[bullish.length - 1];
  const latestBear = bearish[bearish.length - 1];
  const bullRecent = latestBull?.endIdx ?? -1;
  const bearRecent = latestBear?.endIdx ?? -1;

  const isBull = bullRecent >= bearRecent;
  const matches = isBull ? bullish : bearish;
  const direction = isBull ? "BULLISH" : "BEARISH";
  const lastMatch = matches[matches.length - 1];

  const daysSince = (sig.length - 1) - lastMatch.endIdx;
  if (daysSince > LOCK_STALENESS_EXPIRE) return null;

  let strength = Math.min(LOCK_MAX_STRENGTH, matches.length);
  if (daysSince > LOCK_STALENESS_DECAY) strength = Math.max(1, Math.floor(strength / 2));

  return { direction, strength, matchCount: matches.length, daysSinceLast: daysSince };
}

// Build the daily moves array (one per 18:00-ET trading day, dropping today)
// and run lock detection. Returns { direction, strength, ... } or null.
export function computeLockAtTime(candles, atTs = null) {
  if (!candles?.length) return null;
  const anchor = atTs ?? Math.floor(Date.now() / 1000);
  // Only use candles up to (and including) the anchor — important for backfill,
  // so the lock is computed using the data that was actually available at the
  // time of the trade's entry.
  const upto = candles.filter(c => c.timestamp <= anchor);
  if (upto.length < 50) return null; // need at least a few days of bars

  const dailyDays = buildDailyStructure(upto, anchor);
  const prevDays  = dailyDays.filter(d => !d.isToday && d.high && d.low);
  const moves = prevDays.map(d => ({
    type: (d.hitHigh && d.hitLow) ? "BOTH"
        : d.hitHigh               ? "HIGH"
        : d.hitLow                ? "LOW"
        :                           "RANGE",
    high: d.high, low: d.low, date: d.date,
    hitHigh: d.hitHigh, hitLow: d.hitLow,
  }));
  return detectOrderFlowLock(moves);
}

// Convenience: classify a trade's direction against the lock direction.
// Returns "with" | "against" | "none".
export function classifyLockAlignment(direction, lockDirection) {
  if (!lockDirection) return "none";
  if (direction === "BUY"  && lockDirection === "BULLISH") return "with";
  if (direction === "SELL" && lockDirection === "BEARISH") return "with";
  if (direction === "BUY"  && lockDirection === "BEARISH") return "against";
  if (direction === "SELL" && lockDirection === "BULLISH") return "against";
  return "none";
}
