import React, { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./BrokerPage.css";

const API = "/api";
const ALL_MARKETS = ["NAS100","US500","US30","XAUUSD","GBPUSD","BTCUSD","ETHUSD"];
const MARKET_LABELS = {
  NAS100: "NAS100", US500: "S&P 500", US30: "DOW", XAUUSD: "GOLD",
  GBPUSD: "CABLE",  BTCUSD: "BTC/USD", ETHUSD: "ETH/USD",
};

function StatusPill({ status, connection }) {
  const ok = (status === "DEPLOYED" && connection === "CONNECTED");
  const cls = ok ? "ok" : status === "DEPLOYING" || status === "PENDING" ? "warn" : "bad";
  const label = ok ? "Verbonden" : (status || "—");
  return <span className={`bp-pill bp-pill-${cls}`}>{label}</span>;
}

function ConnectForm({ onConnected, currentCount = 0, isAdmin = false }) {
  const { authFetch } = useAuth();
  const [form, setForm] = useState({
    broker: "", login: "", password: "", server: "", platform: "mt5",
    enabledMarkets: [...ALL_MARKETS],
    riskMode: "percentBalance",
    riskValue: 1.0,
  });
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState("");

  // Compute what THIS new account will cost. First account is included in the
  // €69 base; every account from #2 onwards adds €19/mo to the subscription.
  // Admin users have no add-on charges.
  const willBeAccountNum = currentCount + 1;
  const isFirstAccount   = currentCount === 0;
  const monthlyAfterAdd  = isAdmin ? 0 : 69 + Math.max(0, currentCount) * 19;
  const monthlyBeforeAdd = isAdmin ? 0 : 69 + Math.max(0, currentCount - 1) * 19;

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function toggleMarket(m) {
    setForm(f => ({
      ...f,
      enabledMarkets: f.enabledMarkets.includes(m)
        ? f.enabledMarkets.filter(x => x !== m)
        : [...f.enabledMarkets, m],
    }));
  }

  async function submit(e) {
    e.preventDefault();
    // For non-admin users on a 2nd+ account, confirm the price increase before
    // submitting — never silently raise their bill.
    if (!isAdmin && !isFirstAccount) {
      const ok = window.confirm(
        `Adding this broker account will raise your monthly subscription from ` +
        `€${monthlyBeforeAdd} to €${monthlyAfterAdd} (proration applies for the remainder of this month). ` +
        `Continue?`
      );
      if (!ok) return;
    }
    setBusy(true); setError("");
    try {
      const r = await authFetch(`${API}/broker/connect`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(form),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Koppeling mislukt");
      setForm(f => ({ ...f, login: "", password: "" }));
      onConnected?.(j.account);
    } catch (e2) { setError(e2.message); }
    finally { setBusy(false); }
  }

  return (
    <form className="bp-form" onSubmit={submit}>
      <h3>Broker koppelen</h3>
      <p className="bp-hint">
        Vul je MT4/MT5-login, password en server in. Wachtwoord wordt direct
        doorgestuurd naar MetaApi (gehost) en niet bij ons opgeslagen.
      </p>

      {/* Transparent pricing banner — show user EXACTLY what this connection costs */}
      {!isAdmin && (
        <div className={`bp-pricing-banner ${isFirstAccount ? "bp-pricing-included" : "bp-pricing-extra"}`}>
          {isFirstAccount ? (
            <>
              <div className="bp-pricing-icon">✓</div>
              <div className="bp-pricing-text">
                <strong>1st account — included in your €69/mo plan</strong>
                <div>No extra charge. Add additional accounts later for €19/mo each.</div>
              </div>
            </>
          ) : (
            <>
              <div className="bp-pricing-icon">+€19</div>
              <div className="bp-pricing-text">
                <strong>This will be account #{willBeAccountNum} — adds €19/mo to your subscription</strong>
                <div>Your monthly: <strong>€{monthlyBeforeAdd}</strong> → <strong>€{monthlyAfterAdd}</strong> (€69 base + {currentCount}× €19 add-ons after this)</div>
              </div>
            </>
          )}
        </div>
      )}
      {isAdmin && (
        <div className="bp-pricing-banner bp-pricing-admin">
          <div className="bp-pricing-icon">⭐</div>
          <div className="bp-pricing-text">
            <strong>Admin — unlimited accounts, no charges.</strong>
          </div>
        </div>
      )}

      <div className="bp-grid">
        <label>Platform
          <select value={form.platform} onChange={e => setField("platform", e.target.value)}>
            <option value="mt5">MT5</option>
            <option value="mt4">MT4</option>
          </select>
        </label>
        <label>Broker (vrije naam)
          <input value={form.broker} onChange={e => setField("broker", e.target.value)} placeholder="bv. LiquidMarkets" />
        </label>
        <label>MT-server
          <input required value={form.server} onChange={e => setField("server", e.target.value)} placeholder="bv. LiquidMarkets-Server" />
        </label>
        <label>Login
          <input required value={form.login} onChange={e => setField("login", e.target.value)} placeholder="account number" />
        </label>
        <label>Password
          <input required type="password" value={form.password} autoComplete="new-password"
            onChange={e => setField("password", e.target.value)} placeholder="MT-wachtwoord" />
        </label>
      </div>

      <div className="bp-section">
        <h4>Markten waarvoor je signals wil ontvangen</h4>
        <div className="bp-markets">
          {ALL_MARKETS.map(m => (
            <label key={m} className={`bp-chip ${form.enabledMarkets.includes(m) ? "on" : ""}`}>
              <input type="checkbox" checked={form.enabledMarkets.includes(m)} onChange={() => toggleMarket(m)} />
              {MARKET_LABELS[m]}
            </label>
          ))}
        </div>
      </div>

      <div className="bp-section">
        <h4>Risk per trade</h4>
        <div className="bp-risk">
          <label>
            <input type="radio" name="riskMode" checked={form.riskMode === "percentBalance"}
              onChange={() => setField("riskMode", "percentBalance")} />
            % van balance
          </label>
          <label>
            <input type="radio" name="riskMode" checked={form.riskMode === "fixedLot"}
              onChange={() => setField("riskMode", "fixedLot")} />
            Vaste lot-grootte
          </label>
          <input
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={String(form.riskValue ?? "")}
            onChange={e => {
              // Accept both "." and "," as decimal separator (NL locale).
              // Strip everything that isn't digits or a separator, normalise
              // to a single "." so Number() parses on submit.
              const raw = e.target.value.replace(/[^0-9.,]/g, "").replace(",", ".");
              setField("riskValue", raw);
            }} />

          <span className="bp-risk-unit">
            {form.riskMode === "percentBalance" ? "% per trade" : "lot per trade"}
          </span>
        </div>
        <p className="bp-hint">
          {form.riskMode === "percentBalance"
            ? "Bij elke signal berekent CopyFactory automatisch je lot-grootte op basis van je balance + de SL-afstand."
            : "Elke trade wordt geopend met exact deze lot-grootte (geen schaling op je balance)."}
        </p>
      </div>

      {error && <div className="bp-error">{error}</div>}
      <button className="bp-submit" disabled={busy}>{busy ? "Koppelen…" : "Koppelen"}</button>
    </form>
  );
}

function AccountCard({ account, onUpdate, onRemove }) {
  const [enabledMarkets, setEnabledMarkets] = useState(account.enabledMarkets);
  const [riskMode,  setRiskMode]            = useState(account.riskMode);
  const [riskValue, setRiskValue]           = useState(account.riskValue);
  const [copyEnabled, setCopyEnabled]       = useState(account.copyEnabled);
  const [busy, setBusy] = useState(false);
  const dirty = (
    JSON.stringify([...enabledMarkets].sort()) !== JSON.stringify([...account.enabledMarkets].sort()) ||
    riskMode  !== account.riskMode ||
    Number(riskValue) !== Number(account.riskValue) ||
    copyEnabled !== account.copyEnabled
  );

  function toggle(m) {
    setEnabledMarkets(s => s.includes(m) ? s.filter(x => x !== m) : [...s, m]);
  }

  async function save() {
    setBusy(true);
    await onUpdate(account.id, { enabledMarkets, riskMode, riskValue, copyEnabled });
    setBusy(false);
  }
  async function remove() {
    if (!confirm("Account loskoppelen? Trades stoppen direct.")) return;
    setBusy(true);
    await onRemove(account.id);
    setBusy(false);
  }

  return (
    <div className="bp-card">
      <div className="bp-card-head">
        <div>
          <div className="bp-card-title">{account.broker || account.server}</div>
          <div className="bp-card-sub">
            {account.platform.toUpperCase()} · login {account.login} · {account.server}
          </div>
        </div>
        <StatusPill status={account.status} connection={account.connectionStatus} />
      </div>

      {(account.balance != null || account.equity != null) && (
        <div className="bp-stats">
          <div><span>Balance</span><strong>{account.balance?.toFixed(2) ?? "—"}</strong></div>
          <div><span>Equity</span><strong>{account.equity?.toFixed(2) ?? "—"}</strong></div>
        </div>
      )}

      <label className="bp-toggle">
        <input type="checkbox" checked={copyEnabled} onChange={e => setCopyEnabled(e.target.checked)} />
        <span>Copy-trading actief</span>
      </label>

      <div className="bp-section">
        <h4>Markten</h4>
        <div className="bp-markets">
          {ALL_MARKETS.map(m => (
            <label key={m} className={`bp-chip ${enabledMarkets.includes(m) ? "on" : ""}`}>
              <input type="checkbox" checked={enabledMarkets.includes(m)} onChange={() => toggle(m)} />
              {MARKET_LABELS[m]}
            </label>
          ))}
        </div>
      </div>

      <div className="bp-section">
        <h4>Risk</h4>
        <div className="bp-risk">
          <label>
            <input type="radio" name={`risk-${account.id}`} checked={riskMode === "percentBalance"}
              onChange={() => setRiskMode("percentBalance")} />
            % van balance
          </label>
          <label>
            <input type="radio" name={`risk-${account.id}`} checked={riskMode === "fixedLot"}
              onChange={() => setRiskMode("fixedLot")} />
            Vaste lot
          </label>
          <input
            type="text" inputMode="decimal" pattern="[0-9]*[.,]?[0-9]*"
            value={String(riskValue ?? "")}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9.,]/g, "").replace(",", ".");
              setRiskValue(raw);
            }} />
          <span className="bp-risk-unit">{riskMode === "percentBalance" ? "%" : "lot"}</span>
        </div>
      </div>

      <div className="bp-card-actions">
        <button disabled={!dirty || busy} onClick={save} className="bp-btn">
          {busy ? "Opslaan…" : "Wijzigingen opslaan"}
        </button>
        <button disabled={busy} onClick={remove} className="bp-btn bp-btn-danger">Loskoppelen</button>
      </div>
    </div>
  );
}

