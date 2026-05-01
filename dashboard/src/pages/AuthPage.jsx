import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./AuthPage.css";

export default function AuthPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { login }  = useAuth();

  const isRegister = location.pathname === "/register";
  const [mode, setMode]       = useState(isRegister ? "register" : "login");
  const [form, setForm]       = useState({ name: "", email: "", password: "" });
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login"
        ? { email: form.email, password: form.password }
        : { name: form.name, email: form.email, password: form.password };

      const res  = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) { setError(data.error); return; }
      login(data.token, data.user);
      navigate("/dashboard");
    } catch {
      setError("Netwerkfout, probeer opnieuw");
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
        ← TradingVisualizer
      </button>

      <div className="auth-card">
        {/* Logo */}
        <div className="auth-logo">
          <span className="auth-logo-icon">◈</span>
        </div>
        <h1 className="auth-title">
          {mode === "login" ? "Welkom terug" : "Account aanmaken"}
        </h1>
        <p className="auth-sub">
          {mode === "login"
            ? "Log in om live marktdata en signalen te bekijken"
            : "Gratis toegang tot alle markten en signalen"}
        </p>

        {/* Tab switch */}
        <div className="auth-tabs">
          <button
            className={`auth-tab ${mode === "login" ? "auth-tab-active" : ""}`}
            onClick={() => switchMode("login")}
          >
            Inloggen
          </button>
          <button
            className={`auth-tab ${mode === "register" ? "auth-tab-active" : ""}`}
            onClick={() => switchMode("register")}
          >
            Registreren
          </button>
        </div>

        {/* Form */}
        <form className="auth-form" onSubmit={submit} noValidate>
          {mode === "register" && (
            <div className="auth-field">
              <label className="auth-label">Naam</label>
              <input
                className="auth-input"
                type="text"
                placeholder="Jouw naam"
                value={form.name}
                onChange={set("name")}
                required
                autoComplete="name"
              />
            </div>
          )}

          <div className="auth-field">
            <label className="auth-label">E-mailadres</label>
            <input
              className="auth-input"
              type="email"
              placeholder="naam@email.com"
              value={form.email}
              onChange={set("email")}
              required
              autoComplete="email"
            />
          </div>

          <div className="auth-field">
            <label className="auth-label">Wachtwoord</label>
            <input
              className="auth-input"
              type="password"
              placeholder={mode === "register" ? "Minimaal 8 tekens" : "Jouw wachtwoord"}
              value={form.password}
              onChange={set("password")}
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </div>

          {error && (
            <div className="auth-error">
              <span>⚠</span> {error}
            </div>
          )}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading
              ? <span className="auth-spinner" />
              : mode === "login" ? "Inloggen" : "Account aanmaken"}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "login" ? "Nog geen account?" : "Al een account?"}
          {" "}
          <button
            className="auth-switch-link"
            onClick={() => switchMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login" ? "Registreren" : "Inloggen"}
          </button>
        </p>
      </div>
    </div>
  );
}
