/**
 * BLACKBULL Trading API Server
 * Exposes NAS100 cycle analysis + active trade data as JSON REST endpoints.
 * Caches results for 60s to avoid hammering MCP.
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { computeBias, runBacktest, runBacktestV2, generateBacktestInsights, analyzeTopDown, analyzeWeeklyStructure, analyzeDailyStructure, analyzeCycleStructure, groupCandlesByDay, groupCandlesByWeek, getFractalSignals, runFractalLockBacktest, getLiveFractalSignals } from "./bias-engine.js";
import { notifySignal as cfNotifySignal } from "../monitor/copyfactory-bridge.js";
import { computeSweepTP } from "../monitor/lib-sl.mjs";
// MetaApi client is imported below after env is loaded onto process.env, so the
// module sees the token at import time.

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, "../.env");
const env = {};
try {
  readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k && v.length) env[k.trim()] = v.join("=").trim();
  });
} catch {}

const MCP_TOKEN        = process.env.MCP_TOKEN        || env.MCP_TOKEN;
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || env.OPENAI_API_KEY;
const MONGO_URI        = process.env.MONGO_URI        || env.MONGO_URI;
const JWT_SECRET       = process.env.JWT_SECRET       || env.JWT_SECRET || "fallback_dev_secret";
const MCP_URL          = "https://178-104-80-233.sslip.io/mcp";

// ── Stripe (test/live mode aware via STRIPE_MODE env var) ────────────────────
// Switch to live: edit /opt/trading-assistant/.env, set STRIPE_MODE=live and
// fill STRIPE_LIVE_* vars, then `systemctl restart trading-api`. No code change.
const STRIPE_MODE = (process.env.STRIPE_MODE || env.STRIPE_MODE || "test").toLowerCase();
const stripeKeys = STRIPE_MODE === "live"
  ? {
      secret:        process.env.STRIPE_LIVE_SECRET_KEY        || env.STRIPE_LIVE_SECRET_KEY,
      publishable:   process.env.STRIPE_LIVE_PUBLISHABLE_KEY   || env.STRIPE_LIVE_PUBLISHABLE_KEY,
      webhookSecret: process.env.STRIPE_LIVE_WEBHOOK_SECRET    || env.STRIPE_LIVE_WEBHOOK_SECRET,
      priceAuto:     process.env.STRIPE_LIVE_PRICE_ID_AUTO_TRADE || env.STRIPE_LIVE_PRICE_ID_AUTO_TRADE,
      priceExtra:    process.env.STRIPE_LIVE_PRICE_ID_EXTRA_ACCOUNT || env.STRIPE_LIVE_PRICE_ID_EXTRA_ACCOUNT,
      priceSignal:   process.env.STRIPE_LIVE_PRICE_ID_SIGNAL || env.STRIPE_LIVE_PRICE_ID_SIGNAL,
    }
  : {
      secret:        process.env.STRIPE_SECRET_KEY        || env.STRIPE_SECRET_KEY,
      publishable:   process.env.STRIPE_PUBLISHABLE_KEY   || env.STRIPE_PUBLISHABLE_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET    || env.STRIPE_WEBHOOK_SECRET,
      priceAuto:     process.env.STRIPE_PRICE_ID_AUTO_TRADE || env.STRIPE_PRICE_ID_AUTO_TRADE,
      priceExtra:    process.env.STRIPE_PRICE_ID_EXTRA_ACCOUNT || env.STRIPE_PRICE_ID_EXTRA_ACCOUNT,
      priceSignal:   process.env.STRIPE_PRICE_ID_SIGNAL || env.STRIPE_PRICE_ID_SIGNAL,
    };
const StripeSDK = (await import("stripe")).default;
const stripe = stripeKeys.secret ? new StripeSDK(stripeKeys.secret) : null;
if (!stripe) console.warn(`[Stripe] No ${STRIPE_MODE.toUpperCase()} key configured — billing endpoints will return 503.`);
else console.log(`[Stripe] ${STRIPE_MODE.toUpperCase()} mode active, price=${stripeKeys.priceAuto || "(not set)"}`);

// Public app URL — used in Stripe Checkout success/cancel redirects + invoice links.
const APP_URL = process.env.APP_URL || env.APP_URL || "https://app.tradingvisualizer.com";

// Re-export MetaApi vars onto process.env so api/metaapi-client.js (and the
// monitor bridge) can read them via process.env without each module having to
// re-parse .env.
for (const k of ["METAAPI_TOKEN","METAAPI_REGION","METAAPI_MASTER_ACCOUNT_ID","METAAPI_STRATEGY_ID","COPY_LIVE"]) {
  if (!process.env[k] && env[k]) process.env[k] = env[k];
}
const metaapi = await import("./metaapi-client.js");

// ── MongoDB + User model ───────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(() => {
  console.log("MongoDB connected — tradingvisualizer");
}).catch(err => {
  console.error("MongoDB connection error:", err.message);
});

const ADMIN_EMAILS = ["shannonpieternella@gmail.com"];

const userSchema = new mongoose.Schema({
  name:      { type: String, required: true, trim: true },
  email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:  { type: String, required: true },
  isAdmin:   { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date },

  // ── Billing / subscription ────────────────────────────────────────────────
  // tier: "free" (1 winning signal/wk) or "auto-trade" (€69/mo, full access)
  subscriptionTier:             { type: String, enum: ["free", "signal", "auto-trade"], default: "free" },
  // status: "trialing" (free credit), "active" (paid), "past_due" (payment failed →
  //         locked), "canceled" (cancelled at period end), or null (free user).
  subscriptionStatus:           { type: String, enum: ["trialing", "active", "past_due", "canceled", null], default: null },
  // When the current paid period ends. Past this without renewal → locked.
  subscriptionCurrentPeriodEnd: Date,
  // Stripe references — created on first checkout
  stripeCustomerId:             String,
  stripeSubscriptionId:         String,
  // Set true when user has an open invoice that's overdue OR a failed payment.
  // Cleared by webhook on successful payment. Used by requirePaidStatus middleware.
  tradingLocked:                { type: Boolean, default: false },
  // Manual admin overrides (e.g. Nathan got a free month)
  trialGrantedBy:               String,
  trialGrantedAt:               Date,

  // Per-user Discord webhook — admin can configure so each user receives signal
  // notifications in their OWN Discord channel. Empty = no webhook (user only
  // sees signals in dashboard). Monitor.js polls the User collection on each
  // signal-fire and sends to all active subscribers' webhooks in parallel.
  discordWebhookUrl:            String,
  discordWebhookEnabled:        { type: Boolean, default: true },

  // Language preference — persists across devices for logged-in users.
  // Anonymous visitors use localStorage. Defaults to EN (international).
  language:                     { type: String, enum: ["en", "nl"], default: "en" },
});
const User = mongoose.model("User", userSchema);

// ── Invoice model ────────────────────────────────────────────────────────────
// Tracks both subscription invoices (€69/mo, auto-created by Stripe) and
// performance-fee invoices (10% of monthly net profit, generated by our cron).
const invoiceSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  type:             { type: String, enum: ["subscription", "performance_fee"], required: true },
  amount:           { type: Number, required: true },           // in cents (so €69.00 = 6900)
  currency:         { type: String, default: "EUR" },
  status:           { type: String, enum: ["open", "paid", "uncollectible", "void"], default: "open", index: true },
  periodStart:      Date,
  periodEnd:        Date,
  description:      String,
  // Stripe references
  stripeInvoiceId:  String,
  stripePaymentLink: String,    // Stripe-hosted invoice URL — what user clicks to pay
  // Lifecycle timestamps
  createdAt:        { type: Date, default: Date.now },
  paidAt:           Date,
  // Performance-fee specific: snapshot of the calculation
  perfFeeMeta: {
    netProfit:    Number,    // raw profit number (in user's broker currency)
    feePercent:   Number,    // typically 10
    hwmBefore:    Number,    // high-water mark before this period
    hwmAfter:     Number,    // updated HWM after this period
  },
});
const Invoice = mongoose.model("Invoice", invoiceSchema);

// ── BalanceSnapshot model ────────────────────────────────────────────────────
// One row per (user × account × snapshot tick). Persistent history zodat
// performance-fee berekeningen altijd accurate data hebben — ook als de user
// later z'n broker disconnect. Used by:
//   - dashboard /api/billing/balance-history (graph)
//   - perf_fee_cron (10% of monthly net profit)
const balanceSnapshotSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  metaapiAccountId: { type: String, required: true, index: true },
  brokerAccountId:  { type: mongoose.Schema.Types.ObjectId, ref: "BrokerAccount" },
  // MetaApi-reported state at snapshot time
  balance:          Number,    // realised P&L base
  equity:           Number,    // balance + unrealised P&L (open positions)
  freeMargin:       Number,
  margin:           Number,
  marginLevel:      Number,
  currency:         { type: String, default: "USD" },
  // Counters (accumulated this period)
  totalDeposits:    { type: Number, default: 0 },
  totalWithdrawals: { type: Number, default: 0 },
  // Meta
  source:           { type: String, default: "metaapi" },
  snapshotAt:       { type: Date, default: Date.now, index: true },
  createdAt:        { type: Date, default: Date.now },
});
balanceSnapshotSchema.index({ userId: 1, snapshotAt: -1 });
const BalanceSnapshot = mongoose.model("BalanceSnapshot", balanceSnapshotSchema);

// ── AccountTransaction — deposits / withdrawals / balance-only deals ─────────
// Distinguish "user added/withdrew money" from "trading P&L" zodat de perf-fee
// alleen op echt verdiend resultaat wordt geheven, niet op stortingen.
// Populated by balance_snapshot_cron uit MetaApi getDealsByTimeRange().
const accountTransactionSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  metaapiAccountId: { type: String, required: true, index: true },
  // MetaApi deal id — used for idempotent upsert (geen dubbele rows)
  dealId:           { type: String, required: true, unique: true, index: true },
  // DEPOSIT (gestort), WITHDRAWAL (opgenomen), CREDIT (broker-bonus), CORRECTION
  type:             { type: String, enum: ["DEPOSIT", "WITHDRAWAL", "CREDIT", "CORRECTION", "OTHER"], required: true },
  amount:           Number,         // positive for deposit/credit, negative for withdrawal
  currency:         String,
  comment:          String,         // broker-side comment (e.g. "Bank wire deposit")
  brokerTime:       Date,            // exact transaction time at broker
  createdAt:        { type: Date, default: Date.now },
});
accountTransactionSchema.index({ userId: 1, brokerTime: -1 });
const AccountTransaction = mongoose.model("AccountTransaction", accountTransactionSchema);

// Login event tracking
const loginEventSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  name:      String,
  email:     String,
  timestamp: { type: Date, default: Date.now },
  ip:        String,
});
const LoginEvent = mongoose.model("LoginEvent", loginEventSchema);

// Signal-view tracking — fired when a signal-card scrolls into view on the
// dashboard. Used for engagement analytics in /admin.
const signalViewSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  email:     String,
  market:    { type: String, index: true },
  tf:        { type: String, index: true },     // "daily" | "6H" | "90min"
  setupId:   String,                             // optional — when card maps to a known setup id
  dwellMs:   Number,                             // how long the card stayed in view
  timestamp: { type: Date, default: Date.now, index: true },
});
const SignalView = mongoose.model("SignalView", signalViewSchema);

// Setup history — written by monitor.js on every setup creation/patch. The
// `_id` is the stable setup id (market-TF-timestamp). `strict: false` because
// the shape can evolve; we only need a few fields for querying/filtering.
const SetupHistory = mongoose.model(
  "SetupHistory",
  new mongoose.Schema({}, { collection: "setup_history", strict: false }),
);

// Broker accounts — one row per (user, MT account) pairing. Credentials are
// NEVER stored here; they go to MetaApi at provisioning time and we only keep
// the metaapi accountId + display fields. Per-user copy preferences live here
// and are sync'd to CopyFactory's subscriber config on every change.
const brokerAccountSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  metaapiAccountId: { type: String, required: true, unique: true },
  broker:           { type: String },                  // free-text name shown to user
  login:            { type: String, required: true },  // for display
  server:           { type: String, required: true },
  platform:         { type: String, enum: ["mt4", "mt5"], default: "mt5" },
  status:           { type: String, default: "PENDING" },
  enabledMarkets:   { type: [String], default: ["NAS100","US500","US30","XAUUSD","GBPUSD","BTCUSD","ETHUSD"] },
  riskMode:         { type: String, enum: ["percentBalance","fixedLot"], default: "percentBalance" },
  riskValue:        { type: Number, default: 1.0 },    // 1% balance per trade by default
  copyEnabled:      { type: Boolean, default: true },
  // Starting balance — the equity baseline against which all profit (and our
  // 10% performance fee) is measured. Set on first BalanceSnapshot if absent;
  // admin can override (e.g. legacy Nate accounts started ~€800 each before
  // we deployed snapshot tracking).
  startingBalance:      { type: Number, default: null },
  startingBalanceSetAt: { type: Date,   default: null },
  startingBalanceSource:{ type: String, default: null }, // "first_snapshot" | "admin_override"
  createdAt:        { type: Date, default: Date.now },
  updatedAt:        { type: Date, default: Date.now },
});
const BrokerAccount = mongoose.model("BrokerAccount", brokerAccountSchema);

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ ok: false, error: "Niet ingelogd" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Sessie verlopen, log opnieuw in" });
  }
}

// Lock-middleware: blocks routes if user has open invoices, expired period, or
// explicit tradingLocked flag. Returns 402 + payment link so frontend can show
// pay-now CTA. Apply to write endpoints (broker connect, broker patch). Read
// endpoints check lock state via /api/billing/me + render the lock-screen.
async function requirePaidStatus(req, res, next) {
  if (req.user?.isAdmin) return next();
  const u = await User.findById(req.user.id).lean();
  if (!u) return res.status(401).json({ ok: false, error: "Niet ingelogd" });
  const openInv = await Invoice.findOne({ userId: u._id, status: "open" }).sort({ createdAt: -1 }).lean();
  const periodExpired = u.subscriptionCurrentPeriodEnd
                     && new Date(u.subscriptionCurrentPeriodEnd).getTime() < Date.now()
                     && u.subscriptionTier !== "free";
  const locked = u.tradingLocked || !!openInv || periodExpired;
  if (locked) {
    return res.status(402).json({
      ok: false,
      error: "Account vergrendeld — openstaande factuur of vervallen abonnement.",
      paymentLink: openInv?.stripePaymentLink ?? null,
      invoiceId:   openInv?._id ?? null,
      reason:      openInv ? "open_invoice" : (periodExpired ? "period_expired" : "trading_locked"),
    });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ ok: false, error: "Geen toegang" });
  next();
}
const TRADE_FILE       = join(__dir, "../monitor/active_trade_NAS100.json"); // NAS100 default (monitor writes per-market files)
const MARKET_STATE_FILE = join(__dir, "../monitor/market_state.json");
const SYSTEM_STATE_FILE = join(__dir, "../monitor/system_state.json");
const PORT             = process.env.PORT || 3001;
const OPENAI_CHAT_URL  = "https://api.openai.com/v1/chat/completions";
const CHAT_MODEL       = "gpt-4o-mini";

// ── MCP caller ─────────────────────────────────────────────────────────────────
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
                  clientInfo: { name: "api-server", version: "1.0" } } }),
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

const NAS100_SYMBOL   = "CAPITALCOM:US100";
const NAS100_PRICE_MIN = 10000;
const NAS100_PRICE_MAX = 30000;

async function fetchCandles(count = 200) {
  // Always switch to NAS100 first — the monitor may have left the chart on another symbol
  await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol: NAS100_SYMBOL } });
  await new Promise(r => setTimeout(r, 2000));
  await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: "15" } });
  await new Promise(r => setTimeout(r, 1500));
  const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
  const raw = result?.content?.[0]?.text;
  if (!raw) throw new Error("No candle data from MCP");
  const candles = JSON.parse(raw);
  if (!Array.isArray(candles) || !candles.length) throw new Error("Empty candle data");
  // Sanity check: verify price is in NAS100 range
  const lastPrice = candles[candles.length - 1].close;
  if (lastPrice < NAS100_PRICE_MIN || lastPrice > NAS100_PRICE_MAX) {
    throw new Error(`Wrong symbol on chart — price ${lastPrice} not in NAS100 range. Chart may still be switching.`);
  }
  return candles;
}

// ── ET helpers ─────────────────────────────────────────────────────────────────
function tsToETHours(ts) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit"
  }).formatToParts(new Date(ts * 1000));
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return h + m / 60;
}

function tsToETLabel(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit"
  });
}

function getTradingDayStartTs() {
  const now = new Date();
  const etH = tsToETHours(Date.now() / 1000);
  const daysBack = etH < 18 ? 1 : 0;
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const etYear  = parseInt(etParts.find(p => p.type === "year").value);
  const etMonth = parseInt(etParts.find(p => p.type === "month").value);
  const etDay   = parseInt(etParts.find(p => p.type === "day").value);
  const isDST = now.toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT");
  const etOffsetH = isDST ? 4 : 5;
  const targetDate = new Date(Date.UTC(etYear, etMonth - 1, etDay));
  targetDate.setUTCDate(targetDate.getUTCDate() - daysBack);
  const utcH = 18 + etOffsetH;
  let dayStart18 = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), utcH, 0, 0));
  const verifyH = tsToETHours(dayStart18.getTime() / 1000);
  if (Math.abs(verifyH - 18) > 0.5) {
    for (const adj of [-3600, 3600]) {
      const t2 = new Date(dayStart18.getTime() + adj * 1000);
      if (Math.abs(tsToETHours(t2.getTime() / 1000) - 18) < 0.1) { dayStart18 = t2; break; }
    }
  }
  return dayStart18.getTime() / 1000;
}

// Variant of getTradingDayStartTs() that takes any timestamp (sec) and returns
// the 18:00 ET trading-day start that the timestamp falls into.
function getTradingDayStartTsFor(tsSec) {
  const refDate = new Date(tsSec * 1000);
  const etH = tsToETHours(tsSec);
  const daysBack = etH < 18 ? 1 : 0;
  const etParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(refDate);
  const etYear  = parseInt(etParts.find(p => p.type === "year").value);
  const etMonth = parseInt(etParts.find(p => p.type === "month").value);
  const etDay   = parseInt(etParts.find(p => p.type === "day").value);
  const isDST = refDate.toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" }).includes("EDT");
  const etOffsetH = isDST ? 4 : 5;
  const targetDate = new Date(Date.UTC(etYear, etMonth - 1, etDay));
  targetDate.setUTCDate(targetDate.getUTCDate() - daysBack);
  const utcH = 18 + etOffsetH;
  let dayStart18 = new Date(Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate(), utcH, 0, 0));
  const verifyH = tsToETHours(dayStart18.getTime() / 1000);
  if (Math.abs(verifyH - 18) > 0.5) {
    for (const adj of [-3600, 3600]) {
      const t2 = new Date(dayStart18.getTime() + adj * 1000);
      if (Math.abs(tsToETHours(t2.getTime() / 1000) - 18) < 0.1) { dayStart18 = t2; break; }
    }
  }
  return dayStart18.getTime() / 1000;
}

function getCycleForMinutes(min) {
  if (min < 0)    return null;
  if (min < 360)  return "C1";
  if (min < 720)  return "C2";
  if (min < 1080) return "C3";
  if (min < 1440) return "C4";
  return null;
}

const CYCLE_RANGES = {
  C1: { start: 18, end: 24, label: "18:00–00:00" },
  C2: { start:  0, end:  6, label: "00:00–06:00" },
  C3: { start:  6, end: 12, label: "06:00–12:00" },
  C4: { start: 12, end: 18, label: "12:00–18:00" },
};
const CYCLE_START_MINS = { C1: 0, C2: 360, C3: 720, C4: 1080 };
const CYCLE_ORDER = ["C1", "C2", "C3", "C4"];
const PHASE2 = {
  C1: { startMin:   90, endMin:  180, label: "19:30–21:00" },
  C2: { startMin:  450, endMin:  540, label: "01:30–03:00" },
  C3: { startMin:  810, endMin:  900, label: "07:30–09:00" },
  C4: { startMin: 1170, endMin: 1260, label: "13:30–15:00" },
};
const SL_READY_OFFSET_MINS = 30;
const PREV_CYCLE = { C1: "prevC4", C2: "C1", C3: "C2", C4: "C3" };

function isSLReady(entryCycle, dayStartTs) {
  const p2 = PHASE2[entryCycle];
  if (!p2) return true;
  return Date.now() / 1000 >= dayStartTs + (p2.startMin + SL_READY_OFFSET_MINS) * 60;
}

function slReadyLabel(entryCycle, dayStartTs) {
  const p2 = PHASE2[entryCycle];
  if (!p2) return "—";
  return tsToETLabel(dayStartTs + (p2.startMin + SL_READY_OFFSET_MINS) * 60);
}

function getPrevCycleSL(entryCycle, type, analysis) {
  const { cycles, prevC4 } = analysis;
  const prevName = PREV_CYCLE[entryCycle];
  const prevCyc  = prevName === "prevC4" ? prevC4 : cycles[prevName];
  if (!prevCyc || !prevCyc.low) return null;
  const sl = type === "LONG" ? prevCyc.low : prevCyc.high;
  return +sl.toFixed(2);
}

function checkSLHit(sl, type, candles, slReadyTs) {
  if (sl == null) return false;
  const postCandles = candles.filter(c => c.timestamp >= slReadyTs);
  if (type === "LONG")  return postCandles.some(c => c.low  <= sl);
  if (type === "SHORT") return postCandles.some(c => c.high >= sl);
  return false;
}

// LONG trade → sluit als cycle HIGH geraakt na entry window (nieuwe SHORT kans)
// SHORT trade → sluit als cycle LOW geraakt na entry window (nieuwe LONG kans)
function checkOppositeSideHit(trade, analysis) {
  const { cycles, prevC4 } = analysis;
  const allCycs = prevC4 ? [prevC4, ...Object.values(cycles)] : Object.values(cycles);
  const afterTs = trade.windowEndTs;
  for (const cyc of allCycs) {
    if (!cyc.high || cyc.status === "no_data") continue;
    if (trade.type === "LONG" && cyc.hitHigh && cyc.hitHigh.ts > afterTs) {
      return { hit: true, reason: `${cyc.name} HIGH ${cyc.hitHigh.hitPrice} @ ${cyc.hitHigh.time}`, level: cyc.hitHigh.hitPrice, time: cyc.hitHigh.time, newType: "SHORT" };
    }
    if (trade.type === "SHORT" && cyc.hitLow && cyc.hitLow.ts > afterTs) {
      return { hit: true, reason: `${cyc.name} LOW ${cyc.hitLow.hitPrice} @ ${cyc.hitLow.time}`, level: cyc.hitLow.hitPrice, time: cyc.hitLow.time, newType: "LONG" };
    }
  }
  return { hit: false };
}

function getEntryWindow(hitTs, dayStartTs) {
  const minsIntoDay = (hitTs - dayStartTs) / 60;
  const hitCycle = getCycleForMinutes(minsIntoDay) || "C1";
  const cycleStartMin = CYCLE_START_MINS[hitCycle];
  const minsIntoCycle = minsIntoDay - cycleStartMin;
  let entryCycle;
  if (minsIntoCycle < 180) {
    entryCycle = hitCycle;
  } else {
    const nextIdx = (CYCLE_ORDER.indexOf(hitCycle) + 1) % 4;
    entryCycle = CYCLE_ORDER[nextIdx];
  }
  const p2 = PHASE2[entryCycle];
  const windowStartTs = dayStartTs + p2.startMin * 60;
  const windowEndTs   = dayStartTs + p2.endMin   * 60;
  const nowTs = Date.now() / 1000;
  let status;
  if (nowTs < windowStartTs)       status = "upcoming";
  else if (nowTs <= windowEndTs)   status = "open";
  else                             status = "passed";
  return {
    cycle: entryCycle, label: p2.label,
    startTs: windowStartTs, endTs: windowEndTs, status,
    startLabel: tsToETLabel(windowStartTs),
    endLabel:   tsToETLabel(windowEndTs),
  };
}

function analyzeCycles(candles) {
  const nowTs = Date.now() / 1000;
  const dayStartTs = getTradingDayStartTs();
  const nowMinutesIntoDay = (nowTs - dayStartTs) / 60;
  const activeCycle = getCycleForMinutes(nowMinutesIntoDay) || "C4";

  const dayEndTs = dayStartTs + 24 * 3600;
  const allSorted = [...candles]
    .filter(c => c.timestamp >= dayStartTs - 60 && c.timestamp < dayEndTs)
    .sort((a, b) => a.timestamp - b.timestamp);

  let prevC4StartTs = dayStartTs - 6 * 3600;
  let prevC4Candles = [...candles]
    .filter(c => c.timestamp >= prevC4StartTs && c.timestamp < dayStartTs)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!prevC4Candles.length) {
    for (let extra = 1; extra <= 4; extra++) {
      const altEnd   = dayStartTs - extra * 24 * 3600;
      const altStart = altEnd - 6 * 3600;
      const found = [...candles]
        .filter(c => c.timestamp >= altStart && c.timestamp < altEnd)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (found.length) { prevC4Candles = found; prevC4StartTs = altStart; break; }
    }
  }

  const cycleCandles = { C1: [], C2: [], C3: [], C4: [] };
  for (const c of allSorted) {
    const minsIntoDay = (c.timestamp - dayStartTs) / 60;
    const cy = getCycleForMinutes(minsIntoDay);
    if (cy) cycleCandles[cy].push(c);
  }

  const buildCycleObj = (name, label, cc, isActive) => {
    if (!cc.length) return { name, label, status: "no_data", candles: [] };
    let high = -Infinity, highTs = null, low = Infinity, lowTs = null;
    for (const c of cc) {
      if (c.high > high) { high = c.high; highTs = c.timestamp; }
      if (c.low  < low)  { low  = c.low;  lowTs  = c.timestamp; }
    }
    return {
      name, label, status: isActive ? "active" : "complete",
      high: +high.toFixed(2), highTime: tsToETLabel(highTs), highTs,
      low: +low.toFixed(2),   lowTime:  tsToETLabel(lowTs),  lowTs,
      hitHigh: null, hitLow: null, entryHigh: null, entryLow: null,
    };
  };

  const cycles = {};
  for (const [name, range] of Object.entries(CYCLE_RANGES)) {
    cycles[name] = buildCycleObj(name, range.label, cycleCandles[name], name === activeCycle);
  }

  let prevC4 = null;
  if (prevC4Candles.length) {
    prevC4 = buildCycleObj("prevC4", "12:00–18:00 (vorig)", prevC4Candles, false);
    const prevC4EndTs = prevC4StartTs + 6 * 3600;
    const postC4Candles = [...candles]
      .filter(c => c.timestamp >= prevC4EndTs)
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const c of postC4Candles) {
      if (!prevC4.hitHigh && c.high >= prevC4.high)
        prevC4.hitHigh = { hitPrice: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!prevC4.hitLow  && c.low  <= prevC4.low)
        prevC4.hitLow  = { hitPrice: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp };
    }
    if (prevC4.hitHigh) prevC4.entryHigh = getEntryWindow(prevC4.hitHigh.ts, dayStartTs);
    if (prevC4.hitLow)  prevC4.entryLow  = getEntryWindow(prevC4.hitLow.ts,  dayStartTs);
  }

  for (const [name, cyc] of Object.entries(cycles)) {
    if (cyc.status !== "complete" || !cyc.high) continue;
    const myOrder = CYCLE_ORDER.indexOf(name);
    const afterCandles = allSorted.filter(c => {
      const cy = getCycleForMinutes((c.timestamp - dayStartTs) / 60);
      return cy && CYCLE_ORDER.indexOf(cy) > myOrder;
    });
    for (const c of afterCandles) {
      if (!cyc.hitHigh && c.high >= cyc.high)
        cyc.hitHigh = { hitPrice: c.high, time: tsToETLabel(c.timestamp), ts: c.timestamp };
      if (!cyc.hitLow  && c.low  <= cyc.low)
        cyc.hitLow  = { hitPrice: c.low,  time: tsToETLabel(c.timestamp), ts: c.timestamp };
    }
    if (cyc.hitHigh) cyc.entryHigh = getEntryWindow(cyc.hitHigh.ts, dayStartTs);
    if (cyc.hitLow)  cyc.entryLow  = getEntryWindow(cyc.hitLow.ts,  dayStartTs);
  }

  const lastCandle = allSorted[allSorted.length - 1];
  const currentPrice = lastCandle?.close ?? 0;
  const currentTime  = tsToETLabel(lastCandle?.timestamp ?? 0);
  const nowEtH = tsToETHours(nowTs);

  return { cycles, prevC4, activeCycle, currentPrice, currentTime, nowEtH, lastCandle, dayStartTs };
}

function calcEntry(side, high, low) {
  const range = high - low;
  if (range <= 0) return side === "SHORT" ? high : low;
  const raw = side === "SHORT" ? high - 0.30 * range : low + 0.30 * range;
  if (high > 1000) return +raw.toFixed(1);
  if (high > 10)   return +raw.toFixed(3);
  return +raw.toFixed(5);
}

function computeSignal(analysis, candles) {
  const { cycles, prevC4, currentPrice, dayStartTs } = analysis;
  const allCycs = prevC4 ? [prevC4, ...Object.values(cycles)] : Object.values(cycles);
  const completedCycs = allCycs.filter(c => c.status === "complete" && c.high);
  const active = [], upcoming = [];
  const nowTs = Date.now() / 1000;

  for (const cyc of allCycs) {
    if (cyc.status !== "complete") continue;

    // Active = window open OR passed — signal stays valid until a new hit replaces it
    const highStatus = cyc.entryHigh?.status;
    const lowStatus  = cyc.entryLow?.status;

    if (highStatus === "open" || highStatus === "passed") {
      const entry = calcEntry("SHORT", cyc.high, cyc.low);
      const level = cyc.high;
      const entryCycle = cyc.entryHigh.cycle;
      const slReady = isSLReady(entryCycle, dayStartTs);
      const sl = slReady ? getPrevCycleSL(entryCycle, "SHORT", analysis) : null;
      const otherLows = completedCycs.filter(c => c.name !== cyc.name && c.low < entry).map(c => ({ price: +c.low.toFixed(1), name: c.name })).sort((a, b) => b.price - a.price);
      active.push({
        type: "SHORT", cycle: cyc.name, level, entry, sl, slReady, entryCycle,
        hitTs: cyc.hitHigh?.ts ?? 0,
        windowStatus: highStatus,
        slReadyAt: slReadyLabel(entryCycle, dayStartTs),
        tp1: otherLows[0]?.price ?? null, tp1Cycle: otherLows[0]?.name ?? null,
        tp2: otherLows[1]?.price ?? null, tp2Cycle: otherLows[1]?.name ?? null,
        tpDay: completedCycs.length ? +Math.min(...completedCycs.map(c => c.low)).toFixed(1) : null,
        dist: +(entry - currentPrice).toFixed(1),
        until: cyc.entryHigh.endLabel, window: cyc.entryHigh.label,
      });
    }
    if (lowStatus === "open" || lowStatus === "passed") {
      const entry = calcEntry("LONG", cyc.high, cyc.low);
      const level = cyc.low;
      const entryCycle = cyc.entryLow.cycle;
      const slReady = isSLReady(entryCycle, dayStartTs);
      const sl = slReady ? getPrevCycleSL(entryCycle, "LONG", analysis) : null;
      const otherHighs = completedCycs.filter(c => c.name !== cyc.name && c.high > entry).map(c => ({ price: +c.high.toFixed(1), name: c.name })).sort((a, b) => a.price - b.price);
      active.push({
        type: "LONG", cycle: cyc.name, level, entry, sl, slReady, entryCycle,
        hitTs: cyc.hitLow?.ts ?? 0,
        windowStatus: lowStatus,
        slReadyAt: slReadyLabel(entryCycle, dayStartTs),
        tp1: otherHighs[0]?.price ?? null, tp1Cycle: otherHighs[0]?.name ?? null,
        tp2: otherHighs[1]?.price ?? null, tp2Cycle: otherHighs[1]?.name ?? null,
        tpDay: completedCycs.length ? +Math.max(...completedCycs.map(c => c.high)).toFixed(1) : null,
        dist: +(currentPrice - entry).toFixed(1),
        until: cyc.entryLow.endLabel, window: cyc.entryLow.label,
      });
    }
    if (highStatus === "upcoming")
      upcoming.push({ type: "SHORT", cycle: cyc.name, level: cyc.high, window: cyc.entryHigh.label, entryCycle: cyc.entryHigh.cycle, hitTs: cyc.hitHigh?.ts ?? 0 });
    if (lowStatus === "upcoming")
      upcoming.push({ type: "LONG",  cycle: cyc.name, level: cyc.low,  window: cyc.entryLow.label,  entryCycle: cyc.entryLow.cycle,  hitTs: cyc.hitLow?.ts  ?? 0 });
  }

  // Deduplication: per (entryCycle, type) keep only the signal with the latest hit
  const dedupMap = new Map();
  for (const s of active) {
    const key = `${s.entryCycle}-${s.type}`;
    const prev = dedupMap.get(key);
    if (!prev || s.hitTs > prev.hitTs) dedupMap.set(key, s);
  }
  const dedupUpMap = new Map();
  for (const s of upcoming) {
    const key = `${s.entryCycle}-${s.type}`;
    const prev = dedupUpMap.get(key);
    if (!prev || s.hitTs > prev.hitTs) dedupUpMap.set(key, s);
  }

  const deduped = [...dedupMap.values()].map(({ hitTs, entryCycle, ...rest }) => rest);
  const dedupedUpcoming = [...dedupUpMap.values()].map(({ hitTs, entryCycle, ...rest }) => rest);

  // If there's an active signal, suppress upcoming — no need to show both
  const finalUpcoming = deduped.length > 0 ? [] : dedupedUpcoming;
  return { active: deduped, upcoming: finalUpcoming, recent: [] };
}

function findActiveTrade(analysis, candles) {
  const { cycles, prevC4, dayStartTs } = analysis;
  const allCycs = prevC4 ? [prevC4, ...Object.values(cycles)] : Object.values(cycles);
  const completedCycs = allCycs.filter(c => c.status === "complete" && c.high);
  const trades = [];

  for (const cyc of completedCycs) {
    if (cyc.hitHigh && cyc.entryHigh?.status === "passed") {
      const entry = cyc.high, entryCycle = cyc.entryHigh.cycle;
      const sl = getPrevCycleSL(entryCycle, "SHORT", analysis);
      const slReadyTs = dayStartTs + (PHASE2[entryCycle]?.startMin + SL_READY_OFFSET_MINS) * 60;
      const otherLows = completedCycs
        .filter(c => c.name !== cyc.name && c.low < entry)
        .map(c => ({ price: +c.low.toFixed(1), name: c.name }))
        .sort((a, b) => b.price - a.price);
      trades.push({
        type: "SHORT", cycle: cyc.name, entry, sl, slReadyTs,
        tp1: otherLows[0]?.price ?? null, tp1Cycle: otherLows[0]?.name ?? null,
        tp2: otherLows[1]?.price ?? null, tp2Cycle: otherLows[1]?.name ?? null,
        tpDay: completedCycs.length ? +Math.min(...completedCycs.map(c => c.low)).toFixed(1) : null,
        windowEndTs: cyc.entryHigh.endTs, entryWindow: cyc.entryHigh.label,
      });
    }
    if (cyc.hitLow && cyc.entryLow?.status === "passed") {
      const entry = cyc.low, entryCycle = cyc.entryLow.cycle;
      const sl = getPrevCycleSL(entryCycle, "LONG", analysis);
      const slReadyTs = dayStartTs + (PHASE2[entryCycle]?.startMin + SL_READY_OFFSET_MINS) * 60;
      const otherHighs = completedCycs
        .filter(c => c.name !== cyc.name && c.high > entry)
        .map(c => ({ price: +c.high.toFixed(1), name: c.name }))
        .sort((a, b) => a.price - b.price);
      trades.push({
        type: "LONG", cycle: cyc.name, entry, sl, slReadyTs,
        tp1: otherHighs[0]?.price ?? null, tp1Cycle: otherHighs[0]?.name ?? null,
        tp2: otherHighs[1]?.price ?? null, tp2Cycle: otherHighs[1]?.name ?? null,
        tpDay: completedCycs.length ? +Math.max(...completedCycs.map(c => c.high)).toFixed(1) : null,
        windowEndTs: cyc.entryLow.endTs, entryWindow: cyc.entryLow.label,
      });
    }
  }

  trades.sort((a, b) => b.windowEndTs - a.windowEndTs);
  const currentTrade = trades[0] ?? null;

  if (currentTrade) {
    // Check of huidige-dag trade al gesloten moet worden
    const slHitC = currentTrade.sl != null && checkSLHit(currentTrade.sl, currentTrade.type, candles, currentTrade.slReadyTs ?? 0);
    const tpDayHitC = currentTrade.tpDay != null && (
      currentTrade.type === "LONG"
        ? candles.some(c => c.timestamp > (currentTrade.slReadyTs ?? 0) && c.high >= currentTrade.tpDay)
        : candles.some(c => c.timestamp > (currentTrade.slReadyTs ?? 0) && c.low  <= currentTrade.tpDay)
    );
    const oppHitC = checkOppositeSideHit(currentTrade, analysis);
    if (slHitC || tpDayHitC || oppHitC.hit) {
      try { unlinkSync(TRADE_FILE); } catch {}
      return null;
    }
    return currentTrade;
  }

  // Try saved trade from file
  try {
    const saved = JSON.parse(readFileSync(TRADE_FILE, "utf8"));
    const slHit = saved.sl != null && checkSLHit(saved.sl, saved.type, candles, saved.slReadyTs ?? 0);
    const tpDayHit = saved.tpDay != null && (
      saved.type === "LONG"
        ? candles.some(c => c.timestamp > (saved.slReadyTs ?? 0) && c.high >= saved.tpDay)
        : candles.some(c => c.timestamp > (saved.slReadyTs ?? 0) && c.low  <= saved.tpDay)
    );
    const oppHit = checkOppositeSideHit(saved, analysis);
    if (slHit || tpDayHit || oppHit.hit) { try { unlinkSync(TRADE_FILE); } catch {} return null; }
    return saved;
  } catch { return null; }
}

function computeTradeProgress(trade, currentPrice, candles, analysis) {
  if (!trade) return null;
  const isShort = trade.type === "SHORT";
  const pnl = isShort ? +(trade.entry - currentPrice).toFixed(1) : +(currentPrice - trade.entry).toFixed(1);
  const slDist = trade.sl == null ? null
    : isShort ? +(trade.sl - currentPrice).toFixed(1) : +(currentPrice - trade.sl).toFixed(1);
  const isStopped = trade.sl != null && checkSLHit(trade.sl, trade.type, candles, trade.slReadyTs ?? 0);
  const oppHit = analysis ? checkOppositeSideHit(trade, analysis) : { hit: false };
  const calcDist = (tp) => tp == null ? null : isShort ? +(currentPrice - tp).toFixed(1) : +(tp - currentPrice).toFixed(1);
  const tp1Dist = calcDist(trade.tp1);
  const tp2Dist = calcDist(trade.tp2);
  const tpDayDist = calcDist(trade.tpDay);
  const tp1Hit    = trade.tp1 != null && tp1Dist !== null && tp1Dist <= 0;
  const tp2Hit    = trade.tp2 != null && tp2Dist !== null && tp2Dist <= 0;
  const tpDayHit  = trade.tpDay != null && tpDayDist !== null && tpDayDist <= 0;
  const recent = candles.slice(-8);
  const trend  = recent.map(c => c.close > c.open ? 1 : c.close < c.open ? -1 : 0);
  return {
    pnl, slDist, isStopped, oppHit,
    tp1Dist, tp2Dist, tpDayDist,
    tp1Hit, tp2Hit, tpDayHit,
    trend, trendStr: trend.map(t => t > 0 ? "↑" : t < 0 ? "↓" : "→").join(""),
    status: isStopped ? "STOPPED" : oppHit?.hit ? "CLOSED_OPPOSITE" : pnl > 0 ? "WINNING" : pnl < 0 ? "DRAWDOWN" : "BREAKEVEN",
  };
}

// ── Cache ──────────────────────────────────────────────────────────────────────
let cache = null;
let cacheTs = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

async function getData() {
  const now = Date.now();
  if (cache && now - cacheTs < CACHE_TTL) return cache;

  const candles = await fetchCandles(200);
  const analysis = analyzeCycles(candles);
  const signal = computeSignal(analysis, candles);
  const activeTrade = findActiveTrade(analysis, candles);
  const tradeProgress = computeTradeProgress(activeTrade, analysis.currentPrice, candles, analysis);

  // Daily stats
  const { cycles, prevC4 } = analysis;
  const allCycs = prevC4 ? [prevC4, ...Object.values(cycles)] : Object.values(cycles);
  const completedCycs = allCycs.filter(c => c.status === "complete" && c.high);
  const dailyHigh = completedCycs.length ? +Math.max(...completedCycs.map(c => c.high)).toFixed(2) : null;
  const dailyLow  = completedCycs.length ? +Math.min(...completedCycs.map(c => c.low)).toFixed(2)  : null;

  cache = {
    timestamp: now,
    currentPrice: analysis.currentPrice,
    currentTime: analysis.currentTime,
    activeCycle: analysis.activeCycle,
    nowEtH: analysis.nowEtH,
    cycles: Object.values(analysis.cycles),
    prevC4: analysis.prevC4,
    signal,
    activeTrade,
    tradeProgress,
    dailyHigh,
    dailyLow,
    scanMeta: {
      count: candles.length,
      from: tsToETLabel(candles[0]?.timestamp),
      to: tsToETLabel(candles[candles.length - 1]?.timestamp),
    },
  };
  cacheTs = now;
  return cache;
}

// ── Build mentor context string from live market data (new monitor format) ──────
function buildMentorContext(d, marketKey) {
  const fp = p => {
    if (p == null) return "—";
    if (p > 1000) return Number(p).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return Number(p).toFixed(5);
  };

  const lines = [];

  // ── Header ──
  lines.push(`=== ${marketKey} — LIVE DATA ===`);
  lines.push(`Prijs:             ${fp(d.currentPrice)}  @ ${d.currentTime ?? "—"} ET`);
  lines.push(`Admin bias:        ${d.adminBias ?? "AUTO"}`);
  lines.push(`Toegestane richting: ${d.allowedDirection ?? "beide (geen filter)"}`);
  lines.push(``);

  // ── Lock state ──
  lines.push(`=== ORDER FLOW LOCK ===`);
  if (d.lockState) {
    lines.push(`Richting:  ${d.lockState.direction}  (sterkte ×${d.lockState.strength ?? "—"})`);
    if (d.lockState.note) lines.push(`Reden:     ${d.lockState.note}`);
    if (d.lockState.keyDates?.length) lines.push(`Key dates: ${d.lockState.keyDates.join(", ")}`);
  } else {
    lines.push(`Geen lock actief`);
  }
  lines.push(``);

  // ── Phase 2 / entry windows ──
  lines.push(`=== FASE & ENTRY WINDOW ===`);
  if (d.phaseInfo) {
    lines.push(`Actieve cycle:   ${d.phaseInfo.currentCycle ?? "—"}`);
    lines.push(`In Phase 2 nu:   ${d.phaseInfo.inPhase2 ? "JA ← entry window open" : "Nee"}`);
    if (d.phaseInfo.activeP2) lines.push(`Actief P2 window: ${d.phaseInfo.activeP2.label}`);
  }
  lines.push(``);

  // ── Active setup ──
  lines.push(`=== ACTIEVE SETUP ===`);
  if (d.activeSetup) {
    const s = d.activeSetup;
    const isBuy = s.direction === "BUY";
    lines.push(`Richting:  ${s.direction}  (${s.tf ?? s.source})`);
    lines.push(`Status:    ${s.status}`);
    lines.push(`Cycle:     [${s.cycleLabel ?? "—"}]`);
    lines.push(`BSL level: ${fp(s.bslLevel ?? s.level)}`);
    lines.push(`SSL level: ${fp(s.sslLevel)}`);
    lines.push(`Entry:     ${fp(s.entry)}`);
    lines.push(`SL:        ${s.sl != null ? fp(s.sl) : "— (nog niet bepaald — wacht op Phase 2)"}`);
    if (s.tp1 != null) lines.push(`TP 1:2:    ${fp(s.tp1)}`);
    if (s.tp2 != null) lines.push(`TP 1:3:    ${fp(s.tp2)}`);
    if (s.step1Time) lines.push(`Stap 1 tijd: ${s.step1Time} ET`);
    if (s.step2Time) lines.push(`Stap 2 tijd: ${s.step2Time} ET`);
    if (s.createdTime) lines.push(`Aangemaakt:  ${s.createdTime} ET`);
    lines.push(`Volgende P2: ${s.nextPhase2Label ?? "—"}`);
  } else {
    lines.push(`Geen actieve setup`);
  }
  lines.push(``);

  // ── 90min cycles ──
  lines.push(`=== 90-MIN CYCLES (laatste 8) ===`);
  if (d.cycles90?.length) {
    for (const c of d.cycles90) {
      const h = c.hitHigh ? `gesweept @ ${c.hitHigh.time}` : "niet geraakt";
      const l = c.hitLow  ? `gesweept @ ${c.hitLow.time}`  : "niet geraakt";
      const status = !c.complete ? "[ACTIEF]" : (c.hitHigh && c.hitLow) ? "[beide gesweept]" : c.hitHigh ? "[BSL gesweept]" : c.hitLow ? "[SSL gesweept]" : "[geen sweep]";
      lines.push(`[${c.startTime}–${c.endTime ?? "nu"}] ${status}`);
      lines.push(`  BSL high: ${fp(c.high)}  → ${h}`);
      lines.push(`  SSL low:  ${fp(c.low)}   → ${l}`);
    }
  } else {
    lines.push(`Geen 90min data`);
  }
  lines.push(``);

  // ── 6H cycles ──
  lines.push(`=== 6H CYCLES ===`);
  if (d.cycles6H?.length) {
    for (const c of d.cycles6H) {
      if (c.status === "no_data") { lines.push(`${c.name} (${c.label}): geen data`); continue; }
      const tag = c.status === "active" ? "[ACTIEF]" : "[compleet]";
      const h = c.hitHigh ? `gesweept @ ${c.hitHigh.time}` : "niet geraakt";
      const l = c.hitLow  ? `gesweept @ ${c.hitLow.time}`  : "niet geraakt";
      lines.push(`${c.name} ${tag} ${c.label ?? ""}`);
      lines.push(`  BSL high: ${fp(c.high)}  → ${h}`);
      lines.push(`  SSL low:  ${fp(c.low)}   → ${l}`);
    }
  } else {
    lines.push(`Geen 6H data`);
  }
  lines.push(``);

  // ── Daily levels ──
  lines.push(`=== DAGELIJKSE LEVELS ===`);
  if (d.dailyLevels?.length) {
    for (const day of [...d.dailyLevels].reverse().slice(0, 7)) {
      if (!day.high) continue;
      const h = day.hitHigh ? `BSL gesweept @ ${day.hitHigh.time ?? "—"}` : "BSL open";
      const l = day.hitLow  ? `SSL gesweept @ ${day.hitLow.time ?? "—"}`  : "SSL open";
      const today = day.isToday ? " [VANDAAG]" : "";
      lines.push(`${day.date}${today}:  High ${fp(day.high)} (${h})  |  Low ${fp(day.low)} (${l})`);
    }
  } else {
    lines.push(`Geen dagelijkse levels`);
  }
  lines.push(``);

  // ── Scan meta ──
  if (d.scanMeta) {
    const stale = d.scanMeta.stale ? "  ⚠ DATA STALE" : "";
    lines.push(`Laatste scan: ${d.scanMeta.to ?? "—"} ET  |  ${d.scanMeta.candleCount ?? "?"} candles${stale}`);
  }

  return lines.join("\n");
}

// ── Build bias context string for mentor chat ──────────────────────────────────
function buildBiasContext(bias) {
  if (!bias) return null;
  const lines = [];
  lines.push(`=== AUTONOMOUS BIAS ANALYSE ===`);
  lines.push(`Bias:        ${bias.bias} (${bias.confidence}% zekerheid)`);
  if (bias.overridden) lines.push(`⚠ HANDMATIGE OVERRIDE actief — ${bias.override?.reason ?? "geen reden"}`);
  if (bias.primarySignal) lines.push(`Primair signaal: ${bias.primarySignal}`);
  if (bias.orderFlow) {
    lines.push(`Order Flow:  ${bias.orderFlow.direction} (${bias.orderFlow.confidence}%) — ${bias.orderFlow.reason}`);
    lines.push(`  prevC3High: ${bias.orderFlow.prevC3High ?? "n.v.t."}  prevC3Low: ${bias.orderFlow.prevC3Low ?? "n.v.t."}  structuurIntact: ${bias.orderFlow.structureIntact}`);
  }
  lines.push(``);

  lines.push(`Reden(en):`);
  (bias.reasons ?? []).slice(0, 5).forEach(r => lines.push(`  · ${r}`));
  lines.push(``);

  if (bias.weeklyOHLC) {
    const w = bias.weeklyOHLC;
    lines.push(`Week OHLC: O=${w.open.toFixed(0)}  H=${w.high.toFixed(0)}  L=${w.low.toFixed(0)}  C=${w.close.toFixed(0)}`);
  }
  lines.push(`Prijs zone: ${bias.priceZone} (prijs=${bias.currentPrice})`);
  lines.push(`Dag: ${bias.todayName}`);
  lines.push(``);

  if (bias.equalHighs?.length) {
    lines.push(`Equal Highs (EQH) — nog niet geswept (bullish magneet):`);
    bias.equalHighs.forEach(e => lines.push(`  ▲ ${e.level.toFixed(0)}  (${e.dayA}/${e.dayB})  ${e.diffPct}% verschil  ${e.priceDistance != null ? `+${Math.abs(e.priceDistance).toFixed(0)} pts` : ""}`));
    lines.push(``);
  }
  if (bias.equalLows?.length) {
    lines.push(`Equal Lows (EQL) — nog niet geswept (bearish magneet):`);
    bias.equalLows.forEach(e => lines.push(`  ▼ ${e.level.toFixed(0)}  (${e.dayA}/${e.dayB})  ${e.diffPct}% verschil  ${e.priceDistance != null ? `-${Math.abs(e.priceDistance).toFixed(0)} pts` : ""}`));
    lines.push(``);
  }

  if (bias.wednesday?.analyzed) {
    const w = bias.wednesday;
    lines.push(`Woensdag analyse: ${w.isReversal ? (w.isBearishReversal ? "BEARISH REVERSAL" : "BULLISH REVERSAL") : w.eqHighContinuation ? "EQH continuation (bullish)" : w.eqLowContinuation ? "EQL continuation (bearish)" : "geen reversal"}`);
  }

  if (bias.friday?.applicable) {
    const f = bias.friday;
    lines.push(`Vrijdag analyse: isHighProbReversion=${f.isHighProbReversion}  reversionActive=${f.reversionActive}  richting=${f.reversionDirection ?? "n.v.t."}  target=${f.reversionTarget ?? "—"}  kans=${f.reversionConfidence}%  cyclus=${f.currentCycle}  weekNetPct=${f.weekNetPct}%`);
  }

  if (bias.dowAdvice) {
    const d = bias.dowAdvice;
    lines.push(`Dag-van-de-week advies: ${d.phase} — ${d.entryAdvice}`);
    lines.push(`  Hoge kans cycles: ${d.highProb.join(", ")}  |  Lage kans: ${d.lowProb.join(", ")}`);
    if (d.note) lines.push(`  Note: ${d.note}`);
  }

  return lines.join("\n");
}

// ── Express server ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());

// Stripe webhook needs RAW body for signature verification — must be mounted
// BEFORE express.json() so the body isn't parsed as JSON. The handler itself
// is defined further below in the billing section but the parser is here.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), async (req, res, next) => {
  // The actual handler is registered later via stripeWebhookHandler. Bridge here
  // by exposing res/req on a shared symbol so the late-bound function picks up.
  if (!stripeWebhookHandler) return res.status(503).json({ ok: false, error: "Stripe niet geconfigureerd" });
  return stripeWebhookHandler(req, res, next);
});
let stripeWebhookHandler = null;

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Public homepage stats — used for social proof on the landing page.
// No auth required. Returns aggregated win/loss stats + recent winning trades.
app.get("/api/public/stats", (req, res) => {
  let log = [];
  try { log = JSON.parse(readFileSync(join(__dir, "../monitor/setup_log.json"), "utf8")); } catch {}
  const closed = log.filter(e => e.outcome === "WIN" || e.outcome === "LOSS");
  const wins   = closed.filter(e => e.outcome === "WIN").length;
  const losses = closed.filter(e => e.outcome === "LOSS").length;
  const total  = wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

  // Last 30d wins for "recent wins" ticker
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const recentWins = log
    .filter(e => e.outcome === "WIN" && (e.tp2HitTs || e.ts) >= since)
    .sort((a, b) => (b.tp2HitTs || b.ts || 0) - (a.tp2HitTs || a.ts || 0))
    .slice(0, 12)
    .map(e => ({
      market:    e.market,
      direction: e.direction,
      tf:        e.tf || e.source,
      outcome:   e.tp3HitTs ? "TP3" : "TP2",
      time:      e.tp2HitTime || e.datetime,
      ts:        e.tp2HitTs || e.ts,
    }));

  res.json({
    ok: true,
    stats: {
      totalSetups:    closed.length,
      wins, losses, winRate,
      activeMarkets:  ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"].length,
      avgWinR:        2,                             // TP2 = 2R per design
      runnerR:        10,                            // TP3 = 10R runner
    },
    recentWins,
  });
});

// ── Auth routes ────────────────────────────────────────────────────────────────
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, tier } = req.body ?? {};
    if (!name?.trim() || !email?.trim() || !password)
      return res.status(400).json({ ok: false, error: "Vul alle velden in" });
    const chosenTier = ["signal", "auto-trade"].includes(tier) ? tier : "free";
    if (password.length < 8)
      return res.status(400).json({ ok: false, error: "Wachtwoord minimaal 8 tekens" });

    const exists = await User.findOne({ email });
    if (exists)
      return res.status(409).json({ ok: false, error: "E-mailadres is al in gebruik" });

    const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: name.trim(), email, password: hash, isAdmin, lastLogin: new Date(),
      subscriptionTier: chosenTier,    // "free" or "auto-trade" (default free)
    });
    await LoginEvent.create({ userId: user._id, name: user.name, email: user.email, ip: req.ip });
    const token = jwt.sign({ id: user._id, email: user.email, name: user.name, isAdmin }, JWT_SECRET, { expiresIn: "30d" });
    res.json({
      ok: true, token,
      user: { id: user._id, name: user.name, email: user.email, isAdmin },
      // If user picked auto-trade tier at signup, frontend redirects to checkout
      // immediately so they hit Stripe before landing on the dashboard.
      requiresCheckout: (chosenTier === "auto-trade" || chosenTier === "signal") && !isAdmin,
      tier: chosenTier,
    });
  } catch (err) {
    console.error("register error:", err.message);
    res.status(500).json({ ok: false, error: "Server fout, probeer opnieuw" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email?.trim() || !password)
      return res.status(400).json({ ok: false, error: "Vul alle velden in" });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ ok: false, error: "Onjuiste inloggegevens" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ ok: false, error: "Onjuiste inloggegevens" });

    // Track login event
    user.lastLogin = new Date();
    await user.save();
    await LoginEvent.create({ userId: user._id, name: user.name, email: user.email, ip: req.ip });

    const token = jwt.sign({ id: user._id, email: user.email, name: user.name, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ ok: true, token, user: { id: user._id, name: user.name, email: user.email, isAdmin: user.isAdmin } });
  } catch (err) {
    console.error("login error:", err.message);
    res.status(500).json({ ok: false, error: "Server fout, probeer opnieuw" });
  }
});

// Update user's language preference. Logged in only — anonymous users persist via localStorage.
app.patch("/api/auth/language", requireAuth, async (req, res) => {
  const lang = req.body?.language;
  if (!["en", "nl"].includes(lang)) return res.status(400).json({ ok: false, error: "Invalid language" });
  await User.findByIdAndUpdate(req.user.id, { language: lang });
  res.json({ ok: true, language: lang });
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  // Include language preference so frontend can sync after fresh login
  const u = await User.findById(req.user.id).select("language").lean();
  res.json({ ok: true, user: { ...req.user, language: u?.language ?? "en" } });
});

// ── Broker / CopyFactory subscriber endpoints ─────────────────────────────────
// All four endpoints are per-user (requireAuth). Credentials submitted to
// /api/broker/connect are forwarded to MetaApi at provisioning time and are
// NEVER persisted in our DB. We only keep the metaapi accountId + display
// fields. Per-user copy preferences (markets, risk) are stored locally and
// sync'd to CopyFactory on every change.

const ALL_MARKETS = ["NAS100","US500","US30","XAUUSD","GBPUSD","BTCUSD","ETHUSD"];

function sanitizePrefs(body) {
  const enabled = Array.isArray(body.enabledMarkets)
    ? body.enabledMarkets.filter(m => ALL_MARKETS.includes(m))
    : ALL_MARKETS;
  const mode = body.riskMode === "fixedLot" ? "fixedLot" : "percentBalance";
  const raw  = Number(body.riskValue);
  const val  = Number.isFinite(raw) && raw > 0
    ? Math.min(mode === "percentBalance" ? 10 : 100, raw) // hard caps: 10% / 100 lot
    : (mode === "percentBalance" ? 1.0 : 0.01);
  return {
    enabledMarkets: enabled,
    riskMode:       mode,
    riskValue:      val,
    copyEnabled:    body.copyEnabled !== false,
  };
}

// Required broker for new connections — Liquid Markets MT5 via affiliate link.
// Hardcoded validation: only "LiquidMarkets-Server" accepted. Anyone trying to
// connect another broker is rejected with the affiliate signup link in the error
// payload so the dashboard can render a "register here" CTA.
const REQUIRED_BROKER_SERVER = "LiquidMarkets-Server";
const REQUIRED_BROKER_NAME   = "Liquid Markets";
const REQUIRED_BROKER_PLATFORM = "mt5";
const LIQUID_MARKETS_AFFILIATE_URL = process.env.LIQUID_MARKETS_AFFILIATE_URL
  || env.LIQUID_MARKETS_AFFILIATE_URL
  || "https://liquidmarkets.com/?ref=BLBL";  // TODO: replace with real affiliate URL

app.get("/api/broker/required", (req, res) => {
  res.json({
    ok: true,
    broker:        REQUIRED_BROKER_NAME,
    server:        REQUIRED_BROKER_SERVER,
    platform:      REQUIRED_BROKER_PLATFORM,
    affiliateUrl:  LIQUID_MARKETS_AFFILIATE_URL,
    message:       `Voor Auto-Trade is een ${REQUIRED_BROKER_NAME} ${REQUIRED_BROKER_PLATFORM.toUpperCase()} account verplicht. Open er één via onze affiliate link en gebruik server "${REQUIRED_BROKER_SERVER}".`,
  });
});

app.post("/api/broker/connect", requireAuth, requirePaidStatus, async (req, res) => {
  const { login, password, server, platform = "mt5", broker = "" } = req.body || {};
  if (!login || !password || !server) {
    return res.status(400).json({ ok: false, error: "login, password, server zijn verplicht" });
  }
  // Tier check: only auto-trade subscribers (and admin) can connect a broker.
  // Signal tier = signals only (manual trading), no broker execution.
  const u = await User.findById(req.user.id).lean();
  if (!u?.isAdmin && u?.subscriptionTier !== "auto-trade") {
    return res.status(403).json({
      ok: false,
      error: "Broker-koppeling vereist Auto-Trade abonnement. Upgrade vanaf Signal Viewer naar Auto-Trade voor autonomous trading.",
      requiredTier: "auto-trade",
      currentTier:  u?.subscriptionTier ?? "free",
    });
  }
  // Liquid Markets enforcement
  if (server !== REQUIRED_BROKER_SERVER) {
    return res.status(400).json({
      ok: false,
      error: `Alleen ${REQUIRED_BROKER_NAME} (${REQUIRED_BROKER_SERVER}) wordt ondersteund. Open een account via onze affiliate link.`,
      requiredBroker: REQUIRED_BROKER_NAME,
      requiredServer: REQUIRED_BROKER_SERVER,
      affiliateUrl:   LIQUID_MARKETS_AFFILIATE_URL,
    });
  }
  if (platform.toLowerCase() !== REQUIRED_BROKER_PLATFORM) {
    return res.status(400).json({
      ok: false,
      error: `Alleen ${REQUIRED_BROKER_PLATFORM.toUpperCase()} accounts worden ondersteund.`,
      requiredPlatform: REQUIRED_BROKER_PLATFORM,
    });
  }
  try {
    const provisioned = await metaapi.provisionSubscriberAccount({ login, password, server, platform });
    // Deploy so the account actually connects to the broker — without this it
    // stays UNDEPLOYED and CopyFactory signals are ignored. Best-effort: a
    // duplicate-deploy on an already-deployed account returns an error we ignore.
    await metaapi.deployAccount(provisioned.id).catch(err => {
      console.warn("[broker/connect] deploy non-fatal:", err.message);
    });
    const prefs = sanitizePrefs(req.body);
    // Register as CopyFactory subscriber (subscriberId = MT account id).
    await metaapi.upsertSubscriber({
      accountId: provisioned.id,
      name:      `${req.user.name || req.user.email}-${login}`,
      server,
      prefs,
    });
    const row = await BrokerAccount.create({
      userId:           req.user.id,
      metaapiAccountId: provisioned.id,
      broker:           broker || server,
      login:            String(login),
      server,
      platform,
      status:           provisioned.state || "DEPLOYING",
      ...prefs,
    });
    // Sync €19 extra-account add-on to Stripe subscription. Increments
    // quantity if user already has a sub; ignored for free/trial/admin.
    syncExtraAccountQuantity(req.user.id).catch(() => {});
    res.json({ ok: true, account: publicAccount(row) });
  } catch (err) {
    console.error("/api/broker/connect:", err.message);
    res.status(err.status === 400 || err.status === 409 ? 400 : 500).json({
      ok: false, error: err.body?.message || err.message || "Broker koppeling mislukt",
    });
  }
});

app.get("/api/broker/accounts", requireAuth, async (req, res) => {
  const rows = await BrokerAccount.find({ userId: req.user.id }).sort({ createdAt: -1 });
  // Best-effort live state refresh (don't block on failure)
  const refreshed = await Promise.all(rows.map(async r => {
    try {
      const s = await metaapi.getAccountState(r.metaapiAccountId);
      if (s?.state && s.state !== r.status) {
        r.status = s.state; await r.save();
      }
      return publicAccount(r, s);
    } catch { return publicAccount(r); }
  }));
  res.json({ ok: true, accounts: refreshed });
});

app.patch("/api/broker/accounts/:id", requireAuth, requirePaidStatus, async (req, res) => {
  const row = await BrokerAccount.findOne({ _id: req.params.id, userId: req.user.id });
  if (!row) return res.status(404).json({ ok: false, error: "Account niet gevonden" });
  const prefs = sanitizePrefs({ ...row.toObject(), ...req.body });
  Object.assign(row, prefs, { updatedAt: new Date() });
  try {
    await metaapi.upsertSubscriber({
      accountId: row.metaapiAccountId,
      name:      `${req.user.name || req.user.email}-${row.login}`,
      server:    row.server,
      prefs,
    });
    await row.save();
    res.json({ ok: true, account: publicAccount(row) });
  } catch (err) {
    console.error("/api/broker/accounts PATCH:", err.message);
    res.status(500).json({ ok: false, error: err.body?.message || err.message });
  }
});

app.delete("/api/broker/accounts/:id", requireAuth, async (req, res) => {
  const row = await BrokerAccount.findOne({ _id: req.params.id, userId: req.user.id });
  if (!row) return res.status(404).json({ ok: false, error: "Account niet gevonden" });
  try {
    await metaapi.deleteSubscriber(row.metaapiAccountId).catch(() => {});
    await metaapi.deleteAccount(row.metaapiAccountId).catch(() => {});
    await row.deleteOne();
    // Decrement extra-account quantity on Stripe subscription
    syncExtraAccountQuantity(req.user.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error("/api/broker/accounts DELETE:", err.message);
    res.status(500).json({ ok: false, error: err.body?.message || err.message });
  }
});

function publicAccount(row, liveState = null) {
  return {
    id:               row._id,
    metaapiAccountId: row.metaapiAccountId,
    broker:           row.broker,
    login:            row.login,
    server:           row.server,
    platform:         row.platform,
    status:           liveState?.state || row.status,
    connectionStatus: liveState?.connectionStatus,
    balance:          liveState?.balance,
    equity:           liveState?.equity,
    enabledMarkets:   row.enabledMarkets,
    riskMode:         row.riskMode,
    riskValue:        row.riskValue,
    copyEnabled:      row.copyEnabled,
    createdAt:        row.createdAt,
  };
}

app.get("/api/broker/markets", requireAuth, (req, res) => {
  res.json({ ok: true, markets: ALL_MARKETS });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── Billing (Stripe Checkout + invoices) ───────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Tiers:
//   free      — 1 winning signal/wk (until first TP2 of the week)
//   auto-trade — €69/mo, full real-time signals + broker execution
//
// Lifecycle:
//   /api/billing/checkout → Stripe Checkout session → user pays
//   webhook checkout.session.completed → set tier=auto-trade, status=active
//   webhook invoice.paid                → invoice marked paid, tradingLocked=false
//   webhook invoice.payment_failed      → tradingLocked=true (lock-screen)
//   webhook customer.subscription.deleted → tier=free, undeploy MetaApi accounts
// ─────────────────────────────────────────────────────────────────────────────

function requireStripe(req, res, next) {
  if (!stripe) return res.status(503).json({ ok: false, error: "Stripe nog niet geconfigureerd op de server." });
  next();
}

// ── Extra-account add-on synchronization ─────────────────────────────────────
// Each Auto-Trade subscription has an optional "Extra Account" line item
// (€19/mnd × N where N = total broker accounts - 1). Helper updates the
// quantity on the user's Stripe subscription whenever they connect/disconnect.
//
// Admins are exempt — Shannon can connect unlimited free accounts.
async function syncExtraAccountQuantity(userId) {
  const u = await User.findById(userId);
  if (!u) return;
  if (u.isAdmin) return;                                // admin: free unlimited
  if (!u.stripeSubscriptionId) return;                  // free/trial users with no Stripe sub yet — handled at checkout

  const totalAccounts = await BrokerAccount.countDocuments({ userId: u._id });
  const extras = Math.max(0, totalAccounts - 1);        // first account included in base €69

  if (!stripe || !stripeKeys.priceExtra) return;
  try {
    const sub = await stripe.subscriptions.retrieve(u.stripeSubscriptionId);
    // Find existing Extra Account item (by price id)
    const existing = sub.items.data.find(it => it.price.id === stripeKeys.priceExtra);
    if (extras === 0) {
      // No extras needed — remove the item if it exists
      if (existing) await stripe.subscriptionItems.del(existing.id, { proration_behavior: "create_prorations" });
    } else if (existing) {
      // Update quantity
      if (existing.quantity !== extras) {
        await stripe.subscriptionItems.update(existing.id, { quantity: extras, proration_behavior: "create_prorations" });
      }
    } else {
      // Create item with quantity
      await stripe.subscriptionItems.create({
        subscription:       u.stripeSubscriptionId,
        price:              stripeKeys.priceExtra,
        quantity:           extras,
        proration_behavior: "create_prorations",
      });
    }
    console.log(`[extras] user ${u.email}: ${extras} extra account(s) synced to Stripe sub`);
  } catch (e) {
    console.warn(`[extras] sync failed for ${u.email}: ${e.message}`);
  }
}

// Re-deploy + re-subscribe all of a user's broker accounts to MetaApi.
// Called from webhook on payment success / new subscription so users who
// were locked (or subscription.deleted → undeployed) automatically get their
// signals back without having to manually reconnect.
async function reactivateUserAccounts(userId) {
  try {
    const accounts = await BrokerAccount.find({ userId });
    for (const a of accounts) {
      try { await metaapi.deployAccount(a.metaapiAccountId); }
      catch (e) { console.warn(`[reactivate] deploy ${a.metaapiAccountId}: ${e.message}`); }
      try {
        const prefs = sanitizePrefs(a.toObject());
        await metaapi.upsertSubscriber({
          accountId: a.metaapiAccountId,
          name:      `reactivate-${a.login}`,
          server:    a.server,
          prefs,
        });
      } catch (e) { console.warn(`[reactivate] subscriber ${a.metaapiAccountId}: ${e.message}`); }
    }
    console.log(`[reactivate] user ${userId}: ${accounts.length} accounts redeployed`);
  } catch (e) {
    console.warn(`[reactivate] user ${userId} failed: ${e.message}`);
  }
}

// Sync Stripe subscription state into our DB user record. Idempotent.
// Determines tier by inspecting subscription items — checks against our two
// recurring prices (signal vs auto-trade). Falls back to metadata.tier if items
// are still loading.
function determineTierFromSub(sub) {
  if (!sub) return "free";
  const items = sub.items?.data ?? [];
  const hasAuto   = items.some(it => it.price?.id === stripeKeys.priceAuto);
  const hasSignal = items.some(it => it.price?.id === stripeKeys.priceSignal);
  if (hasAuto) return "auto-trade";
  if (hasSignal) return "signal";
  return sub.metadata?.tier === "signal" ? "signal"
       : sub.metadata?.tier === "auto-trade" ? "auto-trade"
       : "free";
}

async function syncSubscriptionToUser(userId, sub) {
  const tier = sub.status === "canceled" ? "free" : determineTierFromSub(sub);
  const update = {
    stripeSubscriptionId:         sub.id,
    subscriptionStatus:           sub.status,
    subscriptionTier:             tier,
    tradingLocked:                ["past_due", "unpaid", "canceled"].includes(sub.status),
  };
  // Guard against undefined/null current_period_end — Stripe sometimes sends
  // subscription updates before the period is calculated. Skip the date update
  // rather than crashing with "Invalid Date" cast error.
  if (sub.current_period_end) {
    update.subscriptionCurrentPeriodEnd = new Date(sub.current_period_end * 1000);
  }
  await User.findByIdAndUpdate(userId, update);
}

// GET /api/profile — aggregated user profile dashboard.
// Returns user info + subscription state + weekly free-tier status + signal lock.
// Single round-trip for the profile page.
app.get("/api/profile", requireAuth, async (req, res) => {
  const u = await User.findById(req.user.id).lean();
  if (!u) return res.status(404).json({ ok: false, error: "user not found" });

  const isAdminUser = !!u.isAdmin;
  const tier   = u.subscriptionTier ?? "free";
  const status = u.subscriptionStatus ?? null;
  const hasActiveSub = ["auto-trade", "signal"].includes(tier)
                    && (status === "active" || status === "trialing")
                    && !u.tradingLocked;

  // Weekly free-tier state — only relevant for free users
  let weekly = null;
  if (!isAdminUser && !hasActiveSub) {
    let setupLog = [];
    try { setupLog = JSON.parse(readFileSync(join(__dir, "../monitor/setup_log.json"), "utf8")); } catch {}
    const weekStart = isoWeekStartUtc();
    const userCreatedMs = u.createdAt ? new Date(u.createdAt).getTime() : 0;
    const firstWin = findFirstTp2HitThisWeek(setupLog, weekStart.getTime(), userCreatedMs);
    weekly = {
      enabled:      true,
      weekStart:    weekStart.toISOString(),
      exhausted:    !!firstWin,
      firstWin:     firstWin ? {
        market:    firstWin.market,
        direction: firstWin.direction,
        tf:        firstWin.tf,
        entry:     firstWin.entry,
        sl:        firstWin.sl,
        tp1:       firstWin.tp1,
        tp2:       firstWin.tp2,
        entryTime: firstWin.entryTime || firstWin.datetime,
        tp2Time:   firstWin.tp2HitTime || firstWin.datetime,
      } : null,
      nextResetAt:  new Date(weekStart.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
    };
  }

  // Stats
  const openInvoices = await Invoice.countDocuments({ userId: u._id, status: "open" });
  const totalInvoices = await Invoice.countDocuments({ userId: u._id });
  // Broker accounts + add-on cost preview
  const brokerCount = await BrokerAccount.countDocuments({ userId: u._id });
  const extras      = Math.max(0, brokerCount - 1);
  // Monthly cost the user will pay (in cents)
  const monthlyCostEur = u.isAdmin ? 0
                       : tier === "auto-trade" ? 6900 + (extras * 1900)
                       : tier === "signal"     ? 3900
                       : 0;
  const periodExpired = u.subscriptionCurrentPeriodEnd
                     && new Date(u.subscriptionCurrentPeriodEnd).getTime() < Date.now()
                     && tier !== "free";
  const tradingLocked = !!u.tradingLocked || periodExpired || openInvoices > 0;

  res.json({
    ok: true,
    user: {
      id:        u._id,
      name:      u.name,
      email:     u.email,
      isAdmin:   !!u.isAdmin,
      memberSince: u.createdAt,
      lastLogin:   u.lastLogin,
    },
    subscription: {
      tier,
      status,
      currentPeriodEnd: u.subscriptionCurrentPeriodEnd ?? null,
      tradingLocked,
      hasActiveSub,
    },
    weekly,                                     // null voor admin/auto-trade users
    signalAccess: {
      // Wat ze in de dashboard mogen zien:
      mode: hasActiveSub || isAdminUser
        ? "full"                                 // alle signals real-time
        : weekly?.exhausted ? "locked-weekly"   // free, weekly already used
                            : "free-weekly",    // free, still active this week
      // Als locked door payment-issue:
      locked: tradingLocked,
    },
    invoices: {
      open:  openInvoices,
      total: totalInvoices,
    },
    accounts: {
      total:           brokerCount,
      includedInBase:  Math.min(1, brokerCount),
      addOnCount:      extras,                   // # extra-account add-ons billed
      addOnPriceCents: 1900,                     // €19/mnd per extra
    },
    pricing: {
      baseCents:       u.isAdmin ? 0
                     : tier === "auto-trade" ? 6900
                     : tier === "signal"     ? 3900
                     : 0,
      extrasCents:     u.isAdmin || tier !== "auto-trade" ? 0 : extras * 1900,
      monthlyCents:    monthlyCostEur,
      currency:        "EUR",
    },
  });
});

// GET /api/billing/me — current subscription state for logged-in user
app.get("/api/billing/me", requireAuth, async (req, res) => {
  const u = await User.findById(req.user.id).lean();
  if (!u) return res.status(404).json({ ok: false, error: "user not found" });
  // Compute "effective" trading lock: tradingLocked flag OR period expired
  const now = Date.now();
  const periodExpired = u.subscriptionCurrentPeriodEnd && new Date(u.subscriptionCurrentPeriodEnd).getTime() < now
                     && u.subscriptionTier !== "free";
  const openInvoices = await Invoice.countDocuments({ userId: u._id, status: "open" });
  const locked = !!u.tradingLocked || periodExpired || openInvoices > 0;
  res.json({
    ok: true,
    tier:               u.subscriptionTier ?? "free",
    status:             u.subscriptionStatus ?? null,
    currentPeriodEnd:   u.subscriptionCurrentPeriodEnd ?? null,
    tradingLocked:      locked,
    openInvoiceCount:   openInvoices,
    publishableKey:     stripeKeys.publishable,
  });
});

// GET /api/billing/transactions — deposits/withdrawals so user can see capital
// movements on their account. Includes broker-side time + comment.
app.get("/api/billing/transactions", requireAuth, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 365, 730);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const txs = await AccountTransaction.find({
    userId:     req.user.id,
    brokerTime: { $gte: since },
  }).sort({ brokerTime: -1 }).limit(500).lean();
  res.json({
    ok: true,
    transactions: txs.map(t => ({
      id:       t._id,
      type:     t.type,
      amount:   t.amount,
      currency: t.currency,
      comment:  t.comment,
      time:     t.brokerTime,
      account:  t.metaapiAccountId,
    })),
  });
});

// GET /api/billing/balance-history — historical snapshots for graph + invoicing
app.get("/api/billing/balance-history", requireAuth, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 90, 365);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const snaps = await BalanceSnapshot.find({
    userId:     req.user.id,
    snapshotAt: { $gte: since },
  }).sort({ snapshotAt: 1 }).lean();
  res.json({
    ok: true,
    snapshots: snaps.map(s => ({
      at:           s.snapshotAt,
      balance:      s.balance,
      equity:       s.equity,
      currency:     s.currency,
      account:      s.metaapiAccountId,
    })),
  });
});

// GET /api/billing/invoices — list invoices for logged-in user (newest first)
app.get("/api/billing/invoices", requireAuth, async (req, res) => {
  const invoices = await Invoice.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ ok: true, invoices: invoices.map(i => ({
    id:          i._id,
    type:        i.type,
    amount:      i.amount,
    currency:    i.currency,
    status:      i.status,
    description: i.description,
    periodStart: i.periodStart,
    periodEnd:   i.periodEnd,
    createdAt:   i.createdAt,
    paidAt:      i.paidAt,
    paymentLink: i.status === "open" ? i.stripePaymentLink : null,
  }))});
});

// POST /api/billing/checkout — start subscription. Accepts {tier: "signal" | "auto-trade"}
// Default = "auto-trade" voor backward-compat.
app.post("/api/billing/checkout", requireAuth, requireStripe, async (req, res) => {
  const tier = req.body?.tier === "signal" ? "signal" : "auto-trade";
  const priceId = tier === "signal" ? stripeKeys.priceSignal : stripeKeys.priceAuto;
  if (!priceId) return res.status(503).json({ ok: false, error: `${tier} price ID niet ingesteld in .env` });
  try {
    const u = await User.findById(req.user.id);
    let customerId = u.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: u.email, name: u.name, metadata: { userId: String(u._id) },
      });
      customerId = customer.id;
      u.stripeCustomerId = customerId;
      await u.save();
    }
    // Auto-Trade only: include €19 extra-account add-ons. Signal Viewer is
    // single-price (no broker = no extras).
    const lineItems = [{ price: priceId, quantity: 1 }];
    if (tier === "auto-trade") {
      const totalAccounts = await BrokerAccount.countDocuments({ userId: u._id });
      const extras = Math.max(0, totalAccounts - 1);
      if (extras > 0 && stripeKeys.priceExtra) {
        lineItems.push({ price: stripeKeys.priceExtra, quantity: extras });
      }
    }
    const session = await stripe.checkout.sessions.create({
      mode:                "subscription",
      customer:            customerId,
      line_items:          lineItems,
      success_url:         `${APP_URL}/billing?success=1`,
      cancel_url:          `${APP_URL}/billing?canceled=1`,
      metadata:            { userId: String(u._id), tier },
      subscription_data:   { metadata: { userId: String(u._id), tier } },
      allow_promotion_codes: true,
    });
    res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("/api/billing/checkout:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/billing/portal — Stripe customer portal (manage/cancel subscription)
app.post("/api/billing/portal", requireAuth, requireStripe, async (req, res) => {
  try {
    const u = await User.findById(req.user.id);
    if (!u.stripeCustomerId) return res.status(400).json({ ok: false, error: "Geen Stripe-klant. Schrijf je eerst in via Checkout." });
    const portal = await stripe.billingPortal.sessions.create({
      customer:    u.stripeCustomerId,
      return_url:  `${APP_URL}/billing`,
    });
    res.json({ ok: true, url: portal.url });
  } catch (err) {
    console.error("/api/billing/portal:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/billing/pay-invoice/:id — get fresh Stripe payment link for an open invoice
app.post("/api/billing/pay-invoice/:id", requireAuth, requireStripe, async (req, res) => {
  try {
    const inv = await Invoice.findOne({ _id: req.params.id, userId: req.user.id });
    if (!inv) return res.status(404).json({ ok: false, error: "Factuur niet gevonden" });
    if (inv.status !== "open") return res.status(400).json({ ok: false, error: `Factuur status is ${inv.status}` });
    if (!inv.stripeInvoiceId) return res.status(400).json({ ok: false, error: "Factuur heeft geen Stripe-koppeling" });
    // Refresh hosted URL from Stripe (the link can rotate)
    const stripeInv = await stripe.invoices.retrieve(inv.stripeInvoiceId);
    inv.stripePaymentLink = stripeInv.hosted_invoice_url;
    await inv.save();
    res.json({ ok: true, paymentLink: stripeInv.hosted_invoice_url });
  } catch (err) {
    console.error("/api/billing/pay-invoice:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Webhook handler (raw body parser is registered earlier near app setup)
stripeWebhookHandler = async (req, res) => {
  if (!stripe) return res.status(503).end();
  let event;
  try {
    if (stripeKeys.webhookSecret) {
      event = stripe.webhooks.constructEvent(
        req.body,                                   // raw Buffer
        req.headers["stripe-signature"],
        stripeKeys.webhookSecret,
      );
    } else {
      // Dev mode (no signing secret yet): trust the body. Replace with signed
      // verification once you've configured the webhook in Stripe dashboard.
      event = JSON.parse(req.body.toString());
      console.warn("[Stripe webhook] no signing secret — verifying disabled (dev mode)");
    }
  } catch (err) {
    console.error("[Stripe webhook] signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const userId = s.metadata?.userId;
        if (userId && s.subscription) {
          const sub = await stripe.subscriptions.retrieve(s.subscription);
          await syncSubscriptionToUser(userId, sub);
          console.log(`[Stripe] checkout completed → user ${userId} subscribed`);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (userId) {
          await syncSubscriptionToUser(userId, sub);
          // Active or trialing → ensure accounts are deployed (handles
          // re-subscribers whose accounts were undeployed at last cancel).
          if (sub.status === "active" || sub.status === "trialing") {
            await reactivateUserAccounts(userId);
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const userId = sub.metadata?.userId;
        if (userId) {
          await User.findByIdAndUpdate(userId, {
            subscriptionTier:   "free",
            subscriptionStatus: "canceled",
            tradingLocked:      true,
          });
          // Best-effort: undeploy + remove CopyFactory subscriber accounts
          try {
            const accounts = await BrokerAccount.find({ userId });
            for (const a of accounts) {
              try { await metaapi.undeployAccount(a.metaapiAccountId); } catch {}
              try { await metaapi.removeSubscriber(a.metaapiAccountId); } catch {}
            }
          } catch (e) { console.warn("subscription.deleted cleanup:", e.message); }
        }
        break;
      }
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        const userId = inv.metadata?.userId
                    || (await User.findOne({ stripeCustomerId: inv.customer }).select("_id").lean())?._id;
        if (userId) {
          // Upsert local Invoice record
          await Invoice.findOneAndUpdate(
            { stripeInvoiceId: inv.id },
            {
              userId, type: "subscription",
              amount: inv.amount_paid, currency: (inv.currency || "eur").toUpperCase(),
              status: "paid", stripeInvoiceId: inv.id,
              stripePaymentLink: inv.hosted_invoice_url,
              periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
              periodEnd:   inv.period_end   ? new Date(inv.period_end   * 1000) : null,
              description: inv.description || "Auto-Trade abonnement",
              paidAt: new Date(),
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
          // Unlock trading + redeploy any accounts that were undeployed
          await User.findByIdAndUpdate(userId, { tradingLocked: false });
          await reactivateUserAccounts(userId);
        }
        break;
      }
      case "invoice.payment_failed":
      case "invoice.created": {
        const inv = event.data.object;
        const userId = inv.metadata?.userId
                    || (await User.findOne({ stripeCustomerId: inv.customer }).select("_id").lean())?._id;
        if (userId) {
          await Invoice.findOneAndUpdate(
            { stripeInvoiceId: inv.id },
            {
              userId, type: "subscription",
              amount: inv.amount_due, currency: (inv.currency || "eur").toUpperCase(),
              status: event.type === "invoice.payment_failed" ? "open" : (inv.paid ? "paid" : "open"),
              stripeInvoiceId: inv.id,
              stripePaymentLink: inv.hosted_invoice_url,
              periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
              periodEnd:   inv.period_end   ? new Date(inv.period_end   * 1000) : null,
              description: inv.description || "Auto-Trade abonnement",
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
          if (event.type === "invoice.payment_failed") {
            await User.findByIdAndUpdate(userId, { tradingLocked: true, subscriptionStatus: "past_due" });
          }
        }
        break;
      }
      default:
        // Other events ignored — only the ones above affect our DB state.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error("[Stripe webhook] handler error:", err.message);
    res.status(500).json({ error: err.message });
  }
};

// ── Admin routes ───────────────────────────────────────────────────────────────

// GET /api/admin/sync — candle freshness + per-TF detail per market
app.get("/api/admin/sync", requireAuth, requireAdmin, (req, res) => {
  const MARKETS_LIST = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const CRYPTO = new Set(["BTCUSD", "ETHUSD"]);
  const SYNC_MS = 20 * 60 * 1000;
  const now = Date.now();
  const monDir = join(__dir, "../monitor");

  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const etWd  = etNow.getDay();
  const etH   = etNow.getHours();
  const isTradingDay = etWd >= 1 && etWd <= 5 && !(etWd === 5 && etH >= 17);

  const fmtET = ts => new Date(ts * 1000).toLocaleString("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  function candleInfo(filePath, maxAgeMs, expectedGapMin) {
    try {
      const raw  = JSON.parse(readFileSync(filePath, "utf8"));
      if (!Array.isArray(raw) || !raw.length) return { ok: false, error: "Leeg" };
      const last  = raw[raw.length - 1];
      const first = raw[0];
      const prev  = raw.length > 1 ? raw[raw.length - 2] : null;
      const gapMin = prev ? +((last.timestamp - prev.timestamp) / 60).toFixed(0) : null;
      const ageMs  = now - last.timestamp * 1000;
      const ageMin = +(ageMs / 60000).toFixed(1);
      const gapOk  = gapMin == null || Math.abs(gapMin - expectedGapMin) <= expectedGapMin * 0.5;
      const fresh  = ageMs <= maxAgeMs;
      return {
        ok:         fresh && gapOk,
        count:      raw.length,
        firstTime:  fmtET(first.timestamp),
        lastTime:   fmtET(last.timestamp),
        lastClose:  last.close,
        ageMin,
        gapMin,
        gapOk,
        fresh,
      };
    } catch { return { ok: false, error: "Geen bestand" }; }
  }

  // Load lock cache for daily lock age
  let lockCache = {};
  try { lockCache = JSON.parse(readFileSync(join(monDir, "lock_cache.json"), "utf8")); } catch {}

  const markets = {};
  for (const key of MARKETS_LIST) {
    const file = join(monDir, `market_data_${key}.json`);
    const isOpen = CRYPTO.has(key) || isTradingDay;

    // Per-TF candle checks
    // 15m: monitor's live scan candles (candles_<key>.json)
    // D: fetch_candles daily candles (candles_1D_<key>.json)
    const tf15m = candleInfo(join(monDir, `candles_${key}.json`),  25 * 60 * 1000, 15);
    const tfD   = candleInfo(join(monDir, `candles_1D_${key}.json`), 26 * 60 * 60 * 1000, 1440);

    // Lock cache freshness
    const lc    = lockCache[key];
    const lockAgeH = lc ? +((now - lc.savedTs) / 3600000).toFixed(1) : null;
    const lockOk   = lc ? lockAgeH <= 6 : false;

    try {
      const d    = JSON.parse(readFileSync(file, "utf8"));
      const ageMs = now - (d.timestamp ?? 0);
      const inSync = isOpen ? ageMs <= SYNC_MS && tf15m.ok : null;
      // Daily levels: dates + H/L + sweep state from market_data
      const dailyLevels = (d.dailyLevels ?? []).map(lev => ({
        date:     lev.date,
        high:     lev.high,
        low:      lev.low,
        isToday:  lev.isToday ?? false,
        hitHigh:  lev.hitHigh ? { price: lev.hitHigh.price, time: lev.hitHigh.time } : null,
        hitLow:   lev.hitLow  ? { price: lev.hitLow.price,  time: lev.hitLow.time  } : null,
      }));
      markets[key] = {
        inSync,
        isOpen,
        ageMin: +(ageMs / 60000).toFixed(1),
        lastScanEt: d.timestamp ? new Date(d.timestamp).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }) : null,
        candleTo:    d.scanMeta?.to     ?? null,
        candleCount: d.scanMeta?.candleCount ?? 0,
        staleAtScan: d.scanMeta?.stale  ?? false,
        allowedDirection: d.allowedDirection ?? null,
        sixHLockState:    d.sixHLockState     ?? null,
        orderFlowBias:    d.orderFlowBias     ?? null,
        candles: {
          "15m": { ...tf15m, label: "15-min", usage: "90-min cycles · 6H cycles · Daily structuur" },
          "D":   { ...tfD,   label: "Dagelijks", usage: "Order flow lock detectie" },
        },
        lockCache: {
          ok: lockOk,
          ageH: lockAgeH,
          direction:     lc?.direction     ?? null,
          strength:      lc?.strength      ?? null,
          matchCount:    lc?.matchCount    ?? null,
          daysSinceLast: lc?.daysSinceLast ?? null,
          movesAgainst:  lc?.movesAgainst  ?? null,
          opportunity:   lc?.opportunity   ?? null,
          note:          lc?.note          ?? null,
          keyDates:      lc?.keyDates      ?? [],
        },
        dailyLevels,
      };
    } catch {
      markets[key] = {
        inSync: false, isOpen, ageMin: null, error: "Geen market data",
        candles: {
          "15m": tf15m,
          "D":   tfD,
        },
        lockCache: {
          ok: lockOk,
          ageH: lockAgeH,
          direction:     lc?.direction     ?? null,
          strength:      lc?.strength      ?? null,
          matchCount:    lc?.matchCount    ?? null,
          daysSinceLast: lc?.daysSinceLast ?? null,
          movesAgainst:  lc?.movesAgainst  ?? null,
          opportunity:   lc?.opportunity   ?? null,
          note:          lc?.note          ?? null,
          keyDates:      lc?.keyDates      ?? [],
        },
        dailyLevels: [],
      };
    }
  }

  const openMarkets = Object.values(markets).filter(m => m.isOpen);
  const allInSync   = openMarkets.length > 0 && openMarkets.every(m => m.inSync === true);
  res.json({ ok: true, allInSync, markets, checkedAt: now });
});

// GET /api/admin/users — all users with stats
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}, { password: 0 }).sort({ createdAt: -1 }).lean();
    const loginCounts = await LoginEvent.aggregate([
      { $group: { _id: "$userId", total: { $sum: 1 } } }
    ]);
    const loginMap = Object.fromEntries(loginCounts.map(l => [String(l._id), l.total]));

    // Signal-view stats per user: total views + last view timestamp
    const viewStats = await SignalView.aggregate([
      { $group: {
        _id: "$userId",
        total: { $sum: 1 },
        lastView: { $max: "$timestamp" },
      }},
    ]);
    const viewMap = Object.fromEntries(viewStats.map(v => [String(v._id), v]));

    const result = users.map(u => ({
      ...u,
      loginCount: loginMap[String(u._id)] ?? 0,
      signalViews: viewMap[String(u._id)]?.total ?? 0,
      lastSignalView: viewMap[String(u._id)]?.lastView ?? null,
    }));
    res.json({ ok: true, users: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/broker-analytics — live snapshot of all broker accounts
// (master + every subscriber): balance, equity, margin, open positions and
// floating PnL. Hits MetaApi REST per account in parallel; polling is free
// (only deployed resource slots are billed).
app.get("/api/admin/broker-analytics", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await BrokerAccount.find({}).lean();
    const userIds = [...new Set(rows.map(r => String(r.userId)))];
    const users   = await User.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    const enriched = await Promise.all(rows.map(async (r) => {
      const out = {
        id:        String(r._id),
        userId:    String(r.userId),
        userName:  userMap[String(r.userId)]?.name  ?? null,
        userEmail: userMap[String(r.userId)]?.email ?? null,
        broker:    r.broker,
        login:     r.login,
        server:    r.server,
        platform:  r.platform,
        copyEnabled:    r.copyEnabled,
        enabledMarkets: r.enabledMarkets,
        riskMode:       r.riskMode,
        riskValue:      r.riskValue,
        metaapiAccountId: r.metaapiAccountId,
        connectionStatus: null,
        state:            null,
        balance:          null,
        equity:           null,
        margin:           null,
        freeMargin:       null,
        currency:         null,
        positions:        [],
        floatingPnl:      0,
        error:            null,
      };
      try {
        const [accState, accInfo, positions] = await Promise.all([
          metaapi.getAccountState(r.metaapiAccountId).catch(() => null),
          metaapi.getAccountInformation(r.metaapiAccountId).catch(() => null),
          metaapi.getOpenPositions(r.metaapiAccountId).catch(() => []),
        ]);
        if (accState) {
          out.state            = accState.state;
          out.connectionStatus = accState.connectionStatus;
        }
        if (accInfo) {
          out.balance    = accInfo.balance;
          out.equity     = accInfo.equity;
          out.margin     = accInfo.margin;
          out.freeMargin = accInfo.freeMargin;
          out.currency   = accInfo.currency;
        }
        if (Array.isArray(positions)) {
          out.positions = positions.map(p => ({
            id:        p.id,
            symbol:    p.symbol,
            type:      p.type,
            volume:    p.volume,
            openPrice: p.openPrice,
            currentPrice: p.currentPrice,
            stopLoss:  p.stopLoss,
            takeProfit: p.takeProfit,
            profit:    p.profit,
            swap:      p.swap,
            commission: p.commission,
            time:      p.time,
            comment:   p.brokerComment,
          }));
          out.floatingPnl = positions.reduce((s, p) => s + (p.profit ?? 0), 0);
        }
      } catch (err) {
        out.error = err.message;
      }
      return out;
    }));

    // Aggregate stats across all subscribers.
    const totals = {
      accounts:    enriched.length,
      connected:   enriched.filter(a => a.connectionStatus === "CONNECTED").length,
      balance:     +enriched.reduce((s, a) => s + (a.balance     ?? 0), 0).toFixed(2),
      equity:      +enriched.reduce((s, a) => s + (a.equity      ?? 0), 0).toFixed(2),
      floatingPnl: +enriched.reduce((s, a) => s + (a.floatingPnl ?? 0), 0).toFixed(2),
      openPositions: enriched.reduce((s, a) => s + a.positions.length, 0),
    };
    res.json({ ok: true, totals, accounts: enriched, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error("/api/admin/broker-analytics:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Compute per-user equity progress aggregated across all their broker accounts.
//   • startingTotal  = Σ account.startingBalance  (admin override or first snap)
//   • currentTotal   = Σ latest BalanceSnapshot.equity
//   • totalProfit    = currentTotal - startingTotal  (profit since day one)
//   • dailyPnl       = currentTotal - equity 24h ago
//   • estPerfFeeCents= 10% × max(0, totalProfit)  (your share — live, not month-end)
// Used by admin subscriptions overview to track per-user growth daily.
async function computeUserEquityProgress(userId, accounts) {
  if (!accounts.length) {
    return {
      startingTotal:   null,
      currentEquity:   null,
      totalProfit:     null,
      totalProfitPct:  null,
      dailyPnl:        null,
      dailyPnlPct:     null,
      estPerfFeeCents: 0,
      accountCount:    0,
      lastUpdated:     null,
      perAccount:      [],
    };
  }
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);

  async function progressForAccount(acc) {
    const accId = acc.metaapiAccountId;
    const [latest, firstEver, yestLast] = await Promise.all([
      BalanceSnapshot.findOne({ metaapiAccountId: accId }).sort({ snapshotAt: -1 }).lean(),
      BalanceSnapshot.findOne({ metaapiAccountId: accId }).sort({ snapshotAt: 1 }).lean(),
      BalanceSnapshot.findOne({ metaapiAccountId: accId, snapshotAt: { $lt: yesterday } }).sort({ snapshotAt: -1 }).lean(),
    ]);
    // Baseline preference: explicit admin-set startingBalance > first-ever snapshot equity.
    const baseline = acc.startingBalance != null
      ? acc.startingBalance
      : (firstEver?.equity ?? null);
    const baselineSource = acc.startingBalance != null ? "admin_override" : (firstEver ? "first_snapshot" : null);
    return {
      accountId:      acc._id,
      login:          acc.login,
      broker:         acc.broker,
      baseline,
      baselineSource,
      baselineSetAt:  acc.startingBalanceSetAt ?? firstEver?.snapshotAt ?? null,
      currentEquity:  latest?.equity ?? null,
      yestEquity:     yestLast?.equity ?? null,
      lastSnapshotAt: latest?.snapshotAt ?? null,
    };
  }
  const perAccount = await Promise.all(accounts.map(progressForAccount));

  // Aggregate — only sum accounts with both baseline AND current data.
  const usable = perAccount.filter(a => a.baseline != null && a.currentEquity != null);
  const startingTotal  = usable.reduce((s, a) => s + a.baseline,      0);
  const currentEquity  = usable.reduce((s, a) => s + a.currentEquity, 0);

  // Daily aggregate — only accounts that ALSO have a >24h-old snapshot.
  const usableDaily = usable.filter(a => a.yestEquity != null);
  const dailyBase   = usableDaily.reduce((s, a) => s + a.yestEquity,    0);
  const dailyNow    = usableDaily.reduce((s, a) => s + a.currentEquity, 0);

  const totalProfit = usable.length ? currentEquity - startingTotal : null;
  const dailyPnl    = usableDaily.length ? dailyNow - dailyBase     : null;

  const lastUpdated = perAccount
    .map(a => a.lastSnapshotAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] ?? null;

  return {
    startingTotal:   usable.length ? startingTotal : null,
    currentEquity:   usable.length ? currentEquity : null,
    totalProfit,
    totalProfitPct:  totalProfit != null && startingTotal > 0 ? (totalProfit / startingTotal) * 100 : null,
    dailyPnl,
    dailyPnlPct:     dailyPnl != null && dailyBase > 0 ? (dailyPnl / dailyBase) * 100 : null,
    // Your live 10% — calculated on every refresh so you see it grow with the user.
    estPerfFeeCents: totalProfit != null && totalProfit > 0 ? Math.round(totalProfit * 0.10 * 100) : 0,
    accountCount:    accounts.length,
    lastUpdated,
    perAccount,
  };
}

// Admin: list of all users with their subscription state — signal access +
// copy-trading status (number of connected broker accounts) — zodat je in één
// blik ziet wie betaalt voor wat.
app.get("/api/admin/users-subscriptions", requireAuth, requireAdmin, async (req, res) => {
  const users = await User.find({}).sort({ createdAt: -1 }).lean();
  // Fetch ALL broker accounts in one query, group by userId — used for both
  // counts AND the per-user equity-progress calculation.
  const allAccounts = await BrokerAccount.find({}).lean();
  const accountsByUser = new Map();
  for (const a of allAccounts) {
    const k = String(a.userId);
    if (!accountsByUser.has(k)) accountsByUser.set(k, []);
    accountsByUser.get(k).push(a);
  }
  // Open invoice counts
  const invAgg = await Invoice.aggregate([
    { $match: { status: "open" } },
    { $group: { _id: "$userId", count: { $sum: 1 }, totalAmount: { $sum: "$amount" } } },
  ]);
  const invMap = Object.fromEntries(invAgg.map(i => [String(i._id), { count: i.count, total: i.totalAmount }]));

  // Compute equity-progress per user in parallel (uses BalanceSnapshot — hourly cron data).
  const progressByUser = new Map();
  await Promise.all(users.map(async (u) => {
    const accs = accountsByUser.get(String(u._id)) ?? [];
    const prog = await computeUserEquityProgress(u._id, accs);
    progressByUser.set(String(u._id), prog);
  }));

  const out = users.map(u => {
    const accs = accountsByUser.get(String(u._id)) ?? [];
    const acc  = {
      total:    accs.length,
      deployed: accs.filter(a => a.status === "DEPLOYED").length,
    };
    const inv  = invMap[String(u._id)] ?? { count: 0, total: 0 };
    const tier = u.subscriptionTier ?? "free";
    const status = u.subscriptionStatus ?? null;
    const hasActiveSub = ["auto-trade", "signal"].includes(tier)
                      && (status === "active" || status === "trialing")
                      && !u.tradingLocked;
    const extras = Math.max(0, acc.total - 1);
    const monthlyCents = u.isAdmin ? 0
                       : tier === "auto-trade" ? 6900 + extras * 1900
                       : tier === "signal"     ? 3900
                       : 0;
    const progress = progressByUser.get(String(u._id));
    return {
      id:            u._id,
      name:          u.name,
      email:         u.email,
      isAdmin:       !!u.isAdmin,
      memberSince:   u.createdAt,
      tier,
      status,
      periodEnd:     u.subscriptionCurrentPeriodEnd ?? null,
      tradingLocked: !!u.tradingLocked,
      signalAccess:    hasActiveSub || u.isAdmin ? "FULL" : "FREE_WEEKLY",
      copyTrading:     tier === "auto-trade" && hasActiveSub && acc.deployed > 0 ? "ACTIVE"
                     : tier === "auto-trade" && hasActiveSub ? "READY_NO_BROKER"
                     : "INACTIVE",
      brokerAccounts: acc,
      addOnCount:     u.isAdmin ? 0 : extras,
      monthlyCents,
      openInvoices:   inv,
      hasStripeCustomer: !!u.stripeCustomerId,
      discordWebhookUrl:     u.discordWebhookUrl ?? null,
      discordWebhookEnabled: u.discordWebhookEnabled !== false,
      // NEW — live equity progress (start-balance → now, daily Δ, your 10% share)
      progress,
    };
  });
  res.json({ ok: true, users: out, total: out.length });
});

// Admin: set/override the starting balance for a specific broker account.
// Used to seed legacy accounts (e.g. Nate's two MT5s started at ~€800 each
// before BalanceSnapshot tracking went live). Once set this becomes the
// baseline for ALL profit + 10% performance-fee calculations.
app.patch("/api/admin/accounts/:id/starting-balance", requireAuth, requireAdmin, async (req, res) => {
  const { startingBalance } = req.body ?? {};
  if (typeof startingBalance !== "number" || !isFinite(startingBalance) || startingBalance < 0) {
    return res.status(400).json({ ok: false, error: "startingBalance must be a non-negative number" });
  }
  const acc = await BrokerAccount.findByIdAndUpdate(
    req.params.id,
    {
      startingBalance,
      startingBalanceSetAt:  new Date(),
      startingBalanceSource: "admin_override",
    },
    { new: true },
  ).lean();
  if (!acc) return res.status(404).json({ ok: false, error: "Account niet gevonden" });
  res.json({ ok: true, account: {
    id: acc._id, login: acc.login, broker: acc.broker,
    startingBalance: acc.startingBalance, setAt: acc.startingBalanceSetAt,
  }});
});

// Admin: list a single user's broker accounts with starting balances + current
// equity. Used by the admin UI's "Edit baselines" drawer.
app.get("/api/admin/users/:id/accounts", requireAuth, requireAdmin, async (req, res) => {
  const accs = await BrokerAccount.find({ userId: req.params.id }).lean();
  const enriched = await Promise.all(accs.map(async (a) => {
    const latest = await BalanceSnapshot.findOne({ metaapiAccountId: a.metaapiAccountId }).sort({ snapshotAt: -1 }).lean();
    const firstEver = await BalanceSnapshot.findOne({ metaapiAccountId: a.metaapiAccountId }).sort({ snapshotAt: 1 }).lean();
    return {
      id:                    a._id,
      metaapiAccountId:      a.metaapiAccountId,
      broker:                a.broker,
      login:                 a.login,
      status:                a.status,
      startingBalance:       a.startingBalance,
      startingBalanceSetAt:  a.startingBalanceSetAt,
      startingBalanceSource: a.startingBalanceSource,
      currentEquity:         latest?.equity ?? null,
      currentBalance:        latest?.balance ?? null,
      lastSnapshotAt:        latest?.snapshotAt ?? null,
      firstSnapshotEquity:   firstEver?.equity ?? null,
      firstSnapshotAt:       firstEver?.snapshotAt ?? null,
    };
  }));
  res.json({ ok: true, accounts: enriched });
});

// Admin: update per-user Discord webhook for signal notifications
app.patch("/api/admin/users/:id/webhook", requireAuth, requireAdmin, async (req, res) => {
  const { discordWebhookUrl, discordWebhookEnabled } = req.body ?? {};
  // Validate URL shape — Discord webhooks always start with this pattern
  if (discordWebhookUrl && !/^https:\/\/discord\.com\/api\/webhooks\//.test(discordWebhookUrl)) {
    return res.status(400).json({ ok: false, error: "Ongeldige Discord webhook URL — moet beginnen met https://discord.com/api/webhooks/" });
  }
  const update = {};
  if (discordWebhookUrl !== undefined)     update.discordWebhookUrl     = discordWebhookUrl || null;
  if (discordWebhookEnabled !== undefined) update.discordWebhookEnabled = !!discordWebhookEnabled;
  const u = await User.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
  if (!u) return res.status(404).json({ ok: false, error: "User niet gevonden" });
  res.json({
    ok: true,
    user: { id: u._id, email: u.email, discordWebhookUrl: u.discordWebhookUrl, discordWebhookEnabled: u.discordWebhookEnabled },
  });
});

// Admin: send a TEST message to a specific user's Discord webhook so admin can
// verify the URL works without waiting for an actual signal.
app.post("/api/admin/users/:id/webhook/test", requireAuth, requireAdmin, async (req, res) => {
  const u = await User.findById(req.params.id).lean();
  if (!u?.discordWebhookUrl) return res.status(400).json({ ok: false, error: "Geen webhook ingesteld" });
  try {
    const r = await fetch(u.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `✅ **Test-bericht van BLACKBULL** — webhook werkt voor ${u.name}.\nJe ontvangt hier voortaan signal-notificaties zodra de strategie een setup detecteert.`,
      }),
    });
    if (!r.ok) throw new Error(`Discord HTTP ${r.status}`);
    res.json({ ok: true, message: "Test-bericht verzonden ✓" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin: global pause/resume of outbound trade signals.
// When paused, copyfactory-bridge.notifySignal + modifySignalSL skip dispatch
// (logged to copyfactory.log). Setup creation + lifecycle keep running locally;
// only broker dispatch is gated. Resume = remove the flag, next cron tick
// dispatches normally again.
app.get("/api/admin/system-state", requireAuth, requireAdmin, (req, res) => {
  try {
    const state = JSON.parse(readFileSync(SYSTEM_STATE_FILE, "utf8"));
    res.json({ ok: true, paused: !!state.paused, since: state.since ?? null, by: state.by ?? null });
  } catch {
    res.json({ ok: true, paused: false, since: null, by: null });
  }
});

app.post("/api/admin/system-state", requireAuth, requireAdmin, (req, res) => {
  const { paused } = req.body ?? {};
  if (typeof paused !== "boolean") {
    return res.status(400).json({ ok: false, error: "paused (boolean) required" });
  }
  const state = paused
    ? { paused: true, since: new Date().toISOString(), by: req.user?.email ?? "admin" }
    : { paused: false, since: null, by: null };
  try {
    writeFileSync(SYSTEM_STATE_FILE, JSON.stringify(state, null, 2));
    res.json({ ok: true, ...state });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Admin positions endpoints — bulk close van trades over alle subscribers
// ───────────────────────────────────────────────────────────────────────────────
// GET  /api/admin/positions       → flat lijst van álle open posities, met
//                                   user/account context zodat admin ziet
//                                   wie wat heeft staan
// POST /api/admin/close-position  → 2 modes:
//      { accountId, positionId }  → sluit één specifieke positie
//      { symbol: "US500" }        → sluit elke open US500 op iedere subscriber
//
// Best-effort: één faal blokkeert de rest niet. Resultaat: { closed:[…], failed:[…] }.
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/admin/positions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await BrokerAccount.find({}).lean();
    const userIds = [...new Set(rows.map(r => String(r.userId)))];
    const users   = await User.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    const flat = [];
    await Promise.all(rows.map(async (r) => {
      const positions = await metaapi.getOpenPositions(r.metaapiAccountId).catch(() => []);
      if (!Array.isArray(positions)) return;
      for (const p of positions) {
        flat.push({
          accountId:  r.metaapiAccountId,
          brokerRowId: String(r._id),
          userId:     String(r.userId),
          userName:   userMap[String(r.userId)]?.name  ?? null,
          userEmail:  userMap[String(r.userId)]?.email ?? null,
          login:      r.login,
          server:     r.server,
          broker:     r.broker,
          positionId: p.id,
          symbol:     p.symbol,
          type:       p.type,
          volume:     p.volume,
          openPrice:  p.openPrice,
          currentPrice: p.currentPrice,
          stopLoss:   p.stopLoss,
          takeProfit: p.takeProfit,
          profit:     p.profit,
          swap:       p.swap,
          commission: p.commission,
          time:       p.time,
          comment:    p.brokerComment,
        });
      }
    }));

    flat.sort((a, b) => (b.time ?? "").localeCompare(a.time ?? ""));
    res.json({ ok: true, positions: flat, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error("/api/admin/positions:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/close-position — close one position (by accountId+positionId)
// or close every position matching a symbol across all subscribers (by symbol).
// Closing is best-effort per account: one failure doesn't block the others.
app.post("/api/admin/close-position", requireAuth, requireAdmin, async (req, res) => {
  const { accountId, positionId, symbol } = req.body ?? {};

  // Single-position close path.
  if (accountId && positionId) {
    try {
      await metaapi.closePositionById(accountId, positionId);
      console.log(`[CLOSE-POS] ${req.user?.email ?? "?"} → ${accountId}/${positionId}`);
      return res.json({ ok: true, accountId, positionId });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  }

  // Bulk close-by-symbol path.
  if (symbol) {
    try {
      const rows = await BrokerAccount.find({}).lean();
      const closed = [], failed = [];
      await Promise.all(rows.map(async (r) => {
        const positions = await metaapi.getOpenPositions(r.metaapiAccountId).catch(() => []);
        if (!Array.isArray(positions)) return;
        const matches = positions.filter(p => p.symbol === symbol);
        for (const p of matches) {
          try {
            await metaapi.closePositionById(r.metaapiAccountId, p.id);
            closed.push({ accountId: r.metaapiAccountId, positionId: p.id, login: r.login });
          } catch (err) {
            failed.push({ accountId: r.metaapiAccountId, positionId: p.id, login: r.login, error: err.message });
          }
        }
      }));
      console.log(`[CLOSE-SYMBOL] ${req.user?.email ?? "?"} → ${symbol} closed=${closed.length} failed=${failed.length}`);
      return res.json({ ok: true, symbol, closed, failed });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(400).json({ ok: false, error: "either {accountId, positionId} or {symbol} required" });
});

// POST /api/signal-view — log that a user saw a signal-card on the dashboard.
// Fired by IntersectionObserver after the card has been visible for ≥1.5 sec.
app.post("/api/signal-view", requireAuth, async (req, res) => {
  try {
    const { market, tf, setupId, dwellMs } = req.body ?? {};
    if (!market || !tf) return res.status(400).json({ ok: false, error: "market + tf required" });
    await SignalView.create({
      userId: req.user._id,
      email:  req.user.email,
      market: String(market).toUpperCase(),
      tf:     String(tf),
      setupId: setupId ? String(setupId) : undefined,
      dwellMs: typeof dwellMs === "number" ? Math.round(dwellMs) : undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/signal-analytics — aggregated engagement data for the admin dashboard
app.get("/api/admin/signal-analytics", requireAuth, requireAdmin, async (req, res) => {
  try {
    const days  = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Views per day (last N days) + unique viewers
    const perDay = await SignalView.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
        views: { $sum: 1 },
        uniqueUsers: { $addToSet: "$userId" },
      }},
      { $project: { date: "$_id", views: 1, uniqueUsers: { $size: "$uniqueUsers" }, _id: 0 } },
      { $sort: { date: 1 } },
    ]);

    // Top markets by views
    const perMarket = await SignalView.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: { market: "$market", tf: "$tf" },
        views: { $sum: 1 },
        uniqueUsers: { $addToSet: "$userId" },
        avgDwellMs: { $avg: "$dwellMs" },
      }},
      { $project: {
        market: "$_id.market", tf: "$_id.tf", views: 1,
        uniqueUsers: { $size: "$uniqueUsers" },
        avgDwellMs: { $round: ["$avgDwellMs", 0] },
        _id: 0,
      }},
      { $sort: { views: -1 } },
    ]);

    // Top users by view count
    const perUser = await SignalView.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: "$userId",
        email: { $first: "$email" },
        views: { $sum: 1 },
        markets: { $addToSet: "$market" },
        lastView: { $max: "$timestamp" },
      }},
      { $project: {
        userId: "$_id", email: 1, views: 1,
        markets: { $size: "$markets" },
        lastView: 1, _id: 0,
      }},
      { $sort: { views: -1 } },
      { $limit: 50 },
    ]);

    // User × market matrix: per user a breakdown of views per market
    const userMarketMatrix = await SignalView.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: { userId: "$userId", market: "$market" },
        email: { $first: "$email" },
        views: { $sum: 1 },
        lastView: { $max: "$timestamp" },
      }},
      { $group: {
        _id: "$_id.userId",
        email: { $first: "$email" },
        totalViews: { $sum: "$views" },
        lastView: { $max: "$lastView" },
        byMarket: { $push: { market: "$_id.market", views: "$views" } },
      }},
      { $sort: { totalViews: -1 } },
      { $limit: 50 },
    ]);

    // Recent view-events
    const recent = await SignalView.find({})
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();

    // Totals
    const totalViews     = await SignalView.countDocuments();
    const todayStart     = new Date(); todayStart.setHours(0,0,0,0);
    const todayViews     = await SignalView.countDocuments({ timestamp: { $gte: todayStart } });
    const uniqueViewers  = (await SignalView.distinct("userId")).length;

    res.json({
      ok: true,
      perDay, perMarket, perUser, userMarketMatrix, recent,
      stats: { totalViews, todayViews, uniqueViewers },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/analytics — login events for charts
app.get("/api/admin/analytics", requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Logins per day (last N days)
    const perDay = await LoginEvent.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
        count: { $sum: 1 },
        uniqueUsers: { $addToSet: "$userId" }
      }},
      { $project: { date: "$_id", count: 1, uniqueUsers: { $size: "$uniqueUsers" }, _id: 0 } },
      { $sort: { date: 1 } }
    ]);

    // Logins per hour of day (0–23)
    const perHour = await LoginEvent.aggregate([
      { $match: { timestamp: { $gte: since } } },
      { $group: {
        _id: { $hour: "$timestamp" },
        count: { $sum: 1 }
      }},
      { $sort: { _id: 1 } }
    ]);

    // Recent events (last 50)
    const recent = await LoginEvent.find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    // Total stats
    const totalUsers  = await User.countDocuments();
    const totalLogins = await LoginEvent.countDocuments();
    const todayStart  = new Date(); todayStart.setHours(0,0,0,0);
    const todayLogins = await LoginEvent.countDocuments({ timestamp: { $gte: todayStart } });

    res.json({ ok: true, perDay, perHour, recent, stats: { totalUsers, totalLogins, todayLogins } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// /api/data — reads from NAS100 cache file (no MCP call, safe for multiple users)
app.get("/api/data", requireAuth, async (req, res) => {
  try {
    const file = join(__dir, "../monitor/market_data_NAS100.json");
    const raw  = JSON.parse(readFileSync(file, "utf8"));
    const data = recomputeRecent(raw);
    // Fallback: use last known candle close when market is closed (currentPrice=0)
    if (!data.currentPrice || data.currentPrice === 0) {
      try {
        const tf = fetchBiasCandles("NAS100");
        const last = tf.candles15[tf.candles15.length - 1];
        if (last?.close > 0) data.currentPrice = last.close;
      } catch {}
    }
    res.json({ ok: true, data });
  } catch (err) {
    console.error("/api/data error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Force cache refresh
app.post("/api/refresh", async (req, res) => {
  cacheTs = 0;
  try {
    const data = await getData();
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Mentor chat — streaming response
app.post("/api/chat", requireAuth, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "No OPENAI_API_KEY configured" });
  }
  // Trading mentor is paid-only — block free tier users (admin always allowed).
  const u = await User.findById(req.user.id).select("subscriptionTier subscriptionStatus tradingLocked isAdmin").lean();
  const paidActive = u?.subscriptionTier && ["signal", "auto-trade"].includes(u.subscriptionTier)
                  && ["active", "trialing"].includes(u.subscriptionStatus)
                  && !u.tradingLocked;
  if (!u?.isAdmin && !paidActive) {
    return res.status(402).json({
      ok: false,
      error: "AI Trading Mentor vereist een AI-Analyst (€39) of Hands-Off AI (€69) abonnement.",
      requiredTier: "signal-or-auto",
      currentTier:  u?.subscriptionTier ?? "free",
    });
  }

  const { message, history = [], market = "NAS100", marketTab = null, filter = {}, userName = null } = req.body;
  if (!message?.trim()) return res.status(400).json({ ok: false, error: "No message" });

  const KNOWN_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const MARKET_NAMES  = { NAS100: "NAS100 (US100)", US500: "US500 (S&P 500)", US30: "US30 (Dow Jones)", XAUUSD: "XAU/USD (Gold)", GBPUSD: "GBP/USD (Cable)", BTCUSD: "BTC/USD", ETHUSD: "ETH/USD" };

  // Determine which markets to include in context
  const isAllTab    = marketTab === null;
  const marketsToLoad = isAllTab ? KNOWN_MARKETS : [KNOWN_MARKETS.includes(market) ? market : "NAS100"];

  // Filter helper — mirrors frontend applyFilter logic
  const fDir    = filter.dir      ?? "ALL";
  const fMatrix = filter.matrixOnly ?? false;
  const fCycle  = filter.cycle    ?? "ALL";

  function applySignalFilter(continuationSignals = [], matrixUnlocked = []) {
    let cont = fMatrix ? [] : [...continuationSignals];
    let mx   = [...matrixUnlocked];
    if (fDir !== "ALL") {
      cont = cont.filter(s => s.type       === fDir);
      mx   = mx.filter(s  => s.matrixType  === fDir);
    }
    if (fCycle !== "ALL") {
      cont = cont.filter(s => s.entryWindow?.cycle === fCycle);
      mx   = mx.filter(s  => s.entryWindow?.cycle === fCycle);
    }
    return { cont, mx };
  }

  // Build filter description for the system prompt
  const filterParts = [];
  if (fDir !== "ALL")  filterParts.push(`alleen ${fDir} setups`);
  if (fMatrix)         filterParts.push(`alleen Matrix Unlocked/Aligned`);
  if (fCycle !== "ALL") filterParts.push(`alleen entry window ${fCycle}`);
  const filterDesc = filterParts.length ? `ACTIEVE FILTERS: ${filterParts.join(", ")}` : null;

  function buildContinuationContext(cont, mx) {
    const lines = [];
    if (mx.length) {
      lines.push(`--- MATRIX SETUPS (${mx.length}) ---`);
      for (const s of mx) {
        const ts = s.tradeSetup;
        const tp = s.tradeProgress;
        lines.push(`${s.matrixType} ${s.matrixLevel?.toUpperCase()} | ${s.entryWindow?.cycle} ${s.entryWindow?.label} ET | status=${s.status}`);
        if (ts) lines.push(`  Entry=${ts.entry} SL=${ts.sl} TP=${ts.tp} Risk=${ts.risk}`);
        if (tp) lines.push(`  Live: prijs=${tp.currentPrice} pnl=${tp.pnl} outcome=${tp.outcome}`);
        lines.push(`  6hr: ${s.sixHrSide} ${s.sixHrLevel} (${s.sixHrCycle}) geraakt @ ${s.sixHrHitTime}`);
      }
    }
    if (cont.length) {
      lines.push(`--- CONTINUATION SETUPS (${cont.length}) ---`);
      for (const s of cont) {
        const ts = s.tradeSetup;
        const tp = s.tradeProgress;
        lines.push(`${s.type} ${s.status} | ${s.entryWindow?.cycle} ${s.entryWindow?.label} ET | window=${s.windowStatus}`);
        if (ts) lines.push(`  Entry=${ts.entry} SL=${ts.sl} TP=${ts.tp} Risk=${ts.risk}`);
        if (tp) lines.push(`  Live: prijs=${tp.currentPrice} pnl=${tp.pnl} outcome=${tp.outcome}`);
      }
    }
    if (!mx.length && !cont.length) lines.push("Geen setups zichtbaar met huidige filters.");
    return lines.join("\n");
  }

  try {
    // Build context for all relevant markets from monitor market_data files
    const contextParts = [];

    for (const mKey of marketsToLoad) {
      try {
        const file = join(__dir, `../monitor/market_data_${mKey}.json`);
        const d    = JSON.parse(readFileSync(file, "utf8"));
        contextParts.push(buildMentorContext(d, mKey));
      } catch {}
    }

    const marketContext = contextParts.length
      ? contextParts.join("\n\n" + "─".repeat(50) + "\n\n")
      : "Geen live marktdata beschikbaar.";

    const scopeDesc = isAllTab
      ? "alle markten (ALL tab)"
      : (MARKET_NAMES[marketsToLoad[0]] ?? marketsToLoad[0]);

    const userAddress = userName ? userName.split(" ")[0] : null;
    const systemPrompt = `Je bent een ervaren trading mentor die dit systeem door en door kent.
Je spreekt direct, eerlijk en menselijk — nooit robotisch, nooit formeel.
Je hebt LIVE marktdata voor elke markt en gebruikt altijd de echte getallen in je antwoorden.
${userAddress ? `De naam van de trader is ${userAddress}. Spreek ze aan bij naam waar het natuurlijk aanvoelt.` : `Spreek de trader aan als "je" of "jij".`}
Houd antwoorden beknopt tenzij meer detail gevraagd wordt. Antwoord in de taal van de gebruiker.

SCOPE: De gebruiker kijkt nu naar ${scopeDesc}.

=== SYSTEEM METHODOLOGIE ===

HOE HET SYSTEEM WERKT:
Het systeem monitort 7 markten (NAS100, US500, US30, XAUUSD, GBPUSD, BTCUSD, ETHUSD) elke 15 minuten.
Per markt worden drie timeframes bijgehouden: dagelijks, 6H cycles en 90-min periodes.
Een setup wordt aangemaakt zodra BEIDE stappen compleet zijn in de referentie cycle.

STAP-STRUCTUUR PER TIMEFRAME:
Voor een BUY setup (bias BULLISH):
  Stap 1: BSL (Buy-Side Liquidity) gesweept = de HIGH van de referentie cycle overschreden → prijs neemt koopstops weg
  Stap 2: SSL (Sell-Side Liquidity) gesweept = de LOW van de referentie cycle doorbroken → prijs neemt verkoopstops weg
  → Beide gedaan = setup actief, wacht op Phase 2 entry window
Voor een SELL setup (bias BEARISH): omgekeerde volgorde (SSL eerst, dan BSL).

REFERENTIE CYCLES (welke cycle wordt gescand):
- 90min: de vorige klok-gebaseerde 90-min periode (18:00 ET = start dag, 16 periodes/dag)
- 6H: de cycle direct VOOR de actieve 6H cycle (C1=18:00–00:00, C2=00:00–06:00, C3=06:00–12:00, C4=12:00–18:00)
- Daily: de vorige handelsdag (niet vandaag)

BIAS & RICHTING:
- Admin bias BULLISH → allowedDirection = BUY → alleen BUY setups worden aangemaakt en getoond
- Admin bias BEARISH → allowedDirection = SELL → alleen SELL setups
- Admin bias AUTO → richting volgt de Order Flow Lock (zie hieronder)
- Als admin de bias handmatig aanpast, gelden signals EN Discord berichten direct voor de nieuwe richting

ORDER FLOW LOCK:
- Het systeem detecteert een lock na een reeks opeenvolgende HIGH- of LOW-sweeps over dagelijkse candles
- BULLISH lock: opeenvolgende dagelijkse HIGHS worden doorbroken (hogere highs) → markt is in uptrend structuur
- BEARISH lock: opeenvolgende dagelijkse LOWS worden doorbroken (lagere lows) → markt is in downtrend structuur
- Sterkte (×1 t/m ×10): hoe hoger, hoe meer opeenvolgende sweeps bevestigen de richting
- Key dates: de dagelijkse levels die de lock opbouwen

PHASE 2 ENTRY WINDOWS:
- Elke 6H cycle heeft een Phase 2 window (korte periode midden in de cycle)
- Alleen in Phase 2 wordt een entry getriggerd als het entry level geraakt wordt
- SL wordt bepaald door de structurele low/high die gevormd wordt in het Phase 2 window
- Buiten Phase 2: setup is actief maar er wordt niet ingegaan

DISCORD ALERTS:
- Stap 1 alert: informatief, eerste sweep van het paar gedetecteerd
- Stap 2 alert (hoofdalert): beide sweeps compleet, setup aangemaakt, wacht op Phase 2 entry
- Link naar dashboard staat altijd in het bericht

LIVE MARKTDATA (gebruik ALLEEN deze getallen, nooit gok of maak getallen op):
${marketContext}`;

    // Build messages array with conversation history
    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message.trim() },
    ];

    // Stream response back to client
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const openaiRes = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 700,
      }),
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      res.write(`data: ${JSON.stringify({ error: err })}\n\n`);
      res.end();
      return;
    }

    // Pipe SSE stream from OpenAI to client
    let buffer = "";
    openaiRes.body.on("data", chunk => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const trimmed = line.replace(/^data: /, "").trim();
        if (!trimmed || trimmed === "[DONE]") continue;
        try {
          const json = JSON.parse(trimmed);
          const token = json.choices?.[0]?.delta?.content;
          if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
        } catch {}
      }
    });

    openaiRes.body.on("end", () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    });

    openaiRes.body.on("error", (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error("/api/chat error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

// All markets data — written by monitor.js, read here without MCP calls
// Recompute `recent` from cycle data at request time (so agoMin is always accurate)
function recomputeRecent(marketData) {
  if (!marketData) return marketData;
  const nowTs = Date.now() / 1000;

  const sig = marketData.signal ?? {};

  const allCycs = marketData.prevC4
    ? [marketData.prevC4, ...(marketData.cycles ?? [])]
    : (marketData.cycles ?? []);

  // Build cycle lookup for fast access
  const cycByName = Object.fromEntries(allCycs.map(c => [c.name, c]));

  // Recompute 30% entry + deduplicate active signals from frozen files
  const activeMapped = (sig.active ?? []).map(s => {
    const cyc = cycByName[s.cycle];
    const entryCycle = s.entryCycle ?? (s.type === "SHORT" ? cyc?.entryHigh?.cycle : cyc?.entryLow?.cycle) ?? s.cycle;
    const hitTs = s.hitTs ?? (s.type === "SHORT" ? cyc?.hitHigh?.ts : cyc?.hitLow?.ts) ?? 0;
    if (cyc?.high != null && cyc?.low != null) {
      return { ...s, level: s.level ?? (s.type === "SHORT" ? cyc.high : cyc.low), entry: calcEntry(s.type, cyc.high, cyc.low), entryCycle, hitTs };
    }
    return { ...s, entryCycle, hitTs };
  });
  // Keep only the latest hit per (entryCycle, type)
  const dedupActiveMap = new Map();
  for (const s of activeMapped) {
    const key = `${s.entryCycle}-${s.type}`;
    const prev = dedupActiveMap.get(key);
    if (!prev || s.hitTs > prev.hitTs) dedupActiveMap.set(key, s);
  }
  const activeFixed = [...dedupActiveMap.values()].map(({ hitTs, entryCycle, ...rest }) => rest);

  // Re-evaluate upcoming signals against current time — drop stale ones
  const nowUpcoming = (sig.upcoming ?? []).filter(s => {
    if (!s.windowStartTs || !s.windowEndTs) return false; // no timestamps = old frozen data, drop
    if (nowTs > s.windowEndTs) return false;              // window already closed, drop
    return true;
  });

  // Suppress upcoming when there's an active signal
  const finalUpcoming = activeFixed.length > 0 ? [] : nowUpcoming;

  return {
    ...marketData,
    signal: { ...sig, active: activeFixed, upcoming: finalUpcoming, recent: [] },
  };
}


app.get("/api/markets", requireAuth, (req, res) => {
  const KNOWN_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const result = {};
  for (const key of KNOWN_MARKETS) {
    const file = join(__dir, `../monitor/market_data_${key}.json`);
    try {
      const md = recomputeRecent(JSON.parse(readFileSync(file, "utf8")));
      // Use cached fractal signals; if not yet cached, compute eagerly from candles
      let cached = fractalCache[key];
      if (!cached || Date.now() - cached.cachedAt > 10 * 60 * 1000) {
        try {
          const tf = fetchBiasCandles(key);
          const override = loadBiasOverride();
          const biasResult = computeBias(tf.candles15, override, { daily: tf.daily, hourly: tf.hourly });
          cached = {
            fractalSignals: biasResult.fractalSignals ?? null,
            bias:           biasResult.bias,
            confidence:     biasResult.confidence,
            cachedAt:       Date.now(),
          };
          fractalCache[key] = cached;
          appendSignalHistory(key, biasResult.fractalSignals ?? null);
        } catch { /* candles not yet available for this market */ }
      }
      if (cached) {
        md.fractalSignals = cached.fractalSignals;
        md.biasSummary    = { bias: cached.bias, confidence: cached.confidence, cachedAt: cached.cachedAt };
      }
      // Fix currentPrice=0: use last known candle close when market is closed
      if (!md.currentPrice || md.currentPrice === 0) {
        try {
          const tf = fetchBiasCandles(key);
          const last = tf.candles15[tf.candles15.length - 1];
          if (last?.close > 0) md.currentPrice = last.close;
        } catch {}
      }
      const _adminBias = readAdminBiasFile();
      const _b = _adminBias[key] ?? _adminBias.GLOBAL ?? "AUTO";
      if (_b === "BULLISH") md.allowedDirection = "BUY";
      else if (_b === "BEARISH") md.allowedDirection = "SELL";
      else {
        const _lock = md.lockState;
        md.allowedDirection = _lock?.direction === "BULLISH" ? "BUY"
                            : _lock?.direction === "BEARISH" ? "SELL"
                            : null;
      }
      md.adminBias = _b;
      result[key] = md;
    } catch {
      result[key] = null;
    }
  }
  res.json({ ok: true, markets: result });
});

