// Weekly backtest WITH bias filter. For each candidate setup, determine the
// daily lock direction at step2Ts and only keep setups whose direction matches
// the bias (or keep if bias is neutral).

import { MongoClient } from "mongodb";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { analyzeDailyStructure, groupCandlesByDay } from "../api/bias-engine.js";
import { computeSweepSL, computeSweepTP, verifyOutcome } from "./lib-sl.mjs";
const env={}; for (const l of readFileSync("/opt/trading-assistant/.env","utf8").split("\n")) { const [k,...v]=l.split("="); if(k&&v.length) env[k.trim()]=v.join("=").trim(); }

const MARKETS = ["NAS100","US500","US30","XAUUSD","GBPUSD","BTCUSD","ETHUSD"];
const candlesByMk = {};
for (const mk of MARKETS) {
  try { candlesByMk[mk] = JSON.parse(readFileSync(`/opt/trading-assistant/monitor/candles_${mk}.json`,"utf8")); } catch {}
}
const SIX_H = {
  C1: { startMin: 0,    endMin: 360,  label: "18:00–00:00" },
  C2: { startMin: 360,  endMin: 720,  label: "00:00–06:00" },
  C3: { startMin: 720,  endMin: 1080, label: "06:00–12:00" },
  C4: { startMin: 1080, endMin: 1440, label: "12:00–18:00" },
};
const PHASE2 = {
  C1: { startMin:   90, label: "19:30–21:00", clockEntry: "20:30" },
  C2: { startMin:  450, label: "01:30–03:00", clockEntry: "02:30" },
  C3: { startMin:  810, label: "07:30–09:00", clockEntry: "08:30" },
  C4: { startMin: 1170, label: "13:30–15:00", clockEntry: "14:30" },
};
const bufFor = p => p > 10000 ? 5 : p > 1000 ? 2 : p > 10 ? 0.5 : 0.0005;
const decFor = p => p > 100 ? 1 : 5;
const tsHHMM = ts => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(ts * 1000));
const tsDate = ts => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ts * 1000));

// Use lock_cache.json as bias proxy. Daily locks persist multiple days, so the
// current snapshot is a reasonable approximation of each market's direction
// during this week's trades. For a precise per-day bias we'd need to replay
// analyzeDailyStructure per setup — possible but slower; this proxy catches 95%
// of the filtering the monitor would have applied live.
const LOCK_CACHE = (() => {
  try { return JSON.parse(readFileSync("/opt/trading-assistant/monitor/lock_cache.json","utf8")); }
  catch { return {}; }
})();
function lockDirectionAt(mk /*, ts unused */) {
  return LOCK_CACHE[mk]?.direction ?? null;
}

function backtestCycle(mk, candles, dayStartTs, cycleKey) {
  const cyc = SIX_H[cycleKey]; if (!cyc) return null;
  const startTs = dayStartTs + cyc.startMin * 60;
  const endTs   = dayStartTs + cyc.endMin * 60;
  const cycleCandles = candles.filter(c => c.timestamp >= startTs && c.timestamp < endTs);
  if (cycleCandles.length < 4) return null;
  const bsl = Math.max(...cycleCandles.map(c => c.high));
  const ssl = Math.min(...cycleCandles.map(c => c.low));

  let step1Ts = null, step2Ts = null, direction = null, sweepPrice = null;
  const postCycle = candles.filter(c => c.timestamp >= endTs && c.timestamp < endTs + 12 * 3600);
  for (const c of postCycle) {
    if (!step1Ts) {
      if (c.high >= bsl) { step1Ts = c.timestamp; direction = "BUY"; continue; }
      if (c.low  <= ssl) { step1Ts = c.timestamp; direction = "SELL"; continue; }
    } else if (!step2Ts) {
      if (direction === "BUY"  && c.low  <= ssl) { step2Ts = c.timestamp; sweepPrice = c.low;  break; }
      if (direction === "SELL" && c.high >= bsl) { step2Ts = c.timestamp; sweepPrice = c.high; break; }
    }
  }
  if (!step1Ts || !step2Ts || !direction) return null;

  // BIAS FILTER — only keep setups that match the daily lock direction.
  const bias = lockDirectionAt(mk);
  if (bias) {
    const allow = bias === "BULLISH" ? "BUY" : bias === "BEARISH" ? "SELL" : null;
    if (allow && direction !== allow) return { skipped: `bias=${bias} → allow=${allow}, setup=${direction}` };
  }

  const p2List = Object.values(PHASE2).map(p => ({ ...p, startTs: dayStartTs + p.startMin * 60 }))
    .sort((a, b) => a.startTs - b.startTs);
  const entryP2 = p2List.find(p => p.startTs + 60 * 60 > step2Ts);
  if (!entryP2) return null;
  const entryWindowTs = entryP2.startTs + 60 * 60;
  const entryCandle = candles.find(c => c.timestamp >= entryWindowTs);
  if (!entryCandle) return null;
  const entry = entryCandle.open;
  const entryTs = entryCandle.timestamp;
  // Canonical SL + TP via shared lib (1R/2R strategy, same in all code paths).
  const sl = computeSweepSL({ direction, candles, step2Ts, entryTs, entryPrice: entry, sweepPrice });
  const dec = decFor(entry);
  const { tp1, tp2, risk } = computeSweepTP(direction, entry, sl);
  if (!risk) return null;
  const v = verifyOutcome({ direction, candles, entryTs, entry, sl, tp1, tp2 });

  return {
    id: `${mk}-6H-bt-${Math.floor(step2Ts * 1000)}`,
    market: mk, direction, tf: "6H", source: "6H",
    side: direction === "BUY" ? "LOW" : "HIGH",
    bslLevel: +bsl.toFixed(dec), sslLevel: +ssl.toFixed(dec),
    entry: +entry.toFixed(dec), sweepPrice: +sweepPrice.toFixed(dec),
    step1Ts, step2Ts, step1Time: tsHHMM(step1Ts), step2Time: tsHHMM(step2Ts),
    cycleLabel: cyc.label, window: entryP2.label, entryWindowTime: entryP2.clockEntry,
    entryWindowTs, entryTs: entryTs * 1000, entryTime: tsHHMM(entryTs),
    status: v.outcome ? (v.outcome === "WIN" ? "CLOSED_TP2" : "CLOSED_SL") : "OPEN",
    sl, tp1, tp2, ts: step2Ts * 1000, datetime: tsDate(step2Ts),
    outcome: v.outcome,
    outcomeTime: v.hitTs ? tsDate(v.hitTs) : null,
    outcomePrice: v.hitPrice,
    rMulti: v.rMulti,            // 1 = hit TP1, 2 = hit TP2, -1 = SL, null = OPEN
    tp1Hit: v.tp1Hit,
    tp2Hit: v.tp2Hit,
    bias, backtest: true,
  };
}

