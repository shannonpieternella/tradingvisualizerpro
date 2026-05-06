// Hourly balance + transaction sync cron.
//
// Per BrokerAccount:
//   1. Fetch current balance/equity → BalanceSnapshot row (always)
//   2. Fetch new MetaApi deals (deposits/withdrawals/credits) since last cron
//      → AccountTransaction rows (idempotent op dealId)
//
// Records persist forever — also after user disconnects — zodat de
// performance-fee cron en de dashboard balance-graph altijd accurate data
// hebben, en je verschil ziet tussen "user heeft geld gestort" vs "trading P&L".
//
// Cron entry: 0 * * * *

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import mongoose from "/opt/trading-assistant/api/node_modules/mongoose/index.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const env = {};
readFileSync(join(__dir, "../.env"), "utf8").split("\n").forEach(l => {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});
for (const k of ["METAAPI_TOKEN", "METAAPI_REGION", "MONGO_URI"]) {
  if (!process.env[k] && env[k]) process.env[k] = env[k];
}

const metaapi = await import("./metaapi-client.js");
await mongoose.connect(process.env.MONGO_URI);

const BrokerAccount = mongoose.model("BrokerAccount", new mongoose.Schema({}, { strict: false, collection: "brokeraccounts" }));
const BalanceSnapshot = mongoose.model("BalanceSnapshot", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId, metaapiAccountId: String, brokerAccountId: mongoose.Schema.Types.ObjectId,
  balance: Number, equity: Number, freeMargin: Number, margin: Number, marginLevel: Number,
  currency: { type: String, default: "USD" }, source: { type: String, default: "metaapi" },
  snapshotAt: { type: Date, default: Date.now }, createdAt: { type: Date, default: Date.now },
}, { collection: "balancesnapshots" }));
const AccountTransaction = mongoose.model("AccountTransaction", new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId, metaapiAccountId: String, dealId: String,
  type: String, amount: Number, currency: String, comment: String,
  brokerTime: Date, createdAt: { type: Date, default: Date.now },
}, { collection: "accounttransactions" }));

// Map MetaApi deal type → our simplified type
function classifyDeal(deal) {
  const t = deal.type;
  if (t === "DEAL_TYPE_BALANCE") {
    // BALANCE deals can be deposits, withdrawals or corrections — distinguished
    // by sign of profit (the deal's `profit` field carries the amount).
    if (deal.profit > 0)  return "DEPOSIT";
    if (deal.profit < 0)  return "WITHDRAWAL";
    return "CORRECTION";
  }
  if (t === "DEAL_TYPE_CREDIT")     return "CREDIT";
  if (t === "DEAL_TYPE_CORRECTION") return "CORRECTION";
  return null;  // trades — handled by balance/equity diff, not standalone records
}

const accounts = await BrokerAccount.find({}).lean();
console.log(`[balance-sync] ${accounts.length} accounts to poll`);

let snapsOk = 0, snapsFail = 0, txsAdded = 0;
for (const a of accounts) {
  // 1. Snapshot
  try {
    const info = await metaapi.getAccountInformation(a.metaapiAccountId);
    if (info) {
      await BalanceSnapshot.create({
        userId:           a.userId,
        metaapiAccountId: a.metaapiAccountId,
        brokerAccountId:  a._id,
        balance:          info.balance,
        equity:           info.equity,
        freeMargin:       info.freeMargin,
        margin:           info.margin,
        marginLevel:      info.marginLevel,
        currency:         info.currency || "USD",
      });
      snapsOk++;
    } else {
      snapsFail++;
    }
  } catch (e) {
    console.warn(`[balance-sync] snap ${a.metaapiAccountId}: ${e.message}`);
    snapsFail++;
  }

  // 2. Transaction sync — only deposits/withdrawals/credits, not trade deals
  try {
    // Window: last 30 days (to catch any deals we may have missed during
    // outages). dealId-uniqueness index makes upsert idempotent.
    const endISO   = new Date().toISOString();
    const startISO = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const deals = await metaapi.getDealsByTimeRange(a.metaapiAccountId, startISO, endISO);
    if (Array.isArray(deals)) {
      for (const d of deals) {
        const cls = classifyDeal(d);
        if (!cls) continue;
        try {
          const r = await AccountTransaction.updateOne(
            { dealId: d.id },
            {
              $setOnInsert: {
                userId:           a.userId,
                metaapiAccountId: a.metaapiAccountId,
                dealId:           d.id,
                type:             cls,
                amount:           d.profit ?? 0,
                currency:         a.currency || "USD",
                comment:          d.comment || "",
                brokerTime:       d.time ? new Date(d.time) : new Date(),
              },
            },
            { upsert: true },
          );
          if (r.upsertedCount > 0) txsAdded++;
        } catch (e) {
          // Ignore duplicates (race on dealId)
          if (!String(e.message).includes("duplicate")) console.warn(`[tx] upsert ${d.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[balance-sync] tx ${a.metaapiAccountId}: ${e.message}`);
  }
}

console.log(`[balance-sync] done: ${snapsOk} snaps ok, ${snapsFail} fail, ${txsAdded} new txs`);
await mongoose.disconnect();
process.exit(0);