// Market state — written by monitor.js, read here for dashboard
app.get("/api/market", requireAuth, (req, res) => {
  try {
    const state = JSON.parse(readFileSync(MARKET_STATE_FILE, "utf8"));
    res.json({ ok: true, ...state });
  } catch {
    // Default: NAS100 if monitor hasn't run yet
    res.json({
      ok: true,
      current: "NAS100",
      tvSymbol: "CAPITALCOM:US100",
      label: "NAS100 (US100)",
      activeMarkets: ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"],
      lastUpdate: null,
    });
  }
});

// ── Debug endpoint — full raw data for all markets ───────────────────────────
app.get("/api/debug", (req, res) => {
  const KNOWN_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const nowTs = Date.now() / 1000;
  const result = {};

  for (const key of KNOWN_MARKETS) {
    const file = join(__dir, `../monitor/market_data_${key}.json`);
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const fileAge = Math.round((nowTs - raw.timestamp / 1000));
      const allCycs = raw.prevC4 ? [raw.prevC4, ...(raw.cycles ?? [])] : (raw.cycles ?? []);

      result[key] = {
        ok: true,
        symbol:      raw.tvSymbol,
        fileAgeSec:  fileAge,
        fileAgeStr:  fileAge < 120 ? `${fileAge}s` : fileAge < 3600 ? `${Math.round(fileAge/60)}m` : `${Math.round(fileAge/3600)}u`,
        lastWrite:   new Date(raw.timestamp).toISOString(),
        candleRange: raw.scanMeta ? `${raw.scanMeta.from} → ${raw.scanMeta.to}` : null,
        candleCount: raw.scanMeta?.count ?? null,
        currentPrice: raw.currentPrice,
        currentTime:  raw.currentTime,
        activeCycle:  raw.activeCycle,
        cycles: allCycs.map(c => ({
          name:   c.name,
          status: c.status,
          high:   c.high,
          low:    c.low,
          hitHigh: c.hitHigh ? { price: c.hitHigh.hitPrice, time: c.hitHigh.time } : null,
          hitLow:  c.hitLow  ? { price: c.hitLow.hitPrice,  time: c.hitLow.time  } : null,
          entryHigh: c.entryHigh ? { status: c.entryHigh.status, window: c.entryHigh.label, cycle: c.entryHigh.cycle } : null,
          entryLow:  c.entryLow  ? { status: c.entryLow.status,  window: c.entryLow.label,  cycle: c.entryLow.cycle  } : null,
        })),
        signal: (() => {
          const s = recomputeRecent(raw).signal;
          return {
            active:   s.active?.map(x => ({ type: x.type, cycle: x.cycle, entry: x.entry, until: x.until })) ?? [],
            upcoming: s.upcoming?.map(x => ({ type: x.type, cycle: x.cycle, level: x.level, window: x.window })) ?? [],
            recent:   s.recent?.map(x => ({ type: x.type, cycle: x.cycle, entry: x.entry, window: x.window, agoMin: x.agoMin })) ?? [],
          };
        })(),
        activeTrade: raw.activeTrade ? {
          type: raw.activeTrade.type, cycle: raw.activeTrade.cycle,
          entry: raw.activeTrade.entry, market: raw.activeTrade.market,
        } : null,
        // 90-min cycles (6u ÷ 4) voor continuation confirmatie
        cycles90: (raw.cycles90 ?? []).map(c => ({
          index:     c.index,
          label:     c.label,
          startMin:  c.startMin,
          endMin:    c.endMin,
          high:      c.high !== -Infinity ? c.high : null,
          highTime:  c.highTime ?? null,
          low:       c.low  !==  Infinity ? c.low  : null,
          lowTime:   c.lowTime  ?? null,
          hitHigh:   c.hitHigh  ?? null,
          hitLow:    c.hitLow   ?? null,
        })),
        continuationSignals: raw.continuationSignals ?? [],
        matrixUnlocked: raw.matrixUnlocked ?? [],
        continuationDayStats: raw.continuationDayStats ?? null,
        warnings: [
          fileAge > 7200 ? `⚠️ Data is ${Math.round(fileAge/60)}m oud — monitor probleem?` : null,
          raw.staleWarning ? "⚠️ Candles waren niet realtime tijdens laatste run" : null,
        ].filter(Boolean),
      };
    } catch (e) {
      result[key] = { ok: false, error: "Geen data bestand — monitor nog niet gerund" };
    }
  }

  // Also include last monitor run time from market_state.json
  let lastRun = null;
  try {
    const state = JSON.parse(readFileSync(MARKET_STATE_FILE, "utf8"));
    lastRun = state.lastUpdate ? new Date(state.lastUpdate).toISOString() : null;
  } catch {}

  res.json({ ok: true, serverTime: new Date().toISOString(), lastMonitorRun: lastRun, markets: result });
});

