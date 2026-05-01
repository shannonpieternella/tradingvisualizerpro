// Backfill `lockAtEntry` + `lockAlignment` on every closed trade in setup_log.json
// (and Mongo `setup_history` if available). Uses the in-memory 15-min candle cache
// per market (candles_<MK>.json) to reconstruct the daily-lock direction at the
// trade's entryTs using the same detector the live engine uses.
//
// Run: node backfill-locks.mjs

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { computeLockAtTime, classifyLockAlignment } from "./lib-lock.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SETUP_LOG_FILE = join(__dir, "setup_log.json");

// Load all per-market candle caches once. Older trades whose market has no
// candles cached can't be backfilled (lockAtEntry stays null).
function loadCandlesCache() {
  const cache = {};
  for (const mk of ["NAS100","US500","US30","XAUUSD","GBPUSD","BTCUSD","ETHUSD"]) {
    const fp = join(__dir, `candles_${mk}.json`);
    if (!existsSync(fp)) continue;
    try {
      const arr = JSON.parse(readFileSync(fp, "utf8"));
      if (Array.isArray(arr) && arr.length) cache[mk] = arr;
    } catch (e) {
      console.warn(`[${mk}] failed to load candles: ${e.message}`);
    }
  }
  return cache;
}

async function maybeOpenMongo() {
  try {
    const envPath = join(__dir, "../.env");
    const env = {};
    try {
      readFileSync(envPath, "utf8").split("\n").forEach(line => {
        const [k, ...v] = line.split("=");
        if (k?.trim() && v.length) env[k.trim()] = v.join("=").trim();
      });
    } catch {}
    const uri = process.env.MONGO_URI || env.MONGO_URI;
    if (!uri) return null;
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    return { client, db: client.db("tradingvisualizer") };
  } catch (e) {
    console.warn(`[Mongo] open failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const log = JSON.parse(readFileSync(SETUP_LOG_FILE, "utf8"));
  console.log(`Loaded ${log.length} setup_log entries`);

  const candleCache = loadCandlesCache();
  console.log(`Markets with cached candles: ${Object.keys(candleCache).join(", ")}`);

  const stats = { processed: 0, withLock: 0, againstLock: 0, noLock: 0, missingData: 0, skipped: 0 };
  const updated = [];

  for (const trade of log) {
    if (trade.outcome !== "WIN" && trade.outcome !== "LOSS") {
      stats.skipped++;
      continue;
    }
    stats.processed++;

    const entryTsMs = trade.entryTs ?? trade.ts;
    if (!entryTsMs) { stats.missingData++; continue; }
    const entryTsSec = Math.floor(entryTsMs / 1000);

    const candles = candleCache[trade.market];
    if (!candles?.length) { stats.missingData++; continue; }

    // Need at least some history before entry — skip if entry predates our cache
    const earliest = candles[0].timestamp;
    if (entryTsSec < earliest + 4 * 86400) { stats.missingData++; continue; }

    const lock = computeLockAtTime(candles, entryTsSec);
    const lockDir = lock?.direction ?? null;
    const alignment = classifyLockAlignment(trade.direction, lockDir);

    trade.lockAtEntry      = lockDir;
    trade.lockStrength     = lock?.strength ?? null;
    trade.lockAlignment    = alignment;

    if      (alignment === "with")    stats.withLock++;
    else if (alignment === "against") stats.againstLock++;
    else                              stats.noLock++;

    updated.push(trade);
  }

  // Persist
  writeFileSync(SETUP_LOG_FILE, JSON.stringify(log, null, 2));
  console.log(`Wrote ${SETUP_LOG_FILE}`);

  const mongo = await maybeOpenMongo();
  if (mongo) {
    const coll = mongo.db.collection("setup_history");
    let writes = 0;
    for (const t of updated) {
      try {
        const r = await coll.updateOne(
          { _id: t.id },
          { $set: { lockAtEntry: t.lockAtEntry, lockStrength: t.lockStrength, lockAlignment: t.lockAlignment, updatedAt: new Date() } },
        );
        if (r.matchedCount) writes++;
      } catch (e) { console.warn(`[Mongo] ${t.id}: ${e.message}`); }
    }
    console.log(`Mongo: updated ${writes} setup_history docs`);
    await mongo.client.close();
  }

  console.log("\nBackfill summary:");
  console.log(`  processed:     ${stats.processed}`);
  console.log(`  with lock:     ${stats.withLock}`);
  console.log(`  against lock:  ${stats.againstLock}`);
  console.log(`  no lock:       ${stats.noLock}`);
  console.log(`  missing data:  ${stats.missingData}`);
  console.log(`  skipped (open):${stats.skipped}`);
}

main().catch(e => { console.error(e); process.exit(1); });