export default function BrokerPage() {
  const { user, authFetch } = useAuth();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading]   = useState(true);
  // Tier check — broker-koppeling is enkel voor Auto-Trade. Signal users zien
  // upgrade-prompt; admin altijd toegang. Loaded via /api/billing/me.
  const [tierInfo, setTierInfo] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, accRes] = await Promise.all([
        authFetch("/api/billing/me").then(r => r.json()),
        authFetch(`${API}/broker/accounts`).then(r => r.json()),
      ]);
      if (meRes.ok) setTierInfo(meRes);
      if (accRes.ok) setAccounts(accRes.accounts);
    } finally { setLoading(false); }
  }, [authFetch]);

  useEffect(() => { load(); }, [load]);

  const isAdmin    = !!user?.isAdmin;
  const tier       = tierInfo?.tier ?? "free";
  const isSignal   = tier === "signal";
  const isFree     = tier === "free";
  const canConnect = isAdmin || tier === "auto-trade";

  // Show upgrade-screen for free + signal users (broker-koppeling = Auto-Trade only)
  if (!loading && !canConnect) {
    return (
      <div className="bp-wrap">
        <header className="bp-top">
          <Link to="/dashboard" className="bp-back">← Dashboard</Link>
          <h1>Broker connection</h1>
        </header>
        <div className="broker-upgrade-card">
          <div className="broker-upgrade-icon">🔒</div>
          <h2>Broker connection requires Auto-Trade</h2>
          <p className="broker-upgrade-current">
            Your current plan: <strong>{isSignal ? "AI-Analyst (€39/mo)" : "Free"}</strong>
            {" — "}broker integration is only available on{" "}
            <strong>Hands-Off AI (€69/mo)</strong>.
          </p>
          <p className="broker-upgrade-explain">
            With Auto-Trade you connect your <strong>Liquid Markets MT5</strong> account once
            and the AI executes every signal automatically — including Stop-Loss, Take-Profit
            and break-even management. You stay in full control via the pause-button in dashboard.
          </p>
          <div className="broker-upgrade-features">
            <div>🤖 AI executes trades on your broker</div>
            <div>🛡️ Auto Stop-Loss + Take-Profit + BE-MOVE</div>
            <div>📊 Live performance dashboard</div>
            <div>🔌 Liquid Markets MT5 integration</div>
          </div>
          <Link to="/billing" className="broker-upgrade-btn">
            Upgrade to Hands-Off AI — €69/mo →
          </Link>
          <p className="broker-upgrade-note">
            Already have an account? Just upgrade your plan — your existing login stays the same.
          </p>
        </div>
      </div>
    );
  }

  async function update(id, patch) {
    const r = await authFetch(`${API}/broker/accounts/${id}`, {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(patch),
    });
    const j = await r.json();
    if (j.ok) setAccounts(s => s.map(a => a.id === id ? j.account : a));
    else alert(j.error || "Update mislukt");
  }
  async function remove(id) {
    const r = await authFetch(`${API}/broker/accounts/${id}`, { method: "DELETE" });
    const j = await r.json();
    if (j.ok) setAccounts(s => s.filter(a => a.id !== id));
    else alert(j.error || "Verwijderen mislukt");
  }

  return (
    <div className="bp-wrap">
      <header className="bp-top">
        <Link to="/dashboard" className="bp-back">← Dashboard</Link>
        <h1>Broker accounts</h1>
        <span className="bp-user">{user?.name}</span>
      </header>

      {/* Cost overview banner — visible at top so user knows what they're paying */}
      {!isAdmin && (
        <div className="bp-cost-overview">
          <div className="bp-cost-row">
            <span className="bp-cost-label">Connected accounts</span>
            <span className="bp-cost-value">{accounts.length}</span>
          </div>
          <div className="bp-cost-row">
            <span className="bp-cost-label">Current monthly</span>
            <span className="bp-cost-value">
              €{accounts.length === 0 ? 69 : 69 + Math.max(0, accounts.length - 1) * 19}
              <span className="bp-cost-breakdown">
                (€69 base{accounts.length > 1 ? ` + ${accounts.length - 1}× €19 extras` : ""})
              </span>
            </span>
          </div>
          <div className="bp-cost-help">
            💡 1st account is included in your €69 base subscription. Each additional broker
            account adds €19/mo (Stripe pro-rata billing).
          </div>
        </div>
      )}

      <ConnectForm
        onConnected={a => setAccounts(s => [a, ...s])}
        currentCount={accounts.length}
        isAdmin={isAdmin}
      />

      <h2 className="bp-hed">Gekoppelde accounts ({accounts.length})</h2>
      {loading && <div className="bp-loading">Laden…</div>}
      {!loading && accounts.length === 0 && (
        <div className="bp-empty">Nog geen accounts. Koppel er een hierboven.</div>
      )}
      <div className="bp-grid-cards">
        {accounts.map(a => (
          <AccountCard key={a.id} account={a} onUpdate={update} onRemove={remove} />
        ))}
      </div>

      <p className="bp-disclaimer">
        Trades worden via CopyFactory automatisch op je broker-account geplaatst zodra de
        AI-engine een signal genereert. Risk-instellingen kunnen op elk moment aangepast worden.
        Alleen voor demo-/oefenaccounts is geadviseerd tot je de werking hebt geverifieerd.
      </p>
    </div>
  );
}