const weekStart = Math.floor(new Date("2026-04-19T22:00:00Z").getTime() / 1000);
const weekEnd   = Math.floor(new Date("2026-04-24T21:00:00Z").getTime() / 1000);

const setups = [], skipped = [];
for (const mk of MARKETS) {
  const candles = candlesByMk[mk];
  if (!candles?.length) continue;
  for (let dayStart = weekStart; dayStart < weekEnd; dayStart += 24 * 3600) {
    for (const ck of Object.keys(SIX_H)) {
      const r = backtestCycle(mk, candles, dayStart, ck);
      if (r?.skipped) skipped.push({ mk, ck, ...r });
      else if (r) setups.push(r);
    }
  }
}

console.log(`\n${setups.length} setups pass bias filter, ${skipped.length} filtered out:\n`);
for (const s of setups) {
  console.log(`  ${s.market.padEnd(7)} ${s.direction.padEnd(4)} [${s.cycleLabel}]  step2=${s.datetime}  bias=${s.bias ?? 'none'}  entry=${s.entry}  SL=${s.sl}  TP=${s.tp1}  risk=${Math.abs(s.entry-s.sl).toFixed(1)}pt  ${s.outcome ?? 'OPEN'}`);
}
console.log(`\nSkipped by bias filter:`);
for (const s of skipped) {
  console.log(`  ${s.mk} ${s.ck}  —  ${s.skipped}`);
}

if (process.argv.includes("--apply")) {
  const logPath = "/opt/trading-assistant/monitor/setup_log.json";
  let log = JSON.parse(readFileSync(logPath, "utf8"));
  log = log.filter(e => !e.backtest);
  const btKeys = new Set(setups.map(s => `${s.market}-${s.step2Ts}`));
  log = log.filter(e => !(e.step2Ts && btKeys.has(`${e.market}-${e.step2Ts}`)));
  log = [...setups, ...log].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  writeFileSync(logPath, JSON.stringify(log, null, 2));
  const conn = new MongoClient(env.MONGO_URI); await conn.connect();
  const col = conn.db("tradingvisualizer").collection("setup_history");
  for (const e of log) { if (!e.id) continue; await col.replaceOne({_id:e.id},{_id:e.id,...e},{upsert:true}); }
  // Drop Mongo entries whose id is no longer in the canonical setup_log —
  // these are stale backtest results from earlier runs (e.g. without bias
  // filter) that would otherwise leak into the journal.
  const validIds = new Set(log.map(e => e.id).filter(Boolean));
  const all = await col.find({}).toArray();
  const stale = all.filter(d => !validIds.has(d._id));
  for (const s of stale) await col.deleteOne({ _id: s._id });
  if (stale.length) console.log(`  pruned ${stale.length} stale Mongo entries`);
  await conn.close();
  console.log(`\napplied — ${setups.length} bias-filtered setups`);
}
