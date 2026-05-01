import React, { useEffect, useRef, useState, useCallback } from "react";
import "./ChartView.css";

// Map monitor market keys → TradingView widget symbols
const TV_SYMBOL_MAP = {
  "CAPITALCOM:US100": "CAPITALCOM:US100",
  "OANDA:XAUUSD":     "OANDA:XAUUSD",
  "OANDA:GBPUSD":     "OANDA:GBPUSD",
};

const MARKET_TV_SYMBOLS = {
  NAS100: "CAPITALCOM:US100",
  US500:  "CAPITALCOM:US500",
  US30:   "CAPITALCOM:US30",
  XAUUSD: "OANDA:XAUUSD",
  GBPUSD: "OANDA:GBPUSD",
};

export default function ChartView({ marketState, selectedMarket }) {
  const containerRef  = useRef(null);
  const widgetRef     = useRef(null);
  const wrapRef       = useRef(null);
  const [loaded, setLoaded]       = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const prevSymbol                = useRef(null);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      wrapRef.current?.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  useEffect(() => {
    const onFsChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // If user selected a market tab, show that market's chart; otherwise show what AI is currently scanning
  const tvSymbol = selectedMarket
    ? (MARKET_TV_SYMBOLS[selectedMarket] ?? marketState?.tvSymbol ?? "CAPITALCOM:US100")
    : (marketState?.tvSymbol ?? "CAPITALCOM:US100");
  const label         = selectedMarket ?? marketState?.label ?? "NAS100";
  const activeMarkets = marketState?.activeMarkets ?? ["NAS100"];
  const lastUpdate    = marketState?.lastUpdate;

  // Build / update widget when symbol changes
  useEffect(() => {
    if (!containerRef.current) return;
    if (prevSymbol.current === tvSymbol) return;
    prevSymbol.current = tvSymbol;
    setLoaded(false);

    // Remove previous widget
    if (widgetRef.current) {
      widgetRef.current.remove();
      widgetRef.current = null;
    }

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: "15",
      timezone: "America/New_York",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      save_image: false,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_side_toolbar: false,
      support_host: "https://www.tradingview.com",
    });
    script.onload = () => setLoaded(true);

    const wrapper = document.createElement("div");
    wrapper.className = "tradingview-widget-container__widget";
    wrapper.style.height = "100%";
    wrapper.style.width  = "100%";

    containerRef.current.innerHTML = "";
    containerRef.current.appendChild(wrapper);
    containerRef.current.appendChild(script);
    widgetRef.current = script;
  }, [tvSymbol]);

  const ago = lastUpdate
    ? (() => {
        const s = Math.round((Date.now() - lastUpdate) / 1000);
        if (s < 60)  return `${s}s geleden`;
        if (s < 3600) return `${Math.round(s / 60)}m geleden`;
        return `${Math.round(s / 3600)}u geleden`;
      })()
    : null;

  return (
    <div className={`chart-view ${fullscreen ? "cv-fullscreen" : ""}`} ref={wrapRef}>
      {/* Header bar */}
      <div className="cv-header">
        <div className="cv-market-info">
          <span className="cv-live-dot" />
          <span className="cv-label">{label}</span>
          <span className="cv-timeframe">15M</span>
        </div>
        <div className="cv-markets">
          {activeMarkets.map(m => (
            <span
              key={m}
              className={`cv-market-pill ${marketState?.current === m ? "cv-pill-active" : "cv-pill-idle"}`}
            >
              {m}
            </span>
          ))}
        </div>
        {ago && <span className="cv-updated">AI scan: {ago}</span>}
        <button
          className="cv-fs-btn"
          onClick={toggleFullscreen}
          title={fullscreen ? "Verlaat fullscreen" : "Fullscreen"}
        >
          {fullscreen ? "✕" : "⛶"}
        </button>
      </div>

      {/* Chart + read-only overlay */}
      <div className="cv-chart-wrap">
        <div
          className="tradingview-widget-container"
          ref={containerRef}
          style={{ height: "100%", width: "100%" }}
        />
        {/* Transparent overlay — blocks all user interaction with the chart */}
        <div className="cv-overlay" title="Read-only — beheerd door AI monitor" />
        {!loaded && (
          <div className="cv-loading">
            <span className="cv-loading-dot" />
            <span>Chart laden...</span>
          </div>
        )}
      </div>
    </div>
  );
}
