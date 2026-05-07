// One-shot script: create the 3 live Stripe products + monthly recurring prices.
//
// Run ONCE when switching to live mode:
//   node /opt/trading-assistant/api/stripe_setup_live_products.mjs
//
// Reads STRIPE_LIVE_SECRET_KEY from .env. Outputs the 3 price IDs that need to
// be pasted into .env as STRIPE_LIVE_PRICE_ID_*. Idempotent — re-running checks
// for existing products by metadata.tradingvisualizer_slug before creating.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import StripeSDK from "/opt/trading-assistant/api/node_modules/stripe/esm/stripe.esm.node.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const env = {};
readFileSync(join(__dir, "../.env"), "utf8").split("\n").forEach(l => {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
});

const SECRET = env.STRIPE_LIVE_SECRET_KEY;
if (!SECRET) {
  console.error("✗ STRIPE_LIVE_SECRET_KEY not set in .env");
  process.exit(1);
}
if (!SECRET.startsWith("sk_live_") && !SECRET.startsWith("rk_live_")) {
  console.error(`✗ STRIPE_LIVE_SECRET_KEY does not look like a live key (starts with ${SECRET.slice(0,8)}...)`);
  process.exit(1);
}

const stripe = new StripeSDK(SECRET);

const PRODUCTS = [
  {
    slug:      "ai-analyst-signal",
    name:      "TradingVisualizer — AI-Analyst",
    description:"Real-time AI signal stream + Trading Mentor. Self-execute trades. €39/maand.",
    amountCents: 3900,
    envKey:    "STRIPE_LIVE_PRICE_ID_SIGNAL",
  },
  {
    slug:      "hands-off-ai-auto-trade",
    name:      "TradingVisualizer — Hands-Off AI",
    description:"AI Auto-Trade. Connect broker, AI executes. 10% performance share on profits. €69/maand.",
    amountCents: 6900,
    envKey:    "STRIPE_LIVE_PRICE_ID_AUTO_TRADE",
  },
  {
    slug:      "extra-broker-account",
    name:      "TradingVisualizer — Extra Broker Account",
    description:"Add-on per additional broker account beyond the first included one. €19/maand per account.",
    amountCents: 1900,
    envKey:    "STRIPE_LIVE_PRICE_ID_EXTRA_ACCOUNT",
  },
];

async function ensureProduct(p) {
  // Check if a product with our slug metadata already exists.
  const existing = await stripe.products.search({
    query: `metadata['tradingvisualizer_slug']:'${p.slug}' AND active:'true'`,
  });
  let product = existing.data[0];
  if (product) {
    console.log(`= product exists: ${product.id} (${p.slug})`);
  } else {
    product = await stripe.products.create({
      name:        p.name,
      description: p.description,
      metadata:    { tradingvisualizer_slug: p.slug },
    });
    console.log(`+ product created: ${product.id} (${p.slug})`);
  }
  // Look for an active monthly EUR recurring price at the right amount.
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 20 });
  const match = prices.data.find(pr =>
    pr.currency === "eur" &&
    pr.recurring?.interval === "month" &&
    pr.unit_amount === p.amountCents,
  );
  if (match) {
    console.log(`= price exists:   ${match.id} (€${p.amountCents/100}/mo)`);
    return { product, price: match };
  }
  const price = await stripe.prices.create({
    product:     product.id,
    currency:    "eur",
    unit_amount: p.amountCents,
    recurring:   { interval: "month" },
    metadata:    { tradingvisualizer_slug: p.slug },
  });
  console.log(`+ price created:  ${price.id} (€${p.amountCents/100}/mo)`);
  return { product, price };
}

console.log(`[stripe-setup] connecting in LIVE mode (key suffix …${SECRET.slice(-4)})`);
const results = [];
for (const p of PRODUCTS) {
  const r = await ensureProduct(p);
  results.push({ ...p, productId: r.product.id, priceId: r.price.id });
}

console.log("\n────────────────────────────────────────────────────────────");
console.log("Paste deze regels in /opt/trading-assistant/.env:");
console.log("────────────────────────────────────────────────────────────");
for (const r of results) console.log(`${r.envKey}=${r.priceId}`);
console.log("────────────────────────────────────────────────────────────\n");

console.log("Volgende stappen:");
console.log("  1. .env aanvullen met bovenstaande price IDs");
console.log("  2. STRIPE_LIVE_PUBLISHABLE_KEY=pk_live_... toevoegen");
console.log("  3. Webhook endpoint in Stripe dashboard aanmaken:");
console.log("       https://tradingvisualizer.com/api/billing/webhook");
console.log("       Listen for: checkout.session.completed,");
console.log("                   customer.subscription.{created,updated,deleted},");
console.log("                   invoice.{paid,payment_failed}");
console.log("     → kopieer signing secret → STRIPE_LIVE_WEBHOOK_SECRET=whsec_...");
console.log("  4. STRIPE_MODE=live in .env");
console.log("  5. systemctl restart trading-api");
console.log("  6. Test 1 €1 checkout end-to-end voor je echte users onboardt");

process.exit(0);
