// Thin wrapper around MetaApi REST + CopyFactory REST.
// We hit the REST API directly (no SDK) — it keeps the surface minimal and
// avoids the node/web bundle confusion in metaapi.cloud-sdk.
//
// Required env (loaded by server.js):
//   METAAPI_TOKEN              — long-lived JWT
//   METAAPI_REGION             — "london" / "new-york" etc., from /users/current/regions
//   METAAPI_MASTER_ACCOUNT_ID  — anchors the strategy
//   METAAPI_STRATEGY_ID        — CopyFactory strategy that fans out signals

const TOKEN          = process.env.METAAPI_TOKEN;
const REGION         = process.env.METAAPI_REGION || "london";
const STRATEGY_ID    = process.env.METAAPI_STRATEGY_ID;
const PROVISIONING_HOST = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
const COPYFACTORY_HOST  = `https://copyfactory-api-v1.${REGION}.agiliumtrade.ai`;
const MT_CLIENT_HOST    = `https://mt-client-api-v1.${REGION}.agiliumtrade.ai`;

if (!TOKEN) console.warn("[metaapi-client] METAAPI_TOKEN not set — broker endpoints will fail until configured");

// Markets the monitor produces signals for. Used for default user prefs and
// for validating user-selected market lists.
export const MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];

// Per-broker symbol mapping. Key = broker server keyword; value = lookup table
// from canonical market name → broker-native symbol. The default is what
// LiquidMarkets uses; brokers with different naming conventions get their own
// entry. Subscribers receive signals using the broker-native names via
// CopyFactory's symbolMapping.
//
// Add a broker by appending an entry; keys are matched as substrings against
// the MT server name (case-insensitive).
export const SYMBOL_MAP = {
  default: {
    NAS100: "NAS100", US500: "US500", US30: "US30",
    XAUUSD: "XAUUSD", GBPUSD: "GBPUSD",
    BTCUSD: "BTCUSD", ETHUSD: "ETHUSD",
  },
  // FTMO MT5 example — uncomment and tune when adding FTMO support:
  // ftmo: { NAS100: "USTEC", US500: "US500", US30: "US30", XAUUSD: "XAUUSD",
  //         GBPUSD: "GBPUSD", BTCUSD: "BTCUSD", ETHUSD: "ETHUSD" },
};

function brokerKeyForServer(server) {
  if (!server) return "default";
  const s = server.toLowerCase();
  for (const k of Object.keys(SYMBOL_MAP)) {
    if (k !== "default" && s.includes(k)) return k;
  }
  return "default";
}

