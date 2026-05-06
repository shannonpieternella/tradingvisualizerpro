/**
 * BLACKBULL Liquidity Execution Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Signal sources: 90-min cycles | 6H cycles | Daily structure
 * Execution: Phase 2 windows only
 * Bias: Admin-controlled (BULLISH / BEARISH / AUTO)
 * Auto mode: Order flow lock (H→L→H = BULLISH | L→H→L = BEARISH)
 */

import fetch from "node-fetch";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import { computeSweepSL, computeSweepTP, verifyOutcome } from "./lib-sl.mjs";
import { notifySignal as cfNotifySignal, cancelSignal as cfCancelSignal, modifySignalSL as cfModifySignalSL } from "./copyfactory-bridge.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const envPath = join(__dir, "../.env");
const env = {};
try {
  readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k?.trim() && v.length) env[k.trim()] = v.join("=").trim();
  });
} catch {}

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || env.DISCORD_WEBHOOK || "https://discord.com/api/webhooks/1490817002556755979/PNFk3zeUmTTTyYtKUzM1dyOrsgKMwR3J4o09aqz3-KoGCjxbdXShdq6fWV7LcW7qZWSt";
const MCP_TOKEN       = process.env.MCP_TOKEN || env.MCP_TOKEN || "";
const MCP_URL         = "https://178-104-80-233.sslip.io/mcp";
const MONGO_URI       = process.env.MONGO_URI  || env.MONGO_URI  || "";

// ── MongoDB singleton ─────────────────────────────────────────────────────────
// Primary store for setup state (survives server reboots).
// Falls back to local JSON files on connection failure — no single point of failure.
let _mongoClient = null;
let _mongoDB     = null;
async function getDB() {
  if (_mongoDB) return _mongoDB;
  if (!MONGO_URI) return null;
  try {
    _mongoClient = new MongoClient(MONGO_URI, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS:         3000,
      socketTimeoutMS:          5000,
    });
    await _mongoClient.connect();
    _mongoDB = _mongoClient.db("tradingvisualizer");
    console.log("[MongoDB] Connected");
    return _mongoDB;
  } catch (e) {
    console.warn(`[MongoDB] Connect failed: ${e.message} — using local files`);
    _mongoClient = null;
    return null;
  }
}
async function closeDB() {
  if (_mongoClient) {
    try { await _mongoClient.close(); } catch {}
    _mongoClient = null; _mongoDB = null;
  }
}

// ── Markets ───────────────────────────────────────────────────────────────────
// Tightened to current realistic price ranges so cross-market candle contamination
// (MCP symbol-switch lag during fetches) gets caught by sanitizeCandles. Bounds
// are wide enough to absorb 6+ months of price drift but narrow enough to
// reject another market's prices (e.g., XAU 4600 won't pass for US500 [6000+]).
const MARKETS = {
  NAS100: { tvSymbol: "CAPITALCOM:US100", priceMin: 18000, priceMax: 35000, label: "NAS100" },
  US500:  { tvSymbol: "CAPITALCOM:US500", priceMin:  5500, priceMax:  9000, label: "US500"  },
  US30:   { tvSymbol: "CAPITALCOM:US30",  priceMin: 38000, priceMax: 60000, label: "US30"   },
  XAUUSD: { tvSymbol: "OANDA:XAUUSD",     priceMin:  3500, priceMax:  6000, label: "XAUUSD" },
  GBPUSD: { tvSymbol: "OANDA:GBPUSD",     priceMin:   1.1, priceMax:   1.6, label: "GBPUSD" },
  BTCUSD: { tvSymbol: "COINBASE:BTCUSD",  priceMin: 50000, priceMax: 200000, label: "BTCUSD" },
  ETHUSD: { tvSymbol: "COINBASE:ETHUSD",  priceMin:  1500, priceMax:  3500, label: "ETHUSD" },
};
const ACTIVE_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
const CRYPTO_MARKETS = new Set(["BTCUSD", "ETHUSD"]);

// ── Phase 2 windows (minutes into trading day) ────────────────────────────────
// Trading day starts 18:00 ET
const PHASE2 = {
  C1: { startMin:   90, endMin:  180, label: "19:30–21:00" },
  C2: { startMin:  450, endMin:  540, label: "01:30–03:00" },
  C3: { startMin:  810, endMin:  900, label: "07:30–09:00" },
  C4: { startMin: 1170, endMin: 1260, label: "13:30–15:00" },
};

// 6H cycle boundaries (minutes into trading day)
const SIX_H_BOUNDS = {
  C1: { startMin:    0, endMin:  360, label: "18:00–00:00" },
  C2: { startMin:  360, endMin:  720, label: "00:00–06:00" },
  C3: { startMin:  720, endMin: 1080, label: "06:00–12:00" },
  C4: { startMin: 1080, endMin: 1440, label: "12:00–18:00" },
};

// ── ET helpers ────────────────────────────────────────────────────────────────
function tsToETHours(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts * 1000));
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return h + m / 60;
}

// Parse a cycle label like "18:00-00:00", "06:00–12:00", or "Prev 12:00-18:00"
// and return the timestamp (sec) of the cycle's END — the most recent occurrence
// of that end-HH:MM at or before step2Ts. Used to constrain step-1 backscans to
// candles that are genuinely POST-CYCLE.
function findCycleEndTs(cycleLabel, step2Ts, candles) {
  if (!cycleLabel || !step2Ts || !candles?.length) return null;
  const m = cycleLabel
    .replace(/^Prev\s+/, "")
    .match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const endHHMM = `${m[3].padStart(2, "0")}:${m[4]}`;
  // Walk backwards through candles from step2Ts to find the most recent candle
  // whose ET HH:MM matches the cycle's end time.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  });
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (c.timestamp > step2Ts) continue;
    if (fmt.format(new Date(c.timestamp * 1000)) === endHHMM) return c.timestamp;
  }
  return null;
}

function tsToETLabel(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit",
  });
}

function tsToETDateTime(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    weekday: "short", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function tsToETDate(ts) {
  return new Date(ts * 1000).toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });
}

function getTradingDayStartTs() {
  const now  = new Date();
  const etH  = tsToETHours(Date.now() / 1000);
  const isDST = now.toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT");
  const etOffsetH = isDST ? 4 : 5;

  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const y = parseInt(etParts.find(p => p.type === "year").value);
  const mo = parseInt(etParts.find(p => p.type === "month").value);
  const d  = parseInt(etParts.find(p => p.type === "day").value);

  const target = new Date(Date.UTC(y, mo - 1, d));
  if (etH < 18) target.setUTCDate(target.getUTCDate() - 1);

  let t = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), 18 + etOffsetH, 0, 0));
  // DST boundary fix
  if (Math.abs(tsToETHours(t.getTime() / 1000) - 18) > 0.5) {
    for (const adj of [-3600, 3600]) {
      const t2 = new Date(t.getTime() + adj * 1000);
      if (Math.abs(tsToETHours(t2.getTime() / 1000) - 18) < 0.1) { t = t2; break; }
    }
  }
  return t.getTime() / 1000;
}

function minsIntoDay(ts, dayStartTs) {
  return (ts - dayStartTs) / 60;
}

function get6HCycle(mins) {
  if (mins < 0)    return null;
  if (mins < 360)  return "C1";
  if (mins < 720)  return "C2";
  if (mins < 1080) return "C3";
  if (mins < 1440) return "C4";
  return null;
}

// Which Phase 2 window is currently active (or null)
function getActivePhase2(dayStartTs) {
  const nowTs = Date.now() / 1000;
  for (const [cycle, p2] of Object.entries(PHASE2)) {
    const startTs = dayStartTs + p2.startMin * 60;
    const endTs   = dayStartTs + p2.endMin   * 60;
    if (nowTs >= startTs && nowTs <= endTs)
      return { cycle, ...p2, startTs, endTs };
  }
  return null;
}

// Next Phase 2 window. When all P2 windows in the current trading day have
// passed (e.g. setup created at 16:15 ET, after C4 P2 ended at 15:00 and before
// the next day's C1 P2 at 19:30), wrap to the next trading day's C1.
function getNextPhase2(dayStartTs) {
  const nowTs = Date.now() / 1000;
  const buildEntries = (startTs) => Object.entries(PHASE2).map(([cycle, p2]) => ({
    cycle, ...p2,
    startTs: startTs + p2.startMin * 60,
    endTs:   startTs + p2.endMin   * 60,
  }));
  const today = buildEntries(dayStartTs);
  const next = today.find(p => p.startTs > nowTs);
  if (next) return next;
  return buildEntries(dayStartTs + 24 * 3600)[0];
}

// Scalp entry windows = primary entry windows + 1h. So C1 → 21:45 ET, C2 → 03:45,
// C3 → 09:45, C4 → 15:45. Returns the next scalp window strictly after nowTs.
// Each window's `entryTs` is the timestamp of the 1m candle that opens it.
const SCALP_OFFSET_MIN = 60;
function getNextScalpEntryWindow(dayStartTs, fromTs = null) {
  const nowTs = fromTs ?? Date.now() / 1000;
  const buildEntries = (startTs) => Object.entries(PHASE2).map(([cycle, p2]) => {
    // Primary entry candle = startMin + 75. Scalp entry = primary + 60 = startMin + 135.
    const entryTs = startTs + (p2.startMin + 75 + SCALP_OFFSET_MIN) * 60;
    const clockMin = (p2.startMin + 75 + SCALP_OFFSET_MIN + 18 * 60) % 1440;
    const label = `${String(Math.floor(clockMin / 60)).padStart(2, "0")}:${String(clockMin % 60).padStart(2, "0")}`;
    return { cycle, label, entryTs };
  });
  const today = buildEntries(dayStartTs);
  const next = today.find(w => w.entryTs > nowTs);
  if (next) return next;
  return buildEntries(dayStartTs + 24 * 3600)[0];
}

// Phase 2 status for a given timestamp
function getPhase2Status(dayStartTs) {
  const p2 = getActivePhase2(dayStartTs);
  const nowTs = Date.now() / 1000;
  const mins = minsIntoDay(nowTs, dayStartTs);
  const cycle = get6HCycle(mins) || "C4";
  return {
    inPhase2: !!p2,
    activeP2: p2,
    currentCycle: cycle,
    phase: p2 ? 2 : 1,
    minsIntoDay: mins,
  };
}

// ── File helpers ──────────────────────────────────────────────────────────────
function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function writeJSON(path, data) {
  try { writeFileSync(path, JSON.stringify(data, null, 2)); } catch (e) {
    console.error(`writeJSON(${path}): ${e.message}`);
  }
}

// ── Admin Bias ────────────────────────────────────────────────────────────────
const ADMIN_BIAS_FILE  = join(__dir, "admin_bias.json");
const LOCK_CACHE_FILE  = join(__dir, "lock_cache.json");

function loadLockCache() { return readJSON(LOCK_CACHE_FILE, {}); }
function saveLockCache(market, lock) {
  const cache = loadLockCache();
  cache[market] = { ...lock, savedTs: Date.now() };
  writeJSON(LOCK_CACHE_FILE, cache);
}

function readAdminBias(marketKey) {
  const data = readJSON(ADMIN_BIAS_FILE, {});
  // Market-specific override takes precedence over global
  return data[marketKey] || data["GLOBAL"] || "AUTO";
}

function initAdminBias() {
  if (!existsSync(ADMIN_BIAS_FILE)) {
    writeJSON(ADMIN_BIAS_FILE, { GLOBAL: "AUTO" });
  }
}

// ── Debug Log ─────────────────────────────────────────────────────────────────
const DEBUG_LOG_FILE   = join(__dir, "debug_log.json");
const SETUP_LOG_FILE   = join(__dir, "setup_log.json");
const MAX_DEBUG_EVENTS = 500;

function logEvent(market, event, details, state = null) {
  const nowTs = Date.now() / 1000;
  const entry = {
    time: tsToETLabel(nowTs),
    ts: Date.now(),
    market,
    event,
    details,
    ...(state ? { state } : {}),
  };
  console.log(`[${entry.time} ET] | ${market.padEnd(6)} | ${event.padEnd(30)} | ${details}`);
  const log = readJSON(DEBUG_LOG_FILE, []);
  log.unshift(entry);
  if (log.length > MAX_DEBUG_EVENTS) log.length = MAX_DEBUG_EVENTS;
  writeJSON(DEBUG_LOG_FILE, log);
}

// Mirror a single setup_log entry to MongoDB `setup_history` so we get durable,
// queryable history across reboots + weeks/months of data. Local JSON remains
// the instant fallback. Fire-and-forget: never block monitor flow on Mongo.
async function mirrorSetupHistory(entry) {
  if (!entry?.id) return;
  try {
    const db = await getDB();
    if (!db) return;
    await db.collection("setup_history").replaceOne(
      { _id: entry.id },
      { _id: entry.id, ...entry, updatedAt: new Date() },
      { upsert: true }
    );
  } catch (e) { console.warn(`[MongoDB] mirrorSetupHistory: ${e.message}`); }
}

function patchSetupLog(id, patch) {
  if (!id) return;
  const log = readJSON(SETUP_LOG_FILE, []);
  const item = log.find(e => e.id === id);
  if (!item) {
    // Silent no-op was hiding desync bugs (setup loaded ACTIVE from Mongo but
    // never appended to setup_log → orphan path + reconcile both blind).
    console.warn(`[patchSetupLog] id ${id} not in setup_log — patch dropped:`, JSON.stringify(patch));
    return;
  }
  Object.assign(item, patch);
  writeJSON(SETUP_LOG_FILE, log);
  mirrorSetupHistory(item); // fire-and-forget
}

function updateSetupLogOutcome(id, outcome, extra = {}) {
  patchSetupLog(id, {
    outcome,
    outcomeTime: tsToETDateTime(Date.now() / 1000),
    status:      outcome === "WIN" ? "CLOSED_TP2" : outcome === "LOSS" ? "CLOSED_SL" : "CLOSED",
    ...extra,
  });
}

// Reconcile: make sure the CLOSED state of an active setup is reflected in the
// canonical setup_log + Mongo. Protects against any edge where the outcome
// handler didn't fire or an older setup_log entry was mis-attributed.
// Match STRICT: id only. Loose fallbacks caused cross-market corruption when
// active_setup files occasionally got wrong data — a WIN on NAS100 wrongly
// propagated to a BTCUSD entry in the log. ID match is the only safe path.
// Process orphaned setup_log entries for a market — catches setups that are
// not in the active-slot file (e.g. when a 6H setup shares a market with a
// newer 90M that took the active slot). Without this, the orphan sits in
// WAITING_PHASE2 / ACTIVE forever even after the entry window passed and SL/TP
// printed in the candles.
//
// Two orphan paths:
//   1. WAITING_PHASE2 with passed entry-window → trigger entry from +15min
//      candle open, recompute SL via canonical formula, mark ACTIVE, then
//      verify outcome.
//   2. ACTIVE → run verifyOutcome to detect SL/TP hits.
function verifyOrphanedActives(marketKey, candles, currentActiveId = null, dailyEq = null, sixHEq = null) {
  if (!candles?.length) return;
  // Multi-setup support: caller may pass a single id (legacy) or an array of
  // ids (one per TF). All matching ids are considered "current" and skipped.
  const currentIds = currentActiveId == null ? []
                   : Array.isArray(currentActiveId) ? currentActiveId
                   : [currentActiveId];
  const log = readJSON(SETUP_LOG_FILE, []);
  let dirty = false;
  for (const item of log) {
    if (item.market !== marketKey) continue;
    if (currentIds.includes(item.id)) continue;  // handled by reconcileActiveSetup per TF
    if (item.type === "scalp") continue;                           // scalps managed by processScalp
    if (item.status !== "ACTIVE" && item.status !== "WAITING_PHASE2" && item.status !== "TP2_HIT_RUNNING") continue;

    // ── (1) WAITING_PHASE2 → trigger entry retroactively if window passed ──
    if (item.status === "WAITING_PHASE2") {
      // Need entryWindowTs (entry candle ts) + step2Ts to construct a valid trigger.
      if (!item.entryWindowTs || !item.step2Ts) continue;
      const entryCandleTs = item.entryWindowTs;
      const entryCandle = candles.find(c => c.timestamp === entryCandleTs);
      if (!entryCandle) continue;                                   // window not yet reached
      const dec = entryCandle.open > 100 ? 1 : 5;
      const actualEntry = +entryCandle.open.toFixed(dec);
      const slPrice = computeSweepSL({
        direction:  item.direction,
        candles,
        step2Ts:    item.step2Ts,
        entryTs:    entryCandle.timestamp,
        entryPrice: actualEntry,
        sweepPrice: item.sweepPrice,
      });
      const { tp1, tp2, tp3 } = computeSweepTP(item.direction, actualEntry, slPrice);
      item.entry     = actualEntry;
      item.sl        = slPrice;
      item.tp1       = tp1;
      item.tp2       = tp2;
      item.tp3       = tp3;
      item.entryTime = tsToETLabel(entryCandle.timestamp);
      item.entryTs   = entryCandle.timestamp * 1000;
      item.status    = "ACTIVE";
      item.tp1Hit    = false;
      item.tp2Hit    = false;
      item.tp3Hit    = false;
      item.slMovedToBE = false;
      item.slHit     = false;
      console.log(`[${marketKey}] ORPHAN TRIGGER: ${item.id} → ACTIVE entry=${actualEntry} sl=${slPrice} tp1=${tp1}`);
      dirty = true;

      // Single-source-of-truth fan-out: ENTRY_TRIGGERED log + setup_log patch +
      // weekly recap + MetaApi signal + Discord. persistActive=false because the
      // orphan's id ≠ currentActiveId, so writing the active-slot file would
      // overwrite the genuine current active setup.
      fireEntryTrigger(marketKey, item, {
        sourceTag: "orphan", persistActive: false, dailyEq, sixHEq,
      }).catch(() => {});
      // fall through to outcome-verify below with the freshly-set fields
    }

    // ── (2) ACTIVE / TP2_HIT_RUNNING → step the state machine vs post-entry candles ──
    // Mirrors the live-path logic at the "Active trade monitoring" block so an
    // orphan that fell out of the active-slot still gets the runner/BE flow:
    //   SL pre-runner  → CLOSED_SL, cancel all legs (loss)
    //   SL post-runner → CLOSED_TP2 + runnerOutcome:BE_STOP, cancel tp3 (win @ 2R)
    //   TP1            → tp1Hit=true, cancel tp1 leg, stay ACTIVE
    //   TP2 (has tp3)  → TP2_HIT_RUNNING, sl=entry, slMovedToBE=true,
    //                    cancel tp2 leg, modify tp3 leg's SL to entry
    //   TP2 (no  tp3)  → CLOSED_TP2 legacy, cancel all legs
    //   TP3 (runner)   → CLOSED_TP3, rMulti=10, cancel tp3 leg
    if (!item.entryTs || item.sl == null || item.tp1 == null) continue;
    const entryTsSec = item.entryTs > 1e12 ? item.entryTs / 1000 : item.entryTs;
    const isBuy = item.direction === "BUY";
    const post  = candles
      .filter(c => c.timestamp > entryTsSec)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!post.length) {
      if (dirty) mirrorSetupHistory(item);
      continue;
    }
    const fp = p => p > 100 ? p.toFixed(1) : p.toFixed(5);
    let changed = false;

    for (const c of post) {
      const isRunner  = item.status === "TP2_HIT_RUNNING";
      // For runner state: only count SL hit on candles AFTER the BE-MOVE
      // moment. Pre-BE candles often touched entry naturally — those aren't
      // post-TP2 reversals and shouldn't close the runner.
      const beTsSec = item.slMovedToBETs ? item.slMovedToBETs / 1000 : 0;
      const slEligible = !isRunner || c.timestamp > beTsSec;
      const slBroken  = slEligible && (isBuy ? c.low  <= item.sl  : c.high >= item.sl);
      const tp1Broken = item.tp1 != null && (isBuy ? c.high >= item.tp1 : c.low  <= item.tp1);
      const tp2Broken = item.tp2 != null && (isBuy ? c.high >= item.tp2 : c.low  <= item.tp2);
      const tp3Broken = item.tp3 != null && (isBuy ? c.high >= item.tp3 : c.low  <= item.tp3);

      if (slBroken && !item.slHit) {
        item.slHit = true;
        if (isRunner) {
          item.status        = "CLOSED_TP2";
          item.runnerOutcome = "BE_STOP";
          item.outcomeTime   = item.outcomeTime  ?? tsToETDateTime(c.timestamp);
          item.outcomePrice  = item.outcomePrice ?? item.sl;
          logEvent(marketKey, "RUNNER_BE_STOP",
            `${item.direction} runner stopped at BE @ ${fp(item.sl)} (TP2 already hit) [orphan]`,
            "tp2_hit");
          cfCancelSignal(item, "tp3").catch(() => {});
        } else {
          item.status        = "CLOSED_SL";
          item.outcome       = "LOSS";
          item.outcomeTime   = item.outcomeTime  ?? tsToETDateTime(c.timestamp);
          item.outcomePrice  = item.outcomePrice ?? item.sl;
          logEvent(marketKey, "SL_HIT",
            `${item.direction} SL @ ${fp(item.sl)} | Entry was ${fp(item.entry)} [orphan]`,
            "sl_hit");
          cfCancelSignal(item, "all").catch(() => {});
        }
        changed = true;
        break;
      }

      if (!isRunner && tp1Broken && !item.tp1Hit) {
        item.tp1Hit     = true;
        item.tp1HitTime = item.tp1HitTime ?? tsToETDateTime(c.timestamp);
        logEvent(marketKey, "TP1_HIT",
          `${item.direction} TP1 @ ${fp(item.tp1)} ✅ (1R) [orphan]`, "tp1_hit");
        cfCancelSignal(item, "tp1").catch(() => {});
        changed = true;
        // fall through — TP2 / SL may still fire on later candles
      }

      if (!isRunner && tp2Broken && !item.tp2Hit) {
        item.tp2Hit     = true;
        item.tp2HitTime = item.tp2HitTime ?? tsToETDateTime(c.timestamp);
        const hasRunner = item.tp3 != null && !item.slMovedToBE;
        if (hasRunner) {
          const beSL          = item.entry;
          item.sl             = beSL;
          item.slMovedToBE    = true;
          item.slMovedToBETs  = c.timestamp * 1000;   // anchor for SL check post-runner
          item.status         = "TP2_HIT_RUNNING";
          logEvent(marketKey, "TP2_HIT",
            `${item.direction} TP2 @ ${fp(item.tp2)} 🏆 (2R) — runner armed, SL→BE ${fp(beSL)} [orphan]`,
            "tp2_hit");
          cfCancelSignal(item, "tp2").catch(() => {});
          cfModifySignalSL(item, marketKey, "tp3", beSL).catch(() => {});
          changed = true;
          // fall through — TP3 / BE-SL may still fire on later candles in this scan
        } else {
          item.status        = "CLOSED_TP2";
          item.outcome       = "WIN";
          item.outcomeTime   = item.outcomeTime  ?? tsToETDateTime(c.timestamp);
          item.outcomePrice  = item.outcomePrice ?? item.tp2;
          logEvent(marketKey, "TP2_HIT",
            `${item.direction} TP2 @ ${fp(item.tp2)} 🏆 (2R) [orphan, no runner]`,
            "tp2_hit");
          cfCancelSignal(item, "all").catch(() => {});
          changed = true;
          break;
        }
      }

      if (item.status === "TP2_HIT_RUNNING" && tp3Broken && !item.tp3Hit) {
        item.tp3Hit       = true;
        item.tp3HitTime   = item.tp3HitTime ?? tsToETDateTime(c.timestamp);
        item.status       = "CLOSED_TP3";
        item.outcome      = "WIN";
        item.rMulti       = 10;
        item.outcomeTime  = item.outcomeTime  ?? tsToETDateTime(c.timestamp);
        item.outcomePrice = item.outcomePrice ?? item.tp3;
        logEvent(marketKey, "TP3_HIT",
          `${item.direction} TP3 @ ${fp(item.tp3)} 🚀 (10R runner) [orphan]`, "tp3_hit");
        cfCancelSignal(item, "tp3").catch(() => {});
        changed = true;
        break;
      }
    }

    if (changed) {
      console.log(`[${marketKey}] ORPHAN VERIFY: ${item.id} → ${item.status}`);
      mirrorSetupHistory(item);
      dirty = true;
    } else if (dirty) {
      mirrorSetupHistory(item);
    }
  }
  if (dirty) writeJSON(SETUP_LOG_FILE, log);
}