// ── Log endpoint — last N lines of monitor.log ───────────────────────────────
app.get("/api/logs", (req, res) => {
  const lines = parseInt(req.query.lines ?? "200");
  const logFile = join(__dir, "../../opt/trading-assistant/logs/monitor.log");
  const logFile2 = "/opt/trading-assistant/logs/monitor.log";
  try {
    const content = readFileSync(logFile2, "utf8");
    const all = content.split("\n");
    const last = all.slice(-Math.min(lines, 1000)).join("\n");
    res.type("text/plain").send(last);
  } catch (e) {
    res.type("text/plain").send(`Log niet gevonden: ${e.message}`);
  }
});

// ── Trade history endpoint ────────────────────────────────────────────────────
// ── Bias Engine ────────────────────────────────────────────────────────────────
let biasCache        = null;
let biasCacheTs      = 0;
const BIAS_TTL       = 5 * 60 * 1000; // 5 minutes
const fractalCache   = {};            // { [market]: { fractalSignals, bias, confidence, cachedAt } }

const SIGNAL_HISTORY_FILE = join(__dir, "../monitor/signal_history.json");
function loadSignalHistory() {
  try { return JSON.parse(readFileSync(SIGNAL_HISTORY_FILE, "utf8")); } catch { return []; }
}
function appendSignalHistory(market, fractalSignals) {
  if (!fractalSignals) return;
  const history = loadSignalHistory();
  const now = Date.now();
  for (const [tf, sig] of [["weekly", fractalSignals.weekly], ["daily", fractalSignals.daily], ["cycle", fractalSignals.cycle]]) {
    if (!sig?.type) continue;
    // Dedup: skip if same market+timeframe+type+note already exists (note encodes cycle labels)
    const exists = history.some(h => h.market === market && h.timeframe === tf &&
      h.type === sig.type && h.note === sig.note);
    if (exists) continue;
    history.unshift({
      id:          `${market}-${tf}-${now}`,
      market,
      timeframe:   tf,
      direction:   sig.direction,
      type:        sig.type,
      entryWindow: sig.entryWindow,
      entryTime:   sig.entryTime,
      lockStrength: sig.lockStrength,
      note:        sig.note,
      levels:      sig.levels ?? null,
      detectedAt:  now,
      detectedAtStr: new Date(now).toLocaleString("nl-NL", { timeZone: "America/New_York" }) + " ET",
    });
  }
  // Keep last 200 entries
  try { writeFileSync(SIGNAL_HISTORY_FILE, JSON.stringify(history.slice(0, 200), null, 2)); } catch {}
}

