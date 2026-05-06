import React, { useState, useEffect, useCallback } from "react";
import { useNavigate, Link } from "react-router-dom";
import Header from "./components/Header.jsx";
import PriceBar from "./components/PriceBar.jsx";
import CycleStrip from "./components/CycleStrip.jsx";
import MentorBlock from "./components/MentorBlock.jsx";
import ChartView from "./components/ChartView.jsx";
import StatusBar from "./components/StatusBar.jsx";
import MarketTabs from "./components/MarketTabs.jsx";
import LiveSignals from "./components/LiveSignals.jsx";
import LockBiasPanel from "./components/LockBiasPanel.jsx";
import PremiumDiscountPanel from "./components/PremiumDiscountPanel.jsx";
import { useAuth } from "./contexts/AuthContext.jsx";
import { useLiveData } from "./contexts/LiveDataContext.jsx";
import { useT } from "./contexts/LanguageContext.jsx";
import "./App.css";

const API_URL = "/api";
const POLL_INTERVAL    = 60 * 1000;
const MARKETS_INTERVAL = 60 * 1000;

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Goedemorgen";
  if (h < 18) return "Goedemiddag";
  return "Goedenavond";
}

function WelcomeBar({ name, isAdmin }) {
  const firstName = name?.split(" ")[0] ?? name;
  return (
    <div className="welcome-bar">
      <span className="welcome-text">
        {getGreeting()}, <strong>{firstName}</strong> — welkom terug
      </span>
      <Link to="/journal" className="welcome-admin-btn">
        📓 Journal
      </Link>
      <Link to="/broker" className="welcome-admin-btn">
        🔗 Broker
      </Link>
      {isAdmin && (
        <Link to="/admin" className="welcome-admin-btn">
          Admin
        </Link>
      )}
    </div>
  );
}

function fmtRelTime(d) {
  if (!d) return "";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 60_000) return "zojuist";
  const m = Math.floor(diff / 60_000); if (m < 60) return `${m}m geleden`;
  const h = Math.floor(m / 60);        if (h < 24) return `${h}u geleden`;
  const dd = Math.floor(h / 24);       return `${dd}d geleden`;
}