function reconcileActiveSetup(activeSetup) {
  if (!activeSetup) return;
  const { status } = activeSetup;
  if (status !== "CLOSED_TP2" && status !== "CLOSED_SL" && status !== "ACTIVE" && status !== "WAITING_PHASE2") return;

  const outcome = status === "CLOSED_TP2" ? "WIN"
                : status === "CLOSED_SL"  ? "LOSS"
                : null;

  const log = readJSON(SETUP_LOG_FILE, []);
  if (!activeSetup.id) return;                      // no id → nothing to reconcile safely
  const match = log.find(e => e.id === activeSetup.id);
  if (!match) return;                                // unknown setup → don't touch log
  if (match.market !== activeSetup.market) return;   // guard against cross-market IDs

  const patch = {
    status,
    sl:        activeSetup.sl,
    tp1:       activeSetup.tp1,
    tp2:       activeSetup.tp2,
    tp3:       activeSetup.tp3,
    entry:     activeSetup.entry,
    entryTime: activeSetup.entryTime ?? match?.entryTime ?? null,
    entryTs:   activeSetup.entryTs   ?? match?.entryTs   ?? null,
    entryWindowTime: activeSetup.entryWindowTime ?? match?.entryWindowTime ?? null,
    entryWindowTs:   activeSetup.entryWindowTs   ?? match?.entryWindowTs   ?? null,
    tp1Hit:    !!activeSetup.tp1Hit,
    tp2Hit:    !!activeSetup.tp2Hit,
    tp3Hit:    !!activeSetup.tp3Hit,
    slMovedToBE: !!activeSetup.slMovedToBE,
  };
  if (outcome) {
    patch.outcome     = outcome;
    patch.outcomeTime = match?.outcomeTime ?? tsToETDateTime(Date.now() / 1000);
  }

  if (match) {
    // Only write if something actually changed — avoid unnecessary Mongo writes.
    const changed = Object.entries(patch).some(([k, v]) => match[k] !== v);
    if (changed) {
      Object.assign(match, patch);
      if (!match.id) match.id = activeSetup.id ?? `${activeSetup.market}-${activeSetup.source ?? activeSetup.tf}-${activeSetup.createdTs}`;
      writeJSON(SETUP_LOG_FILE, log);
      mirrorSetupHistory(match);
    }
  } else if (outcome) {
    // No matching log entry and we have an outcome — insert one so the trade
    // still shows up in the journal.
    const id = activeSetup.id ?? `${activeSetup.market}-${activeSetup.source ?? activeSetup.tf}-${activeSetup.createdTs ?? Date.now()}`;
    const entry = {
      id,
      market:     activeSetup.market,
      direction:  activeSetup.direction,
      source:     activeSetup.source ?? activeSetup.tf,
      tf:         activeSetup.tf,
      side:       activeSetup.direction === "BUY" ? "LOW" : "HIGH",
      bslLevel:   activeSetup.bslLevel,
      sslLevel:   activeSetup.sslLevel,
      entry:      activeSetup.entry,
      sweepPrice: activeSetup.sweepPrice,
      step1Time:  activeSetup.step1Time,
      step2Time:  activeSetup.step2Time,
      cycleLabel: activeSetup.cycleLabel,
      ...patch,
      ts:         activeSetup.createdTs ?? Date.now(),
      datetime:   tsToETDateTime((activeSetup.createdTs ?? Date.now()) / 1000),
    };
    log.unshift(entry);
    writeJSON(SETUP_LOG_FILE, log.slice(0, 10000));
    mirrorSetupHistory(entry);
  }
}

// ── Order Flow Lock ───────────────────────────────────────────────────────────
// Lock = BSL swept → SSL swept → BSL swept again (BULLISH)  or reverse (BEARISH)
// Each day's type is derived from whether future candles swept that day's level:
//   HIGH = buyside (BSL) swept later  |  LOW = sellside (SSL) swept later
//   BOTH = both sides swept           |  RANGE = neither (skip)
//
// Robustness:
//   - Non-overlapping matches only (each day used once per pattern family)
//   - Staleness: patterns ending > 14 days ago are discarded entirely
//   - Decay: patterns ending > 7 days ago count half
//   - Invalidation: 3+ consecutive moves against the lock → strength -= 2
//   - Direction: whichever family has the most recent pattern wins
//   - keyDates: accumulate all unique dates from all counted patterns
const LOCK_STALENESS_EXPIRE = 14;  // days → lock discarded (anything older than this = forget it)
const LOCK_STALENESS_DECAY  = 7;   // days → strength halved (still shown, but flagged as decayed)
const LOCK_MAX_STRENGTH     = 6;

// Validate the lock pattern's three sweeps happen in chronological order:
//   t1Hit (step-1 BSL hit) < t2Sweep (step-2 SSL grab) < t3Hit (step-3 BSL hit)
// for bullish; mirrored for bearish. Each step is a HIGH-type / LOW-type day,
// meaning its OWN level was later swept by some future candle. Step 3's high
// does NOT need to reclaim step-1's level — any new BSL after the SSL grab
// counts as a continuation BOS.
function validateBOS(m1, m2, m3, isBullish) {
  const t1 = isBullish ? m1.hitHigh?.ts : m1.hitLow?.ts;
  const t2 = isBullish ? m2.hitLow?.ts  : m2.hitHigh?.ts;
  const t3 = isBullish ? m3.hitHigh?.ts : m3.hitLow?.ts;
  if (!t1 || !t2 || !t3) return null;
  if (!(t1 < t2 && t2 < t3)) return null;
  return { t1, t2, t3 };
}

