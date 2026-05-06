import React, { useState } from "react";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useT, LanguageSwitch } from "../contexts/LanguageContext.jsx";
import "./AuthPage.css";

export default function AuthPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { login }  = useAuth();
  const t = useT();
  const [params]  = useSearchParams();

  const isRegister = location.pathname === "/register";
  const [mode, setMode]       = useState(isRegister ? "register" : "login");
  const [form, setForm]       = useState({ name: "", email: "", password: "" });
  // Pre-select tier from URL ?tier= so homepage CTA "Hire je AI" lands user
  // directly into the right plan-flow (free → instant dashboard, paid → checkout).
  const initialTier = params.get("tier") === "signal" ? "signal"
                    : params.get("tier") === "auto-trade" ? "auto-trade"
                    : "free";
  const [tier, setTier]       = useState(initialTier);
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      // Derive a default name from email if user didn't fill it in (drop friction).
      const fallbackName = form.email.split("@")[0]?.replace(/[._-]/g, " ").replace(/\b\w/g, c => c.toUpperCase()) || "Trader";
      const body = mode === "login"
        ? { email: form.email, password: form.password }
        : { name: form.name?.trim() || fallbackName, email: form.email, password: form.password, tier };

      const res  = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error); return; }
      login(data.token, data.user);
      // If user picked Auto-Trade at registration → kick off Stripe Checkout
      // immediately. They land on /billing?success=1 after payment.
      if (data.requiresCheckout) {
        try {
          const co = await fetch("/api/billing/checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.token}` },
            body:    JSON.stringify({ tier: data.tier }),
          }).then(r => r.json());
          if (co.ok && co.url) { window.location.href = co.url; return; }
        } catch { /* fall through to dashboard */ }
      }
      navigate("/dashboard");
    } catch {
      setError(t("auth_err_network"));
    } finally {
      setLoading(false);
    }
  }

  function switchMode(m) {
    setMode(m);
    setError("");
    navigate(m === "login" ? "/login" : "/register", { replace: true });
  }

  return (
    <div className="auth-page">
      {/* Background grid */}
      <div className="auth-bg-grid" aria-hidden="true" />

      {/* Back to home */}
      <button className="auth-back" onClick={() => navigate("/")}>
        {t("auth_back")}
      </button>

      {/* Language switch top-right */}
      <div className="auth-lang-corner"><LanguageSwitch /></div>

      <div className="auth-card">
        {/* Logo */}
        <div className="auth-logo">
          <span className="auth-logo-icon">◈</span>
        </div>
        <h1 className="auth-title">
          {mode === "login"
            ? t("auth_login_title")
            : tier === "free" ? t("auth_reg_title_free")
            : tier === "signal" ? t("auth_reg_title_signal")
            : t("auth_reg_title_auto")}
        </h1>
        <p className="auth-sub">
          {mode === "login"
            ? t("auth_login_sub")
            : tier === "free" ? t("auth_reg_sub_free")
            : tier === "signal" ? t("auth_reg_sub_signal")
            : t("auth_reg_sub_auto")}
        </p>

        {/* Tab switch */}
        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === "login" ? "auth-tab-active" : ""}`}
            onClick={() => switchMode("login")}
          >
            {t("auth_tab_login")}
          </button>
          <button
            className={`auth-tab ${mode === "register" ? "auth-tab-active" : ""}`}
            onClick={() => switchMode("register")}
          >
            {t("auth_tab_register")}
          </button>
        </div>

        {/* Form */}
        <form className="auth-form" onSubmit={submit} noValidate>
          {mode === "register" && (
            <div className="auth-field">
              <label className="auth-label">{t("auth_label_name")} <span className="auth-optional">{t("auth_optional")}</span></label>
              <input
                className="auth-input"
                type="text"
                placeholder={t("auth_placeholder_name")}
                value={form.name}
                onChange={set("name")}
                autoComplete="name"
              />
            </div>
          )}

          <div className="auth-field">
            <label className="auth-label">{t("auth_label_email")}</label>
            <input
              className="auth-input"
              type="email"
              placeholder={t("auth_placeholder_email")}
              value={form.email}
              onChange={set("email")}
              required
              autoComplete="email"
            />
          </div>

          <div className="auth-field">
            <label className="auth-label">{t("auth_label_pwd")}</label>
            <input
              className="auth-input"
              type="password"
              placeholder={mode === "register" ? t("auth_placeholder_pwd_reg") : t("auth_placeholder_pwd_login")}
              value={form.password}
              onChange={set("password")}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>

          {/* Tier banner — show selector if free, confirmation if specific tier preset */}
          {mode === "register" && initialTier === "free" && (
            <div className="auth-tier-block">
              <label className="auth-label">{t("auth_choose_role")}</label>
              <div className="auth-tiers auth-tiers-3">
                <button
                  type="button"
                  className={`auth-tier ${tier === "free" ? "auth-tier-active" : ""}`}
                  onClick={() => setTier("free")}
                >
                  <div className="auth-tier-name">{t("auth_tier_free_name")}</div>
                  <div className="auth-tier-price">€0</div>
                  <div className="auth-tier-desc">{t("auth_tier_free_desc")}</div>
                </button>
                <button
                  type="button"
                  className={`auth-tier ${tier === "signal" ? "auth-tier-active" : ""}`}
                  onClick={() => setTier("signal")}
                >
                  <div className="auth-tier-name">{t("auth_tier_signal_name")}</div>
                  <div className="auth-tier-price">€39<span className="auth-tier-int">{t("tier_signal_period")}</span></div>
                  <div className="auth-tier-desc">{t("auth_tier_signal_desc")}</div>
                </button>
                <button
                  type="button"
                  className={`auth-tier ${tier === "auto-trade" ? "auth-tier-active" : ""}`}
                  onClick={() => setTier("auto-trade")}
                >
                  <div className="auth-tier-name">{t("auth_tier_auto_name")}</div>
                  <div className="auth-tier-price">€69<span className="auth-tier-int">{t("tier_auto_period")}</span></div>
                  <div className="auth-tier-desc">{t("auth_tier_auto_desc")}</div>
                </button>
              </div>
            </div>
          )}
          {mode === "register" && initialTier !== "free" && (
            <div className="auth-tier-confirm">
              <div className="auth-tier-confirm-icon">
                {initialTier === "signal" ? "📊" : "🤖"}
              </div>
              <div className="auth-tier-confirm-text">
                <strong>
                  {initialTier === "signal" ? t("auth_confirm_signal") : t("auth_confirm_auto")}
                </strong>
                <span>{t("auth_confirm_after")}</span>
              </div>
              <button type="button" className="auth-tier-switch" onClick={() => setTier("free")}>
                {t("auth_switch_free")}
              </button>
            </div>
          )}

          {error && (
            <div className="auth-error">
              <span>⚠</span> {error}
            </div>
          )}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading
              ? <span className="auth-spinner" />
              : mode === "login" ? t("auth_submit_login")
              : tier === "free" ? t("auth_submit_free")
              : tier === "signal" ? t("auth_submit_signal")
              : t("auth_submit_auto")}
          </button>
          {mode === "register" && (
            <p className="auth-trust">
              {tier === "free" ? t("auth_trust_free") : t("auth_trust_paid")}
            </p>
          )}
        </form>

        <p className="auth-switch">
          {mode === "login" ? t("auth_switch_to_register") : t("auth_switch_to_login")}
          {" "}
          <button
            className="auth-switch-link"
            onClick={() => switchMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? t("auth_link_register") : t("auth_link_login")}
          </button>
        </p>
      </div>
    </div>
  );
}
