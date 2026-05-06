import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./ProfilePage.css";

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("nl-NL", { day: "2-digit", month: "long", year: "numeric" });
}
function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("nl-NL", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtRelTime(d) {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60_000) return "zojuist";
  const m = Math.floor(diff / 60_000); if (m < 60) return `${m}m geleden`;
  const h = Math.floor(m / 60);        if (h < 24) return `${h}u geleden`;
  const dd = Math.floor(h / 24);       return `${dd}d geleden`;
}
function fmtPrice(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 }).format(n);
}

export default function ProfilePage() {
  const { authFetch, user } = useAuth();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [busy,    setBusy]    = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/profile").then(r => r.json());
      if (!r.ok) throw new Error(r.error || "Profiel laden mislukt");
      setProfile(r);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [authFetch]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleUpgrade = async (chosenTier = "auto-trade") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await authFetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: chosenTier }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "Checkout mislukt");
      window.location.href = r.url;
    } catch (e) { setError(e.message); setBusy(false); }
  };

  if (loading) return <div className="pp-wrap"><div className="pp-loading">Laden…</div></div>;
  if (error || !profile) return <div className="pp-wrap"><div className="pp-error">⚠ {error || "Geen data"}</div></div>;

  const { user: userData, subscription, weekly, signalAccess, invoices, accounts, pricing } = profile;
  const isFree   = subscription.tier === "free";
  const isSignal = subscription.tier === "signal";
  const isAuto   = subscription.tier === "auto-trade";
  const isPaid   = isSignal || isAuto;
  const tierLabel = isAuto ? "Auto-Trade"
                  : isSignal ? "AI-Analyst"
                  : "Free";
  const tierColor = isAuto ? "#4ade80"
                  : isSignal ? "#60a5fa"
                  : "#9ca3af";

  // Determine signal access state for UI
  const accessState = signalAccess.mode;  // "full" | "free-weekly" | "locked-weekly"
  const isLockedByPay = signalAccess.locked;

  return (
    <div className="pp-wrap">
      <header className="pp-header">
        <Link to="/dashboard" className="pp-back">← Dashboard</Link>
        <h1>Mijn Profiel</h1>
      </header>

      {/* ── User identity ── */}
      <section className="pp-card pp-user-card">
        <div className="pp-avatar">{userData.name?.[0]?.toUpperCase() ?? "?"}</div>
        <div className="pp-user-info">
          <div className="pp-user-name">
            {userData.name}
            {userData.isAdmin && <span className="pp-admin-badge">⭐ ADMIN</span>}
          </div>
          <div className="pp-user-email">{userData.email}</div>
          <div className="pp-user-meta">
            Lid sinds {fmtDate(userData.memberSince)} · laatst ingelogd {fmtRelTime(userData.lastLogin)}
          </div>
        </div>
      </section>

      {/* ── Locked-by-payment notice (top-priority) ── */}
      {isLockedByPay && (
        <section className="pp-card pp-locked-card">
          <div className="pp-lock-title">🔒 Account vergrendeld</div>
          <div className="pp-lock-body">
            Je hebt {invoices.open} openstaande factu{invoices.open === 1 ? "ur" : "ren"}.
            Betaal om Auto-Trade weer te activeren.
          </div>
          <Link to="/billing" className="pp-btn pp-btn-pay">Bekijk facturen →</Link>
        </section>
      )}

      {/* ── Subscription card ── */}
      <section className="pp-card">
        <h2 className="pp-section-title">Abonnement</h2>
        <div className="pp-sub-grid">
          <div className="pp-sub-cell">
            <div className="pp-sub-label">Plan</div>
            <div className={`pp-sub-tier pp-sub-tier-${subscription.tier}`} style={{ color: tierColor }}>
              {tierLabel}
            </div>
          </div>
          <div className="pp-sub-cell">
            <div className="pp-sub-label">Status</div>
            <div className="pp-sub-status">
              {subscription.status === "active"   ? <span style={{ color: "#4ade80" }}>● Actief</span>
              : subscription.status === "trialing" ? <span style={{ color: "#60a5fa" }}>● Proefperiode</span>
              : subscription.status === "past_due" ? <span style={{ color: "#f87171" }}>● Achterstallig</span>
              : subscription.status === "canceled" ? <span style={{ color: "#9ca3af" }}>● Geannuleerd</span>
              : <span style={{ color: "#9ca3af" }}>—</span>}
            </div>
          </div>
          {isPaid && (
            <div className="pp-sub-cell">
              <div className="pp-sub-label">{subscription.status === "trialing" ? "Gratis tot" : "Verlengt op"}</div>
              <div className="pp-sub-value">{fmtDate(subscription.currentPeriodEnd)}</div>
            </div>
          )}
          {isAuto && accounts && (
            <div className="pp-sub-cell">
              <div className="pp-sub-label">Broker accounts</div>
              <div className="pp-sub-value">
                {accounts.total} gekoppeld
                {accounts.addOnCount > 0 && (
                  <span className="pp-sub-extras"> ({accounts.addOnCount}× €19 add-on)</span>
                )}
              </div>
            </div>
          )}
          {isPaid && pricing && pricing.monthlyCents > 0 && (
            <div className="pp-sub-cell">
              <div className="pp-sub-label">Maandbedrag</div>
              <div className="pp-sub-value pp-price-total">€{(pricing.monthlyCents/100).toFixed(2)}</div>
              {pricing.extrasCents > 0 && (
                <div className="pp-sub-breakdown">
                  €{(pricing.baseCents/100).toFixed(0)} base + €{(pricing.extrasCents/100).toFixed(0)} extras
                </div>
              )}
            </div>
          )}
        </div>
        <div className="pp-sub-actions">
          {isFree && !userData.isAdmin && (
            <Link to="/billing" className="pp-btn pp-btn-primary">
              Bekijk plannen & upgrade →
            </Link>
          )}
          {isSignal && !userData.isAdmin && (
            <Link to="/billing" className="pp-btn pp-btn-primary">
              Upgrade to Auto-Trade — €69/mo →
            </Link>
          )}
          {(isPaid) && (
            <Link to="/billing" className="pp-btn pp-btn-secondary">Beheer abonnement</Link>
          )}
        </div>
      </section>

      {/* ── Weekly free-tier status ── */}
      {weekly && (
        <section className="pp-card pp-weekly-card">
          <h2 className="pp-section-title">📅 Gratis week-signaal</h2>
          {weekly.exhausted ? (
            <>
              <div className="pp-weekly-banner pp-weekly-done">
                <div className="pp-weekly-emoji">🎯</div>
                <div className="pp-weekly-text">
                  <strong>Gratis signaal van deze week is geleverd</strong>
                  <div className="pp-weekly-sub">
                    Reset op <strong>{fmtDate(weekly.nextResetAt)}</strong> (volgende maandag)
                  </div>
                </div>
              </div>
              {weekly.firstWin && (
                <div className="pp-trade-recap">
                  <div className="pp-trade-head">Het winnende signaal:</div>
                  <div className="pp-trade-grid">
                    <div className="pp-trade-cell">
                      <div className="pp-trade-label">Markt</div>
                      <div className="pp-trade-val">{weekly.firstWin.market}</div>
                    </div>
                    <div className="pp-trade-cell">
                      <div className="pp-trade-label">Richting</div>
                      <div className={`pp-trade-val pp-dir-${weekly.firstWin.direction?.toLowerCase()}`}>
                        {weekly.firstWin.direction === "BUY" ? "▲ BUY" : "▼ SELL"}
                      </div>
                    </div>
                    <div className="pp-trade-cell">
                      <div className="pp-trade-label">Entry</div>
                      <div className="pp-trade-val">{fmtPrice(weekly.firstWin.entry)}</div>
                    </div>
                    <div className="pp-trade-cell">
                      <div className="pp-trade-label">TP2 hit</div>
                      <div className="pp-trade-val pp-trade-tp2">{fmtPrice(weekly.firstWin.tp2)} ✓</div>
                    </div>
                  </div>
                  <div className="pp-trade-time">
                    Entry @ {weekly.firstWin.entryTime} · TF {weekly.firstWin.tf}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="pp-weekly-banner pp-weekly-active">
              <div className="pp-weekly-emoji">🟢</div>
              <div className="pp-weekly-text">
                <strong>Je gratis week-signaal is nog beschikbaar</strong>
                <div className="pp-weekly-sub">
                  Je ziet alle live signalen tot het eerste TP2 van deze week wordt gehit.
                  Daarna lock tot {fmtDate(weekly.nextResetAt)}.
                </div>
              </div>
            </div>
          )}

          {/* DUIDELIJKE upgrade-vergelijking — altijd zichtbaar zodat het verschil
              tussen Signal Viewer (€39) en Auto-Trade (€69) glashelder is. */}
          <div className="pp-upgrade-compare">
            <div className="pp-upgrade-head">Wil je meer signalen?</div>
            <div className="pp-upgrade-explain">
              Bij beide plannen krijg je <strong>onbeperkt live signalen</strong> — alle markten, alle TFs (6H / 90M / Daily),
              direct via dashboard én Discord. Het verschil zit in <strong>WIE de trade uitvoert</strong>:
            </div>
            <div className="pp-upgrade-grid">
              <div className="pp-upgrade-tile pp-upgrade-signal">
                <div className="pp-upgrade-label">Signal Viewer</div>
                <div className="pp-upgrade-price">€39<span>/mnd</span></div>
                <div className="pp-upgrade-tag-line">Voor wie ZELF wil traden</div>
                <ul className="pp-upgrade-feats">
                  <li>✅ <strong>Onbeperkt</strong> live signals</li>
                  <li>✅ Discord notificaties</li>
                  <li>✅ Alle TFs + alle markten</li>
                  <li>👤 <strong>JIJ</strong> opent zelf de trade op je broker</li>
                  <li className="pp-upgrade-no">❌ Geen automatische uitvoering</li>
                  <li className="pp-upgrade-no">❌ Geen broker-koppeling</li>
                </ul>
                <div className="pp-upgrade-best">
                  💡 Best voor: ervaren traders die controle willen over entry-timing en lot-size.
                </div>
                <button className="pp-btn pp-btn-secondary pp-btn-big" onClick={() => handleUpgrade("signal")} disabled={busy}>
                  {busy ? "…" : "Kies Signal Viewer →"}
                </button>
              </div>
              <div className="pp-upgrade-tile pp-upgrade-auto">
                <div className="pp-upgrade-tag">⭐ POPULAIR</div>
                <div className="pp-upgrade-label">Auto-Trade</div>
                <div className="pp-upgrade-price">€69<span>/mnd</span></div>
                <div className="pp-upgrade-tag-line">Voor wie HANDS-OFF wil verdienen</div>
                <ul className="pp-upgrade-feats">
                  <li>✅ Alles van Signal Viewer</li>
                  <li>🤖 <strong>AI opent trade automatisch</strong> op jouw broker</li>
                  <li>🛡️ Auto Stop-Loss + Take-Profit beheer</li>
                  <li>🚀 BE-MOVE: SL naar break-even na TP2 (geen verlies meer mogelijk)</li>
                  <li>📊 Performance dashboard met balance grafiek</li>
                  <li>🔌 Liquid Markets MT5 koppeling (verplichte broker)</li>
                  <li className="pp-upgrade-perf">+ 10% performance fee op winst (high-water mark)</li>
                </ul>
                <div className="pp-upgrade-best">
                  💡 Best voor: passieve traders, drukke schedule, of beginners die de strategie willen leren door uitvoering te zien.
                </div>
                <button className="pp-btn pp-btn-primary pp-btn-big" onClick={() => handleUpgrade("auto-trade")} disabled={busy}>
                  {busy ? "…" : "Kies Auto-Trade →"}
                </button>
              </div>
            </div>
            <div className="pp-upgrade-faq">
              <details>
                <summary>Wat is "Auto-Trade" precies?</summary>
                <p>
                  Je koppelt eenmalig je Liquid Markets MT5 broker-account via een veilig formulier (jouw login wordt direct
                  doorgestuurd naar MetaApi, wij slaan 'm niet op). Vanaf dat moment opent ons systeem automatisch <strong>elke
                  setup-trade</strong> zodra die zijn entry-window haalt. Stop-Loss + Take-Profit worden meegestuurd naar de broker.
                  Bij TP2-hit wordt de Stop-Loss automatisch verschoven naar break-even — vanaf dat punt kan je geen verlies meer
                  maken op die trade. De runner blijft lopen tot TP3 of SL@BE.
                </p>
                <p>
                  Je hebt <strong>volledige controle</strong>: pauzeer-knop in het dashboard om alle trades onmiddellijk te
                  stoppen, opzeggen wanneer je wil, en je kan altijd zelf handmatig sluiten in MetaTrader.
                </p>
              </details>
              <details>
                <summary>Wat is de 10% performance fee?</summary>
                <p>
                  Alleen op Auto-Trade. <strong>10% van je netto-winst per maand</strong>, gefactureerd op de 1e van de volgende
                  maand. Met <strong>high-water mark</strong>: je betaalt alleen op nieuwe hoogtepunten, nooit dubbel op recovery.
                  Voorbeeld: jan +€2000 winst → fee €200 (HWM=jan-eind). Feb -€500 → géén fee, HWM blijft. Mrt +€800 →
                  fee alleen op het stuk dat boven HWM uitkomt.
                </p>
              </details>
              <details>
                <summary>Wat als ik wil upgraden of downgraden?</summary>
                <p>
                  Op /billing kan je je abonnement op elk moment opzeggen (geen lock-in) of switchen tussen Signal Viewer (€39)
                  en Auto-Trade (€69). Pro-rata berekening via Stripe.
                </p>
              </details>
            </div>
          </div>
        </section>
      )}

      {/* ── Signal access status (samenvattend) ── */}
      <section className="pp-card pp-access-card">
        <h2 className="pp-section-title">Signaal-toegang</h2>
        <div className={`pp-access-banner pp-access-${accessState}`}>
          {accessState === "full" && (
            <>
              <span className="pp-access-icon">🟢</span>
              <div>
                <strong>Volledige toegang</strong>
                <div>Alle signalen real-time, alle TFs, alle markten.</div>
              </div>
            </>
          )}
          {accessState === "free-weekly" && (
            <>
              <span className="pp-access-icon">🟢</span>
              <div>
                <strong>Gratis week — actief</strong>
                <div>Live signalen tot eerste TP2 van de week.</div>
              </div>
            </>
          )}
          {accessState === "locked-weekly" && (
            <>
              <span className="pp-access-icon">🔒</span>
              <div>
                <strong>Week voorbij — geen signalen tot {fmtDate(weekly.nextResetAt)}</strong>
                <div>Upgrade naar Auto-Trade voor onbeperkte real-time toegang.</div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── Quick links ── */}
      <section className="pp-card pp-links-card">
        <h2 className="pp-section-title">Snelle acties</h2>
        <div className="pp-links">
          <Link to="/billing" className="pp-link-tile">
            <div className="pp-link-icon">💳</div>
            <div className="pp-link-name">Facturen & abonnement</div>
            {invoices.open > 0 && <div className="pp-link-badge">{invoices.open} open</div>}
          </Link>
          <Link to="/broker" className="pp-link-tile">
            <div className="pp-link-icon">🔌</div>
            <div className="pp-link-name">Broker koppeling</div>
          </Link>
          <Link to="/journal" className="pp-link-tile">
            <div className="pp-link-icon">📓</div>
            <div className="pp-link-name">Trade journal</div>
          </Link>
          {userData.isAdmin && (
            <Link to="/admin" className="pp-link-tile">
              <div className="pp-link-icon">⚙️</div>
              <div className="pp-link-name">Admin panel</div>
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
