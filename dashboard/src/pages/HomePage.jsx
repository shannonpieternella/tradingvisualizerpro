import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useT, LanguageSwitch } from "../contexts/LanguageContext.jsx";
import "./HomePage.css";

const MARKETS = [
  { key: "NAS100", label: "NAS100",  sub: "Tech 100",   color: "#00d4ff" },
  { key: "US500",  label: "S&P 500", sub: "US500",      color: "#00e5a8" },
  { key: "US30",   label: "DOW",     sub: "US30",       color: "#b66dff" },
  { key: "XAUUSD", label: "GOLD",    sub: "XAU/USD",    color: "#ffd166" },
  { key: "GBPUSD", label: "CABLE",   sub: "GBP/USD",    color: "#ff8c4a" },
  { key: "BTCUSD", label: "BTC",     sub: "Bitcoin",    color: "#f7931a" },
  { key: "ETHUSD", label: "ETH",     sub: "Ethereum",   color: "#627eea" },
];

function fmtRel(t) {
  if (!t) return "";
  const ms = Date.now() - new Date(t).getTime();
  const m = Math.floor(ms / 60_000); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);      if (h < 24) return `${h}u`;
  return `${Math.floor(h / 24)}d`;
}

export default function HomePage() {
  const navigate = useNavigate();
  const t = useT();
  const [stats, setStats] = useState({ winRate: 0, totalSetups: 0, wins: 0 });
  const [recentWins, setRecentWins] = useState([]);

  useEffect(() => {
    fetch("/api/public/stats")
      .then(r => r.json())
      .then(d => { if (d.ok) { setStats(d.stats); setRecentWins(d.recentWins ?? []); } })
      .catch(() => {});
  }, []);

  const goRegister = (tier = "free") => navigate(`/register?tier=${tier}`);

  return (
    <div className="home">
      {/* ─── NAV ─── */}
      <nav className="home-nav">
        <div className="home-nav-inner">
          <div className="home-brand">
            <div className="home-logo"><span className="home-logo-icon">◈</span></div>
            <span className="home-brand-name">TradingVisualizer</span>
          </div>
          <div className="home-nav-actions">
            <a href="#how" className="home-nav-link">{t("nav_how")}</a>
            <a href="#pricing" className="home-nav-link">{t("nav_pricing")}</a>
            <a href="#faq" className="home-nav-link">{t("nav_faq")}</a>
            <LanguageSwitch />
            <button className="home-btn-ghost" onClick={() => navigate("/login")}>{t("nav_login")}</button>
            <button className="home-btn-primary" onClick={() => goRegister("free")}>
              {t("nav_hire")}
            </button>
          </div>
        </div>
      </nav>

      {/* ─── HERO ─── */}
      <section className="home-hero">
        <div className="home-hero-orbs" aria-hidden="true">
          <span className="home-orb home-orb-1" />
          <span className="home-orb home-orb-2" />
          <span className="home-orb home-orb-3" />
        </div>

        <div className="home-hero-inner">
          <div className="home-hero-badge">
            <span className="home-pulse" />
            {t("hero_badge", { markets: MARKETS.length, accuracy: stats.winRate, setups: stats.totalSetups })}
          </div>

          <h1 className="home-hero-title">
            {t("hero_title_1")}<br />
            <span className="home-hero-gradient">{t("hero_title_2")}</span>
          </h1>

          <p className="home-hero-sub">
            {t("hero_sub", { markets: MARKETS.length })}
            <br />
            <strong>{t("hero_sub_close")}</strong>
          </p>

          <div className="home-hero-cta">
            <button className="home-btn-primary home-btn-xl" onClick={() => goRegister("free")}>
              {t("hero_cta_free")}
            </button>
            <button className="home-btn-outline home-btn-xl" onClick={() => goRegister("auto-trade")}>
              {t("hero_cta_auto")}
            </button>
          </div>

          <div className="home-trust-row">
            <span className="home-trust-item">{t("trust_30s")}</span>
            <span className="home-trust-dot" aria-hidden="true">·</span>
            <span className="home-trust-item">{t("trust_money")}</span>
            <span className="home-trust-dot" aria-hidden="true">·</span>
            <span className="home-trust-item">{t("trust_pause")}</span>
            <span className="home-trust-dot" aria-hidden="true">·</span>
            <span className="home-trust-item">{t("trust_cancel")}</span>
          </div>

          {recentWins.length > 0 && (
            <div className="home-live-ticker">
              <div className="home-ticker-label">
                <span className="home-pulse home-pulse-red" />
                {t("ticker_label")}
              </div>
              <div className="home-ticker-strip">
                {recentWins.concat(recentWins).slice(0, 14).map((w, i) => (
                  <div key={i} className="home-ticker-item">
                    <span className={`home-ticker-dir home-ticker-dir-${w.direction?.toLowerCase()}`}>
                      {w.direction === "BUY" ? "▲" : "▼"}
                    </span>
                    <strong>{w.market}</strong>
                    <span className="home-ticker-tf">{w.tf}</span>
                    <span className="home-ticker-result">
                      {w.outcome === "TP3" ? "TP3 🚀" : "TP2 ✓"}
                    </span>
                    <span className="home-ticker-time">{fmtRel(w.time)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

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
      </section>

      {/* ─── PROBLEM ─── */}
      <section className="home-section home-problems">
        <div className="home-section-inner">
          <div className="home-section-head">
            <div className="home-section-tag home-tag-red">{t("problem_tag")}</div>
            <h2 className="home-section-title">
              {t("problem_title_1")} <span className="home-text-soft">{t("problem_title_2")}</span><br />
              <span className="home-hero-gradient">{t("problem_title_3")}</span>
            </h2>
            <p className="home-section-sub">{t("problem_sub")}</p>
          </div>
          <div className="home-problem-grid">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="home-problem-card">
                <div className="home-problem-emoji">
                  {i === 1 ? "⏱️" : i === 2 ? "🧠" : i === 3 ? "😬" : "💸"}
                </div>
                <h3>{t(`problem_${i}_title`)}</h3>
                <p>{t(`problem_${i}_desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── SOLUTION / STATS ─── */}
      <section className="home-section home-solution">
        <div className="home-section-inner">
          <div className="home-section-head">
            <div className="home-section-tag home-tag-green">{t("solution_tag")}</div>
            <h2 className="home-section-title">
              {t("solution_title_1")} <span className="home-hero-gradient">{t("solution_title_2")}</span>
            </h2>
            <p className="home-section-sub">
              {t("solution_sub_1")}
              <br /><br />
              <strong style={{ color: "var(--hp-text)" }}>{t("solution_sub_2")}</strong>
            </p>
          </div>

          <div className="home-stats-row">
            <div className="home-stat-big">
              <div className="home-stat-num">{MARKETS.length}</div>
              <div className="home-stat-label">{t("stat_markets")}</div>
            </div>
            <div className="home-stat-big">
              <div className="home-stat-num">{stats.winRate}%</div>
              <div className="home-stat-label">{t("stat_accuracy")}</div>
            </div>
            <div className="home-stat-big">
              <div className="home-stat-num">{stats.totalSetups}</div>
              <div className="home-stat-label">{t("stat_setups")}</div>
            </div>
            <div className="home-stat-big">
              <div className="home-stat-num">10R</div>
              <div className="home-stat-label">{t("stat_runner")}</div>
            </div>
            <div className="home-stat-big">
              <div className="home-stat-num">∞</div>
              <div className="home-stat-label">{t("stat_uptime")}</div>
            </div>
          </div>

          <div className="home-solution-callout">
            <span className="home-callout-icon">🤯</span>
            <p>{t("solution_markets_callout", { markets: MARKETS.length })}</p>
          </div>

          <p className="home-disclaimer">{t("disclaimer")}</p>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─── */}
      <section id="how" className="home-section home-how">
        <div className="home-section-inner">
          <div className="home-section-head">
            <div className="home-section-tag">{t("how_tag")}</div>
            <h2 className="home-section-title">
              {t("how_title_1")}<br />
              <span className="home-hero-gradient">{t("how_title_2")}</span>
            </h2>
          </div>
          <div className="home-how-grid">
            {[1, 2, 3].map(i => (
              <div key={i} className="home-how-step">
                <div className="home-how-num">{`0${i}`}</div>
                <div className="home-how-icon">
                  {i === 1 ? "🚀" : i === 2 ? "🎯" : "⚡"}
                </div>
                <h3>{t(`how_${i}_title`)}</h3>
                <p>{t(`how_${i}_desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── PRICING ─── */}
      <section id="pricing" className="home-section home-pricing">
        <div className="home-section-inner">
          <div className="home-section-head">
            <div className="home-section-tag">{t("pricing_tag")}</div>
            <h2 className="home-section-title">
              {t("pricing_title_1")} <span className="home-hero-gradient">{t("pricing_title_2")}</span>
            </h2>
            <p className="home-section-sub">{t("pricing_sub")}</p>
          </div>

          <div className="home-pricing-grid">
            {/* FREE */}
            <div className="home-tier home-tier-free">
              <div className="home-tier-name">{t("tier_free_name")}</div>
              <div className="home-tier-price">€0<span>{t("tier_free_period")}</span></div>
              <div className="home-tier-tag">{t("tier_free_tag")}</div>
              <ul className="home-tier-list">
                <li>{t("tier_free_1")}</li>
                <li>{t("tier_free_2")}</li>
                <li>{t("tier_free_3")}</li>
                <li>{t("tier_free_4")}</li>
                <li className="home-tier-no">{t("tier_free_no1")}</li>
                <li className="home-tier-no">{t("tier_free_no2")}</li>
              </ul>
              <button className="home-tier-btn home-btn-outline" onClick={() => goRegister("free")}>
                {t("tier_free_btn")}
              </button>
              <div className="home-tier-foot">{t("tier_free_foot")}</div>
            </div>

            {/* SIGNAL */}
            <div className="home-tier home-tier-signal">
              <div className="home-tier-name">{t("tier_signal_name")}</div>
              <div className="home-tier-price">€39<span>{t("tier_signal_period")}</span></div>
              <div className="home-tier-tag">{t("tier_signal_tag")}</div>
              <ul className="home-tier-list">
                <li>{t("tier_signal_1")}</li>
                <li>{t("tier_signal_2")}</li>
                <li>{t("tier_signal_3")}</li>
                <li>{t("tier_signal_4")}</li>
                <li>{t("tier_signal_5")}</li>
                <li className="home-tier-no">{t("tier_signal_no1")}</li>
              </ul>
              <button className="home-tier-btn home-btn-outline" onClick={() => goRegister("signal")}>
                {t("tier_signal_btn")}
              </button>
              <div className="home-tier-foot">{t("tier_signal_foot")}</div>
            </div>

            {/* AUTO-TRADE */}
            <div className="home-tier home-tier-auto">
              <div className="home-tier-badge">{t("tier_auto_badge")}</div>
              <div className="home-tier-name">{t("tier_auto_name")}</div>
              <div className="home-tier-price">€69<span>{t("tier_auto_period")}</span></div>
              <div className="home-tier-tag">{t("tier_auto_tag")}</div>
              <ul className="home-tier-list">
                <li>{t("tier_auto_1")}</li>
                <li>{t("tier_auto_2")}</li>
                <li>{t("tier_auto_3")}</li>
                <li>{t("tier_auto_4")}</li>
                <li>{t("tier_auto_5")}</li>
                <li>{t("tier_auto_6")}</li>
                <li className="home-tier-perf">{t("tier_auto_perf")}</li>
              </ul>
              <button className="home-tier-btn home-btn-primary" onClick={() => goRegister("auto-trade")}>
                {t("tier_auto_btn")}
              </button>
              <div className="home-tier-foot">{t("tier_auto_foot")}</div>
            </div>
          </div>

          <p className="home-pricing-note">{t("pricing_note")}</p>
        </div>
      </section>

      {/* ─── SECURITY ─── */}
      <section className="home-section home-value">
        <div className="home-section-inner home-value-inner">
          <div className="home-value-text">
            <div className="home-section-tag home-tag-green">{t("sec_tag")}</div>
            <h2>
              {t("sec_title_1")}<br />
              <span className="home-hero-gradient">{t("sec_title_2")}</span><br />
              <span className="home-text-soft">{t("sec_title_3")}</span>
            </h2>
            <p>{t("sec_para")}</p>
            <ul className="home-value-list">
              <li>{t("sec_li_1")}</li>
              <li>{t("sec_li_2")}</li>
              <li>{t("sec_li_3")}</li>
              <li>{t("sec_li_4")}</li>
              <li>{t("sec_li_5")}</li>
            </ul>
          </div>
          <div className="home-value-art">
            <div className="home-value-shield">🛡️</div>
            <div className="home-value-shield-glow" aria-hidden="true" />
            <div className="home-value-tags">
              <span>MetaApi · Cloud G2 London</span>
              <span>Liquid Markets MT5</span>
              <span>Stripe Subscriptions</span>
              <span>Let's Encrypt SSL</span>
              <span>{t("sec_tag_saas")}</span>
            </div>
          </div>
        </div>
      </section>

      {/* ─── FAQ ─── */}
      <section id="faq" className="home-section home-faq">
        <div className="home-section-inner">
          <div className="home-section-head">
            <div className="home-section-tag">{t("faq_tag")}</div>
            <h2 className="home-section-title">
              {t("faq_title_1")} <span className="home-hero-gradient">{t("faq_title_2")}</span>
            </h2>
          </div>
          <div className="home-faq-list">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => (
              <details key={i} className="home-faq-item">
                <summary>{t(`faq_${i}_q`)}</summary>
                <p>{t(`faq_${i}_a`)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ─── FINAL CTA ─── */}
      <section className="home-section home-final-cta">
        <div className="home-section-inner home-final-inner">
          <div className="home-final-emoji">🤖</div>
          <h2>
            {t("final_title_1")}<br />
            <span className="home-hero-gradient">{t("final_title_2")}</span>
          </h2>
          <p>{t("final_sub")}</p>
          <div className="home-final-cta-row">
            <button className="home-btn-primary home-btn-xl" onClick={() => goRegister("free")}>
              {t("final_cta_free")}
            </button>
            <button className="home-btn-outline home-btn-xl" onClick={() => goRegister("auto-trade")}>
              {t("final_cta_auto")}
            </button>
          </div>
          <div className="home-final-trust">{t("final_trust")}</div>
        </div>
      </section>

      {/* ─── FOOTER ─── */}
      <footer className="home-footer">
        <div className="home-footer-inner">
          <div className="home-footer-brand">
            <div className="home-brand">
              <div className="home-logo"><span className="home-logo-icon">◈</span></div>
              <span className="home-brand-name">TradingVisualizer</span>
            </div>
            <p className="home-footer-tag">{t("footer_tag")}</p>
          </div>
          <div className="home-footer-links">
            <a href="#pricing">{t("nav_pricing")}</a>
            <a href="#how">{t("nav_how")}</a>
            <a href="#faq">{t("nav_faq")}</a>
            <a href="/login">{t("nav_login")}</a>
            <LanguageSwitch />
          </div>
        </div>
        <div className="home-footer-legal">{t("footer_legal")}</div>
      </footer>
    </div>
  );
}
