import React, { useEffect, useState, useRef } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useT, LanguageSwitch } from "../contexts/LanguageContext.jsx";
import { useNavigate, Link } from "react-router-dom";
import "./Header.css";

function BillingBell() {
  const { authFetch } = useAuth();
  const t = useT();
  const [open, setOpen]         = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [me, setMe]             = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, invRes] = await Promise.all([
          authFetch("/api/billing/me").then(r => r.json()),
          authFetch("/api/billing/invoices").then(r => r.json()),
        ]);
        if (cancelled) return;
        if (meRes.ok)  setMe(meRes);
        if (invRes.ok) setInvoices((invRes.invoices ?? []).filter(i => i.status === "open"));
      } catch {}
    }
    load();
    const t = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [authFetch]);

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const count = invoices.length;
  return (
    <div className="bell-wrap" ref={ref}>
      <button className={`bell-btn ${count > 0 ? "bell-has-unread" : ""}`} onClick={() => setOpen(o => !o)} title={t("bell_title")}>
        🔔
        {count > 0 && <span className="bell-badge">{count}</span>}
      </button>
      {open && (
        <div className="bell-dropdown">
          <div className="bell-head">
            <span>{t("bell_title")}</span>
            <Link to="/billing" className="bell-all-link" onClick={() => setOpen(false)}>{t("bell_all_link")}</Link>
          </div>
          {me?.tradingLocked && (
            <div className="bell-locked">{t("bell_locked")}</div>
          )}
          {count === 0 ? (
            <div className="bell-empty">{t("bell_empty")}</div>
          ) : invoices.map(inv => (
            <div key={inv.id} className="bell-item">
              <div className="bell-item-title">
                {inv.type === "performance_fee" ? t("bell_perf_fee") : t("bell_subscription")}
              </div>
              <div className="bell-item-amount">
                {new Intl.NumberFormat("nl-NL", { style: "currency", currency: (inv.currency || "EUR").toUpperCase() }).format((inv.amount || 0)/100)}
              </div>
              {inv.paymentLink && (
                <a className="bell-item-pay" href={inv.paymentLink} target="_blank" rel="noopener noreferrer">
                  {t("bell_pay_now")}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Header({ onRefresh, refreshing }) {
  const { user, logout } = useAuth();
  const t = useT();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/");
  }

  return (
    <header className="header">
      <div className="header-brand">
        <div className="header-logo">
          <span className="logo-bull">◈</span>
        </div>
        <div className="header-title">
          <span className="brand-name">TradingVisualizer</span>
          <span className="brand-sub">AI Market Intelligence</span>
        </div>
      </div>

      <div className="header-center">
        <div className="header-badge">
          <span className="pulse-dot" />
          {t("header_live")}
        </div>
        <span className="header-instrument">{t("header_markets_sub")}</span>
      </div>

      <div className="header-actions">
        {user && (
          <Link to="/profile" className="header-profile-btn" title={t("header_profile")}>
            <span className="header-profile-avatar">{user.name?.[0]?.toUpperCase() ?? "?"}</span>
            <span className="header-profile-name">{user.name}</span>
          </Link>
        )}
        <LanguageSwitch />
        <BillingBell />
        <button
          className={`btn-refresh ${refreshing ? "refreshing" : ""}`}
          onClick={onRefresh}
          disabled={refreshing}
          title="Force refresh"
        >
          <span className="refresh-icon">⟳</span>
          {refreshing ? t("header_syncing") : t("header_refresh")}
        </button>
        <button className="btn-logout" onClick={handleLogout} title={t("header_logout")}>
          ⏻
        </button>
      </div>
    </header>
  );
}