function FreeTierLockOverlay({ freeTier }) {
  const t = useT();
  if (!freeTier?.exhausted) return null;
  const reset = freeTier.nextResetAt ? new Date(freeTier.nextResetAt) : null;
  const wins  = freeTier.missedWins ?? [];
  const won   = freeTier.missedCount ?? 0;
  const tradesWord = won === 1 ? t("fl_missed_singular") : t("fl_missed_plural");

  return (
    <div className="freetier-lock-card">
      <div className="freetier-lock-emoji">🔒</div>
      <h2>{t("fl_title")}</h2>
      {freeTier.firstWin && (
        <div className="freetier-lock-trade">
          {t("fl_your_signal")} <strong>{freeTier.firstWin.market}</strong>
          {" "}{freeTier.firstWin.direction === "BUY" ? "▲ BUY" : "▼ SELL"}
          {" "}{t("fl_tp2_at")}{" "}<strong>{freeTier.firstWin.tp2}</strong>
        </div>
      )}

      {won > 0 && (
        <div className="freetier-fomo">
          <div className="freetier-fomo-head">
            <span className="freetier-fomo-fire">🔥</span>
            <strong>{t("fl_missed", { n: won, trades: tradesWord })}</strong>
            <span className="freetier-fomo-tag">{t("fl_missed_tag")}</span>
          </div>
          <div className="freetier-fomo-sub">{t("fl_missed_sub")}</div>
          <ul className="freetier-fomo-list">
            {wins.slice(0, 8).map((w, i) => (
              <li key={i} className="freetier-fomo-item">
                <span className={`freetier-fomo-dir freetier-fomo-${(w.direction || "").toLowerCase()}`}>
                  {w.direction === "BUY" ? "▲" : "▼"}
                </span>
                <span className="freetier-fomo-mkt">{w.market}</span>
                <span className="freetier-fomo-tf">{w.tf || ""}</span>
                <span className="freetier-fomo-result">
                  {w.outcome === "TP3" ? "TP3 🚀 (10R runner)" : "TP2 ✓ (2R)"}
                </span>
                <span className="freetier-fomo-time">{fmtRelTime(w.time)}</span>
              </li>
            ))}
            {won > 8 && <li className="freetier-fomo-more">{t("fl_more", { n: won - 8 })}</li>}
          </ul>
        </div>
      )}

      <p className="freetier-lock-reset">
        {t("fl_next_signal")}{" "}
        <strong>{reset ? reset.toLocaleDateString(undefined, { weekday: "long", day: "2-digit", month: "long" }) : ""}</strong>
      </p>
      <p className="freetier-lock-cta-text">{t("fl_cta_question")}</p>
      <div className="freetier-lock-cta-buttons">
        <Link to="/billing" className="freetier-lock-btn freetier-lock-btn-secondary">
          {t("fl_cta_signal")}
        </Link>
        <Link to="/billing" className="freetier-lock-btn">
          {t("fl_cta_auto")}
        </Link>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { authFetch, logout, user } = useAuth();
  const { freeTier } = useLiveData();
  const navigate = useNavigate();
  const [data, setData]               = useState(null);
  const [error, setError]             = useState(null);
  const [loading, setLoading]         = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing]   = useState(false);
  const [marketState, setMarketState] = useState(null);
  const [marketsData, setMarketsData] = useState({});  // { NAS100: {...}, XAUUSD: {...}, ... }
  const [activeTab, setActiveTab]     = useState("NAS100"); // default to NAS100 on load
  const [biasVersion, setBiasVersion] = useState(0);

  // Always read from cached market files — never trigger MCP calls from the dashboard.
  const fetchData = useCallback(async () => {
    try {
      setRefreshing(true);
      const res  = await authFetch(`${API_URL}/data`);
      if (res.status === 401) { logout(); navigate("/login"); return; }
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "API error");
      setData(json.data);
      setError(null);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authFetch, logout, navigate]);

  const fetchMarkets = useCallback(async () => {
    try {
      const [stateRes, marketsRes] = await Promise.all([
        authFetch(`${API_URL}/market`),
        authFetch(`${API_URL}/markets`),
      ]);
      const stateJson   = await stateRes.json();
      const marketsJson = await marketsRes.json();
      if (stateJson.ok)   setMarketState(stateJson);
      if (marketsJson.ok) setMarketsData(marketsJson.markets ?? {});
    } catch {}
  }, [authFetch]);

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(iv);
  }, [fetchData]);

  useEffect(() => {
    fetchMarkets();
    const iv = setInterval(fetchMarkets, MARKETS_INTERVAL);
    return () => clearInterval(iv);
  }, [fetchMarkets]);

  // Derive display data: if a market tab is selected AND we have cached data for it, use that.
  // Otherwise fall back to live NAS100 API data.
  const displayData = activeTab && marketsData[activeTab]
    ? marketsData[activeTab]
    : data;

  const displayMarketLabel = activeTab ?? marketState?.current ?? "NAS100";

  return (
    <div className="app">
      <Header onRefresh={() => { fetchData(); fetchMarkets(); }} refreshing={refreshing} />

      {loading && !data ? (
        <div className="loading-screen">
          <div className="loading-spinner" />
          <p className="text-secondary">Connecting to market feed...</p>
        </div>
      ) : error && !data ? (
        <div className="error-screen">
          <span className="error-icon">⚠</span>
          <p className="text-red">{error}</p>
          <button className="btn-retry" onClick={() => fetchData(true)}>Retry</button>
        </div>
      ) : (
        <main className="layout">
          {/* Welcome bar */}
          {user && <WelcomeBar name={user.name} isAdmin={user.isAdmin} />}

          {/* Market tabs */}
          <MarketTabs
            marketsData={marketsData}
            activeTab={activeTab}
            onSelect={setActiveTab}
            marketState={marketState}
          />

          {/* Hero row: price + chart | mentor + bias */}
          <div className="layout-hero">
            <div className="hero-left">
              {displayData && (
                <PriceBar data={displayData} marketState={{ current: displayMarketLabel }} />
              )}
              <ChartView marketState={marketState} selectedMarket={activeTab} />
              {displayData && (
                <CycleStrip
                  cycles={displayData.cycles}
                  prevC4={displayData.prevC4}
                  activeCycle={displayData.activeCycle}
                  currentPrice={displayData.currentPrice}
                  cycles90={displayData.cycles90}
                />
              )}
            </div>
            <div className="hero-right">
              {/* Trading Mentor — paid tiers + admin only. Free users see an
                  upgrade teaser instead so they know what they're missing. */}
              {!freeTier ? (
                <MentorBlock
                  activeTrade={displayData?.activeTrade}
                  progress={displayData?.tradeProgress}
                  market={activeTab ?? "NAS100"}
                  activeTab={activeTab}
                  userName={user?.name}
                />
              ) : (
                <div className="mentor-locked">
                  <div className="mentor-locked-icon">🤖</div>
                  <h3>AI Trading Mentor</h3>
                  <p>
                    Get instant context-aware advice on every active setup.
                    Ask your AI anything about the current market state.
                  </p>
                  <div className="mentor-locked-tag">⭐ Paid plans only</div>
                  <Link to="/billing" className="mentor-locked-btn">
                    Unlock with AI-Analyst (€39) or Hands-Off AI (€69) →
                  </Link>
                </div>
              )}
            </div>
          </div>

          {/* Lock & Bias audit */}
          <LockBiasPanel activeMarket={activeTab} onBiasChange={() => { fetchMarkets(); setBiasVersion(v => v + 1); }} />

          {/* Premium / Discount zones — Daily (18:00 ET → now) + 6H ref cycle.
              Display-only, geen filter. ⭐ GOLDEN wanneer setup-richting met de zone aligneert. */}
          <PremiumDiscountPanel activeMarket={activeTab} />

          {/* Live Fractal Signals — replaced by lock-card if free user has used weekly */}
          {freeTier?.exhausted
            ? <FreeTierLockOverlay freeTier={freeTier} />
            : <LiveSignals activeMarket={activeTab} biasMode="daily" refreshKey={biasVersion} />}

          <StatusBar lastRefresh={lastRefresh} scanMeta={displayData?.scanMeta} error={error} />
        </main>
      )}
    </div>
  );
}
