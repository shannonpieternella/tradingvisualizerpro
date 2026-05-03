import React from "react";
import "./MarketTabs.css";

const MARKET_LABELS = {
  NAS100: { short: "NAS100",  long: "NAS100 (US100)"  },
  US500:  { short: "US500",   long: "S&P 500"          },
  US30:   { short: "US30",    long: "Dow Jones"         },
  XAUUSD: { short: "XAU/USD", long: "Gold"              },
  GBPUSD: { short: "GBP/USD", long: "Cable"             },
  BTCUSD: { short: "BTC/USD", long: "Bitcoin"           },
  ETHUSD: { short: "ETH/USD", long: "Ethereum"          },
};

export default function MarketTabs({ marketsData, activeTab, onSelect, marketState }) {
  // Use API-driven market order when available, fall back to MARKET_LABELS order
  const markets = Object.keys(marketsData).length > 0
    ? Object.keys(marketsData)
    : Object.keys(MARKET_LABELS);

  // For each market, compute a quick status badge
  function getStatus(key) {
    const d = marketsData[key];
    if (!d) return { type: "offline", label: "—" };
    const { signal, activeTrade, tradeProgress, fractalSignals, biasSummary, allowedDirection, lockState, activeSetup, adminBias } = d;

    // Manual admin override — BULLISH/BEARISH from /admin must beat auto-lock so
    // the tab badge flips immediately. AUTO falls through to lock-based logic.
    const manualOverride = adminBias === "BULLISH" || adminBias === "BEARISH" ? adminBias : null;

    // Active setup from monitor — only show if it matches current allowed direction
    if (activeSetup && (!allowedDirection || activeSetup.direction === allowedDirection)) {
      const isBuy = activeSetup.direction === "BUY";
      return { type: isBuy ? "signal" : "signal-bear", label: isBuy ? "BUY" : "SELL" };
    }

    if (activeTrade) {
      const pnl = tradeProgress?.pnl ?? 0;
      if (tradeProgress?.isStopped) return { type: "stopped", label: "STOP" };
      if (pnl > 0)  return { type: "win",  label: `+${pnl}` };
      if (pnl < 0)  return { type: "loss", label: `${pnl}` };
      return { type: "flat", label: "BE" };
    }
    if (signal?.active?.length  > 0) return { type: "signal", label: "SIGNAL" };
    if (signal?.upcoming?.length > 0) return { type: "upcoming", label: "SOON" };

    if (fractalSignals) {
      const { weekly, daily, cycle, activeSignals, allAligned } = fractalSignals;
      // Filter signals against lock direction — never show a signal that conflicts
      const allowed = allowedDirection; // "BUY", "SELL", or null
      const activeOpp = [cycle, daily, weekly].find(s => {
        if (!s?.type) return false;
        if (allowed && s.type !== allowed) return false; // blocked by lock
        return true;
      });
      if (activeOpp) {
        const src = activeOpp === cycle ? "C" : activeOpp === daily ? "D" : "W";
        return { type: activeOpp.type === "BUY" ? "signal" : "signal-bear", label: `${src}:${activeOpp.type}` };
      }
    }

    // Bias badge — manual override beats auto lock, lock beats biasSummary.
    // Without this priority, flipping admin to BEARISH on /admin keeps the tab
    // showing BULL until the auto-lock recomputes hours later.
    const effectiveBias = manualOverride ?? lockState?.direction
      ?? (biasSummary?.bias && biasSummary.bias !== "NEUTRAL" ? biasSummary.bias : null);
    if (effectiveBias) {
      const isBull = effectiveBias === "BULLISH";
      return { type: isBull ? "bias-bull" : "bias-bear", label: isBull ? "BULL" : "BEAR" };
    }

    return { type: "neutral", label: "—" };
  }

  function getPrice(key) {
    const d = marketsData[key];
    if (!d?.currentPrice) return null;
    const p = d.currentPrice;
    if (p > 10000) return p.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    if (p > 1000)  return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return p.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 5 });
  }

  const scanningKey = marketState?.current;

  return (
    <div className="market-tabs">
      {/* "All" tab — shows NAS100 live data */}
      <button
        className={`mt-tab ${activeTab === null ? "mt-tab-active" : ""}`}
        onClick={() => onSelect(null)}
      >
        <span className="mt-tab-name">ALL</span>
        <span className="mt-tab-sub">Live feed</span>
      </button>

      {markets.map(key => {
        const status  = getStatus(key);
        const price   = getPrice(key);
        const isActive = activeTab === key;
        const isScanning = scanningKey === key;

        return (
          <button
            key={key}
            className={`mt-tab ${isActive ? "mt-tab-active" : ""} ${!marketsData[key] ? "mt-tab-offline" : ""}`}
            onClick={() => onSelect(key)}
          >
            <div className="mt-tab-top">
              <span className="mt-tab-name">{MARKET_LABELS[key]?.short ?? key}</span>
              {isScanning && <span className="mt-scanning-dot" title="AI analyseert nu" />}
              <span className={`mt-badge mt-badge-${status.type}`}>{status.label}</span>
            </div>
            <span className="mt-tab-price mono">{price ?? "—"}</span>
          </button>
        );
      })}
    </div>
  );
}