function findLockPatterns(sig, isBullish, candles) {
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
            // No level constraint: step-3's BSL/SSL doesn't need to reclaim step-1.
            // Any "BSL → SSL → BSL" sequence (or mirror for bearish) with the three
            // sweeps in chronological order is a valid lock.
            const bos = validateBOS(a, sig[j], sig[k], isBullish);
            if (bos) {
              patterns.push({
                dates: [a.date, sig[j].date, sig[k].date],
                moves: [a, sig[j], sig[k]],
                bos,
                endIdx: k,
              });
              i = k; // non-overlapping: next search starts from the matched end
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

function detectOrderFlowLock(moves, candles = null, opts = {}) {
  // dailyMode: when true, BOS-candle timestamps are D-candles (24h aligned to UTC
  // for crypto / 17:00 ET open for futures) and should be displayed as ET close-dates
  // (ts + 86400 → ET date) — same convention as buildDailyLockMoves uses for step 1/2.
  // false = candles are intraday (15-min/6H), label with raw ET date+time.
  const { dailyMode = false } = opts;
  const sig = moves.filter(m => m.type !== "RANGE");
  if (sig.length < 3) return null;

  const bullish = findLockPatterns(sig, true,  candles);
  const bearish = findLockPatterns(sig, false, candles);

  if (!bullish.length && !bearish.length) return null;

  // Direction: whichever family has the most recent match wins (fresh structure > stale count)
  const latestBull = bullish[bullish.length - 1];
  const latestBear = bearish[bearish.length - 1];
  const bullRecent = latestBull?.endIdx ?? -1;
  const bearRecent = latestBear?.endIdx ?? -1;

  const isBull = bullRecent >= bearRecent;
  const matches = isBull ? bullish : bearish;
  const direction = isBull ? "BULLISH" : "BEARISH";
  const lastMatch = matches[matches.length - 1];

  // Staleness: how many "signal days" since the last pattern closed?
  const daysSince = (sig.length - 1) - lastMatch.endIdx;
  if (daysSince > LOCK_STALENESS_EXPIRE) return null;

  // Base strength = count of non-overlapping patterns, capped
  let strength = Math.min(LOCK_MAX_STRENGTH, matches.length);

  // Decay: halve strength for patterns > 7 days old
  if (daysSince > LOCK_STALENESS_DECAY) {
    strength = Math.max(1, Math.floor(strength / 2));
  }

  // Invalidation: moves AFTER the last pattern that go against the lock
  const after = sig.slice(lastMatch.endIdx + 1);
  const againstType = isBull ? "LOW" : "HIGH";
  const against = after.filter(m => m.type === againstType).length;
  if (against >= 3) strength = Math.max(1, strength - 2);

  const last = sig[sig.length - 1];
  const opportunity =
    isBull  && (last.type === "LOW"  || last.type === "BOTH") ? "BUY"  :
    !isBull && (last.type === "HIGH" || last.type === "BOTH") ? "SELL" : null;

  const noteVerb = isBull ? "BSL" : "SSL";
  const middle   = isBull ? "pullback" : "bounce";
  const lockNote = `${noteVerb}(${lastMatch.dates[0]}) → ${middle}(${lastMatch.dates[1]}) → ${noteVerb}(${lastMatch.dates[2]}) → ${direction}`
    + (daysSince > LOCK_STALENESS_DECAY ? ` · ${daysSince}d old (decayed)` : "")
    + (against >= 3 ? ` · ${against} moves against (weakened)` : "");

  // Accumulate all unique key dates from every counted pattern of this direction
  const allDates = [];
  for (const m of matches) {
    for (const d of m.dates) if (!allDates.includes(d)) allDates.push(d);
  }

  // Build structured per-step info for the most recent pattern.
  // Step roles per direction:
  //   BULLISH: BSL formed → SSL grabbed → new BSL formed (each gets later swept)
  //   BEARISH: SSL formed → BSL grabbed → new SSL formed
  const [m1, m2, m3] = lastMatch.moves;
  const sweepKey1 = isBull ? "hitHigh" : "hitLow";
  const sweepKey2 = isBull ? "hitLow"  : "hitHigh";
  const sweepKey3 = isBull ? "hitHigh" : "hitLow";
  const levelKey1 = isBull ? "high"    : "low";
  const levelKey2 = isBull ? "low"     : "high";
  const levelKey3 = isBull ? "high"    : "low";

  const steps = [
    {
      step:    1,
      role:    isBull ? "BSL_FORMED"      : "SSL_FORMED",
      label:   isBull ? "BSL ligt op"     : "SSL ligt op",
      date:    m1.date,
      cycle:   m1.cycle ?? null,
      cycleLabel: m1.cycleLabel ?? null,
      level:   m1[levelKey1],
      sweptAt: m1[sweepKey1] ?? null,
    },
    {
      step:    2,
      role:    isBull ? "SSL_GRAB"        : "BSL_GRAB",
      label:   isBull ? "SSL ligt op (liquidity grab onder)"
                      : "BSL ligt op (liquidity grab boven)",
      date:    m2.date,
      cycle:   m2.cycle ?? null,
      cycleLabel: m2.cycleLabel ?? null,
      level:   m2[levelKey2],
      sweptAt: m2[sweepKey2] ?? null,
    },
    {
      step:    3,
      role:    isBull ? "BSL_RECLAIM_BOS" : "SSL_RECLAIM_BOS",
      label:   isBull ? "Nieuwe BSL — bullish BOS bevestigd"
                      : "Nieuwe SSL — bearish BOS bevestigd",
      date:    m3.date,
      cycle:   m3.cycle ?? null,
      cycleLabel: m3.cycleLabel ?? null,
      level:   m3[levelKey3],
      // Step-3's own level was later swept too — that's the BOS continuation
      sweptAt: m3[sweepKey3] ?? null,
      bosAt:   m3[sweepKey3] ?? null,        // alias for UI compatibility
      bosBaseLevel: m3[levelKey3],
    },
  ];

  return {
    direction,
    strength,
    opportunity,
    note:          lockNote,
    keyDates:      allDates,
    matchCount:    matches.length,
    daysSinceLast: daysSince,
    movesAgainst:  against,
    steps,
  };
}

// ── 6H Historical Structure (for 6H lock detection) ──────────────────────────
// Builds 6H cycles across the last N trading days and classifies each cycle
// as HIGH/LOW/BOTH/RANGE based on whether later cycles swept its levels.
// Returns moves compatible with detectOrderFlowLock.
function build6HHistoricalMoves(candles, numDays = 14) {
  const nowTs = Date.now() / 1000;
  const lookbackSecs = numDays * 86400;
  const relevant = candles.filter(c => c.timestamp >= nowTs - lookbackSecs);
  if (!relevant.length) return [];

  // Group candles into 6H buckets per trading day
  const buckets = new Map();
  for (const c of relevant) {
    // Find this candle's trading day start (18:00 ET boundary)
    const etH = tsToETHours(c.timestamp);
    const approxDayStart = etH >= 18
      ? c.timestamp - (etH - 18) * 3600
      : c.timestamp - (etH + 6) * 3600;
    const dayStart = Math.round(approxDayStart / 3600) * 3600;
    const minsIn = (c.timestamp - dayStart) / 60;
    if (minsIn < 0 || minsIn >= 1440) continue;
    const cycle = minsIn < 360 ? "C1" : minsIn < 720 ? "C2" : minsIn < 1080 ? "C3" : "C4";
    const startOffset = { C1: 0, C2: 360, C3: 720, C4: 1080 }[cycle];
    const key = `${dayStart}-${cycle}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        ts:       dayStart + startOffset * 60,
        cycle,
        dayStart,
        high:     c.high,
        low:      c.low,
      });
    } else {
      const b = buckets.get(key);
      if (c.high > b.high) b.high = c.high;
      if (c.low  < b.low)  b.low  = c.low;
    }
  }

  // Sort chronologically. Drop the current in-progress cycle (no future candles yet).
  const cycleEnd = (b) => b.ts + 6 * 3600;
  const all = [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .filter(b => cycleEnd(b) <= nowTs); // only completed cycles

  // Classify: for each cycle, did any LATER cycle sweep its high/low?
  const sortedCandles = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const moves = [];
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    const endTs = cycleEnd(b);
    let hitHigh = null, hitLow = null;
    // Walk forward through later candles; capture the first sweep candle for each side
    for (const c of sortedCandles) {
      if (c.timestamp <= endTs) continue;
      if (!hitHigh && c.high >= b.high) {
        hitHigh = { price: c.high, date: tsToETDate(c.timestamp), time: tsToETLabel(c.timestamp), ts: c.timestamp };
      }
      if (!hitLow && c.low <= b.low) {
        hitLow  = { price: c.low,  date: tsToETDate(c.timestamp), time: tsToETLabel(c.timestamp), ts: c.timestamp };
      }
      if (hitHigh && hitLow) break;
    }
    const type = hitHigh && hitLow ? "BOTH" : hitHigh ? "HIGH" : hitLow ? "LOW" : "RANGE";
    const dateLabel = tsToETDate(b.ts);
    moves.push({
      type, high: b.high, low: b.low,
      date: `${dateLabel} ${b.cycle}`,
      cycle: b.cycle,
      cycleDate: dateLabel,
      cycleLabel: SIX_H_BOUNDS[b.cycle]?.label ?? null,
      hitHigh, hitLow,
    });
  }
  return moves;
}

// ── Order Flow Bias (daily × 6H confluence) ───────────────────────────────────
// Combines the daily and 6H locks into a single robust bias state.
// Lets the admin override via readAdminBias — this only fires when bias = AUTO.
//
// States:
//   STRONG_BULL / STRONG_BEAR  — daily + 6H agree, respected structure
//   BULL / BEAR                — agree but one side weakened/stale
//   BULL_pullback / BEAR_bounce — daily one way, 6H opposite (correction inside trend)
//   BULL_emerging / BEAR_emerging — daily NEUTRAL, 6H showing direction (early move)
//   NEUTRAL                    — no reliable bias
function computeOrderFlowBias(dailyLock, sixHLock) {
  const d = dailyLock?.direction ?? null;
  const s = sixHLock?.direction  ?? null;

  let state = "NEUTRAL";
  let direction = null;
  let score = 0;

  // Both agree → strong signal
  if (d && s && d === s) {
    direction = d === "BULLISH" ? "BUY" : "SELL";
    const sum = (dailyLock.strength ?? 0) + (sixHLock.strength ?? 0);
    if (sum >= 6) state = `STRONG_${d}`;
    else           state = d;
    score = 50 + Math.min(50, sum * 5); // 50-100
  }
  // Daily has direction, 6H disagrees → pullback in ongoing trend
  else if (d && s && d !== s) {
    direction = d === "BULLISH" ? "BUY" : "SELL"; // keep daily bias, but weak
    state = d === "BULLISH" ? "BULL_pullback" : "BEAR_bounce";
    score = 30 + (dailyLock.strength ?? 0) * 5;
  }
  // Daily neutral, 6H directional → emerging trend
  else if (!d && s) {
    direction = s === "BULLISH" ? "BUY" : "SELL";
    state = s === "BULLISH" ? "BULL_emerging" : "BEAR_emerging";
    score = 20 + (sixHLock.strength ?? 0) * 5;
  }
  // Daily only (no 6H)
  else if (d && !s) {
    direction = d === "BULLISH" ? "BUY" : "SELL";
    state = `${d}_weak`;
    score = 20 + (dailyLock.strength ?? 0) * 3;
  }

  // Structure respected check — is the pullback low of the last pattern still intact?
  // If not, reduce score (potential BOS).
  const dailyResp = dailyLock?.daysSinceLast != null && (dailyLock.movesAgainst ?? 0) < 3;
  const sixHResp  = sixHLock?.daysSinceLast != null && (sixHLock.movesAgainst ?? 0) < 3;
  if (direction && !dailyResp && !sixHResp) score = Math.max(10, score - 20);

  return {
    state,
    direction,         // "BUY" | "SELL" | null
    score: Math.min(100, Math.max(0, Math.round(score))),
    dailyDirection: d,
    sixHDirection:  s,
    dailyRespected: dailyResp,
    sixHRespected:  sixHResp,
    note: buildBiasNote(d, s, state),
  };
}

function buildBiasNote(d, s, state) {
  if (state === "NEUTRAL") return "No clear bias — daily and 6H don't align";
  if (state.includes("STRONG"))   return `Daily ${d} + 6H ${s} — strong confluence`;
  if (state.includes("pullback")) return `Daily ${d} in control, 6H showing pullback`;
  if (state.includes("bounce"))   return `Daily ${d} in control, 6H showing bounce`;
  if (state.includes("emerging")) return `6H flipping to ${s} — possible trend change`;
  if (state.includes("weak"))     return `Daily ${d} alone, 6H not confirming`;
  return state;
}

// ── 90-Min Cycle Builder ──────────────────────────────────────────────────────
function build90MinCycles(candles, dayStartTs) {
  const nowTs = Date.now() / 1000;
  const cycles = {};

  // Include 3 cycles before the session start so recently-completed cycles
  // (e.g. 16:30–18:00 just before rollover) remain visible with hit detection.
  const PREV_CYCLES = 3;
  const todayCandles = candles.filter(c => {
    const m = minsIntoDay(c.timestamp, dayStartTs);
    return m >= -(PREV_CYCLES * 90) && m < 1440;
  });

  for (const c of todayCandles) {
    const m   = minsIntoDay(c.timestamp, dayStartTs);
    const idx = Math.floor(m / 90);
    if (!cycles[idx]) {
      const startTs = dayStartTs + idx * 90 * 60;
      const endTs   = startTs + 90 * 60;
      cycles[idx] = {
        index: idx, startTs, endTs,
        startTime: tsToETLabel(startTs),
        endTime:   tsToETLabel(endTs),
        complete:  endTs <= nowTs,
        high: -Infinity, highTs: null,
        low:   Infinity, lowTs:  null,
        candleCount: 0,
        hitHigh: null, hitLow: null,
      };
    }
    const cyc = cycles[idx];
    cyc.candleCount++;
    if (c.high > cyc.high) { cyc.high = c.high; cyc.highTs = c.timestamp; }
    if (c.low  < cyc.low)  { cyc.low  = c.low;  cyc.lowTs  = c.timestamp; }
  }

  // Clean up Infinity values
  for (const cyc of Object.values(cycles)) {
    if (cyc.high === -Infinity) cyc.high = null;
    if (cyc.low  ===  Infinity) cyc.low  = null;
    if (cyc.high) cyc.highTime = tsToETLabel(cyc.highTs);
    if (cyc.low)  cyc.lowTime  = tsToETLabel(cyc.lowTs);
  }

  // Hit detection for complete cycles
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const cyc of Object.values(cycles)) {
    if (!cyc.complete || !cyc.high) continue;
    for (const c of sorted.filter(c => c.timestamp >= cyc.endTs)) {
      if (!cyc.hitHigh && c.high >= cyc.high)
        cyc.hitHigh = { price: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!cyc.hitLow && c.low <= cyc.low)
        cyc.hitLow  = { price: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (cyc.hitHigh && cyc.hitLow) break;
    }
  }

  return cycles;
}

// ── 5.625min Cycle Builder ────────────────────────────────────────────────────
// 22.5M / 4 = 5.625min. 256 cycles per trading day. Used for SCALP signals only:
// fires when a single-leg sweep aligns with the ACTIVE primary setup's direction.
// Not a primary signal source — depends on a parent setup being ACTIVE.
function build5MinCycles(candles, dayStartTs) {
  const nowTs = Date.now() / 1000;
  const cycles = {};
  const CYCLE_MIN = 5.625;
  const PREV_CYCLES = 4;
  const todayCandles = candles.filter(c => {
    const m = minsIntoDay(c.timestamp, dayStartTs);
    return m >= -(PREV_CYCLES * CYCLE_MIN) && m < 1440;
  });

  for (const c of todayCandles) {
    const m   = minsIntoDay(c.timestamp, dayStartTs);
    const idx = Math.floor(m / CYCLE_MIN);
    if (!cycles[idx]) {
      const startTs = dayStartTs + idx * CYCLE_MIN * 60;
      const endTs   = startTs + CYCLE_MIN * 60;
      cycles[idx] = {
        index: idx, startTs, endTs,
        startTime: tsToETLabel(startTs),
        endTime:   tsToETLabel(endTs),
        complete:  endTs <= nowTs,
        high: -Infinity, highTs: null,
        low:   Infinity, lowTs:  null,
        candleCount: 0,
        hitHigh: null, hitLow: null,
      };
    }
    const cyc = cycles[idx];
    cyc.candleCount++;
    if (c.high > cyc.high) { cyc.high = c.high; cyc.highTs = c.timestamp; }
    if (c.low  < cyc.low)  { cyc.low  = c.low;  cyc.lowTs  = c.timestamp; }
  }

  for (const cyc of Object.values(cycles)) {
    if (cyc.high === -Infinity) cyc.high = null;
    if (cyc.low  ===  Infinity) cyc.low  = null;
    if (cyc.high) cyc.highTime = tsToETLabel(cyc.highTs);
    if (cyc.low)  cyc.lowTime  = tsToETLabel(cyc.lowTs);
  }

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const cyc of Object.values(cycles)) {
    if (!cyc.complete || !cyc.high) continue;
    for (const c of sorted.filter(c => c.timestamp >= cyc.endTs)) {
      if (!cyc.hitHigh && c.high >= cyc.high)
        cyc.hitHigh = { price: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!cyc.hitLow && c.low <= cyc.low)
        cyc.hitLow  = { price: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (cyc.hitHigh && cyc.hitLow) break;
    }
  }

  return cycles;
}

// Reference 5.625min cycle — same actionable-pick logic as 90M / 22.5M.
// Sweep-sweep semantics: BUY needs BSL hit then SSL hit; SELL needs SSL then BSL.
function getRef5MinCycle(cycles5M, dir) {
  const arr = Object.values(cycles5M).filter(c => c.high != null && c.low != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (!arr.length) return null;
  const completed = [...arr].filter(c => c.complete).reverse();
  if (completed.length) {
    const best = findBestCandleRef(completed, dir);
    if (best) return best;
  }
  return arr.filter(c => c.complete).pop() ?? arr[arr.length - 1];
}

// ── 22.5min Cycle Builder ─────────────────────────────────────────────────────
// 90M / 4 = 22.5min. 64 cycles per trading day. Same structure as build90MinCycles
// but driven by 1m candles (15m candles give insufficient resolution: only ~1.5
// candles per cycle). BSL/SSL = high/low of completed cycles, identical sweep
// detection semantics as 90M/6H.
function build22MinCycles(candles, dayStartTs) {
  const nowTs = Date.now() / 1000;
  const cycles = {};
  const CYCLE_MIN = 22.5;
  const PREV_CYCLES = 3;
  const todayCandles = candles.filter(c => {
    const m = minsIntoDay(c.timestamp, dayStartTs);
    return m >= -(PREV_CYCLES * CYCLE_MIN) && m < 1440;
  });

  for (const c of todayCandles) {
    const m   = minsIntoDay(c.timestamp, dayStartTs);
    const idx = Math.floor(m / CYCLE_MIN);
    if (!cycles[idx]) {
      const startTs = dayStartTs + idx * CYCLE_MIN * 60;
      const endTs   = startTs + CYCLE_MIN * 60;
      cycles[idx] = {
        index: idx, startTs, endTs,
        startTime: tsToETLabel(startTs),
        endTime:   tsToETLabel(endTs),
        complete:  endTs <= nowTs,
        high: -Infinity, highTs: null,
        low:   Infinity, lowTs:  null,
        candleCount: 0,
        hitHigh: null, hitLow: null,
      };
    }
    const cyc = cycles[idx];
    cyc.candleCount++;
    if (c.high > cyc.high) { cyc.high = c.high; cyc.highTs = c.timestamp; }
    if (c.low  < cyc.low)  { cyc.low  = c.low;  cyc.lowTs  = c.timestamp; }
  }

  for (const cyc of Object.values(cycles)) {
    if (cyc.high === -Infinity) cyc.high = null;
    if (cyc.low  ===  Infinity) cyc.low  = null;
    if (cyc.high) cyc.highTime = tsToETLabel(cyc.highTs);
    if (cyc.low)  cyc.lowTime  = tsToETLabel(cyc.lowTs);
  }

  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const cyc of Object.values(cycles)) {
    if (!cyc.complete || !cyc.high) continue;
    for (const c of sorted.filter(c => c.timestamp >= cyc.endTs)) {
      if (!cyc.hitHigh && c.high >= cyc.high)
        cyc.hitHigh = { price: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!cyc.hitLow && c.low <= cyc.low)
        cyc.hitLow  = { price: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (cyc.hitHigh && cyc.hitLow) break;
    }
  }

  return cycles;
}

// ── 6H Cycle Builder ──────────────────────────────────────────────────────────
function build6HCycles(candles, dayStartTs) {
  const nowTs = Date.now() / 1000;
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);

  // Also include previous day's C4 as prevC4
  const prevC4StartTs = dayStartTs - 6 * 3600;
  let prevC4Candles = candles.filter(c => c.timestamp >= prevC4StartTs && c.timestamp < dayStartTs);
  if (!prevC4Candles.length) {
    // Look back up to 4 days (weekends/gaps)
    for (let d = 2; d <= 4; d++) {
      const s = dayStartTs - d * 24 * 3600 - 6 * 3600;
      const e = s + 6 * 3600;
      const found = candles.filter(c => c.timestamp >= s && c.timestamp < e);
      if (found.length) { prevC4Candles = found; break; }
    }
  }

  const cycles = {};

  // Build prevC4
  if (prevC4Candles.length) {
    const high = Math.max(...prevC4Candles.map(c => c.high));
    const low  = Math.min(...prevC4Candles.map(c => c.low));
    const prevC4End = dayStartTs;
    const afterPrevC4 = sorted.filter(c => c.timestamp >= prevC4End);
    let hitHigh = null, hitLow = null;
    for (const c of afterPrevC4) {
      if (!hitHigh && c.high >= high) hitHigh = { price: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!hitLow  && c.low  <= low)  hitLow  = { price: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (hitHigh && hitLow) break;
    }
    cycles["prevC4"] = { name: "prevC4", label: "Prev 12:00–18:00", status: "complete", high, low, hitHigh, hitLow };
  }

  // Build current day cycles
  for (const [name, bounds] of Object.entries(SIX_H_BOUNDS)) {
    const startTs = dayStartTs + bounds.startMin * 60;
    const endTs   = dayStartTs + bounds.endMin   * 60;
    const cc      = candles.filter(c => c.timestamp >= startTs && c.timestamp < endTs);
    if (!cc.length) {
      cycles[name] = { name, label: bounds.label, status: "no_data", high: null, low: null, hitHigh: null, hitLow: null };
      continue;
    }
    const high = Math.max(...cc.map(c => c.high));
    const low  = Math.min(...cc.map(c => c.low));
    const isActive = endTs > nowTs;
    const hitHigh_c = { _found: false, val: null };
    const hitLow_c  = { _found: false, val: null };

    if (!isActive) {
      for (const c of sorted.filter(c => c.timestamp >= endTs)) {
        if (!hitHigh_c._found && c.high >= high) { hitHigh_c.val = { price: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp }; hitHigh_c._found = true; }
        if (!hitLow_c._found  && c.low  <= low)  { hitLow_c.val  = { price: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp }; hitLow_c._found  = true; }
        if (hitHigh_c._found && hitLow_c._found) break;
      }
    }

    cycles[name] = {
      name, label: bounds.label,
      status: isActive ? "active" : "complete",
      high, low,
      hitHigh: hitHigh_c.val,
      hitLow:  hitLow_c.val,
    };
  }

  return cycles;
}

// ── Daily Structure Builder (18:00-session ET) ────────────────────────────────
// Groups 15-min candles by the 18:00 ET trading-day boundary.
// Label is derived from midnight (6h after session start), matching the
// convention used in buildDailyLockMoves (D-candle label = close date).
function buildDailyStructure(candles) {
  const dayMap = new Map();
  for (const c of candles) {
    const etH = tsToETHours(c.timestamp);
    const approxDayStart = etH >= 18
      ? c.timestamp - (etH - 18) * 3600
      : c.timestamp - (etH + 6) * 3600;
    const key = Math.round(approxDayStart / 3600) * 3600;

    if (!dayMap.has(key)) {
      dayMap.set(key, { startTs: key, high: -Infinity, low: Infinity, candles: [] });
    }
    const day = dayMap.get(key);
    day.candles.push(c);
    if (c.high > day.high) day.high = c.high;
    if (c.low  < day.low)  day.low  = c.low;
  }

  const days = [...dayMap.values()]
    .filter(d => d.high !== -Infinity && d.low !== Infinity)
    .sort((a, b) => a.startTs - b.startTs);

  const allSorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  for (const day of days) {
    day.hitHigh = null;
    day.hitLow  = null;
    const endTs = day.startTs + 24 * 3600;
    const after = allSorted.filter(c => c.timestamp >= endTs);
    for (const c of after) {
      if (!day.hitHigh && c.high >= day.high) day.hitHigh = { price: c.high, date: tsToETDate(c.timestamp), time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!day.hitLow  && c.low  <= day.low)  day.hitLow  = { price: c.low,  date: tsToETDate(c.timestamp), time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (day.hitHigh && day.hitLow) break;
    }
    // Label from midnight (6h after 18:00 session start) = same convention as D-candle labels
    day.date    = tsToETDate(day.startTs + 6 * 3600);
    day.isToday = Math.abs(day.startTs - getTradingDayStartTs()) < 7200;
    if (day.high === -Infinity) day.high = null;
    if (day.low  ===  Infinity) day.low  = null;
  }

  return days.slice(-30);   // enough history for the 14-day lock lookback + spike capture
}

// ── Reference Cycle Helpers (mirrors LiveSignals.jsx logic) ──────────────────

// 90min: scan all completed cycles (most recent first), pick the most actionable one.
// A sweep from cycle N can be completed by candles in cycle N+2 or later.
function getRef90MinCycle(cycles90, dir) {
  const arr = Object.values(cycles90).filter(c => c.high != null && c.low != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (!arr.length) return null;
  const completed = [...arr].filter(c => c.complete).reverse(); // most recent first

  // Cross-cycle sweep: when step-1 is hit in cycle N and step-2 is then swept
  // in cycle N+1, allow a synthetic ref that pairs them — mirrors the
  // getRef6HCycle behavior at line ~1332. Without this, 90M only ever sees
  // same-cycle high+low pairs and silently drops legit cross-cycle setups
  // (e.g. BSL hit at 23:15 in cycle 21:00, SSL swept at 01:30 in cycle 00:00).
  if (completed.length >= 2 && dir) {
    const isBuy      = dir === "BUY";
    const mostRecent = completed[0];
    const step1Cycle = completed.find(c =>
      isBuy ? c.hitHigh != null : c.hitLow != null
    );
    if (step1Cycle && step1Cycle !== mostRecent) {
      // Check that step-2 is actually swept in the more recent cycle (otherwise
      // there's no real pattern yet — fall through to findBestCandleRef).
      const step2Hit = isBuy ? mostRecent.hitLow : mostRecent.hitHigh;
      if (step2Hit) {
        return {
          ...mostRecent,
          high:    isBuy ? step1Cycle.high  : mostRecent.high,
          low:     isBuy ? mostRecent.low   : step1Cycle.low,
          hitHigh: isBuy ? step1Cycle.hitHigh : mostRecent.hitHigh,
          hitLow:  isBuy ? mostRecent.hitLow  : step1Cycle.hitLow,
        };
      }
    }
  }

  if (completed.length) {
    const best = findBestCandleRef(completed, dir);
    if (best) return best;
  }
  // Fallback: clock-based previous period
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etMin = etNow.getHours() * 60 + etNow.getMinutes();
  const fromBase = (etMin - 18 * 60 + 1440) % 1440;
  const prevPeriod = Math.floor(fromBase / 90) - 1;
  const prevStartMin = ((18 * 60 + prevPeriod * 90) % 1440 + 1440) % 1440;
  const prevStartStr = `${String(Math.floor(prevStartMin / 60)).padStart(2, "0")}:${String(prevStartMin % 60).padStart(2, "0")}`;
  return arr.find(c => c.startTime === prevStartStr)
    ?? arr.filter(c => c.complete).pop()
    ?? arr[arr.length - 1];
}

// 22.5min: same actionable-pick logic as 90M, scaled to 22.5min cadence.
function getRef22MinCycle(cycles22M, dir) {
  const arr = Object.values(cycles22M).filter(c => c.high != null && c.low != null)
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (!arr.length) return null;
  const completed = [...arr].filter(c => c.complete).reverse();
  if (completed.length) {
    const best = findBestCandleRef(completed, dir);
    if (best) return best;
  }
  return arr.filter(c => c.complete).pop() ?? arr[arr.length - 1];
}

// 6H: scan all completed cycles (most recent first), pick the most actionable one.
function getRef6HCycle(cycles6H, dir) {
  const entries = Object.entries(cycles6H);
  // entries are in insertion order: prevC4, C1, C2, C3, C4 — reverse = most recent first
  const completed = [...entries]
    .filter(([, c]) => c.status === "complete" && c.high != null)
    .reverse()
    .map(([name, c]) => ({ name, ...c }));
  if (!completed.length) return null;
  if (!dir) return completed[0];

  const isBuy     = dir === "BUY";
  const mostRecent = completed[0];

  // Find any cycle where step-1 is already done (SSL for SELL, BSL for BUY)
  const step1Cycle = completed.find(c =>
    isBuy ? c.hitHigh != null : c.hitLow != null
  );

  if (step1Cycle && step1Cycle.name !== mostRecent.name) {
    // Cross-cycle ref: step-1 hit comes from whichever cycle it happened,
    // step-2 target uses the most recent cycle's levels (nearest price).
    return {
      name:    mostRecent.name,
      label:   mostRecent.label ?? mostRecent.name,
      high:    isBuy ? step1Cycle.high  : mostRecent.high,
      low:     isBuy ? mostRecent.low   : step1Cycle.low,
      hitHigh: isBuy ? step1Cycle.hitHigh : mostRecent.hitHigh,
      hitLow:  isBuy ? mostRecent.hitLow  : step1Cycle.hitLow,
    };
  }

  return findBestCandleRef(completed.slice(0, 2), dir) ?? completed[0];
}

// Returns the best ref from a most-recent-first candidates list.
// Priority:
//   1. Most recent where step-1 done but step-2 NOT yet (in-progress — most actionable)
//   2. Most recent where both done in correct order, within first 3 candidates (fresh complete)
//   3. Most recent (watching — waiting for step-1)
function findBestCandleRef(candidates, dir) {
  if (!candidates.length) return null;
  if (!dir) return candidates[0];
  const isBuy = dir === "BUY";
  // In-progress: step-1 done, step-2 not yet
  const inProgress = candidates.find(c => {
    const step1 = isBuy ? c.hitHigh != null : c.hitLow != null;
    const step2 = isBuy ? c.hitLow  != null : c.hitHigh != null;
    return step1 && !step2;
  });
  if (inProgress) return inProgress;
  // Fresh complete setup (both swept in correct order) — only within 3 most recent
  const freshComplete = candidates.slice(0, 3).find(c => {
    if (!c.hitHigh || !c.hitLow) return false;
    return isBuy ? (c.hitHigh.ts ?? 0) < (c.hitLow.ts ?? 0)
                 : (c.hitLow.ts  ?? 0) < (c.hitHigh.ts ?? 0);
  });
  if (freshComplete) return freshComplete;
  // Fallback: most recent (watching for step-1)
  return candidates[0];
}

// Daily: most relevant recent trading day for the given direction.
// Looks back up to 14 days — sweep pattern can span non-consecutive days.
function getRefDailyDay(dailyDays, allowedDirection) {
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const todayStr = etNow.toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });
  const candidates = [...dailyDays].reverse()
    .filter(d => d.date !== todayStr && d.high != null)
    .slice(0, 14); // 14-day lookback
  if (!candidates.length) return null;
  return findBestCandleRef(candidates, allowedDirection) ?? candidates[0];
}

// ── Card Signal Detector ──────────────────────────────────────────────────────
// Fires events for the REFERENCE cycle only (same cycle the UI cards show).
// Returns { events, newState } — only fires when allowedDirection is set.
function detectCardSignals(cycles90, cycles6H, dailyDays, allowedDirection, prevState, adminBias = "AUTO") {
  const events  = [];
  const newState = JSON.parse(JSON.stringify(prevState));

  // Primary signal sources: 90M and 6H only. 22.5M and 5.625M are scalps (via
  // processScalp); Daily is removed (only 6H/90M as primary setup candidates).
  const refs = {
    "90min": getRef90MinCycle(cycles90, allowedDirection),
    "6H":    getRef6HCycle(cycles6H, allowedDirection),
  };

  // Sweeps older than 30 min are pre-marked as alerted when we switch to a new ref.
  // This prevents re-firing Discord alerts for historical sweeps found via the extended lookback.
  // EXCEPTION: when admin manually sets bias to BULLISH/BEARISH, treat all
  // sweeps in the current ref as fresh — the admin signaled intent right now,
  // so historical sweeps that would otherwise be skipped should still create
  // setups. prevState still prevents double-firing across ticks.
  const isManualBias = adminBias === "BULLISH" || adminBias === "BEARISH";
  const RECENT_TS = isManualBias ? -Infinity : (Date.now() / 1000 - 30 * 60);

  for (const [tf, ref] of Object.entries(refs)) {
    if (!ref || !allowedDirection) continue;

    const cycleKey   = (tf === "90min" || tf === "22.5min") ? ref.startTime
                     : tf === "6H" ? ref.name
                     : ref.date;
    const cycleLabel = (tf === "90min" || tf === "22.5min") ? `${ref.startTime}–${ref.endTime ?? "now"}`
                     : tf === "6H"   ? (ref.label ?? ref.name)
                     :                 ref.date;

    // Reset state when reference cycle changes — suppress alerts for already-old sweeps
    // (RECENT_TS = -Infinity when manual bias, so all hits stay un-sent).
    if (!newState[tf] || newState[tf].cycleKey !== cycleKey) {
      newState[tf] = {
        cycleKey,
        highSent: ref.hitHigh ? ref.hitHigh.ts < RECENT_TS : false,
        lowSent:  ref.hitLow  ? ref.hitLow.ts  < RECENT_TS : false,
      };
    }
    const st    = newState[tf];
    const isBuy = allowedDirection === "BUY";

    // For BUY: HIGH = step 1, LOW = step 2. For SELL: LOW = step 1, HIGH = step 2.
    if (ref.hitHigh && !st.highSent) {
      events.push({ tf, step: isBuy ? 1 : 2, side: "HIGH", ref, cycleKey, cycleLabel, direction: allowedDirection });
      newState[tf].highSent = true;
    }
    if (ref.hitLow && !st.lowSent) {
      events.push({ tf, step: isBuy ? 2 : 1, side: "LOW", ref, cycleKey, cycleLabel, direction: allowedDirection });
      newState[tf].lowSent = true;
    }
  }

  return { events, newState };
}

// SL calculation is centralized in lib-sl.mjs. Legacy shim kept for the few
// old call sites that pass only (direction, candles, entry, sweepPrice).
function calcSL(direction, candles, entryPrice, sweepPrice) {
  return computeSweepSL({ direction, candles, step2Ts: null, entryTs: null, entryPrice, sweepPrice });
}

// ── TP Calculator (1:2 and 1:3 RR) ───────────────────────────────────────────
function calcTP(direction, entry, sl) {
  const risk = Math.abs(entry - sl);
  if (direction === "BUY") {
    return {
      tp1: +(entry + 2 * risk).toFixed(entry > 100 ? 1 : 5),
      tp2: +(entry + 3 * risk).toFixed(entry > 100 ? 1 : 5),
    };
  } else {
    return {
      tp1: +(entry - 2 * risk).toFixed(entry > 100 ? 1 : 5),
      tp2: +(entry - 3 * risk).toFixed(entry > 100 ? 1 : 5),
    };
  }
}

// ── Setup State (per-TF file slots) ──────────────────────────────────────────
// One file per (market × tf). Lets a market run a 6H + 90M + daily setup in
// parallel with independent lifecycle. Backward compat: if no per-TF file
// exists, fall back to legacy `setup_<MK>.json` (one shot — saveSetup migrates).
//
// MongoDB `active_setups` uses composite _id `${market}_${tf}` so per-TF docs
// don't overwrite each other. Legacy `_id: marketKey` docs still loadable.
const PRIMARY_TFS = ["6H", "90min", "daily"];

function setupFilePath(marketKey, tf = null) {
  if (tf) return join(__dir, `setup_${marketKey}_${tf}.json`);
  return join(__dir, `setup_${marketKey}.json`); // legacy
}

function setupMongoId(marketKey, tf = null) {
  return tf ? `${marketKey}_${tf}` : marketKey;
}

async function loadSetup(marketKey, tf = null) {
  const db = await getDB();
  // With tf: load per-TF, with legacy fallback if its content has matching tf.
  if (tf) {
    if (db) {
      try {
        const doc = await db.collection("active_setups").findOne({ _id: setupMongoId(marketKey, tf) });
        if (doc) { const { _id, ...setup } = doc; return setup; }
        // Per-TF doc absent — try legacy doc (might hold a setup of THIS tf).
        const legacyDoc = await db.collection("active_setups").findOne({ _id: marketKey });
        if (legacyDoc && legacyDoc.tf === tf) {
          const { _id, ...setup } = legacyDoc;
          return setup;
        }
      } catch (e) { console.warn(`[MongoDB] loadSetup: ${e.message}`); }
    }
    // File fallback: per-TF file, then legacy if its tf matches.
    const perTf = readJSON(setupFilePath(marketKey, tf), null);
    if (perTf) return perTf;
    const legacy = readJSON(setupFilePath(marketKey), null);
    if (legacy && legacy.tf === tf) return legacy;
    return null;
  }
  // No tf passed (legacy callers like processScalp) — return legacy single setup.
  if (db) {
    try {
      const doc = await db.collection("active_setups").findOne({ _id: marketKey });
      if (doc) { const { _id, ...setup } = doc; return setup; }
    } catch (e) { console.warn(`[MongoDB] loadSetup: ${e.message}`); }
  }
  return readJSON(setupFilePath(marketKey), null);
}

// Returns a map { "6H": setup|null, "90min": setup|null, "daily": setup|null }
async function loadAllSetups(marketKey) {
  const out = {};
  for (const tf of PRIMARY_TFS) out[tf] = await loadSetup(marketKey, tf);
  return out;
}

async function saveSetup(marketKey, setup) {
  const tf = setup?.tf;
  writeJSON(setupFilePath(marketKey, tf), setup);
  // Migration: if legacy file holds the same setup id, delete it so we don't
  // double-track. clearSetup() handles legacy as a fallback.
  try {
    const legacy = readJSON(setupFilePath(marketKey), null);
    if (legacy && legacy.id === setup.id && tf) {
      try { unlinkSync(setupFilePath(marketKey)); } catch {}
    }
  } catch {}
  const db = await getDB();
  if (db) {
    try {
      await db.collection("active_setups").replaceOne(
        { _id: setupMongoId(marketKey, tf) },
        { _id: setupMongoId(marketKey, tf), ...setup },
        { upsert: true }
      );
      // Clean legacy Mongo doc if it held this same setup id
      if (tf) {
        const legacyDoc = await db.collection("active_setups").findOne({ _id: marketKey });
        if (legacyDoc && legacyDoc.id === setup.id) {
          await db.collection("active_setups").deleteOne({ _id: marketKey });
        }
      }
    } catch (e) { console.warn(`[MongoDB] saveSetup: ${e.message}`); }
  }
}

// ── Scalp persistence (one slot per (market × cycle-tf)) ─────────────────────
// Scalps are sub-cycle sweep-sweep entries (22.5M + 5.625M) that piggyback on
// an ACTIVE primary setup. Each cycle-tf has its own file slot so 22.5M and
// 5.625M scalps can be open simultaneously per market.
function scalpFilePath(marketKey, tf) {
  return join(__dir, `scalp_${tf}_${marketKey}.json`);
}
async function loadScalp(marketKey, tf) {
  return readJSON(scalpFilePath(marketKey, tf), null);
}
async function saveScalp(marketKey, tf, scalp) {
  writeJSON(scalpFilePath(marketKey, tf), scalp);
}
async function clearScalp(marketKey, tf) {
  try { unlinkSync(scalpFilePath(marketKey, tf)); } catch {}
}

async function clearSetup(marketKey, setup = null, reason = null) {
  // Per-TF aware: when setup has tf, delete that TF's file + Mongo doc.
  // Legacy callers (no setup arg) still wipe the legacy file/doc.
  const tf = setup?.tf ?? null;
  try { unlinkSync(setupFilePath(marketKey, tf)); } catch {}
  if (!tf) {
    // Legacy: also try the no-tf path explicitly (already done above).
  }
  const db = await getDB();
  if (db) {
    try { await db.collection("active_setups").deleteOne({ _id: setupMongoId(marketKey, tf) }); }
    catch (e) { console.warn(`[MongoDB] clearSetup: ${e.message}`); }
  }
  // Mark the corresponding setup_log entry CANCELLED so the dashboard stops
  // showing it as in-progress. Only touch entries still WAITING_PHASE2/ACTIVE
  // — never overwrite a settled CLOSED_SL/CLOSED_TP2 outcome.
  if (setup?.id) {
    const log = readJSON(SETUP_LOG_FILE, []);
    const item = log.find(e => e.id === setup.id);
    if (item && (item.status === "WAITING_PHASE2" || item.status === "ACTIVE")) {
      patchSetupLog(setup.id, {
        status:        "CANCELLED",
        outcome:       null,
        cancelledTime: tsToETDateTime(Date.now() / 1000),
        cancelReason:  reason || "cleared",
      });
    }
  }
}

// ── Scalp lifecycle (generic over cycle-tf) ──────────────────────────────────
// processScalp runs every tick per (market × cycle-tf). Two responsibilities:
//   1) Settle existing scalp (TP1/TP2/SL/parent-cancelled) vs 1m candles.
//   2) Detect new scalp pending when slot free + parent ACTIVE + lock-bias-
//      direction sweep-sweep on this cycle-tf.
// Called once for cycleTf="22.5min" and once for cycleTf="5.625min".
async function processScalp({ marketKey, activeSetup, activeScalp, cycles, cycleTf, cycleSource, candles1m, allowedDirection, onUpdate }) {
  if (!candles1m?.length) return;
  const sortedC = [...candles1m].sort((a, b) => a.timestamp - b.timestamp);
  const dayStartTs = getTradingDayStartTs();

  // 0. PENDING_ENTRY → ACTIVE: scalp waits for the +1h scalp entry window 1m
  //    candle to open, then enters at that candle's open. SL via computeSweepSL
  //    (lowest low / highest high in step2Ts→entryTs window) for accurate stop.
  if (activeScalp && activeScalp.status === "PENDING_ENTRY") {
    const entryCandle = sortedC.find(c => c.timestamp === activeScalp.scalpEntryWindowTs);
    if (entryCandle) {
      const dec = entryCandle.open > 100 ? 1 : 5;
      const entry = +entryCandle.open.toFixed(dec);
      const sl = computeSweepSL({
        direction:  activeScalp.direction,
        candles:    sortedC, // 1m candles for tight scalp SL
        step2Ts:    activeScalp.step2Ts,
        entryTs:    entryCandle.timestamp,
        entryPrice: entry,
        sweepPrice: activeScalp.sweepPrice,
      });
      const isBuy = activeScalp.direction === "BUY";
      const risk = Math.abs(entry - sl);
      if (risk > 0) {
        const tp1 = +(isBuy ? entry + 5 * risk : entry - 5 * risk).toFixed(dec);
        const tp2 = +(isBuy ? entry + 8 * risk : entry - 8 * risk).toFixed(dec);
        activeScalp = {
          ...activeScalp,
          status: "ACTIVE",
          entry, sl, tp1, tp2,
          risk: +risk.toFixed(dec),
          entryTime: tsToETLabel(entryCandle.timestamp),
          entryTs:   entryCandle.timestamp * 1000,
          tp1Hit: false, tp2Hit: false,
          livePnl: 0, liveRMulti: 0,
        };
        await saveScalp(marketKey, cycleTf, activeScalp);
        patchSetupLog(activeScalp.id, {
          status: "ACTIVE", entry, sl, tp1, tp2,
          entryTime: activeScalp.entryTime, entryTs: activeScalp.entryTs,
        });
        await sendDiscordScalpActivated(marketKey, activeScalp);
        logEvent(marketKey, "SCALP_ACTIVATED",
          `${activeScalp.direction} entry ${entry} SL ${sl} TP1 ${tp1} (5R) TP2 ${tp2} (8R) @ scalp window ${activeScalp.scalpEntryWindow}`,
          "scalp_active");
        // CopyFactory: replicate scalp to subscribers (paper-mode in staging
        // because COPY_LIVE=false; logged-only). Live env flips it on.
        try { await cfNotifySignal(activeScalp, marketKey); }
        catch (e) { console.warn(`[CF] scalp notify failed: ${e.message}`); }
        onUpdate(activeScalp);
      } else {
        activeScalp = { ...activeScalp, status: "CANCELLED", cancelReason: "zero_risk" };
        await saveScalp(marketKey, cycleTf, activeScalp);
        patchSetupLog(activeScalp.id, { status: "CANCELLED", cancelReason: "zero_risk" });
        onUpdate(activeScalp);
      }
    } else if (Date.now() / 1000 > activeScalp.scalpEntryWindowTs + 90) {
      // 1.5 min after window — cancel; we missed the entry candle
      activeScalp = { ...activeScalp, status: "CANCELLED", cancelReason: "window_missed",
        cancelTime: tsToETLabel(Date.now() / 1000) };
      await saveScalp(marketKey, cycleTf, activeScalp);
      patchSetupLog(activeScalp.id, { status: "CANCELLED", cancelReason: "window_missed" });
      logEvent(marketKey, "SCALP_CANCELLED",
        `Scalp window ${activeScalp.scalpEntryWindow} ET passed without 1m candle`, "scalp_cancelled");
      onUpdate(activeScalp);
    }
  }

  // PENDING parent-close cancel — don't keep waiting if primary is gone
  if (activeScalp && activeScalp.status === "PENDING_ENTRY" && activeSetup?.status !== "ACTIVE") {
    activeScalp = { ...activeScalp, status: "CANCELLED", cancelReason: "parent_closed",
      cancelTime: tsToETLabel(Date.now() / 1000) };
    await saveScalp(marketKey, cycleTf, activeScalp);
    patchSetupLog(activeScalp.id, { status: "CANCELLED", cancelReason: "parent_closed" });
    logEvent(marketKey, "SCALP_CANCELLED", `Parent ${activeScalp.parentSource} closed before scalp window`, "scalp_cancelled");
    onUpdate(activeScalp);
  }

  // 1. Settle existing ACTIVE scalp
  if (activeScalp && activeScalp.status === "ACTIVE") {
    const oc = verifyScalpOutcome({ scalp: activeScalp, candles: sortedC });
    if (oc.outcome === "WIN_TP2") {
      activeScalp = { ...activeScalp, status: "CLOSED_TP2", tp1Hit: true, tp2Hit: true,
        exitTime: oc.hitTs ? tsToETLabel(oc.hitTs) : null, exitPrice: oc.hitPrice,
        outcome: "WIN", rMulti: 8 };
      await saveScalp(marketKey, cycleTf, activeScalp);
      patchSetupLog(activeScalp.id, { status: "CLOSED_TP2", outcome: "WIN", rMulti: 8 });
      await sendDiscordScalpEvent(marketKey, activeScalp, "TP2");
      logEvent(marketKey, "SCALP_TP2", `${activeScalp.direction} TP2 (8R) @ ${oc.hitPrice}`, "scalp_closed");
      onUpdate(activeScalp);
    } else if (oc.outcome === "WIN_TP1_THEN_SL") {
      activeScalp = { ...activeScalp, status: "CLOSED_TP1", tp1Hit: true, tp2Hit: false,
        exitTime: oc.hitTs ? tsToETLabel(oc.hitTs) : null, exitPrice: oc.hitPrice,
        outcome: "WIN", rMulti: 5 };
      await saveScalp(marketKey, cycleTf, activeScalp);
      patchSetupLog(activeScalp.id, { status: "CLOSED_TP1", outcome: "WIN", rMulti: 5 });
      await sendDiscordScalpEvent(marketKey, activeScalp, "TP1");
      logEvent(marketKey, "SCALP_TP1", `${activeScalp.direction} TP1 (5R) → SL @ ${oc.hitPrice}`, "scalp_closed");
      onUpdate(activeScalp);
    } else if (oc.outcome === "LOSS") {
      activeScalp = { ...activeScalp, status: "CLOSED_SL", exitTime: oc.hitTs ? tsToETLabel(oc.hitTs) : null,
        exitPrice: oc.hitPrice, outcome: "LOSS", rMulti: -1 };
      await saveScalp(marketKey, cycleTf, activeScalp);
      patchSetupLog(activeScalp.id, { status: "CLOSED_SL", outcome: "LOSS", rMulti: -1 });
      await sendDiscordScalpEvent(marketKey, activeScalp, "SL");
      logEvent(marketKey, "SCALP_SL", `${activeScalp.direction} SL @ ${oc.hitPrice}`, "scalp_closed");
      onUpdate(activeScalp);
    } else {
      // Still open — refresh live progress for dashboard
      const last = sortedC[sortedC.length - 1];
      if (last) {
        const isBuy = activeScalp.direction === "BUY";
        const pnl = isBuy ? last.close - activeScalp.entry : activeScalp.entry - last.close;
        const rMulti = activeScalp.risk ? +(pnl / activeScalp.risk).toFixed(2) : 0;
        const dec = activeScalp.entry > 100 ? 1 : 5;
        activeScalp = { ...activeScalp, livePnl: +pnl.toFixed(dec), liveRMulti: rMulti, lastTickTs: Date.now() };
        await saveScalp(marketKey, cycleTf, activeScalp);
        onUpdate(activeScalp);
      }
    }
    // Parent closed while scalp still open → cancel (don't run scalps without parent)
    if (activeScalp.status === "ACTIVE" && activeSetup?.status !== "ACTIVE") {
      activeScalp = { ...activeScalp, status: "CANCELLED", cancelReason: "parent_closed",
        cancelTime: tsToETLabel(Date.now() / 1000) };
      await saveScalp(marketKey, cycleTf, activeScalp);
      patchSetupLog(activeScalp.id, { status: "CANCELLED", cancelReason: "parent_closed" });
      logEvent(marketKey, "SCALP_CANCELLED", `Parent ${activeScalp.parentSource} closed`, "scalp_cancelled");
      onUpdate(activeScalp);
    }
  }

  // 2. Create a new PENDING_ENTRY scalp. Same trigger criteria as the other cards:
  //    sweep-sweep pattern (BUY: BSL→SSL, SELL: SSL→BSL) on the 5.625M cycle,
  //    direction from lock bias (allowedDirection). Scalp gate: parent must be
  //    ACTIVE in the SAME direction so we never scalp against the primary trade.
  const slotFree = !activeScalp || activeScalp.status?.startsWith("CLOSED_") || activeScalp.status === "CANCELLED";
  if (!slotFree) return;
  if (!allowedDirection) return; // No lock bias → no scalp
  if (!activeSetup || activeSetup.status !== "ACTIVE" || activeSetup.direction !== allowedDirection) return;

  const ref = getRef5MinCycle(cycles, allowedDirection); // generic — works on any cycle obj
  if (!ref) return;

  // Sweep-sweep validation. BUY: step1 = BSL hit, step2 = SSL hit. SELL inverse.
  // Both must be present AND step1Ts < step2Ts (correct order).
  const isBuy = allowedDirection === "BUY";
  const step1Hit = isBuy ? ref.hitHigh : ref.hitLow;
  const step2Hit = isBuy ? ref.hitLow  : ref.hitHigh;
  if (!step1Hit || !step2Hit) return;
  if (!step1Hit.ts || !step2Hit.ts || step1Hit.ts >= step2Hit.ts) return;

  // Anti-dup: don't re-fire on same parent+cycle
  const cycleKey = `${activeSetup.id}::${ref.startTime}`;
  if (activeScalp && activeScalp.cycleKey === cycleKey) return;
  // Recency: ignore stale step-2 sweeps (>30 min old)
  if (Date.now() / 1000 - step2Hit.ts > 30 * 60) return;

  // Find the next scalp entry window (+1h offset from primary windows)
  const scalpWin = getNextScalpEntryWindow(dayStartTs);
  if (!scalpWin) return;

  const scalp = {
    id: `${marketKey}-${cycleSource}-SCALP-${Date.now()}`,
    market: marketKey,
    type: "scalp",
    parentSetupId: activeSetup.id,
    parentSource:  activeSetup.source,
    direction:     allowedDirection,
    tf: cycleTf,
    source: cycleSource,
    cycleKey,
    cycleLabel: `${ref.startTime}–${ref.endTime ?? "now"}`,
    bslLevel:   ref.high,
    sslLevel:   ref.low,
    step1Time:  step1Hit.time,
    step1Ts:    step1Hit.ts,
    step2Time:  step2Hit.time,
    step2Ts:    step2Hit.ts,
    sweepPrice: step2Hit.price, // step-2 sweep depth (used by computeSweepSL)
    sweepTime:  step2Hit.time,
    scalpEntryWindow:   scalpWin.label,    // "03:45" / "09:45" / "15:45" / "21:45"
    scalpEntryWindowTs: scalpWin.entryTs,
    // entry/sl/tp1/tp2 filled when window's 1m candle arrives (step 0 above)
    entry: null, sl: null, tp1: null, tp2: null,
    rrTp1: 5, rrTp2: 8,
    status: "PENDING_ENTRY",
    createdTime: tsToETLabel(Date.now() / 1000),
    createdTs: Date.now(),
  };
  await saveScalp(marketKey, cycleTf, scalp);

  const log = readJSON(SETUP_LOG_FILE, []);
  log.unshift({
    ...scalp,
    side:     isBuy ? "LOW" : "HIGH",
    datetime: tsToETDateTime(Date.now() / 1000),
    ts:       Date.now(),
  });
  writeJSON(SETUP_LOG_FILE, log.slice(0, 10000));

  await sendDiscordScalpReady(marketKey, scalp);
  logEvent(marketKey, "SCALP_PENDING",
    `${scalp.direction} | parent ${activeSetup.source} | step1 ${step1Hit.time} → step2 ${step2Hit.time} | scalp entry ${scalpWin.label} ET (+1h)`,
    "scalp_pending");
  onUpdate(scalp);
}

function verifyScalpOutcome({ scalp, candles }) {
  const { direction, entryTs, sl, tp1, tp2 } = scalp;
  const isBuy = direction === "BUY";
  const post = candles.filter(c => c.timestamp > (entryTs / 1000));
  let tp1Hit = false;
  for (const c of post) {
    const slBroken  = isBuy ? c.low  <= sl  : c.high >= sl;
    const tp2Broken = isBuy ? c.high >= tp2 : c.low  <= tp2;
    const tp1Broken = isBuy ? c.high >= tp1 : c.low  <= tp1;
    if (tp2Broken && (!slBroken || tp1Hit))
      return { outcome: "WIN_TP2", hitTs: c.timestamp, hitPrice: tp2 };
    if (tp1Broken) tp1Hit = true;
    if (slBroken) {
      if (tp1Hit) return { outcome: "WIN_TP1_THEN_SL", hitTs: c.timestamp, hitPrice: sl };
      return { outcome: "LOSS", hitTs: c.timestamp, hitPrice: sl };
    }
  }
  return { outcome: null };
}

async function sendDiscordScalpReady(market, scalp) {
  if (!DISCORD_WEBHOOK) return;
  const dec = scalp.sweepPrice > 100 ? 1 : 5;
  const msg = `⏳ **${market}** · SCALP READY — ${scalp.direction} (1:${scalp.rrTp1}/${scalp.rrTp2} R:R)\n` +
              `Parent ${scalp.parentSource} ACTIVE · Sweep @ ${scalp.sweepTime} (${scalp.sweepPrice.toFixed(dec)}) · Wachten op entry window **${scalp.scalpEntryWindow}** ET (+1h)`;
  await _sendNotify(msg);
  console.log(`[DISCORD] Scalp READY: ${market} ${scalp.direction} → ${scalp.scalpEntryWindow}`);
}

async function sendDiscordScalpActivated(market, scalp) {
  if (!DISCORD_WEBHOOK) return;
  const dec = scalp.entry > 100 ? 1 : 5;
  const msg = `⚡ **${market}** · SCALP TRIGGERED — ${scalp.direction} (1:${scalp.rrTp1}/${scalp.rrTp2} R:R)\n` +
              `Entry ${scalp.entry.toFixed(dec)} (open @ ${scalp.scalpEntryWindow}) · SL ${scalp.sl.toFixed(dec)} · TP1 ${scalp.tp1.toFixed(dec)} (5R) · TP2 ${scalp.tp2.toFixed(dec)} (8R)`;
  await _sendNotify(msg);
  console.log(`[DISCORD] Scalp ACTIVATED: ${market} ${scalp.direction}`);
}

async function sendDiscordScalpEvent(market, scalp, eventType) {
  if (!DISCORD_WEBHOOK) return;
  const dec = scalp.entry > 100 ? 1 : 5;
  const labels = {
    TP2: `🏆 SCALP TP2 hit — 8R win`,
    TP1: `✅ SCALP TP1 hit (5R) → stopped at SL`,
    SL:  `🛑 SCALP SL hit — full loss`,
  };
  const exit = scalp.exitPrice != null ? scalp.exitPrice.toFixed(dec) : "?";
  await _sendNotify(`**${market}** ${labels[eventType]}: ${scalp.direction} entry ${scalp.entry.toFixed(dec)} → ${exit}`);
  console.log(`[DISCORD] Scalp ${eventType}: ${market}`);
}

// Verify the stored setup status against actual candle data.
// Catches cases where the JSON state drifted from reality (e.g. CLOSED_SL when SL
// was never actually hit, or ACTIVE when SL clearly printed in the candles).
function verifySetupAgainstCandles(setup, candles, marketKey) {
  if (!setup || !setup.entryTs || setup.sl == null) return setup;
  const entryTs  = setup.entryTs / 1000;
  const postEntry = candles.filter(c => c.timestamp >= entryTs);
  if (!postEntry.length) return setup;

  const isBuy = setup.direction === "BUY";
  const slPrinted = isBuy
    ? postEntry.some(c => c.low  <= setup.sl)
    : postEntry.some(c => c.high >= setup.sl);

  if (setup.status === "ACTIVE" && slPrinted && !setup.slHit) {
    console.log(`[${marketKey}] VERIFY: SL in candles but setup says ACTIVE — correcting → CLOSED_SL`);
    return { ...setup, slHit: true, status: "CLOSED_SL" };
  }
  if (setup.status === "CLOSED_SL" && !slPrinted) {
    console.log(`[${marketKey}] VERIFY: SL NOT in candles but setup says CLOSED_SL — correcting → ACTIVE`);
    return { ...setup, slHit: false, status: "ACTIVE" };
  }
  return setup;
}

// Card signal state (which reference-cycle sweeps have been notified)
function cardStateFile(marketKey)   { return join(__dir, `card_state_${marketKey}.json`); }
function loadCardState(marketKey)   { return readJSON(cardStateFile(marketKey), {}); }
function saveCardState(marketKey, state) { writeJSON(cardStateFile(marketKey), state); }

// ── Weekly Recap ──────────────────────────────────────────────────────────────
const WEEKLY_RECAP_FILE = join(__dir, "weekly_recap.json");

function getWeekKey() {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now);
  const g = t => etParts.find(p => p.type === t)?.value;
  // Get Monday of current week
  const wd = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[g("weekday")] ?? 0;
  const monday = new Date(now);
  monday.setDate(now.getDate() - wd);
  return monday.toISOString().split("T")[0];
}

function getDayKey() {
  const nowTs = getTradingDayStartTs();
  return tsToETDate(nowTs + 6 * 3600); // label from midday of the trading day
}

function updateWeeklyRecap(marketKey, event) {
  const recap = readJSON(WEEKLY_RECAP_FILE, {});
  const weekKey = getWeekKey();
  const dayKey  = getDayKey();

  if (!recap[weekKey]) recap[weekKey] = {};
  if (!recap[weekKey][marketKey]) recap[weekKey][marketKey] = {};
  if (!recap[weekKey][marketKey][dayKey]) {
    recap[weekKey][marketKey][dayKey] = {
      date: dayKey,
      sweeps: [],
      setups: [],
      trades: { wins: 0, losses: 0, open: 0 },
      bias: readAdminBias(marketKey),
      lockState: null,
    };
  }

  const day = recap[weekKey][marketKey][dayKey];

  if (event.type === "sweep")       day.sweeps.push({ source: event.source, side: event.side, level: event.level, time: event.time });
  if (event.type === "setup")       day.setups.push({ direction: event.direction, source: event.source, entry: event.entry, time: event.time });
  if (event.type === "trade_win")   { day.trades.wins++;   if (day.trades.open > 0) day.trades.open--; }
  if (event.type === "trade_loss")  { day.trades.losses++; if (day.trades.open > 0) day.trades.open--; }
  if (event.type === "trade_open")  day.trades.open++;
  if (event.type === "lock_update") day.lockState = event.lockState;

  writeJSON(WEEKLY_RECAP_FILE, recap);
}

// ── Discord ───────────────────────────────────────────────────────────────────

const DASHBOARD_URL = process.env.DASHBOARD_URL || env.DASHBOARD_URL || "https://app.tradingvisualizer.com/dashboard";

function _fp(p) {
  if (p == null) return "—";
  if (p > 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return p.toFixed(5);
}

// ── Discord message translations (EN + NL) ─────────────────────────────────
// Functions take {market, tf} or {marketKey, event} and return localized string.
// User's language preference (User.language) selects which version they get.
const I18N_DISCORD = {
  step1: {
    en: ({ market, tf }) => `🔵 **${market}** · ${tf} — step 1 complete, waiting for step 2`,
    nl: ({ market, tf }) => `🔵 **${market}** · ${tf} — stap 1 compleet, wacht op stap 2`,
  },
  setup_new: {
    en: ({ market, tf }) => `🟢 **${market}** · ${tf} — new setup ✓ — open dashboard for details`,
    nl: ({ market, tf }) => `🟢 **${market}** · ${tf} — nieuwe setup ✓ — open dashboard voor details`,
  },
  entry_filled: {
    en: ({ marketKey }) => `🟡 **${marketKey}** — entry filled`,
    nl: ({ marketKey }) => `🟡 **${marketKey}** — entry gevuld`,
  },
  sl_hit: {
    en: ({ marketKey }) => `🔴 **${marketKey}** — SL hit`,
    nl: ({ marketKey }) => `🔴 **${marketKey}** — SL geraakt`,
  },
  tp1_hit: {
    en: ({ marketKey }) => `🎯 **${marketKey}** — TP1 hit`,
    nl: ({ marketKey }) => `🎯 **${marketKey}** — TP1 geraakt`,
  },
  tp2_hit: {
    en: ({ marketKey }) => `🏆 **${marketKey}** — TP2 hit`,
    nl: ({ marketKey }) => `🏆 **${marketKey}** — TP2 geraakt`,
  },
  tp3_hit: {
    en: ({ marketKey }) => `🚀 **${marketKey}** — TP3 hit`,
    nl: ({ marketKey }) => `🚀 **${marketKey}** — TP3 geraakt 🚀`,
  },
  runner_be: {
    en: ({ marketKey }) => `🛡️ **${marketKey}** — runner SL moved to break-even`,
    nl: ({ marketKey }) => `🛡️ **${marketKey}** — runner SL naar break-even`,
  },
  // Sales / FOMO message for exhausted free users (TP2/TP3 wins only)
  win_sales: {
    en: ({ marketKey, event }) =>
      `🔥 **${marketKey} just hit ${event === "TP3_HIT" ? "TP3 (10R runner!)" : "TP2 (+2R win)"}**\n` +
      `Auto-Trade users captured this automatically. You missed it.\n` +
      `🤖 Upgrade to never miss another one again.`,
    nl: ({ marketKey, event }) =>
      `🔥 **${marketKey} heeft net ${event === "TP3_HIT" ? "TP3 gehit (10R runner!)" : "TP2 gehit (+2R winst)"}**\n` +
      `Auto-Trade gebruikers hebben deze automatisch gepakt. Jij niet.\n` +
      `🤖 Upgrade om dit nooit meer te missen.`,
  },
};

function _trDiscord(key, lang, vars) {
  const fn = I18N_DISCORD[key]?.[lang] || I18N_DISCORD[key]?.en;
  return fn ? fn(vars) : key;
}

// ── ISO-week start (UTC, monday) — mirrors api/server.js logic ──────────────
function _isoWeekStartUtcMs() {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
}

// Has a free user already had their "1 winning trade" for the current week?
// Returns true if any TP2-hit (or WIN-outcome) is logged in setup_log between
// the user's effective window-start (max of weekStart and createdAt) and the
// reference timestamp `asOfMs` (exclusive — so the CURRENT event doesn't
// count as exhaustion of itself).
function _freeUserExhaustedAt(setupLog, userCreatedMs, weekStartMs, asOfMs) {
  const since = Math.max(weekStartMs, userCreatedMs || 0);
  return setupLog.some(e => {
    const t = e.tp2HitTs || (e.outcome === "WIN" ? (e.ts ?? 0) : 0);
    return t >= since && t < asOfMs;
  });
}

// ── Per-user Discord broadcast — tier+window-aware audience ─────────────────
// Three audiences are computed:
//
//   PAID/ADMIN:          always get the standard message.
//   FREE in-window:      week not yet exhausted (no TP2 since their week-start)
//                        → also get standard live messages (their "trial week")
//   FREE exhausted:      already had a TP2 this week
//                        → for "wins" audience: get sales-framed FOMO message
//                          for "paid" audience: get nothing (no live signals)
//
// For TP2/TP3 events, pass `eventTs` so the exhaustion check uses the moment
// JUST BEFORE the event. This way the very TP2 that EXHAUSTS the user is still
// delivered to them as a normal "you won!" message — and only subsequent wins
// switch to sales-only.
// _sendNotify({ key, vars, audience, salesKey, salesVars, url, eventTs })
//   key:       i18n key for the standard message (e.g. "tp2_hit")
//   vars:      object passed to the i18n function (e.g. { marketKey })
//   audience:  "paid" | "wins"
//   salesKey:  i18n key for the sales-framed message to exhausted free users
//              (only used when audience === "wins")
//   salesVars: vars for sales message
//   url:       link appended to standard message (defaults to DASHBOARD_URL)
//   eventTs:   exhaustion check uses this timestamp (default: now)
//
// The recipient's language preference (User.language) determines which
// localized message they receive. Falls back to EN if missing.
async function _sendNotify(opts = {}) {
  // Backward-compat: legacy callers pass a string ("title") as first arg.
  // We send that as-is (no translation, paid+admin only, no exhaustion logic).
  if (typeof opts === "string") {
    const content = `${opts}\n→ ${DASHBOARD_URL}`;
    const sends = [];
    if (DISCORD_WEBHOOK) {
      sends.push(fetch(DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }).catch(() => {}));
    }
    try {
      const db = await getDB();
      if (db) {
        const subs = await db.collection("users").find({
          discordWebhookUrl:     { $exists: true, $ne: null, $ne: "" },
          discordWebhookEnabled: { $ne: false },
          $or: [
            { isAdmin: true },
            { subscriptionTier: { $in: ["signal", "auto-trade"] },
              subscriptionStatus: { $in: ["active", "trialing"] },
              tradingLocked: { $ne: true } },
          ],
        }).project({ discordWebhookUrl: 1 }).toArray();
        for (const s of subs) {
          sends.push(fetch(s.discordWebhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          }).catch(() => {}));
        }
      }
    } catch {}
    await Promise.allSettled(sends);
    return;
  }

  const { key, vars = {}, audience = "paid", salesKey, salesVars, url = DASHBOARD_URL, eventTs = Date.now() } = opts;
  const upgradeUrl = url.replace("/dashboard", "/billing");
  const sends = [];

  // 1. Global webhook — admin's master channel always gets EN by default
  if (DISCORD_WEBHOOK) {
    sends.push(fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `${_trDiscord(key, "en", vars)}\n→ ${url}` }),
    }).catch(e => console.error(`[DISCORD global] Failed: ${e.message}`)));
  }

  // 2. Per-user webhooks (per-user language)
  try {
    const db = await getDB();
    if (!db) { await Promise.allSettled(sends); return; }

    const setupLog = readJSON(SETUP_LOG_FILE, []);
    const weekStartMs = _isoWeekStartUtcMs();

    // Paid + admin users — always get the standard live message in their language
    const isPaidActive = {
      subscriptionTier: { $in: ["signal", "auto-trade"] },
      subscriptionStatus: { $in: ["active", "trialing"] },
      tradingLocked: { $ne: true },
    };
    const paidUsers = await db.collection("users").find({
      discordWebhookUrl:     { $exists: true, $ne: null, $ne: "" },
      discordWebhookEnabled: { $ne: false },
      $or: [{ isAdmin: true }, isPaidActive],
    }).project({ email: 1, discordWebhookUrl: 1, language: 1 }).toArray();

    for (const u of paidUsers) {
      const lang = u.language === "nl" ? "nl" : "en";
      const content = `${_trDiscord(key, lang, vars)}\n→ ${url}`;
      sends.push(fetch(u.discordWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }).then(r => { if (!r.ok) console.warn(`[DISCORD paid ${u.email}] HTTP ${r.status}`); })
        .catch(e => console.warn(`[DISCORD paid ${u.email}] Failed: ${e.message}`)));
    }

    // Free users — split into in-window (live signals) vs exhausted (sales-only)
    const freeUsers = await db.collection("users").find({
      discordWebhookUrl:     { $exists: true, $ne: null, $ne: "" },
      discordWebhookEnabled: { $ne: false },
      isAdmin:               { $ne: true },
      subscriptionTier:      "free",
    }).project({ email: 1, discordWebhookUrl: 1, language: 1, createdAt: 1 }).toArray();

    for (const u of freeUsers) {
      const lang = u.language === "nl" ? "nl" : "en";
      const userCreatedMs = u.createdAt ? new Date(u.createdAt).getTime() : 0;
      const exhausted = _freeUserExhaustedAt(setupLog, userCreatedMs, weekStartMs, eventTs);

      if (!exhausted) {
        const content = `${_trDiscord(key, lang, vars)}\n→ ${url}`;
        sends.push(fetch(u.discordWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }).then(r => { if (!r.ok) console.warn(`[DISCORD free in-window ${u.email}] HTTP ${r.status}`); })
          .catch(e => console.warn(`[DISCORD free in-window ${u.email}] Failed: ${e.message}`)));
      } else if (audience === "wins" && salesKey) {
        const content = `${_trDiscord(salesKey, lang, salesVars || vars)}\n→ Upgrade: ${upgradeUrl}`;
        sends.push(fetch(u.discordWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        }).then(r => { if (!r.ok) console.warn(`[DISCORD free sales ${u.email}] HTTP ${r.status}`); })
          .catch(e => console.warn(`[DISCORD free sales ${u.email}] Failed: ${e.message}`)));
      }
      // else: exhausted, non-win event → silent
    }
  } catch (e) {
    console.error(`[DISCORD per-user broadcast] DB error: ${e.message}`);
  }
  await Promise.allSettled(sends);
}

async function sendDiscordStep1(market, tf /*, ...unused*/) {
  await _sendNotify({ key: "step1", vars: { market, tf }, audience: "paid" });
  console.log(`[DISCORD] Step-1 notify sent: ${market} ${tf}`);
}

async function sendDiscordSetup(setup) {
  await _sendNotify({ key: "setup_new", vars: { market: setup.market, tf: setup.tf }, audience: "paid" });
  console.log(`[DISCORD] Setup notify sent: ${setup.market} ${setup.tf}`);
}

async function sendDiscordTradeEvent(marketKey, event /*, details*/) {
  // Map event → translation key
  const keyMap = {
    ENTRY_TRIGGERED: "entry_filled",
    SL_HIT:          "sl_hit",
    TP1_HIT:         "tp1_hit",
    TP2_HIT:         "tp2_hit",
    TP3_HIT:         "tp3_hit",
    RUNNER_BE_STOP:  "runner_be",
  };
  const key = keyMap[event];
  if (!key) {
    console.warn(`[DISCORD] unknown trade event: ${event}`);
    return;
  }
  const isWin = event === "TP2_HIT" || event === "TP3_HIT";
  await _sendNotify({
    key,
    vars: { marketKey },
    audience: isWin ? "wins" : "paid",
    salesKey: isWin ? "win_sales" : undefined,
    salesVars: isWin ? { marketKey, event } : undefined,
    eventTs: Date.now(),
  });
}

// ── Premium / Discount entry-zone filter ─────────────────────────────────────
// Only allow entries when the step-2 sweep landed in the right zone of BOTH
// the daily session's running range AND the currently-active 6H cycle's range:
//   BUY  → SSL sweep low  must be in DISCOUNT (below 50% eq) of daily AND 6H
//   SELL → BSL sweep high must be in PREMIUM  (above 50% eq) of daily AND 6H
// Setup creation + sweep detection are unaffected — this gates ONLY the entry
// fire. Failing setups are marked CANCELLED with cancelReason for the journal.
function computeDailyEq(candles, dayStartTs) {
  const today = candles.filter(c => c.timestamp >= dayStartTs);
  if (!today.length) return null;
  const high = Math.max(...today.map(c => c.high));
  const low  = Math.min(...today.map(c => c.low));
  return (high + low) / 2;
}

function computeSixHEq(cycles6H) {
  // Use the in-progress 6H cycle's running high/low. That's the "current 6H
  // session" range — the right reference for "is sweep in this session's
  // discount/premium". Fall through to most-recent completed if no active.
  const all = Object.values(cycles6H || {});
  const active = all.find(c => c.status === "active" && c.high != null && c.low != null);
  const ref = active
    ?? [...all].reverse().find(c => c.status === "complete" && c.high != null && c.low != null);
  if (!ref) return null;
  return (ref.high + ref.low) / 2;
}

function checkEntryZoneFilter(setup, dailyEq, sixHEq) {
  if (dailyEq == null || sixHEq == null) {
    return { passes: true, reason: "incomplete-zone-data" };  // fail-open
  }
  if (setup.sweepPrice == null) {
    return { passes: true, reason: "no-sweep-price" };
  }
  // Per user request: only ONE of daily/6H needs to be in the right zone for
  // the entry to fire (loose OR — was strict AND in the previous revision).
  const sp = setup.sweepPrice;
  if (setup.direction === "BUY") {
    const inDailyDiscount = sp < dailyEq;
    const inSixHDiscount  = sp < sixHEq;
    if (inDailyDiscount || inSixHDiscount) return { passes: true, reason: "BUY discount-aligned (≥1 of 2)" };
    return {
      passes: false,
      reason: `BUY sweep ${sp.toFixed(2)} not in discount of EITHER zone — daily eq ${dailyEq.toFixed(2)} (✗), 6H eq ${sixHEq.toFixed(2)} (✗)`,
    };
  }
  if (setup.direction === "SELL") {
    const inDailyPremium = sp > dailyEq;
    const inSixHPremium  = sp > sixHEq;
    if (inDailyPremium || inSixHPremium) return { passes: true, reason: "SELL premium-aligned (≥1 of 2)" };
    return {
      passes: false,
      reason: `SELL sweep ${sp.toFixed(2)} not in premium of EITHER zone — daily eq ${dailyEq.toFixed(2)} (✗), 6H eq ${sixHEq.toFixed(2)} (✗)`,
    };
  }
  return { passes: true, reason: "unknown-direction" };
}

// ── Single source of truth for ENTRY-TRIGGER fan-out ─────────────────────────
// Every entry-trigger pad (daily 06:00, 90M/6H time-based, orphan-recovery)
// MUST call this. The function guarantees that flipping a setup to ACTIVE
// always produces these effects together — so a path can never accidentally
// fire one without the others (e.g. Discord without MetaApi, or card-update
// without broker signal, the bug that caused BTC 02:45 ET 2026-05-03 to TP2
// without ever placing an order):
//
//   1. ENTRY_TRIGGERED logged → debug_log.json + monitor.log + dashboard event feed
//   2. setup_log.json patched (entry/sl/tp1/tp2/entryTs/entryTime/status="ACTIVE")
//      → dashboard cards + history immediately reflect the trade
//   3. active-slot file + MongoDB synced (only when persistActive=true; the
//      orphan path passes false because its setup is NOT the current active slot)
//   4. updateWeeklyRecap counter incremented
//   5. MetaApi CopyFactory signal sent (TP1 leg + TP2 leg)
//   6. Discord trade-event ENTRY_TRIGGERED posted
//
// External calls (5, 6) are fire-and-forget so a slow / failing endpoint
// can never block the cron tick.
async function fireEntryTrigger(marketKey, setup, opts = {}) {
  const { sourceTag = null, persistActive = true, dailyEq = null, sixHEq = null } = opts;
  const tag = sourceTag ? ` (${sourceTag})` : "";

  // Snapshot the PD zones at entry-trigger time so the journal page can later
  // show stats by alignment. Stored on every trade (passed AND filtered) so
  // the user can compare aligned vs filtered-out outcomes if/when filtering
  // gets relaxed. Uses the same eqs the filter does — single source of truth.
  const sp = setup.sweepPrice;
  const pdSnapshot = (sp != null && (dailyEq != null || sixHEq != null)) ? {
    pdSweepPrice:   sp,
    pdDailyEq:      dailyEq,
    pdSixHEq:       sixHEq,
    pdZoneDaily:    dailyEq != null ? (sp < dailyEq ? "DISCOUNT" : "PREMIUM") : null,
    pdZoneSixH:     sixHEq  != null ? (sp < sixHEq  ? "DISCOUNT" : "PREMIUM") : null,
    // Mirrors checkEntryZoneFilter — a setup counts as PD-aligned when the
    // sweep landed in the right zone of EITHER daily OR 6H (loose OR).
    pdAligned:
      setup.direction === "BUY"
        ? ((dailyEq != null && sp < dailyEq) || (sixHEq != null && sp < sixHEq))
        : setup.direction === "SELL"
          ? ((dailyEq != null && sp > dailyEq) || (sixHEq != null && sp > sixHEq))
          : false,
  } : {};

  // 0. Premium / Discount entry-zone filter. Skipped when callers don't pass
  //    eq values (back-compat). On filter fail: mark CANCELLED, clear the
  //    active slot for non-orphan paths, mutate the in-memory setup so any
  //    same-tick "if status === ACTIVE" checks bail out, and SKIP the 6
  //    fan-out actions (no MetaApi, no Discord, no log_open counter).
  if (dailyEq != null && sixHEq != null) {
    const f = checkEntryZoneFilter(setup, dailyEq, sixHEq);
    if (!f.passes) {
      logEvent(marketKey, "ENTRY_FILTERED",
        `${setup.direction}${tag} — ${f.reason}`, "skipped");
      patchSetupLog(setup.id, {
        status:       "CANCELLED",
        outcome:      null,
        cancelReason: f.reason,
        ...pdSnapshot,
      });
      setup.status = "CANCELLED";
      if (persistActive) {
        try { await clearSetup(marketKey, setup, `PD filter: ${f.reason}`); } catch {}
      }
      return { passed: false, reason: f.reason };
    }
  }

  // 1. Debug log — picked up by dashboard live-event feed.
  logEvent(marketKey, "ENTRY_TRIGGERED",
    `${setup.direction} @ ${setup.entry}${tag} | SL: ${setup.sl} | TP1: ${setup.tp1}`,
    "entry");

  // 2. setup_log.json — historical record + dashboard card state.
  patchSetupLog(setup.id, {
    entry:     setup.entry,
    sl:        setup.sl,
    tp1:       setup.tp1,
    tp2:       setup.tp2,
    tp3:       setup.tp3,
    entryTime: setup.entryTime,
    entryTs:   setup.entryTs,
    status:    "ACTIVE",
    ...pdSnapshot,
  });

  // 3. Weekly stats counter.
  updateWeeklyRecap(marketKey, { type: "trade_open" });

  // 4. Active-slot file + MongoDB (skipped for orphan: orphan id ≠ active slot
  //    so writing would overwrite the genuine current active setup).
  if (persistActive) {
    await saveSetup(marketKey, setup);
  }

  // 5. MetaApi CopyFactory — awaited. The bridge now returns {ok, results}
  //    where ok=true means EVERY leg was accepted. metaApiDispatched is only
  //    flipped to true on full success — partial/failed dispatches stay flagged
  //    so the recovery path keeps trying next tick (broker error, env outage,
  //    network blip all become recoverable instead of silent losses).
  try {
    const dispatch = await cfNotifySignal(setup, marketKey);
    if (dispatch?.ok) {
      setup.metaApiDispatched = true;
      if (persistActive) {
        try { await saveSetup(marketKey, setup); } catch {}
      }
      patchSetupLog(setup.id, { metaApiDispatched: true });
    } else {
      const failed = (dispatch?.results ?? []).filter(r => !r.ok).map(r => `${r.leg}:${r.error ?? "?"}`).join(", ");
      console.warn(`[fireEntryTrigger] partial/failed dispatch ${marketKey} ${setup.id} | failed=[${failed}] skipped=${dispatch?.skipped ?? "none"}`);
      logEvent(marketKey, "METAAPI_DISPATCH_FAILED",
        `${setup.direction} ${setup.id} | ${failed || dispatch?.skipped} — recovery will retry`,
        "error");
    }
  } catch (e) {
    console.warn(`[fireEntryTrigger] cfNotifySignal threw for ${marketKey} ${setup.id}: ${e.message}`);
  }

  // 6. Discord trade-event — fire-and-forget.
  const fp = p => p > 100 ? Number(p).toFixed(1) : Number(p).toFixed(5);
  sendDiscordTradeEvent(marketKey, "ENTRY_TRIGGERED",
    `${setup.direction} @ ${fp(setup.entry)} | SL: ${fp(setup.sl)} | TP: ${fp(setup.tp1)}`)
    .catch(() => {});

  return { passed: true };
}

// Unified exit-event dispatcher. Pairs Discord + MetaApi-cancel/modify + log
// + setup_log patch + weekly recap so each exit kind fires its full bundle of
// side-effects from one place. State mutation (status/flags) stays in the
// caller — that's where the price-comparison and branching live.
//
//   kind ∈ "SL_HIT" | "RUNNER_BE_STOP" | "TP1_HIT"
//        | "TP2_HIT_RUNNER" | "TP2_HIT_LEGACY" | "TP3_HIT"
async function fireTradeEvent(marketKey, setup, kind, opts = {}) {
  const fp  = p => p > 100 ? p.toFixed(1) : p.toFixed(5);
  const dir = setup.direction;
  const entry = setup.entry;

  switch (kind) {
    case "SL_HIT": {
      const sl = setup.sl;
      logEvent(marketKey, "SL_HIT", `${dir} SL @ ${fp(sl)} | Entry was ${fp(entry)}`, "sl_hit");
      updateSetupLogOutcome(setup.id, "LOSS", { outcomePrice: sl });
      updateWeeklyRecap(marketKey, { type: "trade_loss" });
      await sendDiscordTradeEvent(marketKey, "SL_HIT", `${dir} @ ${fp(entry)} → SL ${fp(sl)}`);
      cfCancelSignal(setup, "all").catch(() => {});
      return;
    }
    case "RUNNER_BE_STOP": {
      const sl = setup.sl;
      logEvent(marketKey, "RUNNER_BE_STOP", `${dir} runner stopped at BE @ ${fp(sl)} (TP2 already hit)`, "tp2_hit");
      patchSetupLog(setup.id, { status: "CLOSED_TP2", runnerOutcome: "BE_STOP" });
      await sendDiscordTradeEvent(marketKey, "RUNNER_BE_STOP", `${dir} runner BE-stop @ ${fp(sl)} (TP2 was hit)`);
      cfCancelSignal(setup, "tp3").catch(() => {});
      return;
    }
    case "TP1_HIT": {
      const tp1 = setup.tp1;
      logEvent(marketKey, "TP1_HIT", `${dir} TP1 @ ${fp(tp1)} ✅  (1R)`, "tp1_hit");
      patchSetupLog(setup.id, { tp1Hit: true, tp1HitTime: tsToETDateTime(Date.now() / 1000) });
      await sendDiscordTradeEvent(marketKey, "TP1_HIT", `${dir} @ ${fp(entry)} → TP1 ${fp(tp1)} ✅`);
      cfCancelSignal(setup, "tp1").catch(() => {});
      return;
    }
    case "TP2_HIT_RUNNER": {
      const tp2 = setup.tp2, tp3 = setup.tp3, beSL = opts.beSL;
      logEvent(marketKey, "TP2_HIT", `${dir} TP2 @ ${fp(tp2)} 🏆 (2R) — runner armed, SL→BE ${fp(beSL)}`, "tp2_hit");
      patchSetupLog(setup.id, {
        tp2Hit: true, tp2HitTime: tsToETDateTime(Date.now() / 1000),
        status: "TP2_HIT_RUNNING", sl: beSL, slMovedToBE: true,
      });
      updateWeeklyRecap(marketKey, { type: "trade_win" });
      await sendDiscordTradeEvent(marketKey, "TP2_HIT", `${dir} @ ${fp(entry)} → TP2 ${fp(tp2)} 🏆 — runner active to TP3 ${fp(tp3)} (SL@BE ${fp(beSL)})`);
      cfCancelSignal(setup, "tp2").catch(() => {});
      cfModifySignalSL(setup, marketKey, "tp3", beSL).catch(() => {});
      return;
    }
    case "TP2_HIT_LEGACY": {
      const tp2 = setup.tp2;
      logEvent(marketKey, "TP2_HIT", `${dir} TP2 @ ${fp(tp2)} 🏆 (2R)`, "tp2_hit");
      updateSetupLogOutcome(setup.id, "WIN", { outcomePrice: tp2 });
      updateWeeklyRecap(marketKey, { type: "trade_win" });
      await sendDiscordTradeEvent(marketKey, "TP2_HIT", `${dir} @ ${fp(entry)} → TP2 ${fp(tp2)} 🏆`);
      cfCancelSignal(setup, "all").catch(() => {});
      return;
    }
    case "TP3_HIT": {
      const tp3 = setup.tp3;
      logEvent(marketKey, "TP3_HIT", `${dir} TP3 @ ${fp(tp3)} 🚀 (10R runner)`, "tp3_hit");
      updateSetupLogOutcome(setup.id, "WIN", { outcomePrice: tp3, rMulti: 10 });
      patchSetupLog(setup.id, { tp3Hit: true, tp3HitTime: tsToETDateTime(Date.now() / 1000), status: "CLOSED_TP3" });
      await sendDiscordTradeEvent(marketKey, "TP3_HIT", `${dir} @ ${fp(entry)} → TP3 ${fp(tp3)} 🚀 (10R runner!)`);
      cfCancelSignal(setup, "tp3").catch(() => {});
      return;
    }
    default:
      console.warn(`[${marketKey}] fireTradeEvent: unknown kind "${kind}"`);
  }
}

async function sendDiscordEntryWindow(setup /*, windowLabel*/) {
  // Entry window opened — user opens dashboard to see price/SL/TP.
  await _sendNotify(`⏰ **${setup.market}** · ${setup.tf} — entry window open nu`);
  console.log(`[DISCORD] Entry window notify sent: ${setup.market} ${setup.tf}`);
}

// ── Market Data Writer ────────────────────────────────────────────────────────
function writeMarketData(marketKey, data) {
  const file = join(__dir, `market_data_${marketKey}.json`);
  writeJSON(file, { ...data, timestamp: Date.now() });
}

// ── MCP Caller ───────────────────────────────────────────────────────────────
let _mcpSession = null;
async function mcpCall(method, params = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {}),
  };
  if (!_mcpSession) {
    const r = await fetch(MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {},
                  clientInfo: { name: "monitor", version: "3.0" } } }),
    });
    _mcpSession = r.headers.get("mcp-session-id");
  }
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": _mcpSession },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    const l = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!l) continue;
    try {
      const d = JSON.parse(l);
      if (d.result !== undefined) return d.result;
      if (d.error) throw new Error(d.error.message);
    } catch (e) { if (e.message && !e.message.includes("JSON")) throw e; }
  }
  return null;
}

async function switchToMarket(marketKey, retries = 10) {
  const market = MARKETS[marketKey];
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (attempt > 1) { _mcpSession = null; }
      await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol: market.tvSymbol } });
      await new Promise(r => setTimeout(r, 4000));
      await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: "15" } });
      await new Promise(r => setTimeout(r, 2500));
      let raw = null;
      for (let dr = 0; dr < 3; dr++) {
        const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count: 5 } });
        raw = result?.content?.[0]?.text;
        if (raw) break;
        await new Promise(r => setTimeout(r, 3000));
      }
      if (!raw) throw new Error("No data after switch");
      const testCandles = JSON.parse(raw);
      if (!Array.isArray(testCandles) || !testCandles.length) throw new Error("Empty candles");
      const price = testCandles[testCandles.length - 1].close;
      if (price < market.priceMin || price > market.priceMax)
        throw new Error(`Price ${price} out of range [${market.priceMin}–${market.priceMax}]`);
      console.log(`[${marketKey}] ✅ Switched. Price: ${price}`);
      return true;
    } catch (err) {
      console.warn(`[${marketKey}] Switch attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
  _mcpSession = null;
  return false;
}

async function fetchDailyCandles(marketKey, count = 20) {
  const { tvSymbol, priceMin, priceMax } = MARKETS[marketKey];

  // Switch to D TF, then re-confirm the symbol to ensure correct data
  await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: "D" } });
  await new Promise(r => setTimeout(r, 3000));
  await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol: tvSymbol } });
  await new Promise(r => setTimeout(r, 4000));

  let dailyCandles = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
    const raw = result?.content?.[0]?.text;
    if (raw) {
      const candles = JSON.parse(raw);
      if (Array.isArray(candles) && candles.length >= 2) {
        const gap   = candles[candles.length - 1].timestamp - candles[candles.length - 2].timestamp;
        const price = candles[candles.length - 1].close;
        if (gap > 3600 * 12 && price >= priceMin && price <= priceMax) {
          dailyCandles = candles;
          break;
        }
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  // Always switch back to 15min with symbol confirmed
  await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: "15" } });
  await new Promise(r => setTimeout(r, 2000));
  await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol: tvSymbol } });
  await new Promise(r => setTimeout(r, 3000));

  return dailyCandles;
}

