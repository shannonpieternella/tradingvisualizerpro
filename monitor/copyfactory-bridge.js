// Monitor → CopyFactory bridge.
// Called from monitor.js whenever a setup transitions to ACTIVE (entry fired).
// Sends two external signals per setup (split-position model: TP1 leg + TP2
// leg) to the master strategy; CopyFactory replicates them to all subscribers
// per their per-user symbolFilter + tradeSizeScaling.
//
// Paper-mode default: when COPY_LIVE != "true", we only log what would be sent.
// Flip COPY_LIVE=true in /opt/trading-assistant/.env once the end-to-end flow
// has been verified on the demo subscriber.

import { readFileSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

// CopyFactory requires signalId to be 8 alphanumerical characters. Our setup
// ids are like "NAS100-6H-1777493712669" — too long and contain dashes. Hash
// {setupId, leg} to a stable 8-char alnum string so the same (setup, leg)
// always maps to the same signal id (idempotent updates).
//   leg = "tp1" | "tp2" — split-position model: one leg closes at TP1, the
//   other rides to TP2. Same direction, entry, SL.
function toSignalId(setupId, leg) {
  const hex = createHash("sha1").update(`${setupId}:${leg}`).digest("hex");
  return hex.slice(0, 8); // 8 lowercase hex chars
}

const __dir = dirname(fileURLToPath(import.meta.url));

// Env loader — same minimal style as the rest of the project (no dotenv).
const env = {};
try {
  readFileSync(join(__dir, "../.env"), "utf8").split("\n").forEach(line => {
    if (!line || line.startsWith("#")) return;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
} catch {}

const TOKEN       = process.env.METAAPI_TOKEN       || env.METAAPI_TOKEN;
const REGION      = process.env.METAAPI_REGION      || env.METAAPI_REGION || "london";
const STRATEGY_ID = process.env.METAAPI_STRATEGY_ID || env.METAAPI_STRATEGY_ID;
const COPY_LIVE   = (process.env.COPY_LIVE || env.COPY_LIVE || "false").toLowerCase() === "true";
const HOST        = `https://copyfactory-api-v1.${REGION}.agiliumtrade.ai`;

const LOG_FILE = join(__dir, "../logs/copyfactory.log");

// Master account is on LiquidMarkets — symbol naming on the master must match
// what the broker uses, since CopyFactory replicates the symbol verbatim
// (per-subscriber symbolMapping can rebase later).
const MASTER_SYMBOL_MAP = {
  NAS100: "NAS100", US500: "SPX500", US30: "US30",
  XAUUSD: "XAUUSD", GBPUSD: "GBPUSD",
  BTCUSD: "BTCUSD", ETHUSD: "ETHUSD",
};

function logLine(line) {
  const stamp = new Date().toISOString();
  const text  = `[${stamp}] ${line}\n`;
  try { appendFileSync(LOG_FILE, text); } catch {}
  console.log(text.trimEnd());
}

async function reqCopyFactory(path, method, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(HOST + path, {
      method,
      headers: { "auth-token": TOKEN, "Content-Type": "application/json" },
      body:    body ? JSON.stringify(body) : undefined,
      signal:  ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(t); }
}

// Build one leg of the split-position triplet (tp1 / tp2 / tp3-runner).
function buildLegPayload(setup, marketKey, leg) {
  const isBuy = setup.direction === "BUY";
  const symbol = MASTER_SYMBOL_MAP[marketKey] ?? marketKey;
  const tp = leg === "tp3" ? setup.tp3
           : leg === "tp2" ? setup.tp2
           : setup.tp1;
  // CopyFactory considers a signal expired ~60s after its `time` field.
  // We must therefore stamp the SEND time, not the entry-candle time —
  // otherwise a cron tick that fires >60s after candle-open (which happens
  // around busy ticks) ships an already-stale signal that subscribers reject
  // with "Trade signal has expired".
  const body = {
    symbol,
    type:    isBuy ? "POSITION_TYPE_BUY" : "POSITION_TYPE_SELL",
    volume:  0.01,                          // base unit; per-subscriber scaling rewrites this
    time:    new Date().toISOString(),
    ...(setup.sl != null ? { stopLoss:   setup.sl } : {}),
    ...(tp       != null ? { takeProfit: tp       } : {}),
    // Distinct magic per leg — same symbol+direction+magic causes the broker
    // to net signals into one position, so only one TP gets honored.
    magic:   leg === "tp3" ? 3 : leg === "tp2" ? 2 : 1,
  };
  return { signalId: toSignalId(setup.id, leg), body };
}

async function sendOneLeg(setup, marketKey, leg) {
  const { signalId, body } = buildLegPayload(setup, marketKey, leg);
  const tag = `${marketKey} ${setup.direction} ${body.symbol} ${leg.toUpperCase()} entry=${setup.entry} sl=${setup.sl} tp=${body.takeProfit}`;
  if (!COPY_LIVE) {
    logLine(`PAPER signal → ${tag} | signalId=${signalId}`);
    return;
  }
  try {
    await reqCopyFactory(
      `/users/current/strategies/${STRATEGY_ID}/external-signals/${signalId}`,
      "PUT",
      body,
    );
    logLine(`SENT signal → ${tag} | signalId=${signalId}`);
  } catch (err) {
    logLine(`ERROR sending signal | ${tag} | ${err.message}`);
  }
}

// Send all configured legs (TP1 + TP2 + optional TP3 runner).
// One call per setup transition to ACTIVE.
export async function notifySignal(setup, marketKey) {
  if (!setup?.id || setup.status !== "ACTIVE") return;
  if (!TOKEN || !STRATEGY_ID) {
    logLine(`SKIP (env missing) — market=${marketKey} setup=${setup.id}`);
    return;
  }
  await sendOneLeg(setup, marketKey, "tp1");
  if (setup.tp2 != null) await sendOneLeg(setup, marketKey, "tp2");
  if (setup.tp3 != null) await sendOneLeg(setup, marketKey, "tp3");
}

// Modify the SL of one already-open leg (used for TP3 runner: when TP2 hits we
// move TP3's SL to entry so the runner is risk-free for the long-tail target).
// PUT on the same signalId is upsert per CopyFactory docs — broker patches the
// running position's stopLoss to the new value.
export async function modifySignalSL(setup, marketKey, leg, newSL) {
  if (!setup?.id || !TOKEN || !STRATEGY_ID) return;
  const { signalId, body } = buildLegPayload(setup, marketKey, leg);
  body.stopLoss = newSL;
  body.time     = new Date().toISOString();   // refresh — old time would expire
  const tag = `${marketKey} ${setup.direction} ${body.symbol} ${leg.toUpperCase()} BE-MOVE entry=${setup.entry} newSL=${newSL}`;
  if (!COPY_LIVE) {
    logLine(`PAPER modify-SL → ${tag} | signalId=${signalId}`);
    return;
  }
  try {
    await reqCopyFactory(
      `/users/current/strategies/${STRATEGY_ID}/external-signals/${signalId}`,
      "PUT",
      body,
    );
    logLine(`MODIFY-SL ${leg.toUpperCase()} → ${tag} | signalId=${signalId}`);
  } catch (err) {
    logLine(`ERROR modify-SL | ${tag} | ${err.message}`);
  }
}

async function cancelOneLeg(setup, leg) {
  const sigId = toSignalId(setup.id, leg);
  if (!COPY_LIVE) {
    logLine(`PAPER cancel ${leg.toUpperCase()} — signalId=${sigId}`);
    return;
  }
  try {
    await reqCopyFactory(
      `/users/current/strategies/${STRATEGY_ID}/external-signals/${sigId}/remove`,
      "POST",
      { time: new Date().toISOString() },
    );
    logLine(`CANCEL ${leg.toUpperCase()} signal — signalId=${sigId}`);
  } catch (err) {
    logLine(`ERROR cancelling ${leg} signal | id=${setup.id} | ${err.message}`);
  }
}

// Cancel one or all legs. Best-effort, non-fatal. Cancelling an already-removed
// signal is a no-op at the broker.
//   leg = "tp1" / "tp2" / "tp3"  → that leg only
//   leg = "all"                  → all three (SL hit, TP3 hit, orphan cleanup) [default]
export async function cancelSignal(setup, leg = "all") {
  if (!setup?.id || !TOKEN || !STRATEGY_ID) return;
  if (leg === "tp1" || leg === "tp2" || leg === "tp3") {
    await cancelOneLeg(setup, leg);
  } else {
    await cancelOneLeg(setup, "tp1");
    await cancelOneLeg(setup, "tp2");
    await cancelOneLeg(setup, "tp3");
  }
}