// Bias override stored in a flat JSON file (persists across restarts)
const BIAS_OVERRIDE_FILE = join(__dir, "../monitor/bias_override.json");
function loadBiasOverride() {
  try { return JSON.parse(readFileSync(BIAS_OVERRIDE_FILE, "utf8")); } catch { return null; }
}
function saveBiasOverride(data) {
  try { writeFileSync(BIAS_OVERRIDE_FILE, JSON.stringify(data, null, 2)); } catch {}
}
function clearBiasOverride() {
  try { unlinkSync(BIAS_OVERRIDE_FILE); } catch {}
}

// Read candles from files saved by the monitor / fetch_candles script.
// Returns { candles15, daily, hourly } — multi-timeframe candles.
function fetchBiasCandles(market = "NAS100") {
  const now = Date.now();
  if (biasCache?.[market] && now - biasCacheTs < BIAS_TTL) return biasCache[market];

  const MONITOR_DIR = join(__dir, "../monitor");

  function readCandles(suffix) {
    try {
      const f = join(MONITOR_DIR, `candles_${suffix}_${market}.json`);
      const d = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(d) && d.length >= 5) return d;
    } catch {}
    return null;
  }

  // Try new multi-TF files first, fall back to legacy single file
  let candles15 = readCandles("15") ?? readCandles("") ?? (() => {
    const f = join(MONITOR_DIR, `candles_${market}.json`);
    return JSON.parse(readFileSync(f, "utf8"));
  })();

  if (!Array.isArray(candles15) || candles15.length < 10) {
    throw new Error(`Te weinig 15-min candles voor ${market} (${candles15?.length ?? 0})`);
  }

  const daily  = readCandles("1D");
  const hourly = readCandles("1H");

  const result = { candles15, daily, hourly };
  if (!biasCache) biasCache = {};
  biasCache[market] = result;
  biasCacheTs = now;
  return result;
}