function buildDailyLockMoves(dailyCandles) {
  // For each day: was BSL (high) or SSL (low) swept by any later day's candle?
  // Returns moves[] for lock detection AND dailyLevels[] for dashboard display
  const moves = [];
  const levels = [];

  // Use actual current ET calendar date — not array position — to mark today correctly.
  // Array-position isToday was wrong before regular-session open (last D-candle = yesterday).
  const etTodayStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });

  for (let i = 0; i < dailyCandles.length; i++) {
    const d = dailyCandles[i];
    // TradingView D-candle timestamp = session OPEN (17:00 ET). The user sees the candle
    // labeled by its CLOSE date (next calendar day). Add 86400s to get the close date.
    const date = new Date((d.timestamp + 86400) * 1000).toLocaleDateString("en-US", {
      timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    });
    const isToday = date === etTodayStr;
    let hitHigh = null, hitLow = null;

    if (!isToday) {
      for (let j = i + 1; j < dailyCandles.length; j++) {
        if (!hitHigh && dailyCandles[j].high >= d.high) {
          // +86400 to get close date (matches user's chart label for the sweeping session)
          const sweepDate = new Date((dailyCandles[j].timestamp + 86400) * 1000).toLocaleDateString("en-US", {
            timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
          });
          hitHigh = { price: dailyCandles[j].high, date: sweepDate, time: null, ts: dailyCandles[j].timestamp };
        }
        if (!hitLow && dailyCandles[j].low <= d.low) {
          const sweepDate = new Date((dailyCandles[j].timestamp + 86400) * 1000).toLocaleDateString("en-US", {
            timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
          });
          hitLow = { price: dailyCandles[j].low, date: sweepDate, time: null, ts: dailyCandles[j].timestamp };
        }
        if (hitHigh && hitLow) break;
      }
    }

    const type = hitHigh && hitLow ? "BOTH" : hitHigh ? "HIGH" : hitLow ? "LOW" : "RANGE";
    moves.push({ type, high: d.high, low: d.low, date, hitHigh, hitLow });
    levels.push({ date, high: d.high, low: d.low, hitHigh, hitLow, isToday });
  }

  return { moves: moves.slice(0, -1), levels }; // exclude today from moves (not yet confirmed)
}

