import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import WeeklyOHLC from "./WeeklyOHLC.jsx";
import OrderFlowChart from "./OrderFlowChart.jsx";
import "./BiasPanel.css";

const DAY_ORDER = ["Monday","Tuesday","Wednesday","Thursday","Friday"];

function fmtPrice(v) {
  if (v == null) return "—";
  if (v < 10)   return v.toFixed(5);   // forex e.g. 1.32345
  if (v < 100)  return v.toFixed(3);   // e.g. GBPUSD high range
  if (v < 10000) return v.toFixed(1);  // NAS100/XAU
  return v.toFixed(0);
}

function ConfidenceBar({ value }) {
  const color = value >= 75 ? "#00d4ff" : value >= 55 ? "#f5c518" : "#8899b4";
  return (
    <div className="bp-conf-bar">
      <div className="bp-conf-fill" style={{ width: `${value}%`, background: color }} />
      <span className="bp-conf-label">{value}%</span>
    </div>
  );
}

function EQLevelRow({ item, type }) {
  const icon   = type === "EQH" ? "▲" : "▼";
  const cls    = type === "EQH" ? "bp-eqh" : "bp-eql";
  return (
    <div className={`bp-eq-row ${cls}`}>
      <span className="bp-eq-icon">{icon}</span>
      <span className="bp-eq-level">{item.level.toLocaleString("en-US", { minimumFractionDigits: 0 })}</span>
      <span className="bp-eq-days">{item.dayA} / {item.dayB}</span>
      <span className="bp-eq-diff">{item.diffPct}%</span>
      {item.priceDistance !== null && (
        <span className="bp-eq-dist">
          {type === "EQH" ? "+" : "-"}{Math.abs(item.priceDistance).toFixed(0)} pts
        </span>
      )}
    </div>
  );
}

