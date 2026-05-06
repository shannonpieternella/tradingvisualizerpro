import React, { useEffect, useState, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./BillingPage.css";

function fmtAmount(cents, currency = "EUR") {
  if (cents == null) return "—";
  return new Intl.NumberFormat("nl-NL", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("nl-NL", { day: "2-digit", month: "short", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("nl-NL", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const TIERS = {
  free: { label: "Gratis", color: "#9ca3af", desc: "1 winnend signaal per week (tot eerste TP2)" },
  signal: { label: "Signal Viewer", color: "#60a5fa", desc: "Onbeperkt real-time signals — manual trading" },
  "auto-trade": { label: "Auto-Trade", color: "#4ade80", desc: "Signals + autonomous trading via Liquid Markets" },
};

const STATUS_LABEL = {
  active:    { label: "Actief", color: "#4ade80" },
  trialing:  { label: "Proefperiode", color: "#60a5fa" },
  past_due:  { label: "Achterstallig", color: "#f87171" },
  canceled:  { label: "Geannuleerd", color: "#9ca3af" },
};

export default function BillingPage() {
  const { authFetch, user } = useAuth();
  const [params] = useSearchParams();
  const [me, setMe]               = useState(null);
  const [invoices, setInvoices]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [busy, setBusy]           = useState(false);
  const [bannerMsg, setBannerMsg] = useState(
    params.get("success") ? "✓ Abonnement geactiveerd. Welkom!" :
    params.get("canceled") ? "Checkout geannuleerd — geen wijzigingen." : null
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [meRes, invRes] = await Promise.all([
        authFetch("/api/billing/me").then(r => r.json()),
        authFetch("/api/billing/invoices").then(r => r.json()),
      ]);
      if (meRes.ok) setMe(meRes);
      if (invRes.ok) setInvoices(invRes.invoices ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSubscribe = async (chosenTier = "auto-trade") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ tier: chosenTier }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "Checkout mislukt");
      window.location.href = r.url;
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const handlePortal = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/billing/portal", { method: "POST" }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "Portal mislukt");
      window.location.href = r.url;
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  const handlePayInvoice = async (invoiceId) => {
    setError(null);
    try {
      const r = await authFetch(`/api/billing/pay-invoice/${invoiceId}`, { method: "POST" }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "Geen betalink beschikbaar");
      window.location.href = r.paymentLink;
    } catch (e) { setError(e.message); }
  };

  if (loading) return <div className="bp-wrap"><div className="bp-loading">Laden…</div></div>;

  const tier   = me?.tier ?? "free";
  const status = me?.status;
  const periodEnd = me?.currentPeriodEnd;
  const tierInfo   = TIERS[tier] ?? TIERS.free;
  const statusInfo = STATUS_LABEL[status];
  const openCount  = invoices.filter(i => i.status === "open").length;
  const isAdmin    = !!user?.isAdmin;

  return (
    <div className="bp-wrap">
      <header className="bp-header">
        <Link to="/dashboard" className="bp-back">← Dashboard</Link>
        <h1>Facturatie & Abonnement</h1>
      </header>

      {bannerMsg && <div className="bp-banner bp-banner-info">{bannerMsg}</div>}
      {error    && <div className="bp-banner bp-banner-error">⚠ {error}</div>}

      {/* ── Current tier card ── */}
      <section className="bp-card bp-tier-card">
        <div className="bp-tier-header">
          <div>
            <div className="bp-tier-label">Huidige tier</div>
            <div className="bp-tier-name" style={{ color: tierInfo.color }}>{tierInfo.label}</div>
            <div className="bp-tier-desc">{tierInfo.desc}</div>
          </div>
          {statusInfo && (
            <div className="bp-status-badge" style={{ background: `${statusInfo.color}22`, color: statusInfo.color, borderColor: `${statusInfo.color}55` }}>
              {statusInfo.label}
            </div>
          )}
        </div>

        {periodEnd && tier === "auto-trade" && (
          <div className="bp-tier-meta">
            {status === "trialing" ? "Gratis tot:" : "Lopende periode tot:"} <strong>{fmtDate(periodEnd)}</strong>
          </div>
        )}

        {me?.tradingLocked && (
          <div className="bp-locked-notice">
            🔒 <strong>Trading gepauzeerd</strong> — er zijn {openCount} openstaande factu{openCount === 1 ? "ur" : "ren"}.
            Betaal hieronder om Auto-Trade weer te activeren.
          </div>
        )}

        <div className="bp-actions">
          {tier === "free" && !isAdmin && (
            <>
              <button className="bp-btn bp-btn-secondary" onClick={() => handleSubscribe("signal")} disabled={busy}>
                Signal Viewer — €39/mnd
              </button>
              <button className="bp-btn bp-btn-primary" onClick={() => handleSubscribe("auto-trade")} disabled={busy}>
                {busy ? "…" : "Auto-Trade — €69/mnd"}
              </button>
            </>
          )}
          {tier === "signal" && !isAdmin && (
            <>
              <button className="bp-btn bp-btn-primary" onClick={() => handleSubscribe("auto-trade")} disabled={busy}>
                Upgrade naar Auto-Trade — €69/mnd
              </button>
              <button className="bp-btn bp-btn-secondary" onClick={handlePortal} disabled={busy}>
                Beheer abonnement
              </button>
            </>
          )}
          {tier === "auto-trade" && me?.status !== "trialing" && (
            <button className="bp-btn bp-btn-secondary" onClick={handlePortal} disabled={busy}>
              {busy ? "…" : "Beheer abonnement"}
            </button>
          )}
          {isAdmin && (
            <div className="bp-admin-note">⭐ Admin — alle services gratis, geen facturen.</div>
          )}
        </div>
      </section>

      {/* ── Invoices ── */}
      <section className="bp-card">
        <h2 className="bp-section-title">Facturen ({invoices.length})</h2>
        {invoices.length === 0 ? (
          <div className="bp-empty">Geen facturen — nog niets om te betalen.</div>
        ) : (
          <table className="bp-invoice-table">
            <thead>
              <tr>
                <th>Datum</th>
                <th>Type</th>
                <th>Periode</th>
                <th>Bedrag</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id} className={inv.status === "open" ? "bp-row-open" : ""}>
                  <td>{fmtDateTime(inv.createdAt)}</td>
                  <td>{inv.type === "performance_fee" ? "Performance fee (10%)" : "Abonnement"}</td>
                  <td>{inv.periodStart && inv.periodEnd ? `${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}` : "—"}</td>
                  <td><strong>{fmtAmount(inv.amount, inv.currency)}</strong></td>
                  <td>
                    <span className={`bp-inv-status bp-inv-status-${inv.status}`}>
                      {inv.status === "open" ? "Open" :
                       inv.status === "paid" ? "Betaald" :
                       inv.status === "uncollectible" ? "Onbetaalbaar" : inv.status}
                    </span>
                    {inv.paidAt && <div className="bp-paid-at">op {fmtDate(inv.paidAt)}</div>}
                  </td>
                  <td>
                    {inv.status === "open" && (
                      <button className="bp-btn bp-btn-pay" onClick={() => handlePayInvoice(inv.id)}>
                        Betaal nu
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Tier comparison (3 tiers side-by-side) ── */}
      {tier === "free" && !isAdmin && (
        <section className="bp-card bp-compare">
          <h2 className="bp-section-title">Plannen vergelijken</h2>
          <div className="bp-tier-grid">
            <div className="bp-tier-col">
              <div className="bp-tier-col-name">Gratis</div>
              <div className="bp-tier-col-price">€0</div>
              <ul className="bp-tier-feats">
                <li>1 winnend signaal/week</li>
                <li>Tot eerste TP2-hit</li>
                <li>Geen broker</li>
              </ul>
              <button className="bp-btn bp-btn-secondary" disabled>Huidig plan</button>
            </div>
            <div className="bp-tier-col bp-tier-col-recommended">
              <div className="bp-tier-badge">Populair</div>
              <div className="bp-tier-col-name">Signal Viewer</div>
              <div className="bp-tier-col-price">€39<span className="bp-tier-int">/mnd</span></div>
              <ul className="bp-tier-feats">
                <li>✓ Onbeperkt real-time signals</li>
                <li>✓ Alle TFs (6H / 90M / Daily)</li>
                <li>✓ Discord notifications</li>
                <li>✗ Geen autonomous trading</li>
              </ul>
              <button className="bp-btn bp-btn-primary" onClick={() => handleSubscribe("signal")} disabled={busy}>
                Start Signal Viewer
              </button>
            </div>
            <div className="bp-tier-col bp-tier-col-pro">
              <div className="bp-tier-col-name">Auto-Trade</div>
              <div className="bp-tier-col-price">€69<span className="bp-tier-int">/mnd</span></div>
              <ul className="bp-tier-feats">
                <li>✓ Alles van Signal Viewer</li>
                <li>✓ Autonomous broker execution</li>
                <li>✓ Auto SL/TP + BE-MOVE</li>
                <li>✓ Balance dashboard</li>
                <li className="bp-feat-perf">+ 10% performance fee (HWM)</li>
              </ul>
              <button className="bp-btn bp-btn-primary" onClick={() => handleSubscribe("auto-trade")} disabled={busy}>
                Start Auto-Trade
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