// Force TV to load more historical bars into the chart's _series. Without this
// step `bars()` only returns whatever's in the default visible window (~300-500
// bars), which on 15m TF caps history at ~5 days — too short for the 14-day
// daily-lock lookback. setVisibleRange does NOT trigger backfill; only wheel
// events on the canvas do. Each `scroll_chart` left dispatches a wheel event
// that TV interprets as "load older bars". Empirically: 8 × 500-bar scrolls
// loads ~12-13 days of 15m history. After loading, we snap the timescale back
// to the present so the visible chart still shows live data.
async function loadCandleHistory(scrollSteps = 10) {
  try {
    for (let i = 0; i < scrollSteps; i++) {
      await mcpCall("tools/call", { name: "scroll_chart", arguments: { direction: "left", bars: 500 } });
      await new Promise(r => setTimeout(r, 800));
    }
    // Snap back to present so live updates resume
    const snap = `(function(){try{window.TradingViewApi._activeChartWidgetWV._value.executeActionById('timeScaleReset');return 'ok';}catch(e){return 'err:'+e.message;}})()`;
    await mcpCall("tools/call", { name: "execute_javascript", arguments: { code: snap } });
    await new Promise(r => setTimeout(r, 1500));
  } catch (e) { console.warn(`loadCandleHistory failed: ${e.message}`); }
}

