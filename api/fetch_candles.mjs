/**
 * Fetch multi-timeframe candles for all markets via MCP.
 * Saves: candles_15_MARKET.json, candles_1H_MARKET.json, candles_1D_MARKET.json
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

const MARKETS = {
  NAS100: "CAPITALCOM:US100",
  US500:  "CAPITALCOM:US500",
  US30:   "CAPITALCOM:US30",
  XAUUSD: "CAPITALCOM:GOLD",
  GBPUSD: "FX:GBPUSD",
  BTCUSD: "COINBASE:BTCUSD",
  ETHUSD: "COINBASE:ETHUSD",
};

// Timeframes to fetch: [tvTF, count, fileSuffix]
const TIMEFRAMES = [
  ["D",  500,  "1D"],  // daily candles — for weekly + daily structure analysis
  ["60", 1000, "1H"],  // 1h candles   — for 6h cycle analysis
  ["15", 2000, "15"],  // 15-min       — for live cycle display + current price
];

for (const [market, symbol] of Object.entries(MARKETS)) {
  console.log(`\n=== ${market} (${symbol}) ===`);
  await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol } });
  await sleep(2000);

  for (const [tf, count, suffix] of TIMEFRAMES) {
    console.log(`  [${tf}] Fetching ${count} candles...`);
    try {
      await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: tf } });
      await sleep(1500);
      const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
      const raw = result?.content?.[0]?.text;
      if (!raw) { console.error(`    No data`); continue; }
      const candles = JSON.parse(raw);
      if (!Array.isArray(candles) || !candles.length) { console.error(`    Empty`); continue; }
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
