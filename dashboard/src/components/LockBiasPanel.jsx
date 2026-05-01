import React from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useLiveData } from "../contexts/LiveDataContext.jsx";
import "./LockBiasPanel.css";

const MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
const BIAS_OPTIONS = ["BULLISH", "BEARISH", "AUTO"];

function fp(p) {
  if (p == null) return "—";
  if (p > 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return p.toFixed(5);
}

// Render the 3-step lock pattern: where each level sits, when it was hit,
// and (for step 3) when the BOS confirmation actually happened.
function LockSteps({ lock, scope }) {
  if (!lock?.steps?.length) return null;
  const isBull = lock.direction === "BULLISH";
  return (
    <ol className="lbp-steps">
      {lock.steps.map(s => {
        const isBOS = s.role === "BSL_RECLAIM_BOS" || s.role === "SSL_RECLAIM_BOS";
        const tag   = s.role === "BSL_FORMED" ? "BSL"
                    : s.role === "SSL_FORMED" ? "SSL"
                    : isBOS                   ? (isBull ? "BSL" : "SSL") // post-sweep extreme that was reclaimed
                    : isBull ? "SSL" : "BSL"; // step 2: opposite-side liquidity grab
        const cycleSuffix = scope === "6H" && s.cycle
          ? ` · ${s.cycle}${s.cycleLabel ? ` (${s.cycleLabel})` : ""}`
          : "";
        return (
          <li key={s.step} className={`lbp-step ${isBOS ? "bos" : ""}`}>
            <div className="lbp-step-head">
              <span className="lbp-step-num">Stap {s.step}</span>
              <span className="lbp-step-tag">{s.label}</span>
            </div>
            <div className="lbp-step-body">
              <span className="lbp-step-where">
                {s.date}{cycleSuffix} · {tag} <b>{fp(s.level)}</b>
              </span>
              {s.sweptAt ? (
                <div className={`lbp-step-sweep ${isBOS ? "bos-line" : ""}`}>
                  📌 {tag} gepakt op
                  {" "}<b>{s.sweptAt.date}</b>{s.sweptAt.time ? ` ${s.sweptAt.time} ET` : ""} ({fp(s.sweptAt.price)})
                  {isBOS && ` → ${lock.direction} BOS bevestigd`}
                </div>
              ) : (
                <div className="lbp-step-sweep muted">📌 {tag} nog niet gepakt</div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export default function LockBiasPanel({ activeMarket = null, onBiasChange }) {
  const { authFetch } = useAuth();
  const { markets, adminBias: bias, refresh } = useLiveData();

  const setBiasValue = async (market, direction) => {
    try {
      const r = await authFetch("/api/admin/bias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, direction }),
      }).then(x => x.json());
      if (r.ok) { refresh(); onBiasChange?.(); }
      else console.warn("Bias update failed:", r.error);
    } catch (e) { console.warn("Bias update error:", e.message); }
  };

  const marketsToShow = activeMarket ? [activeMarket] : MARKETS;

  return (
    <div className="lbp-wrap">
      <div className="lbp-header">
        <span className="lbp-title">🔒 Daily Lock & Bias</span>
        <button className="lbp-refresh" onClick={refresh}>↻ Refresh</button>
      </div>

      <div className="lbp-grid">
        {marketsToShow.map(mk => {
          const d = markets[mk];
          if (!d) return (
            <div key={mk} className="lbp-card lbp-empty">
              <span className="lbp-mk">{mk}</span>
              <span className="lbp-no-data">Geen data</span>
            </div>
          );

          const lock      = d.lockState;
          const sixHLock  = d.sixHLockState;
          const flow      = d.orderFlowBias;
          const adminBias = d.adminBias;
          const allowed   = d.allowedDirection;
          const marketBias = bias[mk] || bias.GLOBAL;

          const biasLabel = adminBias === "AUTO"
            ? lock ? `AUTO → ${lock.direction}` : "AUTO → geen lock"
            : adminBias;
          const biasClass = lock?.direction === "BULLISH" || adminBias === "BULLISH" ? "bull"
                          : lock?.direction === "BEARISH" || adminBias === "BEARISH" ? "bear"
                          : "neut";

          return (
            <div key={mk} className="lbp-card">
              {/* Card header */}
              <div className="lbp-card-head">
                <span className="lbp-mk">{mk}</span>
                <span className="lbp-price">{fp(d.currentPrice)}</span>
                <span className={`lbp-bias-pill ${biasClass}`}>{biasLabel}</span>
                {allowed && <span className="lbp-allowed">Only {allowed}</span>}
              </div>

              {/* Order Flow Bias — confluence of daily × 6H locks */}
              {flow && (
                <div className={`lbp-flow ${
                  flow.state?.includes("STRONG_BULL") ? "flow-strong-bull" :
                  flow.state?.includes("STRONG_BEAR") ? "flow-strong-bear" :
                  flow.state?.includes("BULL_pullback") ? "flow-bull-weak" :
                  flow.state?.includes("BEAR_bounce")   ? "flow-bear-weak" :
                  flow.state?.includes("BULL")         ? "flow-bull" :
                  flow.state?.includes("BEAR")         ? "flow-bear" : "flow-neutral"
                }`}>
                  <div className="lbp-flow-head">
                    <span className="lbp-flow-label">🎯 ORDER FLOW</span>
                    <span className="lbp-flow-state">{flow.state?.replace("_"," ") ?? "NEUTRAL"}</span>
                    <span className="lbp-flow-score">{flow.score ?? 0}/100</span>
                    {flow.direction && (
                      <span className={`lbp-flow-dir ${flow.direction === "BUY" ? "buy" : "sell"}`}>
                        {flow.direction === "BUY" ? "▲ BUY" : "▼ SELL"}
                      </span>
                    )}
                  </div>
                  <div className="lbp-flow-note">{flow.note}</div>
                  <div className="lbp-flow-breakdown">
                    <span className={`lbp-flow-sub ${flow.dailyDirection === "BULLISH" ? "bull" : flow.dailyDirection === "BEARISH" ? "bear" : "neut"}`}>
                      Daily: {flow.dailyDirection ?? "—"}{lock?.strength ? ` ×${lock.strength}` : ""}
                      {flow.dailyRespected === false && " ⚠"}
                    </span>
                    <span className={`lbp-flow-sub ${flow.sixHDirection === "BULLISH" ? "bull" : flow.sixHDirection === "BEARISH" ? "bear" : "neut"}`}>
                      6H: {flow.sixHDirection ?? "—"}{sixHLock?.strength ? ` ×${sixHLock.strength}` : ""}
                      {flow.sixHRespected === false && " ⚠"}
                    </span>
                  </div>
                </div>
              )}

              {/* Daily lock detail */}
              {lock ? (
                <div className={`lbp-lock ${lock.direction === "BULLISH" ? "bull" : "bear"}`}>
                  <div className="lbp-lock-dir">
                    {lock.direction === "BULLISH" ? "▲ DAILY BULLISH LOCK" : "▼ DAILY BEARISH LOCK"}
                    <span className="lbp-lock-str">×{lock.strength}</span>
                    {lock.opportunity && (
                      <span className={`lbp-opp ${lock.opportunity === "BUY" ? "buy" : "sell"}`}>
                        ⚡ {lock.opportunity}
                      </span>
                    )}
                  </div>
                  <LockSteps lock={lock} scope="DAILY" />
                  {!lock.steps?.length && lock.note && <div className="lbp-lock-note">{lock.note}</div>}
                </div>
              ) : (
                <div className="lbp-no-lock">Geen daily lock — beide richtingen mogelijk</div>
              )}

              {/* 6H lock detail */}
              {sixHLock && (
                <div className={`lbp-lock ${sixHLock.direction === "BULLISH" ? "bull" : "bear"}`} style={{ marginTop: 6 }}>
                  <div className="lbp-lock-dir">
                    {sixHLock.direction === "BULLISH" ? "▲ 6H BULLISH LOCK" : "▼ 6H BEARISH LOCK"}
                    <span className="lbp-lock-str">×{sixHLock.strength}</span>
                  </div>
                  <LockSteps lock={sixHLock} scope="6H" />
                  {!sixHLock.steps?.length && sixHLock.note && <div className="lbp-lock-note">{sixHLock.note}</div>}
                </div>
              )}

              {/* Bias override buttons */}
              <div className="lbp-bias-row">
                <span className="lbp-bias-label">Bias:</span>
                {BIAS_OPTIONS.map(b => (
                  <button key={b}
                    className={`lbp-bias-btn ${marketBias === b ? "active " + b.toLowerCase() : ""}`}
                    onClick={() => setBiasValue(mk, b)}>{b}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