async function fetchCandles(count = 2000, opts = {}) {
  const { loadHistory = false, scrollSteps = 10 } = opts;
  if (loadHistory) {
    await loadCandleHistory(scrollSteps);
  }
  const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
  const raw    = result?.content?.[0]?.text;
  if (!raw) throw new Error("No candle data from MCP");
  const candles = JSON.parse(raw);
  if (!Array.isArray(candles) || !candles.length) throw new Error("Empty candle array");
  const lastTs  = candles[candles.length - 1].timestamp;
  const diffMin = (Date.now() - lastTs * 1000) / 60000;
  if (diffMin > 20) {
    console.warn(`Candles stale: ${diffMin.toFixed(1)} min old`);
    await mcpCall("tools/call", { name: "execute_javascript", arguments: {
      code: `try { document.querySelector('canvas.chart-gui-wrapper')?.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); } catch(e){} return 'refresh';`
    }});
    await new Promise(r => setTimeout(r, 2500));
    const r2  = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
    const raw2 = r2?.content?.[0]?.text;
    if (raw2) {
      const c2 = JSON.parse(raw2);
      if (Array.isArray(c2) && c2.length) return { candles: c2, staleWarning: true, diffMin };
    }
  }
  return { candles, staleWarning: diffMin > 20, diffMin };
}

// Candle cache: load from disk, fetch only the recent delta via CDP, merge.
// A full fetch (2000 candles) only happens when cache is missing or stale (>2h).
// Normal case: fetch 25 candles (~6h at 15min) and merge — much faster + less CDP load.
// Strip contaminated candles whose price is wildly off from the rest. Happens
// when symbol-switch silently fails and we read bars from another market —
// values land in our cache and corrupt subsequent analysis. Two-stage filter:
//   1. Hard bounds: reject anything outside MARKETS[mk].priceMin/priceMax
//   2. Median-relative: reject candles whose close is < 0.5× or > 2× the
//      median close of all surviving candles (catches contamination that fits
//      within priceMin/priceMax but is anomalous for the actual market).
function sanitizeCandles(candles, marketKey) {
  if (!candles?.length) return candles;
  const { priceMin, priceMax } = MARKETS[marketKey] || {};
  if (priceMin == null) return candles;

  const inBounds = candles.filter(c =>
    Number.isFinite(c.close) && c.close >= priceMin && c.close <= priceMax &&
    Number.isFinite(c.high)  && Number.isFinite(c.low)  && c.high >= c.low
  );
  if (inBounds.length < 5) return inBounds;

  const sorted = [...inBounds].map(c => c.close).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const clean = inBounds.filter(c =>
    c.close >= median * 0.5 && c.close <= median * 2.0 &&
    c.high  >= median * 0.5 && c.low   <= median * 2.0
  );

  const dropped = candles.length - clean.length;
  if (dropped > 0) {
    console.log(`[${marketKey}] sanitizeCandles: dropped ${dropped} contaminated bars (median=${median.toFixed(2)})`);
  }
  return clean;
}

async function fetchCandlesWithCache(marketKey) {
  const cacheFile = join(__dir, `candles_${marketKey}.json`);

  let cached = [];
  try { cached = JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
  // Drop any historical contamination before merging
  cached = sanitizeCandles(cached, marketKey);

  const lastCachedTs = cached.length ? cached[cached.length - 1].timestamp : 0;
  const cacheAgeMin  = (Date.now() / 1000 - lastCachedTs) / 60;

  // Use cache if it has enough history and is less than 2 hours old
  const useCache = cached.length >= 200 && cacheAgeMin < 120;
  const fetchCount = useCache ? 25 : 2000;

  console.log(`[${marketKey}] Candle cache: ${cached.length} bars, ${cacheAgeMin.toFixed(0)} min old → fetching ${fetchCount}`);

  // Cold-start: scroll chart back 10× 500 bars (~12-13 days of 15m) to force TV
  // to load enough history. Otherwise bars() returns only the default ~300-500.
  const result = await fetchCandles(fetchCount, useCache ? {} : { loadHistory: true, scrollSteps: 10 });
  // Sanitize the fresh fetch too — switchToMarket only validates the LAST candle.
  result.candles = sanitizeCandles(result.candles, marketKey);

  if (useCache) {
    // Merge: cache provides history, fresh candles update/extend the tip.
    // Use timestamp as key so duplicate candles (current open bar) get overwritten.
    const byTs = new Map(cached.map(c => [c.timestamp, c]));
    for (const c of result.candles) byTs.set(c.timestamp, c);
    result.candles = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
    console.log(`[${marketKey}] Merged → ${result.candles.length} bars total`);
  }

  return result;
}

function isMarketOpen(marketKey) {
  if (CRYPTO_MARKETS.has(marketKey)) return true;
  const etH = tsToETHours(Date.now() / 1000);
  const now = new Date();
  const wd  = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "narrow" })
    .format(now) === "S" ? (now.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short" }) === "Sat" ? 6 : 0) : 1);
  const etWd = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now)
  );
  if (etWd === 0 && etH < 18) return false; // Sunday before 18:00 ET (markets reopen at 18:00 ET = trading-day anchor)
  if (etWd === 6) return false; // Saturday
  if (etWd === 5 && etH >= 17) return false; // Friday after 17:00
  return true;
}

