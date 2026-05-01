import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./SignalHistory.css";

const TF_LABEL = { weekly: "W", daily: "D", "6h": "6H", cycle: "C" };
const TF_FULL  = { weekly: "Weekly", daily: "Daily", "6h": "6H Cycle", cycle: "90min Cycle" };

function fmtP(v) {
  if (v == null) return "—";
  const n = parseFloat(v);
  if (n < 10)    return n.toFixed(5);
  if (n < 100)   return n.toFixed(3);
  if (n < 10000) return n.toFixed(1);
  return n.toFixed(0);
}

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("nl-NL", {
    timeZone: "America/New_York",
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }) + " ET";
}

// Extract cycle label from note, e.g. "BSL(Thu-C4 Thu, Apr 16) → ..." → "Thu-C4"
function parseCycleFromNote(note) {
  if (!note) return null;
  const m = note.match(/\(([A-Za-z]{3}-C\d)/);
  return m ? m[1] : null;
}

// Extract sweep date label from levels or note
function getSweepInfo(h) {
  const lv = h.levels;
  if (lv?.sweepLabel) return lv.sweepLabel;
  return parseCycleFromNote(h.note);
}

export default function SignalHistory({ activeMarket, allowedDirection, refreshKey = 0 }) {
  const { authFetch } = useAuth();
  const [history, setHistory]         = useState([]);
  const [activeSetup, setActiveSetup] = useState(null);
  const [setupHistory, setSetupHistory] = useState([]);
  const [currentPrice, setCurrentPrice] = useState(null);
  const [loading, setLoading]         = useState(true);
  const [filter, setFilter]           = useState("ALL");
  const [expanded, setExpanded]       = useState(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const mq  = activeMarket ? `?market=${activeMarket}` : "";
      const [histRes, liveRes] = await Promise.all([
        authFetch(`/api/signals/history${mq}`).then(r => r.json()),
        activeMarket ? authFetch(`/api/live-data?market=${activeMarket}`).then(r => r.json()) : Promise.resolve(null),
      ]);
      if (histRes.ok) setHistory(histRes.history ?? []);
      if (liveRes?.ok && activeMarket) {
        const md = liveRes.markets?.[activeMarket];
        setActiveSetup(md?.activeSetup ?? null);
        setCurrentPrice(md?.currentPrice ?? null);
        setSetupHistory(md?.setupHistory ?? []);
      }
    } catch {}
    finally { setLoading(false); }
  }, [authFetch, activeMarket]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (refreshKey > 0) load(); }, [refreshKey, load]);

  // Auto-filter by allowedDirection when set (lock-aligned only)
  const lockFiltered = history.filter(h => {
    if (!allowedDirection) return true;
    return h.type === allowedDirection;
  });

  const filtered = lockFiltered.filter(h => {
    if (filter === "ALL") return true;
    if (filter === "W")   return h.timeframe === "weekly";
    if (filter === "D")   return h.timeframe === "daily";
    if (filter === "6H")  return h.timeframe === "6h";
    if (filter === "C")   return h.timeframe === "cycle";
    if (filter === "BUY")  return h.type === "BUY";
    if (filter === "SELL") return h.type === "SELL";
    return true;
  });

  const filterBtns = allowedDirection
    ? ["ALL", "W", "D", "6H", "C"]
    : ["ALL", "W", "D", "6H", "C", "BUY", "SELL"];

  return (
    <div className="sh-root">
      <div className="sh-header">
        <span className="sh-title">
          Setup History
          {allowedDirection && (
            <span className={`sh-lock-filter ${allowedDirection === "BUY" ? "sh-lock-bull" : "sh-lock-bear"}`}>
              {allowedDirection === "BUY" ? "▲ BUY lock" : "▼ SELL lock"}
            </span>
          )}
        </span>
        <div className="sh-filters">
          {filterBtns.map(f => (
            <button
              key={f}
              className={`sh-filter-btn ${filter === f ? "sh-filter-active" : ""}`}
              onClick={() => setFilter(f)}
            >{f}</button>
          ))}
        </div>
        <button className="sh-refresh" onClick={load} title="Verversen">↺</button>
      </div>

      {/* Active setup progress block */}
      {activeSetup && (() => {
        const isBuy  = activeSetup.direction === "BUY";
        const risk   = activeSetup.entry && activeSetup.sl ? Math.abs(activeSetup.entry - activeSetup.sl) : null;
        const pnlPts = currentPrice && activeSetup.entry
          ? (isBuy ? currentPrice - activeSetup.entry : activeSetup.entry - currentPrice) : null;
        const pnlR   = risk && pnlPts != null ? pnlPts / risk : null;
        const toTP   = currentPrice && activeSetup.tp1 ? Math.abs(activeSetup.tp1 - currentPrice) : null;
        const toSL   = currentPrice && activeSetup.sl  ? Math.abs(currentPrice - activeSetup.sl)  : null;
        const isClosed   = activeSetup.status === "CLOSED_SL" || activeSetup.status === "CLOSED_TP2";
        const isLive     = activeSetup.status === "ACTIVE";
        const isWaiting  = activeSetup.status === "WAITING_PHASE2";
        const outcome    = activeSetup.status === "CLOSED_TP2" ? "WIN" : activeSetup.status === "CLOSED_SL" ? "LOSS" : null;

        return (
          <div className={`sh-active-setup ${isBuy ? "sh-buy" : "sh-sell"} ${outcome === "WIN" ? "sh-win" : outcome === "LOSS" ? "sh-loss" : ""}`}>
            <div className="sh-as-header">
              <span className={`sh-as-dir ${isBuy ? "sh-dir-buy" : "sh-dir-sell"}`}>{isBuy ? "▲ BUY" : "▼ SELL"}</span>
              <span className="sh-as-source">{activeSetup.source} · {activeSetup.createdTime}</span>
              {outcome === "WIN"  && <span className="sh-as-outcome win">WIN ✅</span>}
              {outcome === "LOSS" && <span className="sh-as-outcome loss">LOSS ❌</span>}
              {isWaiting  && <span className="sh-as-status">⏳ Wacht op entry</span>}
              {isLive     && <span className="sh-as-status live">● ACTIEF</span>}
            </div>
            <div className="sh-as-levels">
              <span className="sh-as-lv entry">Entry <b>{fmtP(activeSetup.entry)}</b></span>
              {activeSetup.sl  && <span className="sh-as-lv sl">SL <b>{fmtP(activeSetup.sl)}</b></span>}
              {activeSetup.tp1 && <span className="sh-as-lv tp">TP 1:2 <b>{fmtP(activeSetup.tp1)}</b></span>}
              {risk && <span className="sh-as-lv risk">Risk <b>{risk.toFixed(1)}pt</b></span>}
            </div>
            {(isLive || isWaiting) && currentPrice && risk && (
              <div className="sh-as-progress">
                <div className="sh-as-prog-row">
                  <span className="sh-as-now">{fmtP(currentPrice)}</span>
                  <span className={`sh-as-pnl ${(pnlPts ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {(pnlPts ?? 0) >= 0 ? "+" : ""}{pnlPts?.toFixed(1)}pt
                  </span>
                  <span className={`sh-as-r ${(pnlR ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {(pnlR ?? 0) >= 0 ? "+" : ""}{pnlR?.toFixed(2)}R
                  </span>
                  {toTP != null && <span className="sh-as-dist pos">TP −{toTP.toFixed(1)}pt</span>}
                  {toSL != null && <span className="sh-as-dist neg">SL −{toSL.toFixed(1)}pt</span>}
                </div>
                {isLive && (
                  <div className="sh-as-bar-wrap">
                    <div className="sh-as-bar-track">
                      <div
                        className={`sh-as-bar-fill ${(pnlPts ?? 0) >= 0 ? "pos" : "neg"}`}
                        style={{ width: `${Math.min(100, Math.max(0, Math.abs(pnlR ?? 0) / 2 * 100))}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Monitor setup history with outcomes */}
      {setupHistory.length > 0 && (
        <div className="sh-monitor-history">
          <div className="sh-section-lbl">SETUPS (MONITOR)</div>
          {[...setupHistory].reverse().map((e, i) => {
            const isBuy = e.direction === "BUY" || e.details?.startsWith("BUY");
            const risk  = e.entry && e.sl ? Math.abs(e.entry - e.sl) : null;
            return (
              <div key={i} className={`sh-mh-row ${isBuy ? "sh-buy" : "sh-sell"}`}>
                <span className="sh-mh-time">{e.time}</span>
                <span className={`sh-mh-dir ${isBuy ? "sh-dir-buy" : "sh-dir-sell"}`}>{isBuy ? "▲ BUY" : "▼ SELL"}</span>
                <span className="sh-mh-detail">
                  {fmtP(e.entry)}
                  {risk && <> · {risk.toFixed(1)}pt</>}
                  {e.tp1 && <> → TP {fmtP(e.tp1)}</>}
                </span>
                {e.outcome === "WIN"  && <span className="sh-mh-outcome win">WIN ✅</span>}
                {e.outcome === "LOSS" && <span className="sh-mh-outcome loss">LOSS ❌</span>}
                {!e.outcome           && <span className="sh-mh-outcome open">open</span>}
              </div>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="sh-empty">Laden...</div>
      ) : filtered.length === 0 ? (
        <div className="sh-empty">Geen signalen gevonden</div>
      ) : (
        <div className="sh-list">
          {filtered.map(h => {
            const isBuy    = h.type === "BUY";
            const isOpen   = expanded === h.id;
            const lv       = h.levels;
            const sweepInfo = getSweepInfo(h);

            return (
              <div
                key={h.id}
                className={`sh-row ${isBuy ? "sh-buy" : "sh-sell"} ${isOpen ? "sh-open" : ""}`}
                onClick={() => setExpanded(isOpen ? null : h.id)}
              >
                <div className="sh-row-main">
                  {/* Direction pill */}
                  <span className={`sh-dir-pill ${isBuy ? "sh-dir-buy" : "sh-dir-sell"}`}>
                    {isBuy ? "▲ BUY" : "▼ SELL"}
                  </span>

                  {/* Timeframe */}
                  <span className={`sh-tf-badge sh-tf-${h.timeframe}`}>
                    {TF_LABEL[h.timeframe] ?? h.timeframe}
                  </span>

                  {/* Market (only when not filtered to single market) */}
                  {!activeMarket && (
                    <span className="sh-market">{h.market}</span>
                  )}

                  {/* Sweep cycle / source */}
                  {sweepInfo && (
                    <span className="sh-sweep-info">
                      {isBuy ? "BSL" : "SSL"} swept: <b>{sweepInfo}</b>
                    </span>
                  )}

                  {/* Lock level (entry target) */}
                  {lv?.lockLevel != null && (
                    <span className="sh-entry-lvl">
                      → Entry <b>{fmtP(lv.lockLevel)}</b>
                    </span>
                  )}

                  {/* Time */}
                  <span className="sh-time">{fmt(h.detectedAt)}</span>
                </div>

                {isOpen && (
                  <div className="sh-detail">
                    <div className="sh-detail-row">
                      <span className="sh-dl">Timeframe</span>
                      <span className="sh-dv">{TF_FULL[h.timeframe] ?? h.timeframe}</span>
                    </div>
                    <div className="sh-detail-row">
                      <span className="sh-dl">Entry window</span>
                      <span className="sh-dv">{h.entryWindow ?? "—"}</span>
                    </div>
                    {lv && (
                      <>
                        <div className="sh-detail-row">
                          <span className="sh-dl">{isBuy ? "BSL sweep" : "SSL sweep"}</span>
                          <span className="sh-dv sh-dv-bsl">
                            {fmtP(lv.bslLevel)}
                            {lv.sweepLabel && <span className="sh-dv-lbl"> ({lv.sweepLabel})</span>}
                          </span>
                        </div>
                        <div className="sh-detail-row">
                          <span className="sh-dl">{isBuy ? "SSL pullback" : "BSL pullback"}</span>
                          <span className="sh-dv sh-dv-ssl">
                            {fmtP(lv.sslLevel)}
                            {lv.pullbackLabel && <span className="sh-dv-lbl"> ({lv.pullbackLabel})</span>}
                          </span>
                        </div>
                        <div className="sh-detail-row">
                          <span className="sh-dl">Lock level</span>
                          <span className="sh-dv sh-dv-lock">
                            {fmtP(lv.lockLevel)}
                            {lv.lockLabel && <span className="sh-dv-lbl"> ({lv.lockLabel})</span>}
                          </span>
                        </div>
                        {lv.currentPullback != null && (
                          <div className="sh-detail-row">
                            <span className="sh-dl">Last pullback</span>
                            <span className="sh-dv sh-dv-pb">{fmtP(lv.currentPullback)}</span>
                          </div>
                        )}
                      </>
                    )}
                    {h.lockStrength > 0 && (
                      <div className="sh-detail-row">
                        <span className="sh-dl">Lock strength</span>
                        <span className="sh-dv">🔒 ×{h.lockStrength}</span>
                      </div>
                    )}
                    <div className="sh-detail-note">{h.note}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
