import React, { useState } from "react";
import "./ContinuationSetups.css";

function fmtPrice(p, marketLabel) {
  if (p == null) return "—";
  if (typeof marketLabel === "string" && marketLabel.includes("GBP"))
    return p.toFixed(5);
  if (p > 1000)
    return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return p.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

export default function ContinuationSetups({
  continuationSignals = [],
  marketLabel = "NAS100",
  dayStats = null,
}) {
  const [collapsed, setCollapsed] = useState(false);

  const fp = p => fmtPrice(p, marketLabel);

  // Confirmed signals always stay in the active section (regardless of windowStatus)
  // until the next confirmed trade replaces them via deduplication.
  // Only forming signals move to "passed" when their window closes.
  const active = continuationSignals.filter(
    s => s.status === "confirmed" ||
         s.windowStatus === "open" ||
         s.windowStatus === "upcoming" ||
         s.windowStatus === "forming"
  );
  const passed = continuationSignals.filter(
    s => s.status !== "confirmed" && s.windowStatus === "passed"
  );

  if (!continuationSignals.length && !dayStats) return null;

  return (
    <div className="cont-wrap">
      <div className="cont-section-header" onClick={() => setCollapsed(c => !c)}>
        <span className="cont-section-icon">⟳</span>
        <span className="cont-section-title">CONTINUATION SETUPS</span>
        <span className="cont-market-label">{marketLabel}</span>
        <span className="cont-section-sub">90-min cycle confirmatie</span>
        {passed.length > 0 && (
          <span className="cont-section-badge">{passed.length} vandaag geweest</span>
        )}
        <span className="cont-chevron">{collapsed ? "▸" : "▾"}</span>
      </div>

      {!collapsed && (
        <div className="cont-body">
          {/* Day stats bar */}
          {dayStats && dayStats.total > 0 && (
            <DayStatsBar stats={dayStats} />
          )}

          {/* Active / confirmed setups */}
          {active.map((s, i) => (
            <SetupCard key={i} s={s} fp={fp} isPassed={false} />
          ))}

          {/* Passed forming setups (vandaag geweest) */}
          {passed.length > 0 && (
            <>
              <div className="cont-divider">
                <span>VANDAAG GEWEEST</span>
              </div>
              {passed.map((s, i) => (
                <SetupCard key={`p${i}`} s={s} fp={fp} isPassed={true} />
              ))}
            </>
          )}

          {active.length === 0 && passed.length === 0 && (
            <div className="cont-empty">Geen setups gedetecteerd vandaag</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Day stats bar ─────────────────────────────────────────────────────────────
function DayStatsBar({ stats }) {
  const { wins, losses, open, total, winRate } = stats;
  return (
    <div className="day-stats-bar">
      <span className="ds-label">VANDAAG</span>
      <span className="ds-win">✅ {wins} WIN</span>
      <span className="ds-loss">❌ {losses} LOSS</span>
      {open > 0 && <span className="ds-open">⏳ {open} OPEN</span>}
      {winRate !== null && (
        <span className={`ds-rate ${winRate >= 50 ? "ds-rate-pos" : "ds-rate-neg"}`}>
          {winRate}% winrate
        </span>
      )}
    </div>
  );
}

// ── Setup card ────────────────────────────────────────────────────────────────
function SetupCard({ s, fp, isPassed }) {
  const isBuy     = s.type === "BUY";
  const confirmed = s.status === "confirmed";
  const progress  = s.tradeProgress;
  const setup     = s.tradeSetup;

  return (
    <div className={`cont-card ${isBuy ? "cc-buy" : "cc-sell"} ${confirmed ? "cc-confirmed" : ""} ${isPassed ? "cc-passed" : ""}`}>
      {/* Header */}
      <div className="cc-head">
        <span className={`cc-arrow ${isBuy ? "ca-buy" : "ca-sell"}`}>{isBuy ? "▲" : "▼"}</span>
        <span className="cc-type">{s.type}</span>
        {confirmed
          ? <span className="cc-badge-confirmed">BEVESTIGD</span>
          : <span className="cc-badge-forming">FORMING</span>
        }
        {isPassed && <span className="cc-badge-passed">VOORBIJ</span>}
        {/* Trade outcome badge */}
        {confirmed && progress && progress.outcome !== "open" && (
          <span className={progress.outcome === "win" ? "cc-badge-win" : "cc-badge-loss"}>
            {progress.outcome === "win" ? "WIN ✅" : "LOSS ❌"}
          </span>
        )}
        <span className="cc-window-label">
          {s.entryWindow ? `${s.entryWindow.cycle} · ${s.entryWindow.label} ET` : "—"}
        </span>
      </div>

      {/* Trade levels — only for confirmed signals */}
      {confirmed && setup && progress && (
        <TradeLevels setup={setup} progress={progress} isBuy={isBuy} fp={fp} />
      )}

      {/* Stappen */}
      <div className="cc-steps">
        <div className="cc-step cc-step-done">
          <span className="cs-num">1</span>
          <span className="cs-text">
            {isBuy
              ? <>Break boven 90m #{s.buysideCycleIndex} ({s.buysideCycleLabel}) HIGH <strong>{fp(s.buysideCycleHigh)}</strong> @ {s.buysideBreakTime}</>
              : <>Break onder 90m #{s.sellsideCycleIndex} ({s.sellsideCycleLabel}) LOW <strong>{fp(s.sellsideCycleLow)}</strong> @ {s.sellsideBreakTime}</>
            }
          </span>
        </div>
        <div className="cc-step cc-step-done">
          <span className="cs-num">2</span>
          <span className="cs-text">
            {isBuy
              ? <>Sellside 90m #{s.sellsideCycleIndex} ({s.sellsideCycleLabel}) LOW {fp(s.sellsideCycleLow)} geraakt @ {s.sellsideHitTime} · laagste: <strong>{fp(s.slPrice)}</strong> @ {s.slTime}</>
              : <>Buyside 90m #{s.buysideCycleIndex} ({s.buysideCycleLabel}) HIGH {fp(s.buysideCycleHigh)} geraakt @ {s.buysideHitTime} · hoogste: <strong>{fp(s.slPrice)}</strong> @ {s.slTime}</>
            }
          </span>
        </div>
        <div className={`cc-step ${confirmed ? "cc-step-done" : "cc-step-wait"}`}>
          <span className="cs-num">3</span>
          <span className="cs-text">
            {confirmed
              ? (isBuy
                ? <><span className="cs-bos">BOS</span> boven HIGH <strong>{fp(s.confirmBuysideHigh)}</strong> {s.confirmBuysideLabel && <>· 90m #{s.confirmBuysideCycleIndex} ({s.confirmBuysideLabel}) </>}@ {s.breakConfirmedTime} — <strong>BUY ✓</strong></>
                : <><span className="cs-bos">BOS</span> onder LOW <strong>{fp(s.confirmSellsideLow)}</strong> {s.confirmSellsideLabel && <>· 90m #{s.confirmSellsideCycleIndex} ({s.confirmSellsideLabel}) </>}@ {s.breakConfirmedTime} — <strong>SELL ✓</strong></>)
              : (isBuy
                ? <>Wacht op <span className="cs-bos">BOS</span> boven 90m #{s.confirmBuysideCycleIndex ?? s.buysideCycleIndex} ({s.confirmBuysideLabel ?? s.buysideCycleLabel}) HIGH = <strong>{fp(s.confirmBuysideHigh ?? s.buysideCycleHigh)}</strong>{s.confirmBuysideIsLive && <span className="cs-live-tag">live</span>}</>
                : <>Wacht op <span className="cs-bos">BOS</span> onder 90m #{s.confirmSellsideCycleIndex ?? s.sellsideCycleIndex} ({s.confirmSellsideLabel ?? s.sellsideCycleLabel}) LOW = <strong>{fp(s.confirmSellsideLow ?? s.sellsideCycleLow)}</strong>{s.confirmSellsideIsLive && <span className="cs-live-tag">live</span>}</>)
            }
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Trade levels ──────────────────────────────────────────────────────────────
function TradeLevels({ setup, progress, isBuy, fp }) {
  const { entry, sl, tp, risk } = setup;
  const { pnl, outcome, slHit, tpHit, currentPrice } = progress;

  // Forex (entry < 100): scale to pips (×10000). Indices/gold: use as-is.
  const isForex = entry < 100;
  const scale   = isForex ? 10000 : 1;
  const unit    = isForex ? "pips" : "pts";
  const fmtPts  = v => `${(Math.abs(v) * scale).toFixed(1)} ${unit}`;

  const pnlClass = outcome === "win" ? "tl-win"
    : outcome === "loss" ? "tl-loss"
    : pnl > 0 ? "tl-win" : pnl < 0 ? "tl-loss" : "tl-flat";

  const pnlStr = outcome === "win"  ? `+${fmtPts(Math.abs(tp - entry))} TP ✅`
    : outcome === "loss" ? `−${fmtPts(risk)} SL ❌`
    : pnl >= 0 ? `+${fmtPts(pnl)}` : `−${fmtPts(pnl)}`;

  // Progress bar: % from entry to TP (capped)
  const entryToTp = Math.abs(tp - entry);
  const pct = entryToTp > 0 ? Math.min(100, Math.max(-50, (pnl / entryToTp) * 100)) : 0;

  return (
    <div className={`trade-levels ${isBuy ? "tl-long" : "tl-short"} ${outcome !== "open" ? "tl-closed" : ""}`}>
      <div className="tl-header-row">
        <span className="tl-cur-label">Live prijs</span>
        <span className="tl-cur-price">{fp(currentPrice)}</span>
        <span className={`tl-pnl-badge ${pnlClass}`}>{pnlStr}</span>
      </div>

      {/* Mini progress bar */}
      {outcome === "open" && entryToTp > 0 && (
        <div className="tl-bar-wrap">
          <div className="tl-bar-track">
            <div
              className={`tl-bar-fill ${pnl >= 0 ? "tl-bar-win" : "tl-bar-loss"}`}
              style={{ width: `${Math.min(100, Math.abs(pct))}%`, ...(pnl < 0 ? { right: "50%", left: "auto" } : { left: "50%" }) }}
            />
            <div className="tl-bar-center" />
          </div>
          <div className="tl-bar-labels">
            <span className="tl-bar-sl">SL</span>
            <span className="tl-bar-entry">ENTRY</span>
            <span className="tl-bar-tp">TP</span>
          </div>
        </div>
      )}

      <div className="tl-rows">
        <TlRow label="Entry"  value={fp(entry)} cls="tl-entry-row" />
        <TlRow label="SL"     value={fp(sl)}    cls={`tl-sl-row ${slHit ? "tl-hit" : ""}`} extra={slHit ? `geraakt @ ${slHit.time}` : risk ? `${fmtPts(risk)} risico` : null} />
        <TlRow label="TP 1:2" value={fp(tp)}    cls={`tl-tp-row ${tpHit ? "tl-hit" : ""}`} extra={tpHit ? `geraakt @ ${tpHit.time}` : null} />
      </div>
    </div>
  );
}

function TlRow({ label, value, cls, extra }) {
  return (
    <div className={`tl-row ${cls || ""}`}>
      <span className="tlr-label">{label}</span>
      <span className="tlr-value mono">{value}</span>
      {extra && <span className="tlr-extra">{extra}</span>}
    </div>
  );
}
