import React from "react";
import { useNavigate } from "react-router-dom";
import "./HomePage.css";

const FEATURES = [
  {
    icon: "⟳",
    title: "90-Min Cycle Engine",
    desc: "Automatische detectie van continuation setups op basis van 90-minuten cycli met Break of Structure bevestiging.",
  },
  {
    icon: "💎",
    title: "Matrix Unlocked",
    desc: "De sterkste setup: 90-min continuation gecombineerd met 6-uurs cycle alignment. Dubbele bevestiging, maximale kans.",
  },
  {
    icon: "📊",
    title: "5 Markten",
    desc: "NAS100, S&P 500, Dow Jones, Gold (XAU/USD) en GBP/USD — allemaal live gemonitord door de AI scanner.",
  },
  {
    icon: "🤖",
    title: "AI Trading Mentor",
    desc: "Stel vragen over actieve setups en krijg direct context-bewust advies gebaseerd op de live marktdata.",
  },
  {
    icon: "👑",
    title: "Golden Cycle C3",
    desc: "C3 (06:00–12:00 ET) is de meest winstgevende cyclus van de dag — London/NY overlap met het hoogste volume.",
  },
  {
    icon: "⚡",
    title: "Real-time Signalen",
    desc: "De monitor scant elke 15 minuten. Signalen worden direct bijgewerkt zodra een Break of Structure wordt bevestigd.",
  },
];

const MARKETS = [
  { key: "NAS100", label: "NAS100",  sub: "US Tech 100",   color: "#00d4ff" },
  { key: "US500",  label: "S&P 500", sub: "US500",         color: "#00e5a0" },
  { key: "US30",   label: "DOW",     sub: "US30",          color: "#b16ef8" },
  { key: "XAUUSD", label: "GOLD",    sub: "XAU/USD",       color: "#ffd700" },
  { key: "GBPUSD", label: "CABLE",   sub: "GBP/USD",       color: "#ff8c00" },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="home">
      {/* Nav */}
      <nav className="home-nav">
        <div className="home-nav-inner">
          <div className="home-brand">
            <div className="home-logo">
              <span className="home-logo-icon">◈</span>
            </div>
            <span className="home-brand-name">TradingVisualizer</span>
          </div>
          <div className="home-nav-actions">
            <button className="home-btn-ghost" onClick={() => navigate("/login")}>Inloggen</button>
            <button className="home-btn-primary" onClick={() => navigate("/register")}>Gratis starten</button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="home-hero">
        <div className="home-hero-inner">
          <div className="home-hero-badge">
            <span className="home-pulse" />
            AI Scanner actief — 5 markten live
          </div>
          <h1 className="home-hero-title">
            Professionele<br />
            <span className="home-hero-gradient">Trading Signalen</span>
          </h1>
          <p className="home-hero-sub">
            Automatische detectie van high-probability setups op basis van 90-minuten cyclus analyse.
            Matrix Unlocked, Break of Structure, Golden Cycle — alles op één plek.
          </p>
          <div className="home-hero-cta">
            <button className="home-btn-primary home-btn-lg" onClick={() => navigate("/register")}>
              Account aanmaken
            </button>
            <button className="home-btn-outline home-btn-lg" onClick={() => navigate("/login")}>
              Inloggen
            </button>
          </div>

          {/* Live market pills */}
          <div className="home-markets">
            {MARKETS.map(m => (
              <div key={m.key} className="home-market-pill" style={{ "--mcolor": m.color }}>
                <span className="home-market-dot" />
                <span className="home-market-key">{m.label}</span>
                <span className="home-market-sub">{m.sub}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Decorative grid lines */}
        <div className="home-hero-grid" aria-hidden="true" />
      </section>

      {/* Features */}
      <section className="home-features">
        <div className="home-section-inner">
          <h2 className="home-section-title">Alles wat je nodig hebt</h2>
          <p className="home-section-sub">
            Van automatische signaaldetectie tot live AI begeleiding — gebouwd voor serieuze traders.
          </p>
          <div className="home-feature-grid">
            {FEATURES.map((f, i) => (
              <div key={i} className="home-feature-card">
                <div className="home-feature-icon">{f.icon}</div>
                <h3 className="home-feature-title">{f.title}</h3>
                <p className="home-feature-desc">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA strip */}
      <section className="home-cta-strip">
        <div className="home-section-inner home-cta-inner">
          <div>
            <h2 className="home-cta-title">Klaar om te starten?</h2>
            <p className="home-cta-sub">Maak een gratis account aan en bekijk de live marktdata direct.</p>
          </div>
          <button className="home-btn-primary home-btn-lg" onClick={() => navigate("/register")}>
            Account aanmaken
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="home-footer">
        <span>© 2026 TradingVisualizer.com</span>
        <span className="home-footer-sep">·</span>
        <span>Alle data is puur informatief — geen beleggingsadvies</span>
      </footer>
    </div>
  );
}
