/**
 * Fetch multi-timeframe candles for all markets via MCP.
 * Saves: candles_1m_MARKET.json, candles_15_MARKET.json, candles_1H_MARKET.json,
 *        candles_1D_MARKET.json
 *
 * FILTER_TFS env var: comma-separated tvTF codes (e.g. "1" or "1,15"). Limits
 * fetch to that subset — used in staging to fetch only 1m without overwriting
 * the 15/1H/1D files (which staging shares via symlink with live).
 */
import fetch from "node-fetch";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, "../.env");
const env = {};
try {
  readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k && v.length) env[k.trim()] = v.join("=").trim();
  });
} catch {}

const MCP_TOKEN = process.env.MCP_TOKEN || env.MCP_TOKEN;
// MCP_URL override-able via env so the 1m fetch cron can target the fast-lane
// endpoint (/mcp-fast → tab #1) and stop competing with monitor.js for the
// main MCP/CDP lock. Defaults to the original /mcp for backwards compat.
const MCP_URL   = process.env.MCP_URL || env.MCP_URL || "https://178-104-80-233.sslip.io/mcp";
const headers   = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
  ...(MCP_TOKEN ? { Authorization: `Bearer ${MCP_TOKEN}` } : {}),
};
let _session = null;

async function mcpCall(method, params = {}) {
  if (!_session) {
    const r = await fetch(MCP_URL, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"initialize",
        params:{ protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{ name:"fetch-candles", version:"1.0" } } }),
    });
    _session = r.headers.get("mcp-session-id");
    console.log("MCP session:", _session);
  }
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": _session },
    body: JSON.stringify({ jsonrpc:"2.0", id:2, method, params }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    const l = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!l) continue;
    try { const o = JSON.parse(l); if (o.result !== undefined) return o.result; if (o.error) throw new Error(JSON.stringify(o.error)); } catch {}
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Symbol + price range. Range is used to detect symbol-switch lag: if MCP
// returns candles whose close falls outside the range, the chart hadn't yet
// switched, so we retry. Tightened to current realistic ranges (mirrors
// monitor.js MARKETS) so cross-market contamination (NAS prices in BTC file
// etc.) gets caught by the price-range guard.
const MARKETS = {
  NAS100: { symbol: "CAPITALCOM:US100",  min: 18000, max: 35000 },
  US500:  { symbol: "CAPITALCOM:US500",  min:  5500, max:  9000 },
  US30:   { symbol: "CAPITALCOM:US30",   min: 38000, max: 60000 },
  XAUUSD: { symbol: "CAPITALCOM:GOLD",   min:  3500, max:  6000 },
  GBPUSD: { symbol: "FX:GBPUSD",         min:   1.1, max:   1.6 },
  BTCUSD: { symbol: "COINBASE:BTCUSD",   min: 50000, max: 200000 },
  ETHUSD: { symbol: "COINBASE:ETHUSD",   min:  1500, max:  3500 },
};

// Timeframes to fetch: [tvTF, count, fileSuffix]
const ALL_TIMEFRAMES = [
  ["D",  500,  "1D"],  // daily candles — for weekly + daily structure analysis
  ["60", 1000, "1H"],  // 1h candles   — for 6h cycle analysis
  ["15", 2000, "15"],  // 15-min       — for live cycle display + current price
  ["1",  2000, "1m"],  // 1-min        — for 22.5-min cycle analysis
];

// Optional FILTER_TFS env var: comma-separated tvTF codes to limit which TFs run.
const _filter = (process.env.FILTER_TFS || env.FILTER_TFS || "").trim();
const _filterSet = _filter ? new Set(_filter.split(",").map(s => s.trim())) : null;
const TIMEFRAMES = _filterSet
  ? ALL_TIMEFRAMES.filter(([tf]) => _filterSet.has(tf))
  : ALL_TIMEFRAMES;
if (_filterSet) {
  console.log(`FILTER_TFS=${_filter} → fetching only: ${TIMEFRAMES.map(t => t[2]).join(", ")}`);
}

// Mirror monitor.js's market-hours gate: when an index/forex market is closed
// (weekend or after Friday 17:00 ET), refetching its candles produces the same
// data we already have on disk and just causes extra MCP/TradingView traffic
// that competes with the always-open crypto fetches. Skip closed markets.
const CRYPTO = new Set(["BTCUSD", "ETHUSD"]);
function isOpen(marketKey) {
  if (CRYPTO.has(marketKey)) return true;
  const now = new Date();
  const wd  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(now)
  );
  if (wd === 0 || wd === 6) return false; // weekend
  // Hour-of-ET — basic Friday-late check; engine has finer windows but this
  // is enough to skip Saturday morning fetches that ran on Friday's data.
  const etH = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(now));
  if (wd === 5 && etH >= 17) return false; // Friday after 17:00 ET
  return true;
}

for (const [market, meta] of Object.entries(MARKETS)) {
  if (!isOpen(market)) {
    console.log(`\n=== ${market} — market closed, skipping ===`);
    continue;
  }
  const { symbol, min: priceMin, max: priceMax } = meta;
  console.log(`\n=== ${market} (${symbol}) ===`);
  await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol } });
  // 1m fetch needs longer settle time — chart history loads more bars after switch
  await sleep(3500);

  for (const [tf, count, suffix] of TIMEFRAMES) {
    console.log(`  [${tf}] Fetching ${count} candles...`);
    try {
      await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: tf } });
      await sleep(2500);
      // Retry up to 5× on price-range mismatch (catches symbol-switch lag).
      let candles = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
        const raw = result?.content?.[0]?.text;
        if (!raw) { console.error(`    No data (attempt ${attempt})`); await sleep(4000); continue; }
        const c = JSON.parse(raw);
        if (!Array.isArray(c) || !c.length) { console.error(`    Empty (attempt ${attempt})`); await sleep(4000); continue; }
        const last = c[c.length - 1].close;
        if (last < priceMin || last > priceMax) {
          console.warn(`    Out-of-range close ${last} (attempt ${attempt}, range ${priceMin}-${priceMax}) — chart not switched yet, retrying`);
          // Re-issue symbol+TF + extra settle time so the chart fully reloads
          await mcpCall("tools/call", { name: "change_symbol",    arguments: { symbol } });
          await sleep(2000);
          await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: tf } });
          await sleep(4000);
          continue;
        }
        candles = c;
        break;
      }
      if (!candles) { console.error(`    Gave up after 5 attempts — skipping ${market}/${tf}`); continue; }
      const outFile = join(__dir, `../monitor/candles_${suffix}_${market}.json`);
      writeFileSync(outFile, JSON.stringify(candles.slice(-count), null, 2));
      console.log(`    Saved ${candles.length} candles → range: ${candles[0].time_et} → ${candles[candles.length-1].time_et}`);
    } catch (e) {
      console.error(`    Error:`, e.message);
    }
    await sleep(500);
  }
  // Restore to 15-min for monitor compatibility
  await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: "15" } });
  await sleep(500);
}
console.log("\nDone.");