export function mapSymbols(server, markets) {
  const table = SYMBOL_MAP[brokerKeyForServer(server)] ?? SYMBOL_MAP.default;
  return markets.map(m => table[m] ?? m);
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function req(host, path, method = "GET", body = null, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(host + path, {
      method,
      headers: {
        "auth-token": TOKEN,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) {
      const msg = data?.message ?? text ?? r.statusText;
      const err = new Error(`MetaApi ${method} ${path} → ${r.status}: ${msg}`);
      err.status = r.status; err.body = data;
      throw err;
    }
    return data;
  } finally { clearTimeout(t); }
}

// ── MT account provisioning ──────────────────────────────────────────────────
export async function provisionSubscriberAccount({ login, password, server, platform = "mt5", name }) {
  if (!login || !password || !server) throw new Error("login, password, server required");
  const body = {
    name:             name || `BLBL-SUB-${login}`,
    type:             "cloud",
    login:            String(login),
    password,
    server,
    platform,
    magic:            0,
    application:      "CopyFactory",
    copyFactoryRoles: ["SUBSCRIBER"],
    region:           REGION,
  };
  const res = await req(PROVISIONING_HOST, "/users/current/accounts", "POST", body, 60000);
  return res; // { id, state }
}

export async function getAccountState(accountId) {
  return req(PROVISIONING_HOST, `/users/current/accounts/${accountId}`);
}

// MetaApi creates accounts in UNDEPLOYED state — must be deployed before they
// connect to the broker and start receiving CopyFactory signals.
export async function deployAccount(accountId) {
  return req(PROVISIONING_HOST, `/users/current/accounts/${accountId}/deploy`, "POST");
}

// MT client API — live account state for analytics. REST polling is free
// (only running resource slots are billed), so safe to call on every admin
// page refresh.
export async function getAccountInformation(accountId) {
  return req(MT_CLIENT_HOST, `/users/current/accounts/${accountId}/account-information`);
}
export async function getOpenPositions(accountId) {
  return req(MT_CLIENT_HOST, `/users/current/accounts/${accountId}/positions`);
}

export async function deleteAccount(accountId) {
  // MetaApi soft-deletes by default; pass force=true to hard-delete immediately.
  return req(PROVISIONING_HOST, `/users/current/accounts/${accountId}`, "DELETE");
}

// ── CopyFactory subscriber config ────────────────────────────────────────────
// Builds the subscription config for one user, applying their market filter
// and risk preferences against our master strategy.
function buildSubscription(prefs, server) {
  const sub = { strategyId: STRATEGY_ID, multiplier: 1 };

  // Market filter — empty `included` means "all symbols", otherwise whitelist.
  const enabled = Array.isArray(prefs?.enabledMarkets) ? prefs.enabledMarkets : MARKETS;
  if (enabled.length && enabled.length < MARKETS.length) {
    sub.symbolFilter = { included: mapSymbols(server, enabled), excluded: [] };
  }

  // Risk model:
  //   "percentBalance" → fixedRisk (riskFraction = pct/100). Requires SL on signal.
  //   "fixedLot"       → fixedVolume (tradeVolume = lots).
  //   default          → balance scaling (preserves master's risk profile).
  const mode = prefs?.riskMode;
  const val  = Number(prefs?.riskValue);
  if (mode === "percentBalance" && Number.isFinite(val) && val > 0) {
    sub.tradeSizeScaling = { mode: "fixedRisk", riskFraction: val / 100 };
  } else if (mode === "fixedLot" && Number.isFinite(val) && val > 0) {
    sub.tradeSizeScaling = { mode: "fixedVolume", tradeVolume: val };
  } else {
    sub.tradeSizeScaling = { mode: "balance" };
  }
  return sub;
}

// PUT /users/current/configuration/subscribers/{subscriberId}
// subscriberId = the subscriber MT account id.
export async function upsertSubscriber({ accountId, name, server, prefs }) {
  if (!accountId) throw new Error("accountId required");
  const body = {
    name: name || `BLBL-SUB-${accountId.slice(0, 8)}`,
    subscriptions: prefs?.copyEnabled === false ? [] : [buildSubscription(prefs, server)],
  };
  return req(COPYFACTORY_HOST, `/users/current/configuration/subscribers/${accountId}`, "PUT", body);
}

export async function deleteSubscriber(accountId) {
  return req(COPYFACTORY_HOST, `/users/current/configuration/subscribers/${accountId}`, "DELETE");
}

// ── Signal fan-out ───────────────────────────────────────────────────────────
// CopyFactory signal API: PUT /users/current/strategies/{id}/external-signals/{signalId}
// Note: the *signal* path is `/strategies/...`, NOT `/configuration/strategies/...`
// (configuration paths are for managing strategies/subscribers; signal paths are
// for live trading flow).
export async function sendStrategySignal(signal) {
  if (!STRATEGY_ID) throw new Error("METAAPI_STRATEGY_ID not set");
  if (!signal?.signalId) throw new Error("signal.signalId required");
  const path = `/users/current/strategies/${STRATEGY_ID}/external-signals/${signal.signalId}`;
  const body = {
    symbol:     signal.symbol,
    type:       signal.type,
    volume:     signal.volume ?? 0.01,    // base unit; per-subscriber scaling rewrites this
    time:       signal.time ?? new Date().toISOString(),
    ...(signal.stopLoss   != null ? { stopLoss:   signal.stopLoss   } : {}),
    ...(signal.takeProfit != null ? { takeProfit: signal.takeProfit } : {}),
    ...(signal.magic      != null ? { magic:      signal.magic      } : {}),
  };
  return req(COPYFACTORY_HOST, path, "PUT", body);
}

export async function removeStrategySignal(signalId) {
  if (!STRATEGY_ID) throw new Error("METAAPI_STRATEGY_ID not set");
  const path = `/users/current/strategies/${STRATEGY_ID}/external-signals/${signalId}/remove`;
  return req(COPYFACTORY_HOST, path, "POST", { time: new Date().toISOString() });
}

// Map our internal direction + setup to a CopyFactory signal payload.
// `setup` is the activeSetup row from the monitor (entry/sl/tp1/sweepPrice).
export function buildSignalFromSetup(setup, masterServer) {
  const isBuy = setup.direction === "BUY";
  const symbol = (SYMBOL_MAP[brokerKeyForServer(masterServer)] ?? SYMBOL_MAP.default)[setup.market] ?? setup.market;
  return {
    signalId:   setup.id, // stable per-setup id
    symbol,
    type:       isBuy ? "POSITION_TYPE_BUY" : "POSITION_TYPE_SELL",
    volume:     0.01, // per-subscriber scaling overrides this; 0.01 keeps it valid for fixedRisk too
    time:       new Date(setup.entryTs ?? Date.now()).toISOString(),
    stopLoss:   setup.sl ?? undefined,
    takeProfit: setup.tp1 ?? undefined,
    magic:      0,
  };
}