// GET /api/bias — compute and return full bias analysis
app.get("/api/bias", requireAuth, async (req, res) => {
  try {
    const market   = req.query.market ?? "NAS100";
    const tf       = fetchBiasCandles(market);
    const override = loadBiasOverride();
    const result   = computeBias(tf.candles15, override, { daily: tf.daily, hourly: tf.hourly });
    fractalCache[market] = {
      fractalSignals: result.fractalSignals ?? null,
      bias:           result.bias,
      confidence:     result.confidence,
      cachedAt:       Date.now(),
    };
    appendSignalHistory(market, result.fractalSignals ?? null);
    res.json({ ok: true, bias: result, market });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/bias/override — set manual override
app.post("/api/bias/override", requireAuth, (req, res) => {
  const { direction, reason } = req.body ?? {};
  if (!["BULLISH","BEARISH","NEUTRAL"].includes(direction)) {
    return res.status(400).json({ ok: false, error: "direction must be BULLISH, BEARISH or NEUTRAL" });
  }
  const override = { direction, reason: reason ?? "", setBy: req.user.name, setAt: Date.now() / 1000 };
  saveBiasOverride(override);
  biasCache = null; // invalidate cache
  res.json({ ok: true, override });
});

// DELETE /api/bias/override — clear manual override
app.delete("/api/bias/override", requireAuth, (req, res) => {
  clearBiasOverride();
  biasCache = null;
  res.json({ ok: true, message: "Override cleared" });
});

// GET /api/signals/history — return logged fractal signal history
app.get("/api/signals/history", requireAuth, (req, res) => {
  try {
    const market = req.query.market;
    const SETUP_LOG = join(__dir, "../monitor/setup_log.json");
    let log = [];
    try { log = JSON.parse(readFileSync(SETUP_LOG, "utf8")); } catch {}
    if (market) log = log.filter(e => e.market === market);

    // Map to the shape SignalHistory.jsx expects
    const history = log.map(e => ({
      id:          e.id,
      market:      e.market,
      type:        e.direction,
      timeframe:   e.source === "DAILY" ? "daily" : e.source === "6H" ? "6h" : "cycle",
      detectedAt:  e.ts,
      entryWindow: e.window,
      lockStrength: 0,
      note:        `${e.direction} | ${e.source} sweep @ ${e.entry} | Cycle: ${e.cycleLabel ?? "—"}`,
      levels: {
        sweepLabel:   e.cycleLabel ?? null,
        lockLevel:    e.entry,
      },
      outcome:     e.outcome ?? null,
      outcomeTime: e.outcomeTime ?? null,
      datetime:    e.datetime,
    }));
    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Backtest Engine ────────────────────────────────────────────────────────────

// MongoDB model for backtest log
const BacktestLogSchema = new mongoose.Schema({
  weekKey:       String,
  date:          String,
  dayName:       String,
  bias:          String,
  confidence:    Number,
  primarySignal: String,
  priceAtEntry:  Number,
  highAfter:     Number,
  lowAfter:      Number,
  closeAfter:    Number,
  bullishMove:   Number,
  bearishMove:   Number,
  outcome:       String,
  reasons:       [String],
  market:        { type: String, default: "NAS100" },
  savedAt:       { type: Date, default: Date.now },
});
const BacktestLog = mongoose.model("BacktestLog", BacktestLogSchema);

// POST /api/backtest/run — run backtest on available data and save to DB
app.post("/api/backtest/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const market  = req.body?.market ?? "NAS100";
    const candles = await fetchBiasCandles(market);
    const results = runBacktest(candles);

    // Upsert results (avoid duplicates by weekKey+date+market)
    let saved = 0;
    for (const r of results) {
      await BacktestLog.findOneAndUpdate(
        { weekKey: r.weekKey, date: r.date, market },
        { ...r, market, savedAt: new Date() },
        { upsert: true, new: true }
      );
      saved++;
    }
    res.json({ ok: true, ran: results.length, saved, preview: results.slice(-5) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/backtest — get stored backtest log + performance stats
app.get("/api/backtest", requireAuth, async (req, res) => {
  try {
    const market = req.query.market ?? "NAS100";
    const limit  = Math.min(parseInt(req.query.limit ?? "100"), 500);
    const logs   = await BacktestLog.find({ market }).sort({ savedAt: -1 }).limit(limit).lean();

    const total  = logs.length;
    const wins   = logs.filter(l => l.outcome === "WIN").length;
    const losses = logs.filter(l => l.outcome === "LOSS").length;
    const winRate = total > 0 ? +(wins / total * 100).toFixed(1) : 0;

    const byDay  = {};
    for (const l of logs) {
      if (!byDay[l.dayName]) byDay[l.dayName] = { win: 0, loss: 0, total: 0 };
      byDay[l.dayName].total++;
      if (l.outcome === "WIN")  byDay[l.dayName].win++;
      if (l.outcome === "LOSS") byDay[l.dayName].loss++;
    }

    const bySignal = {};
    for (const l of logs) {
      const sig = l.primarySignal ?? "UNKNOWN";
      if (!bySignal[sig]) bySignal[sig] = { win: 0, loss: 0, total: 0 };
      bySignal[sig].total++;
      if (l.outcome === "WIN")  bySignal[sig].win++;
      if (l.outcome === "LOSS") bySignal[sig].loss++;
    }

    res.json({
      ok: true, market,
      stats: { total, wins, losses, winRate },
      byDay, bySignal,
      logs: logs.slice(0, limit),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Backtest V2 — full trade simulation with SL/TP + learning ─────────────────

const BacktestV2RunSchema = new mongoose.Schema({
  market:      { type: String, required: true },
  startDate:   String,
  endDate:     String,
  rrRatio:     { type: Number, default: 2 },
  use3DayOF:   { type: Boolean, default: true },
  runAt:       { type: Date, default: Date.now },
  ranBy:       String,
  trades:      [mongoose.Schema.Types.Mixed],
  insights:    mongoose.Schema.Types.Mixed,
  totalTrades: Number,
  winRate:     Number,
  totalPnl:    Number,
});
const BacktestV2Run = mongoose.model("BacktestV2Run", BacktestV2RunSchema);

// POST /api/backtest/v2/run — run enhanced backtest and save results
app.post("/api/backtest/v2/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      market    = "NAS100",
      startDate = null,
      endDate   = null,
      rrRatio   = 2,
      use3DayOF = true,
    } = req.body ?? {};

    // Fetch max candles directly via MCP for historical data (bypass file cache)
    let candles;
    try {
      // Try to get 2000 candles for longer backtesting windows
      candles = await fetchCandlesForBacktest(market, 2000);
    } catch {
      // Fall back to monitor file
      candles = fetchBiasCandles(market);
    }

    if (!candles || candles.length < 20) {
      return res.status(400).json({ ok: false, error: "Te weinig candles voor backtest" });
    }

    const { trades, insights } = runBacktestV2(candles, { startDate, endDate, rrRatio, use3DayOF });

    // Save run to MongoDB
    const run = await BacktestV2Run.create({
      market, startDate, endDate, rrRatio, use3DayOF,
      ranBy: req.user.name,
      trades,
      insights,
      totalTrades: insights?.total ?? trades.filter(t => t.entryType).length,
      winRate:     insights?.winRate ?? 0,
      totalPnl:    insights?.totalPnl ?? 0,
    });

    res.json({
      ok: true,
      runId:      run._id,
      market,
      startDate,
      endDate,
      totalTrades: trades.filter(t => t.entryType).length,
      candleCount: candles.length,
      trades:      trades.slice(0, 5), // preview
      insights,
    });
  } catch (e) {
    console.error("backtest v2 run error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/backtest/v2/runs — list stored backtest runs
app.get("/api/backtest/v2/runs", requireAuth, requireAdmin, async (req, res) => {
  try {
    const market = req.query.market;
    const query  = market ? { market } : {};
    const runs = await BacktestV2Run
      .find(query, { trades: 0 }) // exclude trade array for list view
      .sort({ runAt: -1 })
      .limit(20)
      .lean();
    res.json({ ok: true, runs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/backtest/v2/run/:id — get full run including trades
app.get("/api/backtest/v2/run/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const run = await BacktestV2Run.findById(req.params.id).lean();
    if (!run) return res.status(404).json({ ok: false, error: "Run niet gevonden" });
    res.json({ ok: true, run });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper: fetch more candles via MCP for backtesting
async function fetchCandlesForBacktest(market = "NAS100", count = 2000) {
  const MARKET_SYMBOL_MAP = {
    NAS100:  "CAPITALCOM:US100",
    US500:   "CAPITALCOM:US500",
    US30:    "CAPITALCOM:US30",
    XAUUSD:  "CAPITALCOM:GOLD",
    GBPUSD:  "FX:GBPUSD",
  };
  const symbol = MARKET_SYMBOL_MAP[market] ?? `CAPITALCOM:${market}`;

  await mcpCall("tools/call", { name: "change_symbol", arguments: { symbol } });
  await new Promise(r => setTimeout(r, 2000));
  await mcpCall("tools/call", { name: "change_timeframe", arguments: { timeframe: "15" } });
  await new Promise(r => setTimeout(r, 1500));

  const result = await mcpCall("tools/call", { name: "get_bar_data", arguments: { count } });
  const raw = result?.content?.[0]?.text;
  if (!raw) throw new Error("No candle data from MCP");
  const candles = JSON.parse(raw);
  if (!Array.isArray(candles) || !candles.length) throw new Error("Empty candle data");
  return candles;
}

// POST /api/backtest/fractal/run — run fractal order flow lock backtest
app.post("/api/backtest/fractal/run", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { market = "NAS100", startDate = null, endDate = null } = req.body ?? {};
    // Use 1D candles for daily fractal BT (500 bars = 2yr context)
    // Use 1H candles for cycle BT (1000 bars = ~40 days = many 6H cycles)
    const tf = fetchBiasCandles(market);
    const dailyCandles  = tf.daily;
    const hourlyCandles = tf.hourly;
    const candles15     = tf.candles15;
    if ((!dailyCandles || dailyCandles.length < 10) && (!candles15 || candles15.length < 50)) {
      return res.status(400).json({ ok: false, error: "Te weinig candles voor fractal backtest" });
    }
    // cycleCandles: prefer 1H (1000 bars ≈ 40 days), fallback to 15-min
    const cycleCandles = (hourlyCandles?.length ?? 0) >= 20 ? hourlyCandles : candles15;
    const result = runFractalLockBacktest(dailyCandles ?? candles15, { startDate, endDate, candles15: cycleCandles, raw15: candles15 });
    res.json({ ok: true, market, candleCount: (dailyCandles ?? candles15).length, startDate, endDate, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/live-signals?market=NAS100  — live fractal signals (daily, 6h cycle, 90min) voor vandaag
app.get("/api/live-signals", requireAuth, (req, res) => {
  const KNOWN_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const market = req.query.market;
  const markets = (market && KNOWN_MARKETS.includes(market)) ? [market] : KNOWN_MARKETS;
  const result = {};
  for (const key of markets) {
    try {
      const tf = fetchBiasCandles(key);
      result[key] = getLiveFractalSignals(tf.candles15, { daily: tf.daily, hourly: tf.hourly });
    } catch (e) {
      result[key] = { error: e.message };
    }
  }
  res.json({ ok: true, signals: result });
});

// GET /api/weekend-recap?week=2026-04-14  (optional: pass Monday date of desired week)
// Returns fractal lock backtest results for all markets for the given week.
// Default: past Mon-Fri (or current week if today is a weekday).
app.get("/api/weekend-recap", requireAuth, async (req, res) => {
  const KNOWN_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const CRYPTO_MARKETS = new Set(["BTCUSD", "ETHUSD"]);
  const { week } = req.query;

  function addDays(dateStr, n) {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Mon-Fri for traditional, Mon-Sun for crypto
  function getWeekRange(mondayStr, isCrypto = false) {
    if (mondayStr) {
      return { startDate: mondayStr, endDate: addDays(mondayStr, isCrypto ? 6 : 4) };
    }
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const dow = nowET.getDay();
    const daysToMon = dow === 0 ? 6 : dow === 6 ? 5 : dow - 1;
    const mon = new Date(nowET);
    mon.setDate(nowET.getDate() - daysToMon);
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const startDate = fmt(mon);
    return { startDate, endDate: addDays(startDate, isCrypto ? 6 : 4) };
  }

  const results = {};

  for (const market of KNOWN_MARKETS) {
    try {
      const isCrypto = CRYPTO_MARKETS.has(market);
      const { startDate, endDate } = getWeekRange(week, isCrypto);
      const tf = fetchBiasCandles(market);
      const dailyCandles  = tf.daily;
      const hourlyCandles = tf.hourly;
      const candles15     = tf.candles15;
      if ((!dailyCandles || dailyCandles.length < 10) && (!candles15 || candles15.length < 50)) {
        results[market] = { ok: false, error: "Te weinig candles" };
        continue;
      }
      const cycleCandles = (hourlyCandles?.length ?? 0) >= 20 ? hourlyCandles : candles15;
      const bt = runFractalLockBacktest(dailyCandles ?? candles15, {
        startDate, endDate,
        candles15: cycleCandles, raw15: candles15,
        allowWeekend: isCrypto,
      });
      results[market] = { ok: true, startDate, endDate, ...bt };
    } catch (e) {
      results[market] = { ok: false, error: e.message };
    }
  }

  const { startDate, endDate } = getWeekRange(week, false);
  res.json({ ok: true, startDate, endDate, markets: results });
});

app.get("/api/trade-history", requireAuth, (req, res) => {
  const KNOWN_MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const market = req.query.market;
  const markets = (market && KNOWN_MARKETS.includes(market)) ? [market] : KNOWN_MARKETS;
  const all = [];
  for (const key of markets) {
    const file = join(__dir, `../monitor/trade_history_${key}.json`);
    try {
      const entries = JSON.parse(readFileSync(file, "utf8"));
      all.push(...entries);
    } catch {}
  }
  all.sort((a, b) => b.ts - a.ts);
  res.json({ ok: true, trades: all });
});

// ── Admin Bias endpoints ───────────────────────────────────────────────────────
const ADMIN_BIAS_FILE = join(__dir, "../monitor/admin_bias.json");
const VALID_BIAS      = ["BULLISH", "BEARISH", "AUTO"];
const KNOWN_BIAS_KEYS = ["GLOBAL", "NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];

function readAdminBiasFile() {
  try { return JSON.parse(readFileSync(ADMIN_BIAS_FILE, "utf8")); } catch { return { GLOBAL: "AUTO" }; }
}
function writeAdminBiasFile(data) {
  writeFileSync(ADMIN_BIAS_FILE, JSON.stringify(data, null, 2));
}

app.get("/api/admin/bias", requireAuth, (req, res) => {
  res.json({ ok: true, bias: readAdminBiasFile() });
});

app.post("/api/admin/bias", requireAuth, requireAdmin, (req, res) => {
  const { market = "GLOBAL", direction } = req.body ?? {};
  if (!VALID_BIAS.includes(direction))
    return res.status(400).json({ ok: false, error: `direction must be one of: ${VALID_BIAS.join(", ")}` });
  if (!KNOWN_BIAS_KEYS.includes(market))
    return res.status(400).json({ ok: false, error: `market must be one of: ${KNOWN_BIAS_KEYS.join(", ")}` });
  const data = readAdminBiasFile();
  data[market] = direction;
  writeAdminBiasFile(data);
  console.log(`[BIAS] ${market} → ${direction}`);
  res.json({ ok: true, market, direction, bias: data });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Manual-trade endpoint — admin can fire een trade direct vanuit het dashboard
// ───────────────────────────────────────────────────────────────────────────────
// POST /api/admin/manual-trade
// Body: { market, direction, sl, tp1?, tp2?, tp3?, entry?, volume? }
//
// Wat dit doet:
//   1. Validate input (markt bestaat, BUY/SELL, SL geometrie klopt vs entry)
//   2. Auto-bereken TP1/TP2/TP3 uit entry+sl met dezelfde computeSweepTP als
//      de auto-engine (1R / 2R / 10R risk-multiples). Caller mag overriden.
//   3. Bouw een kunstmatige ACTIVE setup en stuur via dezelfde CopyFactory
//      bridge die de auto-trigger gebruikt → CopyFactory repliceert naar
//      alle subscribers met hun eigen risk-scaling.
//   4. Append naar setup_log zodat het dashboard de manual trade toont.
//
// Use case: als de auto-trigger faalt en de recovery-tick nog niet heeft
// gelopen, kan de admin via /admin → Trade tab handmatig de trade alsnog
// firen. Geen SSH/curl nodig.
// ═══════════════════════════════════════════════════════════════════════════════
const SETUP_LOG_FILE_API = join(__dir, "../monitor/setup_log.json");

app.post("/api/admin/manual-trade", requireAuth, requireAdmin, async (req, res) => {
  const KNOWN = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const { market, direction, sl, tp1, tp2, tp3, entry, volume } = req.body ?? {};

  if (!KNOWN.includes(market)) return res.status(400).json({ ok: false, error: `market must be one of ${KNOWN.join(", ")}` });
  if (direction !== "BUY" && direction !== "SELL") return res.status(400).json({ ok: false, error: "direction must be BUY or SELL" });
  const slN  = Number(sl);
  if (!Number.isFinite(slN)  || slN  <= 0) return res.status(400).json({ ok: false, error: "sl must be a positive number" });
  // TP1/TP2/TP3 are auto-computed from entry+sl using the same 1R/2R/10R rule
  // the auto-engine uses (computeSweepTP). Caller may override any leg by
  // passing an explicit value; otherwise we derive from entry+sl below.
  const tp1Override = tp1 != null && tp1 !== "" ? Number(tp1) : null;
  const tp2Override = tp2 != null && tp2 !== "" ? Number(tp2) : null;
  const tp3Override = tp3 != null && tp3 !== "" ? Number(tp3) : null;
  for (const [name, v] of [["tp1", tp1Override], ["tp2", tp2Override], ["tp3", tp3Override]]) {
    if (v != null && (!Number.isFinite(v) || v <= 0)) return res.status(400).json({ ok: false, error: `${name} must be a positive number` });
  }

  // Entry defaults to current price from market_data file (last known) so the
  // operator doesn't have to re-type it. Caller can override.
  let entryN = entry != null && entry !== "" ? Number(entry) : null;
  if (entryN == null || !Number.isFinite(entryN)) {
    try {
      const md = JSON.parse(readFileSync(join(__dir, `../monitor/market_data_${market}.json`), "utf8"));
      entryN = Number(md.currentPrice);
    } catch { /* falls through to error below */ }
  }
  if (!Number.isFinite(entryN) || entryN <= 0) return res.status(400).json({ ok: false, error: "entry could not be determined; pass an explicit entry price" });

  // Direction sanity vs SL geometry. Operators occasionally type SL on the
  // wrong side (e.g. SL above entry on a BUY) — refuse rather than dispatch a
  // signal the broker will reject anyway.
  if (direction === "BUY"  && slN >= entryN) return res.status(400).json({ ok: false, error: "BUY: SL must be below entry" });
  if (direction === "SELL" && slN <= entryN) return res.status(400).json({ ok: false, error: "SELL: SL must be above entry" });

  // Auto-compute TPs from entry+sl (1R/2R/10R) — same formula the auto-engine
  // uses, so manual + auto trades have identical R-multiples.
  const computed = computeSweepTP(direction, entryN, slN);
  const tp1N = tp1Override ?? computed.tp1;
  const tp2N = tp2Override ?? computed.tp2;
  const tp3N = tp3Override ?? computed.tp3;

  const setupId = `${market}-MANUAL-${Date.now()}`;
  const nowIso  = new Date().toISOString();
  const setup = {
    id:         setupId,
    market,
    direction,
    tf:         "manual",
    source:     "manual",
    status:     "ACTIVE",       // bridge requires ACTIVE to dispatch
    entry:      entryN,
    sl:         slN,
    tp1:        tp1N,
    tp2:        tp2N,
    tp3:        tp3N,
    entryTriggered:    true,
    entryTime:         new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" }),
    entryTs:           Date.now(),
    createdTs:         Date.now(),
    metaApiDispatched: false,   // flipped to true below if dispatch succeeded
    manualOperator:    req.user?.email ?? "unknown",
  };

  // Dispatch each leg via the bridge, recording per-leg success.
  const legs = [];
  try {
    await cfNotifySignal(setup, market);
    setup.metaApiDispatched = true;
    if (tp1N != null) legs.push({ leg: "tp1", ok: true, tp: tp1N });
    if (tp2N != null) legs.push({ leg: "tp2", ok: true, tp: tp2N });
    if (tp3N != null) legs.push({ leg: "tp3", ok: true, tp: tp3N });
  } catch (e) {
    return res.status(502).json({ ok: false, error: `bridge dispatch failed: ${e.message}` });
  }

  // Append to setup_log so dashboard journal + history see the manual trade.
  try {
    const log = JSON.parse(readFileSync(SETUP_LOG_FILE_API, "utf8"));
    log.unshift({
      ...setup,
      ts:        Date.now(),
      datetime:  new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace("T", " ").slice(0, 16) + " ET",
    });
    writeFileSync(SETUP_LOG_FILE_API, JSON.stringify(log.slice(0, 10000), null, 2));
  } catch (e) {
    console.warn(`[/api/admin/manual-trade] setup_log append failed: ${e.message}`);
  }

  console.log(`[MANUAL-TRADE] ${req.user?.email ?? "?"} → ${market} ${direction} entry=${entryN} sl=${slN} tp1=${tp1N} tp2=${tp2N ?? "—"} tp3=${tp3N ?? "—"}`);
  res.json({ ok: true, setupId, legs, entry: entryN, dispatched: setup.metaApiDispatched });
});

// ── Debug Log endpoint ─────────────────────────────────────────────────────────
const DEBUG_LOG_FILE_API = join(__dir, "../monitor/debug_log.json");

app.get("/api/debug-log", requireAuth, (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || "100"), 500);
  const market = req.query.market;
  try {
    let log = JSON.parse(readFileSync(DEBUG_LOG_FILE_API, "utf8"));
    if (market) log = log.filter(e => e.market === market);
    res.json({ ok: true, events: log.slice(0, limit), total: log.length });
  } catch {
    res.json({ ok: true, events: [], total: 0 });
  }
});

// ── Weekly Recap endpoint ──────────────────────────────────────────────────────
const WEEKLY_RECAP_FILE_API = join(__dir, "../monitor/weekly_recap.json");

app.get("/api/weekly-recap", requireAuth, (req, res) => {
  try {
    const recap  = JSON.parse(readFileSync(WEEKLY_RECAP_FILE_API, "utf8"));
    const weeks  = Object.keys(recap).sort().reverse();
    const week   = req.query.week || weeks[0];
    const data   = recap[week] ?? {};

    // Build summary stats per market
    const summary = {};
    for (const [mkt, days] of Object.entries(data)) {
      const dayList = Object.values(days);
      const trades  = dayList.reduce((s, d) => ({
        wins:   s.wins   + (d.trades?.wins   ?? 0),
        losses: s.losses + (d.trades?.losses ?? 0),
        open:   s.open   + (d.trades?.open   ?? 0),
      }), { wins: 0, losses: 0, open: 0 });
      const total   = trades.wins + trades.losses;
      summary[mkt]  = { ...trades, total, winRate: total > 0 ? Math.round(trades.wins / total * 100) : null };
    }

    res.json({ ok: true, week, weeks, days: data, summary });
  } catch {
    res.json({ ok: true, week: null, weeks: [], days: {}, summary: {} });
  }
});

// ── Live market data (new engine format) ──────────────────────────────────────
const PRICE_RANGES = {
  NAS100: [10000,30000], US500: [3000,12000], US30: [20000,70000],
  XAUUSD: [1500,7000],   GBPUSD: [1.0,2.2],  BTCUSD: [10000,200000], ETHUSD: [500,20000],
};

// ── Free-tier weekly window helpers ───────────────────────────────────────────
// Free users see live signals UNTIL the first TP2 hit of the current ISO week.
// After that → all signals hidden until next Monday 00:00 ET.
// Admin users + paid auto-trade users always see everything.
function isoWeekStartUtc(d = new Date()) {
  const day = d.getUTCDay();                         // 0..6, Sun=0
  const diff = (day === 0 ? 6 : day - 1);            // back to Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday;
}
function findFirstTp2HitThisWeek(setupLog, weekStartMs, floorMs = 0) {
  // Earliest TP2 hit AFTER both weekStart AND user-specific floor.
  // Floor = user.createdAt zodat een free user die vandaag registreert
  // niet meteen "exhausted" is door een TP2 die VOOR z'n registratie viel.
  const since = Math.max(weekStartMs, floorMs);
  const candidates = setupLog
    .filter(e => (e.tp2HitTs && e.tp2HitTs >= since)
              || (e.outcome === "WIN" && (e.ts ?? 0) >= since))
    .sort((a, b) => (a.tp2HitTs || a.ts || 0) - (b.tp2HitTs || b.ts || 0));
  return candidates[0] || null;
}

app.get("/api/live-data", requireAuth, async (req, res) => {
  const MARKETS_LIST = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const market = req.query.market;
  const markets = market && MARKETS_LIST.includes(market) ? [market] : MARKETS_LIST;

  // Determine user's access tier:
  //   admin            → full access (free)
  //   auto-trade paid  → full access + broker
  //   signal paid      → full access (no broker)
  //   free             → 1 winning signal/week filter
  const u = await User.findById(req.user.id).lean();
  const isAdminUser = !!u?.isAdmin;
  const paidTier = ["auto-trade", "signal"].includes(u?.subscriptionTier);
  const hasActiveSub = paidTier
                    && (u?.subscriptionStatus === "active" || u?.subscriptionStatus === "trialing")
                    && !u?.tradingLocked;
  const isFreeTier = !isAdminUser && !hasActiveSub;
  const userCreatedMs = u?.createdAt ? new Date(u.createdAt).getTime() : 0;

  // Load setup history from setup_log.json — the canonical per-setup record with
  // actual entry/sl/tp1/tp2 + outcome fields, keyed by a stable setup `id`.
  let setupLog = [];
  try { setupLog = JSON.parse(readFileSync(join(__dir, "../monitor/setup_log.json"), "utf8")); } catch {}
  const setupHistory = {};
  for (const key of markets) {
    setupHistory[key] = setupLog
      .filter(e => e.market === key)
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 20)
      .map(e => ({
        ...e,
        // Back-compat with older LockBiasPanel fields.
        time:    e.datetime ?? null,
        details: `${e.direction}${e.source ? " | " + e.source : ""}${e.cycleLabel ? " | [" + e.cycleLabel + "]" : ""}`,
      }));
  }

  const adminBiasData = readAdminBiasFile();

  const result = {};
  for (const key of markets) {
    const file = join(__dir, `../monitor/market_data_${key}.json`);
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      const mktBias = adminBiasData[key] ?? adminBiasData.GLOBAL ?? "AUTO";
      if (mktBias === "BULLISH") d.allowedDirection = "BUY";
      else if (mktBias === "BEARISH") d.allowedDirection = "SELL";
      else {
        // AUTO: use the daily × 6H confluence bias first; fall back to raw daily lock
        d.allowedDirection = d.orderFlowBias?.direction
          ?? (d.lockState?.direction === "BULLISH" ? "BUY"
              : d.lockState?.direction === "BEARISH" ? "SELL" : null);
      }
      d.adminBias = mktBias;
      result[key] = { ...d, setupHistory: setupHistory[key] ?? [] };
    } catch { result[key] = null; }
  }

  // Apply free-tier weekly filter — gate signals behind a per-user weekly TP2.
  // Floor at user.createdAt so a fresh registrant isn't immediately "exhausted"
  // by a TP2 that fired BEFORE they signed up.
  let freeTier = null;
  if (isFreeTier) {
    const weekStart = isoWeekStartUtc();
    const firstWin = findFirstTp2HitThisWeek(setupLog, weekStart.getTime(), userCreatedMs);
    const exhausted = !!firstWin;
    if (exhausted) {
      // FULL strip — also wipe cycle data so the LiveSignals cards can't
      // re-render setups from raw cycle highs/lows. Lock state + structure
      // header stays (LockBiasPanel + bias indicators still render).
      for (const key of Object.keys(result)) {
        if (!result[key]) continue;
        result[key].activeSetup  = null;
        result[key].activeSetups = {};
        result[key].setupHistory = [];
        result[key].cycles90     = [];
        result[key].cycles6H     = [];
        result[key].cycles22M    = [];
        result[key].cycles5M     = [];
        result[key].dailyLevels  = [];
        result[key]._signalsLocked = true;          // dashboard hint to render lock-overlay
      }
    }
    // FOMO-feed: alle TP2/TP3 wins NA de eerste-win, om free users te laten
    // zien wat ze missen. Dit is engagement-driver: ze zien de wins die ze
    // gemist hebben + counter, met directe upgrade-CTA.
    let missedWins = [];
    if (exhausted && firstWin) {
      const firstWinTs = firstWin.tp2HitTs || firstWin.ts || 0;
      missedWins = setupLog
        .filter(e => (e.tp2HitTs && e.tp2HitTs > firstWinTs)
                  || (e.outcome === "WIN" && (e.ts ?? 0) > firstWinTs))
        .sort((a, b) => (b.tp2HitTs || b.ts || 0) - (a.tp2HitTs || a.ts || 0))
        .slice(0, 20)                                         // most recent 20
        .map(e => ({
          market:    e.market,
          direction: e.direction,
          tf:        e.tf || e.source,
          entry:     e.entry,
          tp2:       e.tp2,
          tp3:       e.tp3,
          outcome:   e.outcome ?? (e.tp3HitTs ? "TP3" : "TP2"),
          time:      e.tp3HitTime || e.tp2HitTime || e.datetime,
          ts:        e.tp3HitTs || e.tp2HitTs || e.ts || 0,
        }));
    }

    freeTier = {
      enabled:       true,
      weekStart:     weekStart.toISOString(),
      registeredAt:  u?.createdAt ?? null,
      effectiveStart: new Date(Math.max(weekStart.getTime(), userCreatedMs)).toISOString(),
      exhausted,
      firstWin:      firstWin ? {
        market:    firstWin.market,
        direction: firstWin.direction,
        entry:     firstWin.entry,
        tp2:       firstWin.tp2,
        time:      firstWin.tp2HitTime || firstWin.datetime,
      } : null,
      missedWins,                                              // FOMO feed
      missedCount:   missedWins.length,
      nextResetAt:   new Date(weekStart.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
      message:       exhausted
        ? `Gratis week-signaal is geleverd (${firstWin?.market} TP2). Upgrade naar Auto-Trade voor onbeperkte real-time toegang.`
        : "Gratis tier actief — je ziet live signals tot de eerste TP2-hit van de week.",
    };
  }
  res.json({ ok: true, markets: result, freeTier, timestamp: Date.now() });
});

// ── Journal: historic setup log with filters ─────────────────────────────────
// Mongo is primary; setup_log.json is the instant fallback when Mongo is down.
// A trade is journalable only if it has settled (WIN/LOSS) with complete
// entry/SL/TP info. Active/pending setups live in the live dashboard, not here.
function isJournalable(e) {
  if (e.outcome !== "WIN" && e.outcome !== "LOSS") return false;
  return e.entry != null && e.sl != null && e.tp1 != null;
}

function applyJournalFilters(items, q) {
  const market    = q.market    ? String(q.market)    : null;
  const direction = q.direction ? String(q.direction) : null;
  const tf        = q.tf        ? String(q.tf)        : null;  // "6H" | "90min" | "daily"
  const source    = q.source    ? String(q.source)    : null; // "6H" | "90M" | "daily"
  const outcome   = q.outcome   ? String(q.outcome)   : null; // WIN | LOSS | OPEN
  const lockAlign = q.lockAlignment ? String(q.lockAlignment) : null; // with | against | none
  const entryWin  = q.entryWindow ? String(q.entryWindow) : null; // "HH:MM" ET
  const from      = q.from      ? Date.parse(q.from)  : null;
  const to        = q.to        ? Date.parse(q.to)    : null;
  const dow       = q.day != null && q.day !== "" ? Number(q.day) : null; // 0=Sun..6=Sat (ET)
  return items.filter(e => {
    if (market    && e.market    !== market)                             return false;
    if (direction && e.direction !== direction)                          return false;
    if (tf        && e.tf        !== tf)                                 return false;
    if (source    && e.source    !== source)                             return false;
    if (outcome === "WIN"  && e.outcome !== "WIN")                        return false;
    if (outcome === "LOSS" && e.outcome !== "LOSS")                       return false;
    if (outcome === "OPEN" && (e.outcome === "WIN" || e.outcome === "LOSS")) return false;
    if (lockAlign && e.lockAlignment !== lockAlign)                       return false;
    if (entryWin  && e.entryWindowTime !== entryWin)                      return false;
    if (from && (e.ts ?? 0) < from)                                       return false;
    if (to   && (e.ts ?? 0) > to)                                         return false;
    if (dow !== null && !Number.isNaN(dow)) {
      const d = new Date(e.ts ?? 0);
      const etDow = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
      if (etDow !== dow) return false;
    }
    return true;
  });
}

async function readJournalSource() {
  // Prefer MongoDB — durable + scales beyond the local file cap.
  try {
    const rows = await SetupHistory.find({}).lean().exec();
    if (rows.length) return rows.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
  } catch (e) { console.warn("[journal] mongo read failed:", e.message); }
  // Fallback: local setup_log.json
  try { return JSON.parse(readFileSync(join(__dir, "../monitor/setup_log.json"), "utf8")); }
  catch { return []; }
}

app.get("/api/journal", requireAuth, async (req, res) => {
  try {
    const all = (await readJournalSource()).filter(isJournalable);
    const filtered = applyJournalFilters(all, req.query).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit  ?? "100", 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);
    res.json({
      ok:    true,
      total: filtered.length,
      items: filtered.slice(offset, offset + limit),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/journal/stats", requireAuth, async (req, res) => {
  try {
    const all = (await readJournalSource()).filter(isJournalable);
    // Distinct entry-window times across the lock-filtered universe (so the
    // dropdown stays stable when other filters narrow the visible set).
    const lockAlign = req.query.lockAlignment ? String(req.query.lockAlignment) : null;
    const lockUniverse = lockAlign ? all.filter(e => e.lockAlignment === lockAlign) : all;
    const entryWindows = Array.from(new Set(
      lockUniverse.map(e => e.entryWindowTime).filter(Boolean)
    )).sort();
    const filtered = applyJournalFilters(all, req.query);
    const wins   = filtered.filter(e => e.outcome === "WIN").length;
    const losses = filtered.filter(e => e.outcome === "LOSS").length;
    const open   = filtered.filter(e => !e.outcome).length;
    const total  = wins + losses;
    const winRate = total > 0 ? +(wins / total * 100).toFixed(1) : null;

    // Risk:reward stats — for each settled trade where entry/sl/tp exist,
    // compute R-multiple of the outcome.
    const settled = filtered.filter(e => e.outcome && e.entry != null && e.sl != null);
    const rValues = settled.map(e => {
      const risk = Math.abs(e.entry - e.sl);
      if (!risk) return 0;
      if (e.outcome === "WIN") {
        const target = e.outcomePrice ?? e.tp1 ?? e.entry;
        const reward = Math.abs(target - e.entry);
        return +(reward / risk).toFixed(2);
      } else {
        return -1;
      }
    });
    const avgR = rValues.length ? +(rValues.reduce((a, b) => a + b, 0) / rValues.length).toFixed(2) : null;

    // Per-market breakdown
    const byMarket = {};
    for (const e of filtered) {
      const mk = e.market ?? "unknown";
      if (!byMarket[mk]) byMarket[mk] = { wins: 0, losses: 0, open: 0 };
      if (e.outcome === "WIN")  byMarket[mk].wins++;
      else if (e.outcome === "LOSS") byMarket[mk].losses++;
      else                      byMarket[mk].open++;
    }
    for (const mk of Object.keys(byMarket)) {
      const t = byMarket[mk].wins + byMarket[mk].losses;
      byMarket[mk].winRate = t > 0 ? +(byMarket[mk].wins / t * 100).toFixed(1) : null;
    }

    // Per day-of-week (ET) breakdown
    const byDow = Array.from({ length: 7 }, () => ({ wins: 0, losses: 0, open: 0 }));
    for (const e of filtered) {
      if (!e.ts) continue;
      const d = new Date(new Date(e.ts).toLocaleString("en-US", { timeZone: "America/New_York" }));
      const dow = d.getDay();
      if (e.outcome === "WIN")  byDow[dow].wins++;
      else if (e.outcome === "LOSS") byDow[dow].losses++;
      else                      byDow[dow].open++;
    }

    // Per Premium/Discount alignment breakdown — pdAligned was only stored on
    // entries captured AFTER the PD-filter rollout, so older trades fall in
    // the `unknown` bucket and let the user see how much history pre-dates
    // the feature.
    const byPdAlignment = {
      aligned:    { wins: 0, losses: 0, open: 0 },
      misaligned: { wins: 0, losses: 0, open: 0 },
      unknown:    { wins: 0, losses: 0, open: 0 },
    };
    for (const e of filtered) {
      const bucket = e.pdAligned === true  ? byPdAlignment.aligned
                   : e.pdAligned === false ? byPdAlignment.misaligned
                   : byPdAlignment.unknown;
      if (e.outcome === "WIN")       bucket.wins++;
      else if (e.outcome === "LOSS") bucket.losses++;
      else                            bucket.open++;
    }
    for (const k of Object.keys(byPdAlignment)) {
      const t = byPdAlignment[k].wins + byPdAlignment[k].losses;
      byPdAlignment[k].winRate = t > 0 ? +(byPdAlignment[k].wins / t * 100).toFixed(1) : null;
    }

    // Per entry-window-time (ET) breakdown — which session times are profitable
    const byEntryWindow = {};
    for (const e of filtered) {
      const w = e.entryWindowTime;
      if (!w) continue;
      if (!byEntryWindow[w]) byEntryWindow[w] = { wins: 0, losses: 0, open: 0, rSum: 0, rCount: 0 };
      if (e.outcome === "WIN")       byEntryWindow[w].wins++;
      else if (e.outcome === "LOSS") byEntryWindow[w].losses++;
      else                            byEntryWindow[w].open++;
      // R-multiple per trade for avgR per window
      if (e.outcome && e.entry != null && e.sl != null) {
        const risk = Math.abs(e.entry - e.sl);
        if (risk) {
          const r = e.outcome === "WIN"
            ? +(Math.abs((e.outcomePrice ?? e.tp1 ?? e.entry) - e.entry) / risk).toFixed(2)
            : -1;
          byEntryWindow[w].rSum += r;
          byEntryWindow[w].rCount++;
        }
      }
    }
    for (const w of Object.keys(byEntryWindow)) {
      const b = byEntryWindow[w];
      const t = b.wins + b.losses;
      b.winRate = t > 0 ? +(b.wins / t * 100).toFixed(1) : null;
      b.avgR    = b.rCount > 0 ? +(b.rSum / b.rCount).toFixed(2) : null;
    }

    res.json({
      ok: true,
      total: filtered.length,
      wins, losses, open,
      winRate, avgR,
      byMarket, byDow, byEntryWindow, byPdAlignment,
      entryWindows,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Journal chart: per-setup candles + markers for TradeReplay page ──────────
app.get("/api/journal/:id/chart", requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    // Live-signal id format: "live-{MARKET}-{TF}" — build setup object on the fly
    // from the market's current live data (cycles + activeSetup if present).
    let setup = null;
    if (id.startsWith("live-")) {
      const parts = id.slice(5).split("-");
      const mk = parts[0];
      const tf = parts.slice(1).join("-") || "6H";
      try {
        const md = JSON.parse(readFileSync(join(__dir, `../monitor/market_data_${mk}.json`), "utf8"));
        // If there's a monitor-managed activeSetup matching this TF, use it.
        if (md.activeSetup && (md.activeSetup.tf === tf || md.activeSetup.source === tf)) {
          setup = { ...md.activeSetup, market: mk };
        } else {
          // Otherwise synthesize from live cycle data. Only return step legs
          // that fit the proper sweep order for the bias direction:
          //   BUY  → step1 = BSL hit, step2 = SSL sweep AFTER step1
          //   SELL → step1 = SSL hit, step2 = BSL sweep AFTER step1
          // step2 is left null until it has actually fired in the correct
          // sequence, so the chart matches what the card shows.
          const dir = md.allowedDirection;
          const cycles = tf === "90min" ? md.cycles90 : md.cycles6H;
          if (cycles?.length && dir) {
            const isBuy = dir === "BUY";
            const step1Key = isBuy ? "hitHigh" : "hitLow";
            const step2Key = isBuy ? "hitLow"  : "hitHigh";
            // Pick the most recent cycle where the step1 leg has fired.
            const ref = cycles
              .filter(c => c[step1Key]?.ts)
              .sort((a, b) => (b[step1Key].ts) - (a[step1Key].ts))[0];
            if (ref) {
              const step1Ts = ref[step1Key].ts;
              const step2Ts = ref[step2Key]?.ts && ref[step2Key].ts > step1Ts ? ref[step2Key].ts : null;
              setup = {
                id, market: mk, direction: dir, tf, source: tf,
                bslLevel: ref.high, sslLevel: ref.low,
                step1Ts, step2Ts,
                sweepPrice: step2Ts ? ref[step2Key].price : null,
                cycleLabel: ref.label ?? ref.name ?? `${ref.startTime}-${ref.endTime}`,
                entry: null, sl: null, tp1: null, tp2: null,
                status: "LIVE_PREVIEW",
                datetime: new Date().toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
              };
            }
          }
        }
      } catch {}
      if (!setup) return res.status(404).json({ ok: false, error: "no live data for this market/TF" });
    } else {
      const all = await readJournalSource();
      setup = all.find(e => e.id === id);
      if (!setup) return res.status(404).json({ ok: false, error: "setup not found" });
    }
    const mk = setup.market;
    // Pick a candle file matching the setup's timeframe so the chart
    // resolution fits the setup's scale: daily setups → 1D candles,
    // 6H setups → 1H, 90min/default → 15min. Verify actual frequency from
    // the file delta (some legacy files are mislabeled) and fall back if needed.
    // Pick the freshest candle file across available timeframes — 15-min
    // when fresh enough, otherwise fall back to whatever candles_${mk}.json
    // holds (legacy default, may be daily or 15-min depending on the market).
    // Picking by freshness avoids empty slices when one file is stale.
    let candles = null;
    let bestLastTs = -Infinity;
    for (const cand of [
      `candles_15_${mk}.json`,
      `candles_${mk}.json`,
      `candles_1H_${mk}.json`,
      `candles_1D_${mk}.json`,
    ]) {
      try {
        const c = JSON.parse(readFileSync(join(__dir, `../monitor/${cand}`), "utf8"));
        const lastTs = c?.[c.length - 1]?.timestamp ?? 0;
        if (lastTs > bestLastTs) { bestLastTs = lastTs; candles = c; }
      } catch {}
    }
    if (!candles?.length) {
      return res.status(500).json({ ok: false, error: `no candles for ${mk}` });
    }
    // Window: anchor on the 18:00 ET trading-day boundary on the day of the
    // earliest setup event so the full SSL/BSL sweep context is always visible.
    // End: for closed setups, 48h after entry (capped to lastCandle); for
    // live/open setups, run through the latest candle.
    // Determine candle frequency from the median delta of the last ~20
    // candles — robust to mixed/corrupted leading entries.
    let candleSec = 900;
    if (candles.length >= 3) {
      const tail = candles.slice(-Math.min(20, candles.length));
      const deltas = [];
      for (let i = 1; i < tail.length; i++) deltas.push(tail[i].timestamp - tail[i - 1].timestamp);
      deltas.sort((a, b) => a - b);
      candleSec = deltas[Math.floor(deltas.length / 2)] || 900;
    }
    const step1Ts    = setup.step1Ts ?? 0;
    const step2Ts    = setup.step2Ts ?? 0;
    const entryTsSec = setup.entryTs ? (setup.entryTs > 1e12 ? setup.entryTs / 1000 : setup.entryTs) : 0;
    const lastCandle = candles[candles.length - 1]?.timestamp ?? Math.floor(Date.now() / 1000);
    const anchors    = [step1Ts, step2Ts, entryTsSec].filter(Boolean);
    const earliestTs = anchors.length ? Math.min(...anchors) : lastCandle - 24 * 3600;
    // For intraday (≤1H) candles use the 18:00 ET trading-day boundary; for
    // daily candles use a generous N-day window since events are inside one
    // candle and the trading-day-start trick doesn't apply.
    let startTs, endTs;
    if (candleSec >= 60000) {
      startTs = earliestTs - 30 * 86400;
      endTs   = setup.outcome && entryTsSec ? Math.min(entryTsSec + 30 * 86400, lastCandle) : lastCandle;
    } else {
      startTs = getTradingDayStartTsFor(earliestTs) - 1 * 3600;
      endTs   = setup.outcome && entryTsSec ? Math.min(entryTsSec + 48 * 3600, lastCandle) : lastCandle;
    }
    const slice = candles.filter(c => c.timestamp >= startTs && c.timestamp <= endTs);
    res.json({
      ok: true,
      setup,
      candles: slice.map(c => ({
        time: c.timestamp,
        open: c.open, high: c.high, low: c.low, close: c.close,
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`BLACKBULL API running on http://0.0.0.0:${PORT}`);
});
