import React, { useEffect, useState, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./EnginePage.css";

const MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
const BIAS_OPTIONS = ["BULLISH", "BEARISH", "AUTO"];

export default function EnginePage() {
  const { authFetch } = useAuth();
  const [markets, setMarkets]   = useState({});
  const [bias, setBias]         = useState({ GLOBAL: "AUTO" });
  const [logs, setLogs]         = useState([]);
  const [tab, setTab]           = useState("structure");

  // ── Polling ───────────────────────────────────────────────────────────────
  const loadMarkets = useCallback(async () => {
    try {
      const r = await authFetch("/api/live-data").then(x => x.json());
      if (r.ok) setMarkets(r.markets ?? {});
    } catch {}
  }, [authFetch]);

  const loadBias = useCallback(async () => {
    try {
      const r = await authFetch("/api/admin/bias").then(x => x.json());
      if (r.ok) setBias(r.bias);
    } catch {}
  }, [authFetch]);

  const loadLogs = useCallback(async () => {
    try {
      const r = await authFetch("/api/debug-log?limit=100").then(x => x.json());
      if (r.ok) setLogs(r.events ?? []);
    } catch {}
  }, [authFetch]);

  useEffect(() => {
    loadMarkets(); loadBias(); loadLogs();
    const t1 = setInterval(loadMarkets, 10000);
    const t2 = setInterval(loadLogs, 5000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadMarkets, loadBias, loadLogs]);

  const setBiasValue = async (market, direction) => {
    try {
      const r = await authFetch("/api/admin/bias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, direction }),
      }).then(x => x.json());
      if (r.ok) setBias(r.bias);
    } catch {}
  };

  // ── Format price ──────────────────────────────────────────────────────────
  const fp = (p) => {
    if (p == null) return "—";
    if (p > 1000) return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return p.toFixed(5);
  };

  // ── Log color ─────────────────────────────────────────────────────────────
  const logColor = (ev = "") => {
    if (ev.includes("SL_HIT") || ev.includes("ERROR"))   return "#ff3e5e";
    if (ev.includes("TP2") || ev.includes("TP1"))        return "#00ff88";
    if (ev.includes("SETUP_CREATED"))                    return "#00d4ff";
    if (ev.includes("ENTRY"))                            return "#ffd700";
    if (ev.includes("SWEEP"))                            return "#ff9500";
    if (ev.includes("TRADE_ACTIVE"))                     return "#4d9fff";
    return "#4a5568";
  };

  return (
    <div className="eng-page">

      {/* ── Header ── */}
      <div className="eng-header">
        <div className="eng-header-left">
          <span className="eng-dot" />
          <span className="eng-title">TradingVisualizer · Liquidity Engine</span>
        </div>
        <div className="eng-tabs">
          {[["structure","📊 Structure"],["lock","🔒 Lock & Bias"],["console","📋 Console"]].map(([t,l]) => (
            <button key={t} className={`eng-tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
      </div>

      {/* ── Admin Bias Bar ── */}
      <div className="eng-bias-bar">
        <span className="eng-bias-label">GLOBAL BIAS</span>
        {BIAS_OPTIONS.map(b => (
          <button key={b}
            className={`eng-bias-btn ${bias.GLOBAL === b ? "active " + b.toLowerCase() : ""}`}
            onClick={() => setBiasValue("GLOBAL", b)}>{b}
          </button>
        ))}
        <span className="eng-bias-sep" />
        {MARKETS.map(m => (
          <span key={m} className="eng-mkt-bias">
            <span className="eng-mkt-name">{m}</span>
            {BIAS_OPTIONS.map(b => (
              <button key={b}
                className={`eng-bias-sm ${(bias[m] || bias.GLOBAL) === b ? "active " + b.toLowerCase() : ""}`}
                onClick={() => setBiasValue(m, b)}>{b[0]}
              </button>
            ))}
          </span>
        ))}
      </div>

      {/* ── Structure Tab ── */}
      {tab === "structure" && (
        <div className="eng-grid">
          {MARKETS.map(mk => {
            const d = markets[mk];
            if (!d) return (
              <div key={mk} className="eng-card">
                <div className="eng-card-head">{mk} <span className="eng-no-data">Geen data — monitor nog niet gedraaid</span></div>
              </div>
            );
            const setup = d.activeSetup;
            const phase = d.phaseInfo;
            const lock  = d.lockState;

            return (
              <div key={mk} className="eng-card">
                {/* Card header */}
                <div className="eng-card-head">
                  <span className="eng-mkt-title">{mk}</span>
                  <span className="eng-price">{fp(d.currentPrice)}</span>
                  <span className="eng-time">{d.currentTime} ET</span>
                  <span className={`eng-phase-tag ${phase?.inPhase2 ? "p2" : "p1"}`}>
                    Phase {phase?.phase ?? "?"} {phase?.inPhase2 ? `· ${phase.activeP2?.label}` : `· ${phase?.currentCycle ?? ""}`}
                  </span>
                </div>

                {/* Lock + Bias */}
                <div className="eng-meta-row">
                  <span className="eng-tag">Bias: <b>{d.adminBias}</b></span>
                  {lock && <span className={`eng-tag ${lock.direction === "BULLISH" ? "bull" : "bear"}`}>
                    🔐 {lock.direction} Lock ×{lock.strength}
                  </span>}
                  {d.allowedDirection && <span className="eng-tag cyan">Only {d.allowedDirection}</span>}
                </div>

                {/* Active setup */}
                {setup && (
                  <div className={`eng-setup ${setup.direction === "BUY" ? "buy" : "sell"}`}>
                    <div className="eng-setup-title">
                      {setup.direction === "BUY" ? "🟢" : "🔴"} {setup.direction} · {setup.source}
                      <span className={`eng-status-tag ${setup.status?.toLowerCase()}`}>{setup.status?.replace(/_/g," ")}</span>
                    </div>
                    <div className="eng-setup-row">
                      <div className="eng-level sl">SL<br/><b>{fp(setup.sl)}</b></div>
                      <div className="eng-level entry">Entry<br/><b>{fp(setup.entry)}</b></div>
                      <div className="eng-level tp">TP1 1:2<br/><b>{fp(setup.tp1)}</b></div>
                      <div className="eng-level tp">TP2 1:3<br/><b>{fp(setup.tp2)}</b></div>
                    </div>
                    {setup.status === "WAITING_PHASE2" && (
                      <div className="eng-waiting">⏳ Wacht op Phase 2 · {setup.nextPhase2Label}</div>
                    )}
                  </div>
                )}
                {!setup && <div className="eng-no-setup">Geen actieve setup</div>}

                {/* 90-Min Cycles */}
                <div className="eng-section">90-MIN CYCLES (laatste 6)</div>
                <table className="eng-tbl eng-tbl-sm">
                  <thead><tr><th>Window</th><th className="hi">H</th><th>↑</th><th className="lo">L</th><th>↓</th></tr></thead>
                  <tbody>
                    {(d.cycles90 ?? []).slice(-6).map(c => (
                      <tr key={c.index} className={!c.complete ? "active-row" : ""}>
                        <td className="mono">{c.startTime}–{c.endTime}</td>
                        <td className="hi">{fp(c.high)}</td>
                        <td className={c.hitHigh ? "hit-y" : "hit-n"}>{c.hitHigh ? "✓" : "—"}</td>
                        <td className="lo">{fp(c.low)}</td>
                        <td className={c.hitLow ? "hit-y" : "hit-n"}>{c.hitLow ? "✓" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Daily Levels */}
                <div className="eng-section">DAILY LEVELS</div>
                <table className="eng-tbl eng-tbl-sm">
                  <thead><tr><th>Datum</th><th className="hi">High</th><th>↑</th><th className="lo">Low</th><th>↓</th></tr></thead>
                  <tbody>
                    {(d.dailyLevels ?? []).map((day, i) => (
                      <tr key={i} className={day.isToday ? "active-row" : ""}>
                        <td className="mono">{day.date}</td>
                        <td className="hi">{fp(day.high)}</td>
                        <td className={day.hitHigh ? "hit-y" : "hit-n"}>{day.hitHigh ? "✓" : "—"}</td>
                        <td className="lo">{fp(day.low)}</td>
                        <td className={day.hitLow ? "hit-y" : "hit-n"}>{day.hitLow ? "✓" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Lock & Bias Tab ── */}
      {tab === "lock" && (
        <div className="eng-lock-wrap">
          {MARKETS.map(mk => {
            const d = markets[mk];
            if (!d) return null;
            const lock = d.lockState;
            const adminBias = d.adminBias;
            const allowed  = d.allowedDirection;
            const biasLabel = adminBias === "AUTO"
              ? lock ? `AUTO → ${lock.direction}` : "AUTO → geen lock"
              : adminBias;
            const biasClass = (lock?.direction === "BULLISH" || adminBias === "BULLISH") ? "bull"
                            : (lock?.direction === "BEARISH" || adminBias === "BEARISH") ? "bear"
                            : "neut";

            return (
              <div key={mk} className="eng-lock-card">
                {/* Header */}
                <div className="eng-lock-head">
                  <span className="eng-mkt-title">{mk}</span>
                  <span className="eng-price">{fp(d.currentPrice)}</span>
                  <span className="eng-time">{d.currentTime} ET</span>
                  <span className={`eng-bias-pill ${biasClass}`}>{biasLabel}</span>
                  {allowed && <span className="eng-allowed-pill">Only {allowed}</span>}
                </div>

                {/* Lock detail */}
                <div className="eng-lock-body">
                  {lock ? (
                    <div className={`eng-lock-detail ${lock.direction === "BULLISH" ? "bull" : "bear"}`}>
                      <div className="eng-lock-dir">
                        {lock.direction === "BULLISH" ? "▲ BULLISH LOCK" : "▼ BEARISH LOCK"}
                        <span className="eng-lock-str">×{lock.strength}</span>
                        {lock.opportunity && (
                          <span className={`eng-opp-tag ${lock.opportunity === "BUY" ? "buy" : "sell"}`}>
                            ⚡ {lock.opportunity} KANS
                          </span>
                        )}
                      </div>
                      {lock.note && <div className="eng-lock-note">{lock.note}</div>}
                    </div>
                  ) : (
                    <div className="eng-lock-none">Geen lock — observeer beide richtingen</div>
                  )}
                </div>

                {/* Daily levels — last 5 days */}
                <div className="eng-section">DAILY LEVELS (high / low sequence)</div>
                <table className="eng-tbl">
                  <thead>
                    <tr>
                      <th>Dag</th>
                      <th className="hi">High</th>
                      <th>Swept?</th>
                      <th className="lo">Low</th>
                      <th>Swept?</th>
                      <th>Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(d.dailyLevels ?? []).map((day, i) => {
                      const bothSwept = day.hitHigh && day.hitLow;
                      const type = day.hitHigh && !day.hitLow ? "HIGH" : !day.hitHigh && day.hitLow ? "LOW" : bothSwept ? "BOTH" : "—";
                      const typeClass = type === "HIGH" ? "hi" : type === "LOW" ? "lo" : type === "BOTH" ? "" : "muted";
                      return (
                        <tr key={i} className={day.isToday ? "active-row" : ""}>
                          <td className="mono">{day.date}{day.isToday ? " ◀" : ""}</td>
                          <td className="hi">{fp(day.high)}</td>
                          <td className={day.hitHigh ? "hit-y" : "hit-n"}>
                            {day.hitHigh ? `✓ ${day.hitHigh.time}` : "—"}
                          </td>
                          <td className="lo">{fp(day.low)}</td>
                          <td className={day.hitLow ? "hit-y" : "hit-n"}>
                            {day.hitLow ? `✓ ${day.hitLow.time}` : "—"}
                          </td>
                          <td className={typeClass}><b>{type}</b></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Bias buttons */}
                <div className="eng-lock-bias-row">
                  <span className="eng-bias-label">Override bias:</span>
                  {BIAS_OPTIONS.map(b => (
                    <button key={b}
                      className={`eng-bias-btn ${(bias[mk] || bias.GLOBAL) === b ? "active " + b.toLowerCase() : ""}`}
                      onClick={() => setBiasValue(mk, b)}>{b}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Console Tab ── */}
      {tab === "console" && (
        <div className="eng-console-wrap">
          <div className="eng-console-head">
            LIVE DEBUG CONSOLE
            <button className="eng-console-btn" onClick={loadLogs}>↻ Refresh</button>
          </div>
          <div className="eng-console">
            {logs.length === 0 && (
              <div style={{color:"#4a5568", padding:"20px"}}>
                Geen events — monitor heeft nog niet gedraaid met nieuwe code.
              </div>
            )}
            {logs.map((e, i) => (
              <div key={i} className="eng-log-line">
                <span className="eng-log-time">{e.time}</span>
                <span className="eng-log-mkt">{e.market}</span>
                <span className="eng-log-ev" style={{color: logColor(e.event)}}>{e.event}</span>
                <span className="eng-log-det">{e.details}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
