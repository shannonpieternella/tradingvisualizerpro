// Performance-fee cron — runs 1st of each month at 02:00 UTC.
// For every Auto-Trade user (subscriptionStatus=active or trialing):
//   1. Find balance snapshots at start + end of last month
//   2. Compute net profit = end_equity - start_equity (net of deposits/withdrawals)
//   3. Apply high-water mark: only charge fee if end_equity > prev HWM
//   4. Create Invoice (10% of net profit, type=performance_fee)
//   5. Send Stripe invoice → user gets pay-now link in dashboard notifications
//
// Cron entry: 0 2 1 * *  /usr/bin/node /opt/trading-assistant/api/perf_fee_cron.mjs

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
for (const k of ["MONGO_URI", "STRIPE_MODE", "STRIPE_SECRET_KEY", "STRIPE_LIVE_SECRET_KEY"]) {
  if (!process.env[k] && env[k]) process.env[k] = env[k];
}

const mode = (process.env.STRIPE_MODE || "test").toLowerCase();
const stripeKey = mode === "live" ? process.env.STRIPE_LIVE_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
const StripeSDK = (await import("stripe")).default;
const stripe = stripeKey ? new StripeSDK(stripeKey) : null;

const FEE_PERCENT = 10;

await mongoose.connect(process.env.MONGO_URI);

const User = mongoose.model("User", new mongoose.Schema({}, { strict: false, collection: "users" }));
const Invoice = mongoose.model("Invoice", new mongoose.Schema({}, { strict: false, collection: "invoices" }));
const BalanceSnapshot = mongoose.model("BalanceSnapshot", new mongoose.Schema({}, { strict: false, collection: "balancesnapshots" }));
const AccountTransaction = mongoose.model("AccountTransaction", new mongoose.Schema({}, { strict: false, collection: "accounttransactions" }));

// ── Period: previous calendar month in UTC ───────────────────────────────────
const now = new Date();
const periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)); // first of current month
const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0)); // first of last month
console.log(`[perf-fee] period: ${periodStart.toISOString()} → ${periodEnd.toISOString()}`);

// All paid Auto-Trade users (skip admins, skip trialing — no fee on trial)
const users = await User.find({
  subscriptionTier: "auto-trade",
  subscriptionStatus: "active",
  isAdmin: { $ne: true },
}).lean();
console.log(`[perf-fee] ${users.length} eligible users`);

let invoiced = 0, skipped = 0;
for (const u of users) {
  try {
    // Find earliest snapshot >= periodStart and latest snapshot < periodEnd
    const startSnap = await BalanceSnapshot.findOne({
      userId: u._id, snapshotAt: { $gte: periodStart },
    }).sort({ snapshotAt: 1 }).lean();
    const endSnap = await BalanceSnapshot.findOne({
      userId: u._id, snapshotAt: { $lt: periodEnd },
    }).sort({ snapshotAt: -1 }).lean();

    if (!startSnap || !endSnap) {
      console.log(`  - ${u.email}: insufficient snapshots, skip`);
      skipped++;
      continue;
    }

    // High-water mark from previous fee invoices
    const lastFee = await Invoice.findOne({
      userId: u._id, type: "performance_fee",
    }).sort({ createdAt: -1 }).lean();
    const hwm = lastFee?.perfFeeMeta?.hwmAfter ?? startSnap.equity;

    // Net deposits/withdrawals during the period — exclude these from profit
    // so user is NOT charged on capital they put in themselves, and we don't
    // miss profit obscured by a withdrawal.
    const txs = await AccountTransaction.find({
      userId:     u._id,
      brokerTime: { $gte: periodStart, $lt: periodEnd },
    }).lean();
    let netDeposits = 0;        // deposits + corrections (positive) - withdrawals (also positive sign in amount.abs)
    for (const t of txs) {
      if (t.type === "DEPOSIT" || t.type === "CREDIT" || t.type === "CORRECTION") netDeposits += (t.amount || 0);
      if (t.type === "WITHDRAWAL") netDeposits += (t.amount || 0);  // amount is already negative
    }

    // True profit above HWM, adjusted for capital flows.
    //   end_equity - hwm = raw change from previous high
    //   - netDeposits = subtract capital injections / add back withdrawals
    //   = profit purely from trading (gain) above HWM
    const netProfit = (endSnap.equity - hwm) - netDeposits;
    if (netProfit <= 0) {
      console.log(`  - ${u.email}: no new high (end=${endSnap.equity} hwm=${hwm}), skip`);
      skipped++;
      continue;
    }

    const feeAmount = Math.round(netProfit * (FEE_PERCENT / 100) * 100); // cents
    if (feeAmount < 100) {
      console.log(`  - ${u.email}: fee <€1, skip`);
      skipped++;
      continue;
    }

    // Create local Invoice record first (idempotency: fee invoice per user per period)
    const exists = await Invoice.findOne({
      userId: u._id, type: "performance_fee",
      periodStart, periodEnd,
    });
    if (exists) {
      console.log(`  - ${u.email}: invoice for this period exists, skip`);
      skipped++;
      continue;
    }

    const invoiceDoc = {
      userId:        u._id,
      type:          "performance_fee",
      amount:        feeAmount,
      currency:      "EUR",
      status:        "open",
      periodStart, periodEnd,
      description:   `Performance fee ${FEE_PERCENT}% (${periodStart.toISOString().slice(0,7)})`,
      perfFeeMeta:   {
        netProfit:    netProfit,
        feePercent:   FEE_PERCENT,
        hwmBefore:    hwm,
        hwmAfter:     endSnap.equity - netDeposits,   // HWM adjusted for capital flows
        netDeposits:  netDeposits,
        startEquity:  startSnap.equity,
        endEquity:    endSnap.equity,
      },
      createdAt:     new Date(),
    };

    // If Stripe configured, also create Stripe invoice → hosted URL for user
    if (stripe && u.stripeCustomerId) {
      try {
        const invoiceItem = await stripe.invoiceItems.create({
          customer: u.stripeCustomerId,
          amount:   feeAmount,
          currency: "eur",
          description: invoiceDoc.description,
        });
        const stripeInv = await stripe.invoices.create({
          customer:           u.stripeCustomerId,
          collection_method:  "send_invoice",
          days_until_due:     7,
          metadata:           { userId: String(u._id), type: "performance_fee" },
        });
        const finalized = await stripe.invoices.finalizeInvoice(stripeInv.id);
        invoiceDoc.stripeInvoiceId   = finalized.id;
        invoiceDoc.stripePaymentLink = finalized.hosted_invoice_url;
      } catch (e) {
        console.warn(`  - ${u.email}: Stripe invoice failed: ${e.message}`);
        // Still save local record so we don't double-charge next month
      }
    }

    await Invoice.create(invoiceDoc);
    // Lock trading until paid
    await User.updateOne({ _id: u._id }, { tradingLocked: true });

    console.log(`  ✓ ${u.email}: €${(feeAmount/100).toFixed(2)} (profit ${netProfit.toFixed(2)} above HWM ${hwm.toFixed(2)})`);
    invoiced++;
  } catch (e) {
    console.error(`  ✗ ${u.email}: ${e.message}`);
  }
}

console.log(`\n[perf-fee] done: ${invoiced} invoiced, ${skipped} skipped`);
await mongoose.disconnect();
process.exit(0);
