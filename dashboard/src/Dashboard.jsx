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
import { useAuth } from "./contexts/AuthContext.jsx";
import { useLiveData } from "./contexts/LiveDataContext.jsx";
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

export default function Dashboard() {
  const { authFetch, logout, user } = useAuth();
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
              <MentorBlock
                activeTrade={displayData?.activeTrade}
                progress={displayData?.tradeProgress}
                market={activeTab ?? "NAS100"}
                activeTab={activeTab}
                userName={user?.name}
              />
            </div>
          </div>

          {/* Lock & Bias audit */}
          <LockBiasPanel activeMarket={activeTab} onBiasChange={() => { fetchMarkets(); setBiasVersion(v => v + 1); }} />

          {/* Live Fractal Signals */}
          <LiveSignals activeMarket={activeTab} biasMode="daily" refreshKey={biasVersion} />

          <StatusBar lastRefresh={lastRefresh} scanMeta={displayData?.scanMeta} error={error} />
        </main>
      )}
    </div>
  );
}