// ── Core Market Analysis ──────────────────────────────────────────────────────
async function analyzeMarket(marketKey, candles, dailyLockState = null, dailyLockLevels = null, candles1m = null) {
  const tag = `[${marketKey}]`;
  const dayStartTs = getTradingDayStartTs();
  const phaseInfo  = getPhase2Status(dayStartTs);
  const adminBias  = readAdminBias(marketKey);

  // Build structures
  const cycles90  = build90MinCycles(candles, dayStartTs);
  const cycles6H  = build6HCycles(candles, dayStartTs);
  // 22.5min cycles need 1m candles for resolution. Empty object if 1m feed missing
  // (cron seeds candles_1m_<MK>.json every 2 min; first run after deploy may be empty).
  const cycles22M = candles1m?.length ? build22MinCycles(candles1m, dayStartTs) : {};
  // 5.625min cycles for SCALP signals. Same 1m feed.
  const cycles5M  = candles1m?.length ? build5MinCycles(candles1m, dayStartTs) : {};
  // 18:00 ET session grouping — labels match D-candle convention (close date)
  const dailyDays = buildDailyStructure(candles);

  // Premium / Discount equilibrium values used by checkEntryZoneFilter to
  // gate entry-trigger paths. Computed once per analyzeMarket so all 3
  // entry paths (daily / 90M-6H / orphan-recovery) see the same numbers.
  const dailyEq = computeDailyEq(candles, dayStartTs);
  const sixHEq  = computeSixHEq(cycles6H);

  // Order flow lock — ALWAYS derived from buildDailyStructure on the in-memory
  // 15-min candles. Trading day = 18:00 ET → 18:00 ET (matches the 6H cycles
  // and Phase-2 windows used elsewhere in this engine). The D-TF path was
  // dropped because TV's "D" candles for crypto on Coinbase are UTC-aligned
  // (00:00 UTC → 00:00 UTC) and produce off-by-day labels for users on ET.
  const prevDays = dailyDays.filter(d => !d.isToday && d.high && d.low);
  const dailyLockMoves = prevDays.map(d => ({
    type: (d.hitHigh && d.hitLow) ? "BOTH"
        : d.hitHigh               ? "HIGH"
        : d.hitLow                ? "LOW"
        :                           "RANGE",
    high: d.high, low: d.low, date: d.date,
    hitHigh: d.hitHigh, hitLow: d.hitLow,
  }));
  const lockState = detectOrderFlowLock(dailyLockMoves, candles);
  // Levels for the dashboard daily card — derive from same 18:00-ET aggregation
  if (!dailyLockLevels || !dailyLockLevels.length) {
    dailyLockLevels = dailyDays.slice(-10).map(d => ({
      date: d.date, high: d.high, low: d.low,
      hitHigh: d.hitHigh, hitLow: d.hitLow, isToday: !!d.isToday,
    }));
  }

  // Supplement D-TF dailyLevels with real-time 15-min sweep detection.
  // The D candle for "yesterday" may not yet have a next D candle (e.g. early morning
  // before regular session opens). Use 15-min candles from the current session to fill
  // in hitHigh/hitLow that D-candle comparison alone cannot detect yet.
  if (dailyLockLevels && dailyLockLevels.length) {
    const sorted15m = [...candles].sort((a, b) => a.timestamp - b.timestamp);
    const etTodayStr = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    });
    // Use date-string comparison (isToday in cache may be stale from old code)
    const latestNonToday = [...dailyLockLevels].reverse()
      .find(lev => lev.date !== etTodayStr && lev.high);
    if (latestNonToday && (!latestNonToday.hitHigh || !latestNonToday.hitLow)) {
      // Candles from this session onward (session started at 18:00 ET, D session ended at 17:00 ET —
      // 1h overlap is acceptable; the relevant sweeps happen well within the session)
      const sessionStart = getTradingDayStartTs();
      for (const c of sorted15m.filter(c => c.timestamp >= sessionStart)) {
        if (!latestNonToday.hitHigh && c.high >= latestNonToday.high)
          latestNonToday.hitHigh = { price: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
        if (!latestNonToday.hitLow && c.low <= latestNonToday.low)
          latestNonToday.hitLow = { price: c.low, time: tsToETLabel(c.timestamp), ts: c.timestamp };
        if (latestNonToday.hitHigh && latestNonToday.hitLow) break;
      }
    }
  }

  // ── 6H Lock (tactical bias) ─────────────────────────────────────────────
  // Applies the same H→L→H / L→H→L lock detection on 6H cycles from the last
  // 14 days. Combined with the daily lock via confluence scoring.
  const sixHMoves = build6HHistoricalMoves(candles, 14);
  const sixHLockState = detectOrderFlowLock(sixHMoves, candles);

  // ── Order Flow Bias (daily × 6H confluence) ─────────────────────────────
  // Only used when adminBias === "AUTO". Manual BULLISH/BEARISH overrides still win.
  const orderFlowBias = computeOrderFlowBias(lockState, sixHLockState);

  // Determine allowed direction.
  // Manual override (BULLISH/BEARISH) always wins. AUTO uses the daily×6H confluence
  // bias (orderFlowBias.direction) — only trades when bias is clear.
  let allowedDirection = null; // null = both allowed
  if (adminBias === "BULLISH") {
    allowedDirection = "BUY";
  } else if (adminBias === "BEARISH") {
    allowedDirection = "SELL";
  } else if (adminBias === "AUTO") {
    // Use confluence bias first; fall back to raw daily lock if confluence is NEUTRAL
    if (orderFlowBias.direction) {
      allowedDirection = orderFlowBias.direction;
    } else if (lockState) {
      allowedDirection = lockState.direction === "BULLISH" ? "BUY" : "SELL";
    }
  }

  logEvent(marketKey, "STRUCTURE_BUILT",
    `90M: ${Object.keys(cycles90).length} cycles | Daily: ${dailyDays.length} days | Bias: ${adminBias} | ` +
    `D-Lock: ${lockState?.direction ?? "—"}×${lockState?.strength ?? 0} | ` +
    `6H-Lock: ${sixHLockState?.direction ?? "—"}×${sixHLockState?.strength ?? 0} | ` +
    `Flow: ${orderFlowBias.state} (${orderFlowBias.score})`);

  // Update lock in weekly recap
  if (lockState) {
    updateWeeklyRecap(marketKey, { type: "lock_update", lockState: lockState.direction });
  }

  // ── Card signal detection (reference cycle per timeframe) ────────────────
  const prevCardState = loadCardState(marketKey);
  const { events: cardEvents, newState: updatedCardState } = detectCardSignals(
    cycles90, cycles6H, dailyDays, allowedDirection, prevCardState, adminBias
  );
  saveCardState(marketKey, updatedCardState);

  for (const ev of cardEvents) {
    logEvent(marketKey, `CARD_SWEEP_${ev.step}`, `${ev.tf} ${ev.side} step${ev.step} [${ev.cycleLabel}]`, "sweep");
    updateWeeklyRecap(marketKey, { type: "sweep", source: ev.tf, side: ev.side, level: ev.side === "HIGH" ? ev.ref.high : ev.ref.low, time: ev.side === "HIGH" ? ev.ref.hitHigh?.time : ev.ref.hitLow?.time });
  }

  // ── Signal validation & setup creation ───────────────────────────────────
  const currentPrice = candles[candles.length - 1]?.close ?? 0;
  const currentTime  = tsToETLabel(candles[candles.length - 1]?.timestamp ?? Date.now() / 1000);

  // PER-TF iteration: each timeframe has its own setup slot via per-TF files.
  // Lets a market run 6H + 90M + daily setups in parallel with independent
  // lifecycle. Inside the loop, `activeSetup` is scoped to the current TF;
  // event filtering uses `tfEvents` (the cardEvents matching this TF).
  const allTfSetups = await loadAllSetups(marketKey);
  for (const _currentTf of PRIMARY_TFS) {
  let activeSetup = allTfSetups[_currentTf];
  const tfEvents  = cardEvents.filter(e => e.tf === _currentTf);

  // ════════════════════════════════════════════════════════════════════════════
  // RECOVERY-PAD #1 — "Halverwege gestrand" detectie
  // ────────────────────────────────────────────────────────────────────────────
  // Symptoom dat dit ving op 04-05-2026: Mongo had US500/US30 als ACTIVE,
  // maar geen MetaApi-signal en geen Discord "entry gevuld" message.
  //
  // Oorzaak: vorige tick mutateerde status=ACTIVE → schreef Mongo → werd
  // gekild door 300s timeout vóórdat cfNotifySignal HTTP-call af was. Op de
  // volgende tick zag de trigger-code entryTriggered:true → skipte → setup
  // bleef permanent silent in de broker.
  //
  // Hoe deze fix werkt: bij elke tick checken we VOOR de trigger-code of er
  // een setup is die ACTIVE staat maar nooit naar MetaApi is gegaan
  // (metaApiDispatched is undefined/false). Zo ja → hervuren. CopyFactory
  // gebruikt sha1(setupId:leg) als signalId — dezelfde input geeft dezelfde
  // signalId, dus re-firen is idempotent (broker accepteert 't of geeft 'no
  // change' terug, geen dubbele orders).
  if (activeSetup && activeSetup.status === "ACTIVE" && activeSetup.entryTriggered && !activeSetup.metaApiDispatched && activeSetup.entry != null && activeSetup.sl != null) {
    // Half-completed triggers can persist with tp3 (or even tp2) missing if
    // the killed tick stopped after computing tp1 but before computeSweepTP
    // finished. Recompute every leg from entry+sl using the canonical formula
    // so the recovered dispatch always sends the full triplet.
    if (activeSetup.tp1 == null || activeSetup.tp2 == null || activeSetup.tp3 == null) {
      const tpRes = computeSweepTP(activeSetup.direction, activeSetup.entry, activeSetup.sl);
      activeSetup.tp1 = activeSetup.tp1 ?? tpRes.tp1;
      activeSetup.tp2 = activeSetup.tp2 ?? tpRes.tp2;
      activeSetup.tp3 = activeSetup.tp3 ?? tpRes.tp3;
      activeSetup.tp3Hit = activeSetup.tp3Hit ?? false;
    }
    console.warn(`[${marketKey}] METAAPI RECOVERY: ${activeSetup.id} ACTIVE without metaApiDispatched flag — re-firing signal`);
    logEvent(marketKey, "METAAPI_RECOVERY",
      `${activeSetup.direction} ${activeSetup.id} | entry=${activeSetup.entry} sl=${activeSetup.sl} — bootstrap dispatch`,
      "recovery");
    try {
      const dispatch = await cfNotifySignal(activeSetup, marketKey);
      if (dispatch?.ok) {
        activeSetup.metaApiDispatched = true;
        await saveSetup(marketKey, activeSetup);
        patchSetupLog(activeSetup.id, {
          metaApiDispatched: true,
          tp1: activeSetup.tp1, tp2: activeSetup.tp2, tp3: activeSetup.tp3,
        });
        // Mirror the auto-engine's full ENTRY_TRIGGERED surface only when
        // the broker actually accepted — otherwise we'd Discord-spam "entry
        // gevuld" for trades that didn't land. Failed dispatch keeps the flag
        // false → next tick recovery retries until ok.
        logEvent(marketKey, "ENTRY_TRIGGERED",
          `${activeSetup.direction} @ ${activeSetup.entry} (recovery) | SL: ${activeSetup.sl} | TP1: ${activeSetup.tp1}`,
          "entry");
        const fp = p => p > 100 ? Number(p).toFixed(1) : Number(p).toFixed(5);
        sendDiscordTradeEvent(marketKey, "ENTRY_TRIGGERED",
          `${activeSetup.direction} @ ${fp(activeSetup.entry)} (recovery) | SL: ${fp(activeSetup.sl)} | TP: ${fp(activeSetup.tp1)}`)
          .catch(() => {});
      } else {
        const failed = (dispatch?.results ?? []).filter(r => !r.ok).map(r => `${r.leg}:${r.error ?? "?"}`).join(", ");
        console.warn(`[${marketKey}] METAAPI RECOVERY partial/failed: ${failed || dispatch?.skipped} — will retry next tick`);
        logEvent(marketKey, "METAAPI_DISPATCH_FAILED",
          `${activeSetup.direction} ${activeSetup.id} (recovery) | ${failed || dispatch?.skipped} — retrying`,
          "error");
      }
    } catch (e) {
      console.warn(`[${marketKey}] METAAPI RECOVERY threw: ${e.message}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RECOVERY-PAD #2 — "Trigger heeft nooit gelopen" detectie (late-fire)
  // ────────────────────────────────────────────────────────────────────────────
  // Vangt het scenario waar de trigger NOOIT heeft gelopen voor een setup:
  // - Cron-tick gemist op 02:45 ET (de minuut waarop entry candle drops)
  // - MCP was offline tijdens het Phase 2 window
  // - Phase 2 venster is inmiddels expired (>03:00 ET)
  //
  // Zonder dit pad: setup blijft eeuwig in WAITING_PHASE2 hangen, geen trade.
  //
  // Hoe het werkt: zoek de entry-candle exact op `entryWindowTs` (vast tijdstip
  // bij setup-creatie). Als die candle bestaat in onze data EN minder dan 24u
  // oud is, vuren we alsnog via fireEntryTrigger met de open-prijs van die
  // candle als entry. Cap op 24u zodat een 3-dagen-oude setup niet ineens
  // tegen de huidige market price gefired wordt.
  if (activeSetup && activeSetup.status === "WAITING_PHASE2" && !activeSetup.entryTriggered && activeSetup.entryWindowTs && activeSetup.step2Ts) {
    const entryCandle = candles.find(c => c.timestamp === activeSetup.entryWindowTs);
    // Cap how stale the late-fire can be. Original 24h was too lenient — we
    // saw US30 fired 1.3h late on a setup where the market had already moved
    // against the entry, instant SL. Tighter cap keeps the late-fire useful
    // (catches the MCP candle race + missed cron tick) without firing on
    // stale data where the original setup thesis is gone.
    //   30 min covers: race within same Phase 2 window + 1-2 missed cron ticks
    //   Beyond that → operator handles via /admin manual-trade form
    const ageMin = entryCandle ? (Date.now() / 1000 - entryCandle.timestamp) / 60 : 0;
    if (entryCandle && ageMin < 30) {
      console.warn(`[${marketKey}] LATE-FIRE RECOVERY: ${activeSetup.id} WAITING_PHASE2 with entryWindowTs ${ageMin.toFixed(0)}min ago — firing now`);
      const dec = entryCandle.open > 100 ? 1 : 5;
      const actualEntry = +entryCandle.open.toFixed(dec);
      const slPrice = computeSweepSL({
        direction: activeSetup.direction,
        candles,
        step2Ts: activeSetup.step2Ts,
        entryTs: entryCandle.timestamp,
        entryPrice: actualEntry,
        sweepPrice: activeSetup.sweepPrice,
      });
      const { tp1, tp2, tp3 } = computeSweepTP(activeSetup.direction, actualEntry, slPrice);
      activeSetup.entry = actualEntry;
      activeSetup.level = actualEntry;
      activeSetup.sl    = slPrice;
      activeSetup.tp1   = tp1;
      activeSetup.tp2   = tp2;
      activeSetup.tp3   = tp3;
      activeSetup.tp3Hit = false;
      activeSetup.slMovedToBE = false;
      activeSetup.entryTriggered = true;
      activeSetup.status = "ACTIVE";
      activeSetup.entryTs = entryCandle.timestamp * 1000;
      activeSetup.entryTime = tsToETLabel(entryCandle.timestamp);
      try {
        await fireEntryTrigger(marketKey, activeSetup, { sourceTag: `late-fire | ${ageMin.toFixed(0)}min late` });
      } catch (e) {
        console.warn(`[${marketKey}] LATE-FIRE RECOVERY failed: ${e.message}`);
      }
    }
  }

  // Validate and auto-correct setup state against actual candles
  if (activeSetup) {
    const before = activeSetup.status;
    activeSetup = verifySetupAgainstCandles(activeSetup, candles, marketKey);
    // Persist corrected status (e.g. ACTIVE → CLOSED_SL when SL was hit in
    // historical candles). Without this, the file stays stale and the slot
    // appears occupied, blocking new same-TF setups from being created.
    if (activeSetup && activeSetup.status !== before) {
      await saveSetup(marketKey, activeSetup);
      patchSetupLog(activeSetup.id, { status: activeSetup.status, slHit: activeSetup.slHit });
    }

    // ── Robust field repair — runs every tick so ALL setups (new + old) end up
    // with a complete step-1 hit time and a correct entry-window clock time.
    let repaired = false;

    // (0) step2Ts: older setups saved only step2Time (HH:MM). Reconstruct the
    //     full timestamp by scanning candles backwards from createdTs for the
    //     MOST RECENT candle that actually crossed the step-2 level.
    if (!activeSetup.step2Ts && activeSetup.bslLevel != null && activeSetup.sslLevel != null) {
      const isBuy     = activeSetup.direction === "BUY";
      const step2Lvl  = isBuy ? activeSetup.sslLevel : activeSetup.bslLevel;
      const anchor    = (activeSetup.createdTs ?? Date.now()) / 1000;
      const scanStart = anchor - 3 * 24 * 3600; // up to 3 days back
      const hit = [...candles]
        .filter(c => c.timestamp >= scanStart && c.timestamp <= anchor)
        .sort((a, b) => b.timestamp - a.timestamp)
        .find(c => isBuy ? c.low <= step2Lvl : c.high >= step2Lvl);
      if (hit) {
        activeSetup.step2Ts   = hit.timestamp;
        activeSetup.step2Time = tsToETLabel(hit.timestamp);
        repaired = true;
      }
    }

    // (1) step1Ts: the step-1 sweep must happen AFTER the reference cycle ends
    //     (otherwise we'd be labelling the cycle-forming candle as a "sweep",
    //     which is a semantic error — the level isn't "defined" until the
    //     cycle closes). Parse cycleLabel (e.g. "18:00-00:00" or "Prev 12:00-18:00")
    //     to find the actual cycle-end boundary, then scan forward from there.
    //     If no post-cycle hit exists, leave step1Ts null (honest = unknown).
    if (!activeSetup.step1Ts && activeSetup.step2Ts && activeSetup.bslLevel != null && activeSetup.sslLevel != null) {
      const isBuy    = activeSetup.direction === "BUY";
      const level    = isBuy ? activeSetup.bslLevel : activeSetup.sslLevel;
      const cycleEndTs = findCycleEndTs(activeSetup.cycleLabel, activeSetup.step2Ts, candles);
      // Without a reliable cycle-end, don't backscan.
      if (cycleEndTs) {
        const hit = [...candles]
          .filter(c => c.timestamp >= cycleEndTs && c.timestamp < activeSetup.step2Ts)
          .sort((a, b) => a.timestamp - b.timestamp)
          .find(c => isBuy ? c.high >= level : c.low <= level);
        if (hit) {
          activeSetup.step1Ts   = hit.timestamp;
          activeSetup.step1Time = tsToETLabel(hit.timestamp);
          repaired = true;
        }
      }
    }

    // (2) entryWindowTime: derive from nextPhase2Label every tick so legacy
    //     setups (saved with the old buggy formatter) self-heal.
    const LBL_TO_ENTRY = {
      "19:30–21:00": "20:45", "01:30–03:00": "02:45",
      "07:30–09:00": "08:45", "13:30–15:00": "14:45",
    };
    const correctEntry = LBL_TO_ENTRY[activeSetup.nextPhase2Label];
    if (correctEntry && activeSetup.entryWindowTime !== correctEntry) {
      activeSetup.entryWindowTime = correctEntry;
      activeSetup.entryWindowTs = null; // force recompute to entry-candle ts (+75)
      repaired = true;
    }

    // (2-fix) Setups created when all of the current trading day's P2 windows
    //     had already passed used to save nextPhase2Label="soon" + null window.
    //     Re-derive from the (now wrap-aware) getNextPhase2 so they fill in.
    if (activeSetup.tf !== "daily" &&
        (activeSetup.nextPhase2Label === "soon" || !activeSetup.entryWindowTime)) {
      const p2 = getNextPhase2(dayStartTs);
      if (p2) {
        const clockMin = (p2.startMin + 75 + 18 * 60) % 1440;
        const derivedEntry = `${String(Math.floor(clockMin / 60)).padStart(2, "0")}:${String(clockMin % 60).padStart(2, "0")}`;
        activeSetup.nextPhase2Label = p2.label;
        activeSetup.entryWindowTime = derivedEntry;
        activeSetup.entryWindowTs   = Math.floor(p2.startTs + 75 * 60);
        repaired = true;
      }
    }

    // (2a) Backfill step1Ts / step2Ts / entryTs from their HH:MM string counterparts
    //     using createdTs/entryTs as date anchors. Ensures display shows the
    //     full ET date + time across ALL markets, even for legacy log entries
    //     saved under older code paths.
    const reconstructTsFromHHMM = (hhmm, anchorTs) => {
      if (!hhmm || !anchorTs) return null;
      const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const targetMins = parseInt(m[1]) * 60 + parseInt(m[2]);
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date(anchorTs * 1000))
        .filter(p => p.type !== "literal").map(p => [p.type, p.value]));
      const anchorMins = parseInt(parts.hour) * 60 + parseInt(parts.minute);
      // Walk back through candles; pick the nearest candle at/before anchor whose
      // HH:MM matches the target — gives the correct absolute ts even across DST.
      for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i];
        if (c.timestamp > anchorTs) continue;
        const ct = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York", hourCycle: "h23",
          hour: "2-digit", minute: "2-digit",
        }).format(new Date(c.timestamp * 1000));
        if (ct === hhmm) return c.timestamp;
      }
      return null;
    };
    const createdTsSec = (activeSetup.createdTs ?? 0) / 1000 || null;
    if (!activeSetup.step1Ts && activeSetup.step1Time && createdTsSec) {
      const t = reconstructTsFromHHMM(activeSetup.step1Time, createdTsSec);
      if (t) { activeSetup.step1Ts = t; repaired = true; }
    }
    if (!activeSetup.step2Ts && activeSetup.step2Time && createdTsSec) {
      const t = reconstructTsFromHHMM(activeSetup.step2Time, createdTsSec);
      if (t) { activeSetup.step2Ts = t; repaired = true; }
    }
    // Fallback: use sweepPrice (exact match against candle extreme) to pin step2Ts.
    // Pick the CLOSEST match (diff) to handle tiny fp rounding; never a loose
    // tolerance that would match any neighboring candle.
    if (!activeSetup.step2Ts && activeSetup.sweepPrice != null) {
      const searchStart = activeSetup.step1Ts ?? 0;
      const target = activeSetup.sweepPrice;
      const isBuy = activeSetup.direction === "BUY";
      let best = null, bestDiff = Infinity;
      for (const c of candles) {
        if (c.timestamp <= searchStart) continue;
        const diff = isBuy ? Math.abs(c.low - target) : Math.abs(c.high - target);
        if (diff < bestDiff) { bestDiff = diff; best = c; }
      }
      // Only accept if the match is essentially exact (0.01% or one tick).
      const acceptable = target > 1000 ? 0.5 : target > 10 ? 0.05 : 0.0005;
      if (best && bestDiff <= acceptable) {
        activeSetup.step2Ts = best.timestamp;
        activeSetup.step2Time = tsToETLabel(best.timestamp);
        repaired = true;
      }
    }
    if (!activeSetup.entryTime && activeSetup.entryTs) {
      activeSetup.entryTime = tsToETLabel(activeSetup.entryTs / 1000);
      repaired = true;
    }

    // (1b) SL drift check: if this setup is ACTIVE/CLOSED and has step2Ts +
    //      entryTs, recompute the canonical SL and correct it if it drifted.
    //      This makes the code self-healing — no more manual re-audits.
    //      Skip when slMovedToBE — after TP2 we intentionally moved SL to entry
    //      for the runner; the canonical sweep-window SL is no longer correct.
    if (activeSetup.step2Ts && activeSetup.entryTs && activeSetup.entry && !activeSetup.slMovedToBE) {
      const entryTsSec = activeSetup.entryTs > 1e12 ? activeSetup.entryTs / 1000 : activeSetup.entryTs;
      const canonicalSL = computeSweepSL({
        direction:  activeSetup.direction,
        candles,
        step2Ts:    activeSetup.step2Ts,
        entryTs:    entryTsSec,
        entryPrice: activeSetup.entry,
        sweepPrice: activeSetup.sweepPrice,
      });
      // Only realign when drift > one tick (avoid noise from fp rounding).
      const tick = activeSetup.entry > 100 ? 0.1 : 0.0001;
      if (Math.abs((activeSetup.sl ?? canonicalSL) - canonicalSL) > tick) {
        activeSetup.sl  = canonicalSL;
        const tpRes     = computeSweepTP(activeSetup.direction, activeSetup.entry, canonicalSL);
        activeSetup.tp1 = tpRes.tp1;
        activeSetup.tp2 = tpRes.tp2;
        activeSetup.tp3 = tpRes.tp3;
        repaired = true;
      }
    }

    // (2b) entryWindowTs: compute the absolute timestamp (sec) when entry window
    //     opens. First try candle-match (gives us real data alignment); fall
    //     back to PHASE2 cycle math based on the current trading day when the
    //     entry is still in the future (no candle yet).
    if (activeSetup.entryWindowTime && !activeSetup.entryWindowTs) {
      const target = activeSetup.entryWindowTime;
      const anchorTs = (activeSetup.createdTs ?? Date.now()) / 1000;
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hourCycle: "h23",
        hour: "2-digit", minute: "2-digit",
      });
      let found = candles.find(c =>
        c.timestamp >= anchorTs && fmt.format(new Date(c.timestamp * 1000)) === target
      )?.timestamp;
      if (!found) {
        // Future-time path: match the P2 cycle that produced nextPhase2Label.
        const p2Entry = Object.entries(PHASE2).find(([, p]) => p.label === activeSetup.nextPhase2Label);
        if (p2Entry) {
          const [, p2] = p2Entry;
          let ts = dayStartTs + (p2.startMin + 75) * 60;
          // If the current trading day's window already passed, jump to next day.
          if (ts <= anchorTs) ts += 24 * 3600;
          found = ts;
        }
      }
      if (found) { activeSetup.entryWindowTs = found; repaired = true; }
    }

    if (repaired) {
      await saveSetup(marketKey, activeSetup);
      reconcileActiveSetup(activeSetup); // propagate to setup_log + Mongo
    }

    // (3) Invalid-pattern gate: a WAITING_PHASE2 setup that lacks a time-ordered
    //     step 1 (step1Ts < step2Ts) is not a real sweep-sweep pattern — clear
    //     it so the user doesn't see a "SWEEP ✓ wacht entry" that never had a
    //     first leg. Only applies pre-entry; ACTIVE/CLOSED stays as historic.
    if (activeSetup && activeSetup.status === "WAITING_PHASE2") {
      const bad = !activeSetup.step1Ts || !activeSetup.step2Ts || activeSetup.step1Ts >= activeSetup.step2Ts;
      if (bad) {
        logEvent(marketKey, "SETUP_CLEARED",
          `${activeSetup.direction} ${activeSetup.tf} — step-1 not confirmed before step-2; invalid sweep pattern`,
          "skipped");
        await clearSetup(marketKey, activeSetup, "invalid sweep pattern"); activeSetup = null;
      }
    }

    if (activeSetup) {
      const { priceMin, priceMax } = MARKETS[marketKey];
      const entryOk = activeSetup.entry >= priceMin && activeSetup.entry <= priceMax;
      const dirOk   = !allowedDirection || allowedDirection === activeSetup.direction;
      // Once a setup is ACTIVE, the trade is live — let it mature to SL/TP via
      // verifySetupAgainstCandles instead of clearing it on a lock flip. Clearing
      // an ACTIVE setup orphans its setup_log entry (status stays ACTIVE forever)
      // because clearSetup only wipes per-market state + active_setups, not the log.
      const isActive = activeSetup.status === "ACTIVE";
      if (!entryOk) {
        logEvent(marketKey, "SETUP_CLEARED", `Corrupt setup (entry ${activeSetup.entry} outside range) — cleared`);
        await clearSetup(marketKey, activeSetup, `entry ${activeSetup.entry} outside range`); activeSetup = null;
      } else if (!dirOk && !isActive) {
        logEvent(marketKey, "SETUP_CLEARED", `Setup direction ${activeSetup.direction} conflicts with lock ${lockState?.direction} — cleared`);
        await clearSetup(marketKey, activeSetup, `bias flip → ${lockState?.direction}`); activeSetup = null;
      }
    }
  }

  // Process card events — all step-1 alerts first, then the first step-2 creates a setup
  for (const ev of tfEvents.filter(e => e.step === 1)) {
    const { tf, direction, ref, cycleLabel } = ev;
    const isBuy    = direction === "BUY";
    const hitTime  = isBuy ? ref.hitHigh?.time : ref.hitLow?.time;
    await sendDiscordStep1(marketKey, tf, direction, cycleLabel, ref.high, ref.low, hitTime);
  }

  // Smart-pick: when multiple TFs fire step-2 in same tick, pick the one whose
  // SL is positioned at the SAFEST extreme — furthest below entry for BUY,
  // furthest above entry for SELL. SL ≈ sweep depth ± buffer (per lib-sl), so
  // we rank by sweep depth: BUY → lowest swept low wins; SELL → highest swept high wins.
  // Result: SL sits beyond all other TFs' stops, surviving more market noise.
  const step2Events = tfEvents.filter(e => e.step === 2);
  const completeEv = step2Events.length <= 1 ? step2Events[0] : step2Events
    .map(ev => {
      const isBuy = ev.direction === "BUY";
      const swept = isBuy ? ev.ref.hitLow?.price : ev.ref.hitHigh?.price;
      return { ev, swept };
    })
    .sort((a, b) => {
      // BUY: ascending swept (lowest first = safest = furthest below entry).
      // SELL: descending swept (highest first = safest = furthest above entry).
      const isBuy = a.ev.direction === "BUY";
      const av = a.swept ?? (isBuy ?  Infinity : -Infinity);
      const bv = b.swept ?? (isBuy ?  Infinity : -Infinity);
      return isBuy ? av - bv : bv - av;
    })[0]?.ev;
  if (step2Events.length > 1 && completeEv) {
    console.log(`${tag} smart-pick: ${step2Events.length} step-2 events; picked ${completeEv.tf} (safest SL — furthest from entry)`);
  }
  if (completeEv) {
    const { tf, direction, ref, cycleLabel } = completeEv;
    const isBuy      = direction === "BUY";
    const bslLevel   = ref.high;
    const sslLevel   = ref.low;
    // Timestamps (seconds since epoch) for the two sweep hits — needed later to
    // compute the lowest/highest print across the WHOLE sweep window for SL.
    let step1Ts      = isBuy ? ref.hitHigh?.ts   : ref.hitLow?.ts;
    let step2Ts      = isBuy ? ref.hitLow?.ts    : ref.hitHigh?.ts;
    // Backscan: if the ref cycle didn't record step 1, scan candles between
    // the cycle's end and step 2 for the first candle that crossed the level.
    // Constrained to POST-CYCLE candles — pre-cycle candles that merely form
    // the level don't count as sweeps.
    if (!step1Ts && step2Ts) {
      const cycleEndTs = findCycleEndTs(cycleLabel, step2Ts, candles);
      if (cycleEndTs) {
        const level = isBuy ? bslLevel : sslLevel;
        const scanHit = candles
          .filter(c => c.timestamp >= cycleEndTs && c.timestamp < step2Ts)
          .sort((a, b) => a.timestamp - b.timestamp)
          .find(c => isBuy ? c.high >= level : c.low <= level);
        if (scanHit) step1Ts = scanHit.timestamp;
      }
    }
    // Manual-bias bypass: when admin has explicitly set BULLISH/BEARISH, allow
    // step-1 from a PRIOR cycle. Engine's default backscan only looks between
    // cycle-end and step-2 (a tiny window), which rejects valid cross-cycle
    // sweeps like "BSL hit at 17:00 in cycle A, SSL swept at 21:00 in cycle B".
    // Under manual bias, the admin signaled directional intent so we accept
    // any step-1 hit before step-2 within a reasonable lookback (24h).
    if (!step1Ts && step2Ts && (adminBias === "BULLISH" || adminBias === "BEARISH")) {
      const level = isBuy ? bslLevel : sslLevel;
      const minTs = step2Ts - 24 * 3600;
      const scanHit = candles
        .filter(c => c.timestamp >= minTs && c.timestamp < step2Ts)
        .sort((a, b) => b.timestamp - a.timestamp)  // most recent first
        .find(c => isBuy ? c.high >= level : c.low <= level);
      if (scanHit) {
        step1Ts = scanHit.timestamp;
        console.log(`${tag} manual-bias step-1 backscan: hit @ ${tsToETLabel(scanHit.timestamp)} (level=${level})`);
      }
    }
    // VALIDITY GATE: a valid sweep-sweep needs step 1 (level hit) BEFORE step 2
    // (opposite level swept). Without a confirmed, time-ordered step 1 this is
    // not a real sweep pattern — don't create a setup for it.
    const validSweepPattern = !!(step1Ts && step2Ts && step1Ts < step2Ts);
    if (!validSweepPattern) {
      logEvent(marketKey, "SETUP_SKIPPED",
        `${direction} | ${tf} | step-1 not confirmed before step-2 — invalid sweep pattern`,
        "skipped");
    }
    const step1Time  = step1Ts ? tsToETLabel(step1Ts) : (isBuy ? ref.hitHigh?.time : ref.hitLow?.time);
    const step2Time  = step2Ts ? tsToETLabel(step2Ts) : (isBuy ? ref.hitLow?.time  : ref.hitHigh?.time);
    const entryPrice = isBuy ? sslLevel : bslLevel;
    const sweepPrice = isBuy ? ref.hitLow?.price : ref.hitHigh?.price;
    const tfSrc      = tf === "90min" ? "90M" : tf === "22.5min" ? "22.5M" : tf;

    // Daily: entry fires on the OPEN of the next 06:00 ET candle strictly after
    // step-2 (no Phase2 window logic). 6H/90M: entry window opens at the 6H
    // Phase 2 start + 60min, entry candle is +15min later (handled at trigger).
    let entryWindowTime, entryWindowTs, nextPhase2Label;
    if (tf === "daily") {
      const dailyFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
      });
      const next6 = step2Ts
        ? candles.find(c => c.timestamp > step2Ts && dailyFmt.format(new Date(c.timestamp * 1000)) === "06:00")
        : null;
      entryWindowTime = "06:00";
      entryWindowTs   = next6?.timestamp ?? null;
      nextPhase2Label = "Daily 06:00";
    } else {
      // Prefer the currently-active Phase 2 window (we might still be in it).
      // Only fall back to the next P2 if we're currently between windows.
      const relevantP2 = phaseInfo.activeP2 ?? getNextPhase2(dayStartTs);
      // Entry candle opens at Phase 2 start + 75 min (e.g. C1 P2=19:30 → entry 20:45).
      // relevantP2.startMin is minutes-since-18:00 ET (the trading day anchor), so
      // to get clock-time we shift by 18h and wrap at 24h.
      const entryWindowMin = relevantP2 ? relevantP2.startMin + 75 : null;
      entryWindowTime = entryWindowMin != null
        ? (() => {
            const clockMin = (entryWindowMin + 18 * 60) % 1440;
            return `${String(Math.floor(clockMin / 60)).padStart(2, "0")}:${String(clockMin % 60).padStart(2, "0")}`;
          })()
        : null;
      // Absolute timestamp (seconds since epoch) of the entry candle —
      // lets the UI render the full date+time unambiguously (e.g. "Fri 04/24 08:45").
      entryWindowTs   = relevantP2 ? Math.floor(relevantP2.startTs + 75 * 60) : null;
      nextPhase2Label = relevantP2?.label ?? "soon";
    }

    // Don't clobber a live setup. Single-setup-per-market file format means
    // assigning a new setup to activeSetup overwrites the running ACTIVE/RUNNING
    // setup's tracking (entry, SL, TP progression, trigger flags). That breaks
    // verifySetupAgainstCandles + bridge state and orphans the broker position.
    // WAITING_PHASE2 may be replaced — it's pre-entry, the new sweep refines it.
    // True parallel-TF support requires a multi-setup architecture (Issue B,
    // deferred). For now: skip new-setup creation when a live setup is on file.
    const liveSetupExists = activeSetup
      && activeSetup.status !== "WAITING_PHASE2"
      && !String(activeSetup.status ?? "").startsWith("CLOSED")
      && !String(activeSetup.status ?? "").startsWith("CANCELLED")
      && !String(activeSetup.status ?? "").startsWith("INVALID");
    if (validSweepPattern && liveSetupExists) {
      logEvent(marketKey, "SETUP_BLOCKED",
        `${direction} | ${tf} new sweep — blocked by live ${activeSetup.tf} ${activeSetup.status} setup`,
        "skipped");
    }

    // Cross-TF same-window dedup: if ANOTHER TF already has a setup pointing
    // at the same entryWindowTs (= same entry candle), don't create a duplicate
    // here. Two setups firing at the same entry-time = two near-identical
    // orders, doubling broker exposure for no extra alpha. Different windows
    // (e.g. 6H 14:45 + 90M 02:45) keep both — those are genuinely separate trades.
    const sameWindowConflict = entryWindowTs && Object.entries(allTfSetups).some(([otherTf, s]) => {
      if (!s || otherTf === _currentTf) return false;
      // Only block against setups still active or pre-entry — closed setups don't conflict.
      const isLiveOrWaiting = s.status === "WAITING_PHASE2"
                           || s.status === "ACTIVE"
                           || s.status === "TP2_HIT_RUNNING";
      return isLiveOrWaiting && s.entryWindowTs === entryWindowTs;
    });
    if (validSweepPattern && !liveSetupExists && sameWindowConflict) {
      const conflictTf = Object.entries(allTfSetups).find(([otf, s]) =>
        s && otf !== _currentTf && s.entryWindowTs === entryWindowTs)?.[0];
      logEvent(marketKey, "SETUP_BLOCKED",
        `${direction} | ${tf} skipped — ${conflictTf} already has setup for entry-window ${nextPhase2Label}`,
        "skipped");
    }
    if (validSweepPattern && !liveSetupExists && !sameWindowConflict) {
    const setupId = `${marketKey}-${tfSrc}-${Date.now()}`;
    const setup = {
      id:              setupId,
      market:          marketKey,
      direction,
      tf,
      source:          tfSrc,
      bslLevel,
      sslLevel,
      level:           entryPrice,
      entry:           entryPrice,
      sl: null, tp1: null, tp2: null, tp3: null,
      sweepPrice,
      step1Time,
      step2Time,
      step1Ts,
      step2Ts,
      cycleLabel,
      adminBias,
      lockStrength:    lockState?.strength ?? 0,
      lockState:       lockState?.direction ?? null,
      createdTime:     tsToETLabel(Date.now() / 1000),
      createdTs:       Date.now(),
      status:          "WAITING_PHASE2",
      nextPhase2Label,
      entryWindowTime,              // "20:45" etc — when the entry candle opens
      entryWindowTs,                // seconds-since-epoch — for date-aware display
      entryTime:       null,         // set when entry triggers
      entryTriggered:  false,
      windowAlertSent: false,
      tp1Hit: false, tp2Hit: false, tp3Hit: false, slHit: false, slMovedToBE: false,
    };

    logEvent(marketKey, "SETUP_CREATED", `${direction} | ${tf} both swept | [${cycleLabel}] | Window: ${setup.nextPhase2Label}`, "setup_active");

    const setupLog = readJSON(SETUP_LOG_FILE, []);
    // Snapshot the current daily-lock direction at setup creation so the
    // journal can later filter by lock alignment without re-running detection.
    const lockAtEntry = lockState?.direction ?? null;
    const lockAlignmentAtEntry = lockAtEntry == null ? "none"
      : (direction === "BUY"  && lockAtEntry === "BULLISH") ? "with"
      : (direction === "SELL" && lockAtEntry === "BEARISH") ? "with"
      : "against";
    const logEntry = {
      id:        setupId,
      market:    marketKey,
      direction,
      tf,
      source:    tfSrc,
      side:      isBuy ? "LOW" : "HIGH",
      bslLevel,
      sslLevel,
      entry:     entryPrice,          // target entry — overwritten with actual at trigger
      sweepPrice,
      step1Time,
      step2Time,
      cycleLabel,
      window:    setup.nextPhase2Label,
      entryWindowTime,
      entryWindowTs,
      status:    "WAITING_PHASE2",
      sl: null, tp1: null, tp2: null, tp3: null,
      ts:        Date.now(),
      datetime:  tsToETDateTime(Date.now() / 1000),
      outcome:   null,
      lockAtEntry,
      lockStrength:   lockState?.strength ?? null,
      lockAlignment:  lockAlignmentAtEntry,
    };
    setupLog.unshift(logEntry);
    writeJSON(SETUP_LOG_FILE, setupLog.slice(0, 10000));
    mirrorSetupHistory(logEntry); // fire-and-forget durable copy

    updateWeeklyRecap(marketKey, { type: "setup", direction, source: tfSrc, entry: entryPrice, time: setup.createdTime });

    await saveSetup(marketKey, setup);
    activeSetup = setup;

    await sendDiscordSetup(setup);
    } // end validSweepPattern gate
  }

  // ── Phase 2 execution check ───────────────────────────────────────────────
  // Daily setups have no Phase2 — they fire on the OPEN of the 06:00 ET candle
  // exactly (entryWindowTs). Handle them BEFORE the 6H/90M phase2 path so the
  // shared trigger flow works without phaseInfo gating.
  if (activeSetup && activeSetup.status === "WAITING_PHASE2" && activeSetup.tf === "daily") {
    const ewTs = activeSetup.entryWindowTs;
    const entryCandle = ewTs ? candles.find(c => c.timestamp === ewTs) : null;
    if (entryCandle && !activeSetup.entryTriggered) {
      const dec = entryCandle.open > 100 ? 1 : 5;
      const actualEntry = +entryCandle.open.toFixed(dec);
      const slPrice = computeSweepSL({
        direction:  activeSetup.direction,
        candles,
        step2Ts:    activeSetup.step2Ts,
        entryTs:    entryCandle.timestamp,
        entryPrice: actualEntry,
        sweepPrice: activeSetup.sweepPrice,
      });
      const { tp1, tp2, tp3 } = computeSweepTP(activeSetup.direction, actualEntry, slPrice);
      activeSetup.entry = actualEntry;
      activeSetup.level = actualEntry;
      activeSetup.sl = slPrice;
      activeSetup.tp1 = tp1;
      activeSetup.tp2 = tp2;
      activeSetup.tp3 = tp3;
      activeSetup.tp3Hit = false;
      activeSetup.slMovedToBE = false;
      activeSetup.entryTriggered = true;
      activeSetup.status = "ACTIVE";
      activeSetup.entryTs = entryCandle.timestamp * 1000;
      activeSetup.entryTime = tsToETLabel(entryCandle.timestamp);
      const r = await fireEntryTrigger(marketKey, activeSetup, {
        sourceTag: "daily 06:00",
        dailyEq, sixHEq,
      });
      if (!r?.passed) activeSetup = null;  // filter cleared the active slot
    }
  }

  if (activeSetup && activeSetup.status === "WAITING_PHASE2" && activeSetup.tf !== "daily") {
    // Send entry window alert at Phase2.startMin + 60 (heads-up; entry candle fires at +75)
    if (phaseInfo.inPhase2 && !activeSetup.windowAlertSent) {
      const entryWindowMin = phaseInfo.activeP2.startMin + 60;
      if (phaseInfo.minsIntoDay >= entryWindowMin) {
        activeSetup.windowAlertSent = true;
        saveSetup(marketKey, activeSetup);
        const windowLabel = phaseInfo.activeP2.label;
        await sendDiscordEntryWindow(activeSetup, windowLabel);
      }
    }

    if (phaseInfo.inPhase2 && activeSetup.windowAlertSent) {
      // TIME-BASED entry: enter on the OPEN of the 15-min candle that opens
      // 75 min after Phase 2 start (e.g. 02:45 for C2). Skips the volatile
      // first candle at window-open (+60); gives a stable reference price.
      const entryCandleTs = phaseInfo.activeP2.startTs + 75 * 60;         // entry candle (e.g. 02:45)
      const windowCandles = candles.filter(c => c.timestamp >= entryCandleTs);

      if (!activeSetup.entryTriggered && windowCandles.length > 0) {
        const entryCandle = windowCandles[0];
        const actualEntry = entryCandle.open;

        const dec = actualEntry > 100 ? 1 : 5;
        const buf = actualEntry > 10000 ? 5 : actualEntry > 1000 ? 2 : actualEntry > 10 ? 0.5 : 0.0005;

        // SL structural: take the extreme of the ENTIRE sweep window.
        //   BUY  → lowest low  from step-2 SSL-sweep through entry candle (-buf)
        //   SELL → highest high from step-2 BSL-sweep through entry candle (+buf)
        // Canonical SL: delegate to computeSweepSL — single source of truth
        // for the sweep-window rule, shared with backtest + reconcile paths.
        const slPrice = computeSweepSL({
          direction:  activeSetup.direction,
          candles,
          step2Ts:    activeSetup.step2Ts,
          entryTs:    entryCandle.timestamp,
          entryPrice: actualEntry,
          sweepPrice: activeSetup.sweepPrice,
        });

        activeSetup.entry = +actualEntry.toFixed(dec);
        activeSetup.level = activeSetup.entry;
        activeSetup.sl    = slPrice;
        const { tp1, tp2, tp3 } = computeSweepTP(activeSetup.direction, activeSetup.entry, activeSetup.sl);
        activeSetup.tp1 = tp1;
        activeSetup.tp2 = tp2;
        activeSetup.tp3 = tp3;
        activeSetup.tp3Hit = false;
        activeSetup.slMovedToBE = false;

        activeSetup.entryTriggered = true;
        activeSetup.status  = "ACTIVE";
        activeSetup.entryTs = entryCandle.timestamp * 1000;
        activeSetup.entryTime = tsToETLabel(entryCandle.timestamp);

        const r = await fireEntryTrigger(marketKey, activeSetup, {
          sourceTag: `time-based | Window: ${phaseInfo.activeP2?.label}`,
          dailyEq, sixHEq,
        });
        if (!r?.passed) activeSetup = null;  // filter cleared the active slot
      } else if (!activeSetup.entryTriggered) {
        logEvent(marketKey, "WAITING_PHASE2_ENTRY", `${activeSetup.direction} @ ${activeSetup.entry} | Current: ${currentPrice} | Entry window open (14:30+)`, "waiting");
      }
    } else if (phaseInfo.inPhase2 && !activeSetup.windowAlertSent) {
      logEvent(marketKey, "WAITING_ENTRY_WINDOW", `${activeSetup.direction} setup — Phase 2 actief, wacht op entry window (+60 min)`, "waiting");
    } else {
      logEvent(marketKey, "ENTRY_SKIPPED", `${activeSetup.direction} setup — outside Phase 2 window. Phase: ${phaseInfo.phase} | Cycle: ${phaseInfo.currentCycle}`, "skipped");
    }
  }

  // ── Active trade monitoring ───────────────────────────────────────────────
  // Two live states are watched here: "ACTIVE" (pre-TP2) and "TP2_HIT_RUNNING"
  // (post-TP2, runner leg still open with SL trailed to entry / breakeven).
  if (activeSetup && (activeSetup.status === "ACTIVE" || activeSetup.status === "TP2_HIT_RUNNING")) {
    const { direction, entry, sl, tp1, tp2, tp3 } = activeSetup;
    const fp = p => p > 100 ? p.toFixed(1) : p.toFixed(5);
    const isRunner = activeSetup.status === "TP2_HIT_RUNNING";

    // Check SL (current sl reflects entry once slMovedToBE). Discord +
    // MetaApi side-effects unified in fireTradeEvent.
    //
    // CRITICAL: when isRunner, only consider candles AFTER the BE-MOVE moment.
    // Looking at all post-entry candles would falsely trigger BE-STOP on
    // historical candles whose lows happen to be at/below entry — those touched
    // entry during the natural price action BEFORE TP2 was hit, not as a real
    // post-TP2 reversal.
    if (!activeSetup.slHit) {
      const entryTsSec = (activeSetup.entryTs ?? 0) / 1000;
      const beTsSec    = (activeSetup.slMovedToBETs ?? 0) / 1000;
      const sinceTs    = isRunner && beTsSec > 0 ? beTsSec : entryTsSec;
      const slHit = direction === "BUY"
        ? candles.some(c => c.timestamp > sinceTs && c.low  <= sl)
        : candles.some(c => c.timestamp > sinceTs && c.high >= sl);
      if (slHit) {
        activeSetup.slHit = true;
        if (isRunner) {
          // Runner stopped at BE after TP2 already filled — overall WIN @ 2R.
          activeSetup.status = "CLOSED_TP2";
          await fireTradeEvent(marketKey, activeSetup, "RUNNER_BE_STOP");
        } else {
          activeSetup.status = "CLOSED_SL";
          await fireTradeEvent(marketKey, activeSetup, "SL_HIT");
        }
        saveSetup(marketKey, activeSetup);
      }
    }

    // Check TP1 (only relevant pre-runner)
    if (!isRunner && !activeSetup.tp1Hit && !activeSetup.slHit) {
      const tp1Hit = direction === "BUY"
        ? candles.some(c => c.timestamp > (activeSetup.entryTs ?? 0) / 1000 && c.high >= tp1)
        : candles.some(c => c.timestamp > (activeSetup.entryTs ?? 0) / 1000 && c.low  <= tp1);
      if (tp1Hit) {
        activeSetup.tp1Hit = true;
        await fireTradeEvent(marketKey, activeSetup, "TP1_HIT");
        saveSetup(marketKey, activeSetup);
      }
    }

    // Check TP2 (only relevant pre-runner). If tp3 leg exists → trade does NOT
    // close on TP2: cancel only the tp2 leg, move tp3's SL to entry, and
    // transition to TP2_HIT_RUNNING for the long-tail runner.
    if (!isRunner && !activeSetup.tp2Hit && !activeSetup.slHit) {
      const tp2Hit = direction === "BUY"
        ? candles.some(c => c.timestamp > (activeSetup.entryTs ?? 0) / 1000 && c.high >= tp2)
        : candles.some(c => c.timestamp > (activeSetup.entryTs ?? 0) / 1000 && c.low  <= tp2);
      if (tp2Hit) {
        activeSetup.tp2Hit = true;
        const hasRunner = tp3 != null && !activeSetup.slMovedToBE;
        if (hasRunner) {
          const beSL = activeSetup.entry;
          activeSetup.sl = beSL;
          activeSetup.slMovedToBE = true;
          activeSetup.slMovedToBETs = Date.now();   // anchor for SL check post-runner
          activeSetup.status = "TP2_HIT_RUNNING";
          await fireTradeEvent(marketKey, activeSetup, "TP2_HIT_RUNNER", { beSL });
        } else {
          activeSetup.status = "CLOSED_TP2";
          await fireTradeEvent(marketKey, activeSetup, "TP2_HIT_LEGACY");
        }
        saveSetup(marketKey, activeSetup);
      }
    }

    // Check TP3 (runner target, 10R) — only when runner is armed.
    if (isRunner && !activeSetup.tp3Hit && !activeSetup.slHit && tp3 != null) {
      const tp3Hit = direction === "BUY"
        ? candles.some(c => c.timestamp > (activeSetup.entryTs ?? 0) / 1000 && c.high >= tp3)
        : candles.some(c => c.timestamp > (activeSetup.entryTs ?? 0) / 1000 && c.low  <= tp3);
      if (tp3Hit) {
        activeSetup.tp3Hit = true;
        activeSetup.status = "CLOSED_TP3";
        await fireTradeEvent(marketKey, activeSetup, "TP3_HIT");
        saveSetup(marketKey, activeSetup);
      }
    }

    // Live PnL log — risk reference uses the original entry-to-SL distance
    // (so the R-multiple stays meaningful even after SL is trailed to BE).
    const pnl = direction === "BUY" ? currentPrice - entry : entry - currentPrice;
    const refRisk = activeSetup.slMovedToBE && tp1 != null
      ? Math.abs(entry - tp1)            // 1R = entry→tp1 distance once SL is on BE
      : Math.abs(entry - sl);
    const rr   = refRisk > 0 ? (pnl / refRisk).toFixed(2) : "0";
    logEvent(marketKey, "TRADE_ACTIVE", `${direction} | Entry: ${fp(entry)} | Now: ${fp(currentPrice)} | PnL: ${pnl > 0 ? "+" : ""}${pnl.toFixed(1)} pts | ${rr}R${isRunner ? " | RUNNER" : ""}`, "active");
  }

  // Reconcile: ensure setup_log reflects the canonical state of the active
  // setup (catches edge cases like mis-attributed outcomes or missed patches).
  reconcileActiveSetup(activeSetup);

  allTfSetups[_currentTf] = activeSetup ?? null;
  } // ── end per-TF loop ───────────────────────────────────────────────────

  // Pick a "primary" setup for downstream code (scalp anchor, market_data
  // dashboard write). Preference order: 6H first (longest horizon), then 90M,
  // then daily. Scalps still piggyback on whichever primary is active.
  let activeSetup = allTfSetups["6H"] ?? allTfSetups["90min"] ?? allTfSetups["daily"] ?? null;

  // Multi-setup orphan scan: pass ALL current per-TF setup ids so genuine
  // parallel setups don't get treated as orphans of each other.
  const activeIds = Object.values(allTfSetups).filter(s => s?.id).map(s => s.id);
  verifyOrphanedActives(marketKey, candles, activeIds, dailyEq, sixHEq);

  // ── SCALP detection (22.5M + 5.625M sweep-sweep aligned with ACTIVE primary) ─
  // Both cycle-tfs are scalps with +1h entry windows + 5R/8R TP. Independent
  // slots — each market can have a 22.5M scalp AND a 5.625M scalp open at once.
  let scalp22M = await loadScalp(marketKey, "22.5min");
  await processScalp({
    marketKey, activeSetup, activeScalp: scalp22M,
    cycles: cycles22M, cycleTf: "22.5min", cycleSource: "22.5M",
    candles1m, allowedDirection,
    onUpdate: (s) => { scalp22M = s; },
  });
  let scalp5M = await loadScalp(marketKey, "5.625min");
  await processScalp({
    marketKey, activeSetup, activeScalp: scalp5M,
    cycles: cycles5M, cycleTf: "5.625min", cycleSource: "5.6M",
    candles1m, allowedDirection,
    onUpdate: (s) => { scalp5M = s; },
  });

  // ── Write market data for dashboard/API ───────────────────────────────────
  const lastCandle = candles[candles.length - 1];
  // Daily entry reference: the OPEN of the 06:00 ET candle on the current
  // trading day. Used by the Daily card on the dashboard to show real entry
  // price + live PnL when the daily pattern triggers at 06:00.
  const dailyEntryFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
  });
  let dailyEntryOpen = null, dailyEntryTs = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (dailyEntryFmt.format(new Date(c.timestamp * 1000)) === "06:00") {
      dailyEntryOpen = c.open;
      dailyEntryTs   = c.timestamp;
      break;
    }
  }
  writeMarketData(marketKey, {
    market: marketKey,
    label: MARKETS[marketKey].label,
    tvSymbol: MARKETS[marketKey].tvSymbol,
    currentPrice,
    currentTime,
    dailyEntryOpen,
    dailyEntryTs,
    adminBias,
    lockState: lockState ? {
      direction:     lockState.direction,
      strength:      lockState.strength,
      note:          lockState.note,
      keyDates:      lockState.keyDates ?? [],
      matchCount:    lockState.matchCount,
      daysSinceLast: lockState.daysSinceLast,
      movesAgainst:  lockState.movesAgainst,
      steps:         lockState.steps ?? [],
    } : null,
    sixHLockState: sixHLockState ? {
      direction:     sixHLockState.direction,
      strength:      sixHLockState.strength,
      note:          sixHLockState.note,
      matchCount:    sixHLockState.matchCount,
      daysSinceLast: sixHLockState.daysSinceLast,
      movesAgainst:  sixHLockState.movesAgainst,
      steps:         sixHLockState.steps ?? [],
    } : null,
    orderFlowBias,
    allowedDirection,
    phaseInfo: {
      phase: phaseInfo.phase,
      inPhase2: phaseInfo.inPhase2,
      currentCycle: phaseInfo.currentCycle,
      activeP2: phaseInfo.activeP2 ? { cycle: phaseInfo.activeP2.cycle, label: phaseInfo.activeP2.label } : null,
    },
    activeSetup,
    // All per-TF setups, so the dashboard/API can show parallel 6H + 90M + daily
    // setups simultaneously instead of just the primary one.
    activeSetups: allTfSetups,
    cycles6H: Object.values(cycles6H).map(c => ({
      name: c.name, label: c.label, status: c.status,
      high: c.high, low: c.low, hitHigh: c.hitHigh, hitLow: c.hitLow,
    })),
    cycles90: Object.values(cycles90)
      .sort((a, b) => a.index - b.index)
      .slice(-8)
      .map(c => ({
        index: c.index, startTime: c.startTime, endTime: c.endTime,
        complete: c.complete, high: c.high, low: c.low,
        hitHigh: c.hitHigh, hitLow: c.hitLow,
      })),
    cycles22M: Object.values(cycles22M)
      .sort((a, b) => a.index - b.index)
      .slice(-12) // last ~4.5 hours of 22.5M cycles
      .map(c => ({
        index: c.index, startTime: c.startTime, endTime: c.endTime,
        complete: c.complete, high: c.high, low: c.low,
        hitHigh: c.hitHigh, hitLow: c.hitLow,
      })),
    cycles5M: Object.values(cycles5M)
      .sort((a, b) => a.index - b.index)
      .slice(-16) // last ~1.5 hours of 5.625M cycles
      .map(c => ({
        index: c.index, startTime: c.startTime, endTime: c.endTime,
        complete: c.complete, high: c.high, low: c.low,
        hitHigh: c.hitHigh, hitLow: c.hitLow,
      })),
    activeScalps: { "22.5min": scalp22M, "5.625min": scalp5M },
    dailyLevels: (() => {
      // Prefer D-TF levels (correct session boundaries matching user's chart).
      // D-candle labels are now close-date-aligned (+1 day fix in buildDailyLockMoves).
      const all = dailyLockLevels ?? dailyDays.slice(-10).map(d => ({
        date: d.date, high: d.high, low: d.low,
        hitHigh: d.hitHigh, hitLow: d.hitLow, isToday: d.isToday,
      }));
      const keys = lockState?.keyDates ?? [];
      if (!keys.length) return all.slice(-7);
      // Always include the 7 most recent consecutive trading days so the signal card
      // can scan a full week of sweep history — not just sparse lock key dates.
      const last7Dates = new Set(all.slice(-7).map(d => d.date));
      return all.filter(d => keys.includes(d.date) || last7Dates.has(d.date));
    })(),
    scanMeta: {
      candleCount: candles.length,
      from: candles[0]?.time_et,
      to: lastCandle?.time_et,
      stale: (Date.now() - (lastCandle?.timestamp ?? 0) * 1000) > 20 * 60 * 1000,
    },
  });
}

// ── Main Loop ─────────────────────────────────────────────────────────────────
async function runMarket(marketKey) {
  if (!isMarketOpen(marketKey)) {
    console.log(`[${marketKey}] Market closed, skipping`);
    return;
  }

  const tag = `[${marketKey}]`;
  console.log(`\n${tag} ── Starting analysis ─────────────────────`);
  logEvent(marketKey, "PHASE_TRANSITION", `Starting scan | ${tsToETLabel(Date.now() / 1000)} ET`, "scan_start");

  try {
    const switched = await switchToMarket(marketKey);
    if (!switched) {
      logEvent(marketKey, "SYSTEM_ERROR", "Chart switch failed — skipping market", "error");
      return;
    }

    // 1. Daily lock is now computed inside analyzeMarket from 18:00-ET-aligned
    //    15-min aggregation (buildDailyStructure). No D-TF pre-fetch needed —
    //    TV's D-candles for crypto/Coinbase are UTC-aligned which clashes with
    //    the rest of this engine's 18:00-ET trading-day model.
    const dailyLockState = null;
    const dailyLockLevels = null;

    // 2. Fetch 15-min candles — uses on-disk cache, only fetches delta via CDP
    const { candles, staleWarning, diffMin } = await fetchCandlesWithCache(marketKey);
    console.log(`${tag} ${candles.length} candles. Last: ${candles[candles.length-1]?.time_et} (${(diffMin||0).toFixed(1)}min old)`);

    // Market data robustness: validate the fetched candles belong to the correct market.
    // switchToMarket already checked price after switch, but candles could drift if the
    // MCP session silently switched symbol. Re-validate every scan cycle.
    const { priceMin: pMin, priceMax: pMax } = MARKETS[marketKey];
    const lastClose = candles[candles.length - 1]?.close;
    if (lastClose == null || lastClose < pMin || lastClose > pMax) {
      logEvent(marketKey, "MARKET_MISMATCH",
        `15m close ${lastClose} outside expected [${pMin}–${pMax}] for ${marketKey} — skipping to prevent data corruption`,
        "error");
      _mcpSession = null; // force full reconnect next run
      return;
    }

    if (staleWarning) {
      logEvent(marketKey, "SYSTEM_WARNING", `Candles stale: ${(diffMin||0).toFixed(1)} min old`, "warning");
    }

    // Persist candle cache — keep 3 weeks of 15-min bars (~2016 candles)
    writeJSON(join(__dir, `candles_${marketKey}.json`), candles.slice(-2016));

    // 1m candles for 22.5M cycles — populated by fetch_candles cron (*/2 min in
    // staging, FILTER_TFS=1). Sanitize to drop wrong-market contamination.
    let candles1m = null;
    try {
      const raw = readFileSync(join(__dir, `candles_1m_${marketKey}.json`), "utf8");
      candles1m = sanitizeCandles(JSON.parse(raw), marketKey);
      const ageMin = candles1m.length ? (Date.now()/1000 - candles1m[candles1m.length-1].timestamp) / 60 : Infinity;
      if (ageMin > 10) console.warn(`${tag} 1m candles ${ageMin.toFixed(1)} min old — 22.5M may be stale`);
    } catch { /* file absent on first deploy — 22.5M cycles fall back to {} */ }

    await analyzeMarket(marketKey, candles, dailyLockState, dailyLockLevels, candles1m);

  } catch (err) {
    console.error(`${tag} Error: ${err.message}`);
    logEvent(marketKey, "SYSTEM_ERROR", err.message, "error");
    _mcpSession = null;
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  BLACKBULL Liquidity Execution Engine v3.0");
  console.log(`  ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`);
  console.log("═══════════════════════════════════════════════════════");

  initAdminBias();

  const etH = tsToETHours(Date.now() / 1000);
  const marketsToRun = ACTIVE_MARKETS.filter(k => isMarketOpen(k));
  console.log(`Running ${marketsToRun.length} markets (ET ${etH.toFixed(1)}h)`);

  for (let i = 0; i < marketsToRun.length; i++) {
    const marketKey = marketsToRun[i];
    await runMarket(marketKey);
    if (i < marketsToRun.length - 1) {
      console.log(`Waiting 3s before next market...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // Return TradingView to NAS100 after all markets
  try {
    await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol: MARKETS["NAS100"].tvSymbol } });
  } catch {}

  console.log(`\n✅ All markets analyzed. ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET`);
  await closeDB();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