export default function BiasPanel({ activeMarket = "NAS100", autonomousFilter, onBiasChange }) {
  const { authFetch, user } = useAuth();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [overrideDir, setOverrideDir]     = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [showOverride, setShowOverride]   = useState(false);
  const [saving, setSaving]     = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res  = await authFetch(`/api/bias?market=${activeMarket}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setData(json.bias);
      setError(null);
      onBiasChange?.(json.bias);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch, activeMarket, onBiasChange]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [load]);

  async function handleSetOverride() {
    if (!overrideDir) return;
    setSaving(true);
    try {
      await authFetch("/api/bias/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: overrideDir, reason: overrideReason }),
      });
      setShowOverride(false);
      setOverrideDir("");
      setOverrideReason("");
      await load();
    } finally { setSaving(false); }
  }

  async function handleClearOverride() {
    setSaving(true);
    try {
      await authFetch("/api/bias/override", { method: "DELETE" });
      await load();
    } finally { setSaving(false); }
  }

  if (loading) return (
    <div className="bp-root bp-loading">
      <div className="bp-spinner" /><span>Bias laden...</span>
    </div>
  );
  if (error) return (
    <div className="bp-root bp-error">
      <span className="bp-error-icon">⚠</span>
      <span>{error}</span>
      <button className="bp-retry" onClick={load}>Retry</button>
    </div>
  );
  if (!data) return null;

  const { bias, confidence, primarySignal, reasons, orderFlow, topDown,
          fractalSignals, equalHighs, equalLows,
          primaryEQH, primaryEQL, weeklyOHLC, todayName, priceZone, currentPrice,
          dowAdvice, wednesday, thursday, friday, overridden, override, dailyOHLC, weeklyCandles,
          orderFlowMoves } = data;

  const biasClass = bias === "BULLISH" ? "bp-bull" : bias === "BEARISH" ? "bp-bear" : "bp-neutral";
  const biasIcon  = bias === "BULLISH" ? "▲" : bias === "BEARISH" ? "▼" : "◆";

  const wOHLC = weeklyOHLC;
  const weekRange    = wOHLC ? wOHLC.high - wOHLC.low : 0;
  const priceInWeek  = wOHLC && weekRange > 0
    ? Math.min(100, Math.max(0, ((currentPrice - wOHLC.low) / weekRange) * 100))
    : 50;

  const todayIndex = DAY_ORDER.indexOf(todayName);

  // Fractal signal card helper
  function FractalSignalCard({ label, fullLabel, sig }) {
    if (!sig) return null;
    const hasSignal = sig.type !== null;
    const isBuy     = sig.type === "BUY";
    const dirIcon   = sig.direction === "BULLISH" ? "▲" : sig.direction === "BEARISH" ? "▼" : "◆";
    const sigClass  = hasSignal
      ? (isBuy ? "bp-fs-buy" : "bp-fs-sell")
      : (sig.direction === "BULLISH" ? "bp-fs-bull" : sig.direction === "BEARISH" ? "bp-fs-bear" : "bp-fs-neut");
    const lv = sig.levels;

    return (
      <div className={`bp-fs-card ${sigClass}`}>
        <div className="bp-fs-top">
          <span className="bp-fs-label">{label}</span>
          <span className="bp-fs-dir">{dirIcon} {sig.direction}</span>
          <span className="bp-fs-conf">{sig.confidence}%</span>
        </div>
        {/* Exact levels from the lock sequence */}
        {lv && (
          <div className="bp-fs-levels">
            <span className="bp-fs-lv-row bp-fs-lv-bsl" title="Buyside liquidity level swept">
              BSL <b>{fmtPrice(lv.bslLevel)}</b>
              {lv.sweepLabel && <span className="bp-fs-lv-lbl">({lv.sweepLabel})</span>}
            </span>
            <span className="bp-fs-lv-arr">→</span>
            <span className="bp-fs-lv-row bp-fs-lv-ssl" title="Sellside liquidity level swept">
              SSL <b>{fmtPrice(lv.sslLevel)}</b>
              {lv.pullbackLabel && <span className="bp-fs-lv-lbl">({lv.pullbackLabel})</span>}
            </span>
            <span className="bp-fs-lv-arr">→</span>
            <span className="bp-fs-lv-row bp-fs-lv-lock" title="Level that confirmed the lock">
              Lock <b>{fmtPrice(lv.lockLevel)}</b>
              {lv.lockLabel && <span className="bp-fs-lv-lbl">({lv.lockLabel})</span>}
            </span>
            {lv.currentPullback != null && (
              <span className="bp-fs-lv-pullback" title="Current pullback level (opportunity)">
                ↓ Pullback <b>{fmtPrice(lv.currentPullback)}</b>
              </span>
            )}
          </div>
        )}
        {hasSignal && (
          <div className="bp-fs-signal">
            <span className={`bp-fs-type ${isBuy ? "bp-fs-type-buy" : "bp-fs-type-sell"}`}>
              {isBuy ? "▲ BUY" : "▼ SELL"}
            </span>
            <span className="bp-fs-entry">{sig.entryWindow}</span>
          </div>
        )}
        {!hasSignal && (
          <div className="bp-fs-context">
            {sig.structure === "INSUFFICIENT_DATA"
              ? "⚠ te weinig data — monitor loopt"
              : sig.lockStrength > 0
                ? "Locked — wacht op pullback"
                : sig.direction !== "NEUTRAL"
                  ? sig.structure?.replace(/_/g," ").toLowerCase()
                  : "geen lock — observeer"}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bp-root">
      {/* Header + toggle */}
      <div className="bp-header">
        <span className="bp-title">Bias & Fractal Signals</span>
        <div className={`bp-auto-badge ${autonomousFilter ? "bp-auto-on" : "bp-auto-off"}`}>
          {autonomousFilter ? "● AAN" : "○ UIT"}
        </div>
      </div>

      {overridden && (
        <div className="bp-override-banner">
          HANDMATIGE OVERRIDE actief — {override?.reason || "geen reden"} ({override?.setBy})
        </div>
      )}

      {/* ── ORDER FLOW CHART ── */}
      {orderFlowMoves?.daily?.length > 2 && (
        <OrderFlowChart
          moves={orderFlowMoves.daily}
          lockLevels={fractalSignals?.daily?.levels}
          currentPrice={currentPrice}
          title="Daily Order Flow — BSL / SSL structuur"
        />
      )}

      {/* ── FRACTAL SIGNALS — three independent timeframe signals ── */}
      {fractalSignals && (
        <div className="bp-fractal-signals">
          <div className="bp-fs-header">
            <span className="bp-fs-title">Fractal Order Flow Signals</span>
            </div>
          <div className="bp-fs-grid">
            <FractalSignalCard label="W" fullLabel="Weekly"   sig={fractalSignals.weekly} />
            <FractalSignalCard label="D" fullLabel="Daily"    sig={fractalSignals.daily}  />
          </div>
        </div>
      )}

      {/* Bias direction (context) */}
      <div className={`bp-bias-row ${biasClass}`}>
        <span className="bp-bias-icon">{biasIcon}</span>
        <span className="bp-bias-label">{bias}</span>
        <ConfidenceBar value={confidence} />
      </div>

      {/* Primary signal */}
      {primarySignal && (
        <div className={`bp-signal-badge ${primarySignal.startsWith("FRIDAY_REVERSION") ? "bp-signal-reversion" : primarySignal.startsWith("TOPDOWN") ? "bp-signal-topdown" : ""}`}>
          {primarySignal === "ORDER_FLOW_BULLISH"          && "⚡ Order flow bullish — C3 high gebroken"}
          {primarySignal === "ORDER_FLOW_BEARISH"          && "⚡ Order flow bearish — C3 low gebroken"}
          {primarySignal === "TOPDOWN_FULL_BUY"            && "🎯 Fractaal BUY — weekly+daily+cycle bullish"}
          {primarySignal === "TOPDOWN_FULL_SELL"           && "🎯 Fractaal SELL — weekly+daily+cycle bearish"}
          {primarySignal === "TOPDOWN_BULLISH"             && "◈ Top-down gedeeltelijk bullish"}
          {primarySignal === "TOPDOWN_BEARISH"             && "◈ Top-down gedeeltelijk bearish"}
          {primarySignal === "TOPDOWN_BUY"                 && "◈ Top-down BUY setup — pullback in bullish trend"}
          {primarySignal === "TOPDOWN_SELL"                && "◈ Top-down SELL setup — pullback in bearish trend"}
          {primarySignal === "EQH_PENDING"                 && "🎯 EQH niet geswept — bullish"}
          {primarySignal === "EQL_PENDING"                 && "🎯 EQL niet geswept — bearish"}
          {primarySignal === "WEDNESDAY_REVERSAL_BEARISH"  && "↩ Woensdag bearish reversal"}
          {primarySignal === "WEDNESDAY_REVERSAL_BULLISH"  && "↩ Woensdag bullish reversal"}
          {primarySignal === "FRIDAY_REVERSION_BEARISH"    && `↩ Vrijdag reversion ACTIEF (${friday?.currentCycle}) — BEARISH`}
          {primarySignal === "FRIDAY_REVERSION_BULLISH"    && `↩ Vrijdag reversion ACTIEF (${friday?.currentCycle}) — BULLISH`}
          {primarySignal === "MANUAL_OVERRIDE"             && "✋ Handmatig override"}
        </div>
      )}

      {/* Reasons */}
      <div className="bp-reasons">
        {reasons.slice(0,3).map((r, i) => (
          <div key={i} className="bp-reason-row">
            <span className="bp-reason-dot">·</span>{r}
          </div>
        ))}
      </div>

      {/* Weekly OHLC bar */}
      {wOHLC && (
        <div className="bp-weekly-ohlc">
          <div className="bp-ohlc-label">WEEK OHLC</div>
          <div className="bp-ohlc-vals">
            <span>O <b>{wOHLC.open.toFixed(0)}</b></span>
            <span>H <b className="bp-high">{wOHLC.high.toFixed(0)}</b></span>
            <span>L <b className="bp-low">{wOHLC.low.toFixed(0)}</b></span>
            <span>C <b>{wOHLC.close.toFixed(0)}</b></span>
          </div>
          {/* Price position bar */}
          <div className="bp-price-bar-wrap">
            <span className="bp-price-bar-label">Low</span>
            <div className="bp-price-bar">
              <div className="bp-price-needle" style={{ left: `${priceInWeek}%` }} />
              <div className="bp-price-zone-fill"
                style={{
                  left: priceInWeek > 50 ? "50%" : `${priceInWeek}%`,
                  width: Math.abs(priceInWeek - 50) + "%",
                  background: priceInWeek > 50 ? "rgba(0,212,255,0.15)" : "rgba(255,80,80,0.15)",
                }} />
            </div>
            <span className="bp-price-bar-label">High</span>
            <span className={`bp-zone-label bp-zone-${priceZone.toLowerCase()}`}>{priceZone}</span>
          </div>
        </div>
      )}

      {/* Day-of-week tracker */}
      <div className="bp-dow-strip">
        {DAY_ORDER.map((d, i) => (
          <div key={d} className={`bp-dow-cell ${i === todayIndex ? "bp-dow-today" : ""} ${i < todayIndex ? "bp-dow-past" : ""}`}>
            <span className="bp-dow-name">{d.slice(0,3)}</span>
            {i === todayIndex && dowAdvice && (
              <span className={`bp-dow-phase bp-phase-${dowAdvice.highlight?.toLowerCase()}`}>
                {dowAdvice.phase}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Today's advice */}
      {dowAdvice && (
        <div className={`bp-advice bp-advice-${dowAdvice.highlight?.toLowerCase()}`}>
          <div className="bp-advice-title">{todayName} — {dowAdvice.phase}</div>
          <div className="bp-advice-text">{dowAdvice.entryAdvice}</div>
          <div className="bp-cycle-grid">
            <div className="bp-cycle-row">
              <span className="bp-cycle-lbl bp-cycle-high">✓</span>
              {["C1","C2","C3","C4"].map(c => {
                const isHigh = dowAdvice.highProb.includes(c);
                const isLow  = dowAdvice.lowProb.includes(c);
                return (
                  <span key={c} className={`bp-cycle-badge ${isHigh ? "bp-cycle-good" : isLow ? "bp-cycle-weak" : "bp-cycle-neutral"}`}>
                    {c}
                    {isHigh && <span className="bp-cycle-star">★</span>}
                  </span>
                );
              })}
            </div>
          </div>
          {dowAdvice.note && (
            <div className="bp-advice-note">{dowAdvice.note}</div>
          )}
        </div>
      )}

      {/* Equal Highs */}
      {equalHighs.length > 0 && (
        <div className="bp-eq-section">
          <div className="bp-eq-title">Equal Highs (EQH)</div>
          {equalHighs.map((e, i) => <EQLevelRow key={i} item={e} type="EQH" />)}
        </div>
      )}

      {/* Equal Lows */}
      {equalLows.length > 0 && (
        <div className="bp-eq-section">
          <div className="bp-eq-title">Equal Lows (EQL)</div>
          {equalLows.map((e, i) => <EQLevelRow key={i} item={e} type="EQL" />)}
        </div>
      )}

      {/* Wednesday special */}
      {wednesday?.analyzed && (
        <div className={`bp-wed-block ${wednesday.isReversal ? "bp-wed-reversal" : "bp-wed-cont"}`}>
          <span className="bp-wed-icon">{wednesday.isReversal ? "↩" : "→"}</span>
          <span className="bp-wed-text">
            {wednesday.isReversal
              ? wednesday.isBearishReversal
                ? "Woensdag bearish reversal — houd bearish bias"
                : "Woensdag bullish reversal — houd bullish bias"
              : wednesday.eqHighContinuation
                ? "Woensdag liet EQH achter — trend gaat door (bullish)"
                : wednesday.eqLowContinuation
                  ? "Woensdag liet EQL achter — trend gaat door (bearish)"
                  : "Woensdag: geen reversal — observeer"}
          </span>
        </div>
      )}

      {/* Thursday C4 reminder */}
      {todayName === "Thursday" && thursday?.applicable && (
        <div className="bp-thu-block">
          <span className="bp-thu-icon">⏰</span>
          <div>
            <div className="bp-thu-title">C4 Entry Focus (13:30–15:00 ET)</div>
            <div className="bp-thu-text">{thursday.advice}</div>
          </div>
        </div>
      )}

      {/* Friday reversion block */}
      {todayName === "Friday" && friday?.applicable && (
        <div className={`bp-fri-block ${
          friday.isHighProbReversion
            ? friday.reversionActive ? "bp-fri-reversion" : "bp-fri-waiting"
            : "bp-fri-close"
        }`}>
          <span className="bp-fri-icon">
            {friday.isHighProbReversion
              ? friday.reversionActive ? "↩" : "⏳"
              : "◻"}
          </span>
          <div style={{ flex: 1 }}>
            <div className="bp-fri-title">
              {friday.isHighProbReversion
                ? friday.reversionActive
                  ? `Reversion ACTIEF (${friday.currentCycle}) — ${friday.reversionDirection}`
                  : `Reversion wacht op C3 (nu ${friday.currentCycle}) — nog ${friday.wholeWeekBullish ? "BULLISH" : "BEARISH"}`
                : "Vrijdag — Weekly Close"}
            </div>
            <div className="bp-fri-text">{friday.advice}</div>
            {friday.isHighProbReversion && (
              <div className="bp-fri-stats">
                <span className="bp-fri-stat">
                  {friday.wholeWeekBullish ? friday.bullDays : friday.bearDays}/4 dagen
                  {friday.wholeWeekBullish ? " bullish" : " bearish"}
                </span>
                <span className="bp-fri-stat">Week {friday.weekNetPct > 0 ? "+" : ""}{friday.weekNetPct}%</span>
                <span className="bp-fri-stat bp-fri-target">
                  Target C3+: {friday.reversionTarget?.toLocaleString("en-US")}
                </span>
                <span className="bp-fri-stat bp-fri-conf">
                  {friday.reversionConfidence}% kans
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Weekly OHLC visual candle chart */}
      {weeklyCandles?.length > 0 && dailyOHLC?.length > 0 && (
        <WeeklyOHLC
          weeklyCandles={weeklyCandles}
          dailyCandles={dailyOHLC}
          equalHighs={equalHighs}
          equalLows={equalLows}
          currentPrice={currentPrice}
        />
      )}

      {/* Override controls — admin only */}
      {user?.isAdmin && (
        <div className="bp-override-section">
          {!showOverride ? (
            <div className="bp-override-btns">
              {overridden
                ? <button className="bp-override-clear" onClick={handleClearOverride} disabled={saving}>
                    ✕ Override verwijderen
                  </button>
                : <button className="bp-override-open" onClick={() => setShowOverride(true)}>
                    ✎ Bias overschrijven
                  </button>
              }
            </div>
          ) : (
            <div className="bp-override-form">
              <div className="bp-override-form-title">Handmatige Bias Override</div>
              <div className="bp-override-dir-row">
                {["BULLISH","BEARISH","NEUTRAL"].map(d => (
                  <button
                    key={d}
                    className={`bp-override-dir ${overrideDir === d ? "bp-override-dir-active" : ""} bp-dir-${d.toLowerCase()}`}
                    onClick={() => setOverrideDir(d)}
                  >
                    {d === "BULLISH" ? "▲" : d === "BEARISH" ? "▼" : "◆"} {d}
                  </button>
                ))}
              </div>
              <input
                className="bp-override-reason"
                placeholder="Reden (optioneel)"
                value={overrideReason}
                onChange={e => setOverrideReason(e.target.value)}
              />
              <div className="bp-override-action-row">
                <button className="bp-override-save" onClick={handleSetOverride} disabled={saving || !overrideDir}>
                  {saving ? "..." : "Opslaan"}
                </button>
                <button className="bp-override-cancel" onClick={() => setShowOverride(false)}>
                  Annuleren
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
