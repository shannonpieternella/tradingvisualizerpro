import React from "react";
import "./MatrixUnlocked.css";
import "./ContinuationSetups.css"; // hergebruik tl-* stijlen voor TradeLevels

function fmtPrice(p, marketLabel) {
  if (p == null) return "—";
  if (typeof marketLabel === "string" && marketLabel.includes("GBP"))
    return p.toFixed(5);
  if (p > 1000)
    return p.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  return p.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 5 });
}

// ── Trade levels (zelfde logica als ContinuationSetups) ───────────────────────
function TradeLevels({ setup, progress, isBuy, fp }) {
  const { entry, sl, tp, risk } = setup;
  const { pnl, outcome, slHit, tpHit, currentPrice } = progress;

  // Forex (entry < 100): schaal naar pips (×10000). Indices/goud: as-is.
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

  const entryToTp = Math.abs(tp - entry);
  const pct = entryToTp > 0 ? Math.min(100, Math.max(-50, (pnl / entryToTp) * 100)) : 0;

  return (
    <div className={`trade-levels ${isBuy ? "tl-long" : "tl-short"} ${outcome !== "open" ? "tl-closed" : ""}`}>
      <div className="tl-header-row">
        <span className="tl-cur-label">Live prijs</span>
        <span className="tl-cur-price">{fp(currentPrice)}</span>
        <span className={`tl-pnl-badge ${pnlClass}`}>{pnlStr}</span>
      </div>

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
        <div className="tl-row tl-entry-row">
          <span className="tlr-label">Entry</span>
          <span className="tlr-value mono">{fp(entry)}</span>
        </div>
        <div className={`tl-row tl-sl-row ${slHit ? "tl-hit" : ""}`}>
          <span className="tlr-label">SL</span>
          <span className="tlr-value mono">{fp(sl)}</span>
          {slHit
            ? <span className="tlr-extra">geraakt @ {slHit.time}</span>
            : risk ? <span className="tlr-extra">{fmtPts(risk)} risico</span> : null}
        </div>
        <div className={`tl-row tl-tp-row ${tpHit ? "tl-hit" : ""}`}>
          <span className="tlr-label">TP 1:2</span>
          <span className="tlr-value mono">{fp(tp)}</span>
          {tpHit && <span className="tlr-extra">geraakt @ {tpHit.time}</span>}
        </div>
      </div>
    </div>
  );
}

export default function MatrixUnlocked({ matrixUnlocked = [], marketLabel = "NAS100" }) {
  if (!matrixUnlocked.length) return null;

  const fp = p => fmtPrice(p, marketLabel);

  return (
    <div className="matrix-wrap">
      {matrixUnlocked.map((mu, i) => {
        const isBuy      = mu.matrixType === "BUY";
        const confirmed  = mu.status === "confirmed";
        const isUnlocked = mu.matrixLevel === "unlocked";
        const hasLevels  = confirmed && mu.tradeSetup && mu.tradeProgress;

        // Stap 1: tijd van de break
        const step1Time = isBuy ? mu.buysideBreakTime : mu.sellsideBreakTime;
        // Stap 2: tijd van de retracement hit + extreme (slPrice/slTime)
        const step2HitTime = isBuy ? mu.sellsideHitTime : mu.buysideHitTime;
        // Stap 3: bevestigingsniveau
        const step3Level = isBuy ? mu.confirmBuysideHigh : mu.confirmSellsideLow;

        return (
          <div key={i} className={`matrix-card ${isBuy ? "matrix-buy" : "matrix-sell"} ${isUnlocked ? "" : "matrix-aligned"}`}>
            {/* Header */}
            <div className="matrix-header">
              <span className="matrix-lock">{isUnlocked ? "🔓" : "⚡"}</span>
              <span className={`matrix-title ${isUnlocked ? "" : "matrix-title-aligned"}`}>
                {isUnlocked ? "MATRIX UNLOCKED" : "ALIGNED"}
              </span>
              <span className="matrix-market-label">{marketLabel}</span>
              <span className={`matrix-dir ${isBuy ? "mdir-buy" : "mdir-sell"}`}>
                {isBuy ? "▲ BUY" : "▼ SELL"}
              </span>
              <span className={`matrix-status ${confirmed ? "mstatus-confirmed" : "mstatus-forming"}`}>
                {confirmed ? "BEVESTIGD" : "FORMING"}
              </span>
              {mu.entryWindow && (
                <span className="matrix-window">
                  {mu.entryWindow.cycle} · {mu.entryWindow.label} ET
                </span>
              )}
            </div>

            <div className={`matrix-subtitle ${isUnlocked ? "" : "matrix-subtitle-aligned"}`}>
              {isUnlocked
                ? "💎 Dubbele bevestiging — 90min continuation + 6hr cycle aligned"
                : "⏳ 6hr cycle aligned — wacht op break bevestiging"
              }
            </div>

            {/* Trade levels — alleen bij confirmed met setup */}
            {hasLevels && (
              <TradeLevels
                setup={mu.tradeSetup}
                progress={mu.tradeProgress}
                isBuy={isBuy}
                fp={fp}
              />
            )}

            {/* 90-min stappen */}
            <div className="matrix-section-label">90-MIN CONTINUATION</div>
            <div className="matrix-steps">
              {/* Stap 1: break boven/onder de 90m cyclus */}
              <div className="matrix-step done">
                <span className="ms-num">1</span>
                <span className="ms-text">
                  {isBuy
                    ? <>Break boven 90m #{mu.buysideCycleIndex} ({mu.buysideCycleLabel}) HIGH <strong>{fp(mu.buysideCycleHigh)}</strong> @ {step1Time}</>
                    : <>Break onder 90m #{mu.sellsideCycleIndex} ({mu.sellsideCycleLabel}) LOW <strong>{fp(mu.sellsideCycleLow)}</strong> @ {step1Time}</>
                  }
                </span>
              </div>

              {/* Stap 2: retracement naar andere kant */}
              <div className="matrix-step done">
                <span className="ms-num">2</span>
                <span className="ms-text">
                  {isBuy
                    ? <>
                        Sellside 90m #{mu.sellsideCycleIndex} ({mu.sellsideCycleLabel}) LOW {fp(mu.sellsideCycleLow)} geraakt @ {step2HitTime}
                        {mu.slPrice && <> · laagste: <strong>{fp(mu.slPrice)}</strong> @ {mu.slTime}</>}
                      </>
                    : <>
                        Buyside 90m #{mu.buysideCycleIndex} ({mu.buysideCycleLabel}) HIGH {fp(mu.buysideCycleHigh)} geraakt @ {step2HitTime}
                        {mu.slPrice && <> · hoogste: <strong>{fp(mu.slPrice)}</strong> @ {mu.slTime}</>}
                      </>
                  }
                </span>
              </div>

              {/* Stap 3: bevestiging break */}
              <div className={`matrix-step ${confirmed ? "done" : "wait"}`}>
                <span className="ms-num">3</span>
                <span className="ms-text">
                  {confirmed
                    ? (isBuy
                      ? <><span className="ms-bos">BOS</span> boven HIGH <strong>{fp(step3Level)}</strong> {mu.confirmBuysideLabel && <>· 90m #{mu.confirmBuysideCycleIndex} ({mu.confirmBuysideLabel}) </>}@ {mu.breakConfirmedTime} — <strong>BUY ✓</strong></>
                      : <><span className="ms-bos">BOS</span> onder LOW <strong>{fp(step3Level)}</strong> {mu.confirmSellsideLabel && <>· 90m #{mu.confirmSellsideCycleIndex} ({mu.confirmSellsideLabel}) </>}@ {mu.breakConfirmedTime} — <strong>SELL ✓</strong></>)
                    : (isBuy
                      ? <>Wacht op <span className="ms-bos">BOS</span> boven 90m #{mu.confirmBuysideCycleIndex ?? mu.buysideCycleIndex} ({mu.confirmBuysideLabel ?? mu.buysideCycleLabel}) HIGH = <strong>{fp(step3Level ?? mu.buysideCycleHigh)}</strong>{mu.confirmBuysideIsLive && <span className="ms-live-tag">live</span>}</>
                      : <>Wacht op <span className="ms-bos">BOS</span> onder 90m #{mu.confirmSellsideCycleIndex ?? mu.sellsideCycleIndex} ({mu.confirmSellsideLabel ?? mu.sellsideCycleLabel}) LOW = <strong>{fp(step3Level ?? mu.sellsideCycleLow)}</strong>{mu.confirmSellsideIsLive && <span className="ms-live-tag">live</span>}</>)
                  }
                </span>
              </div>
            </div>

            {/* 6-uur alignment */}
            <div className="matrix-section-label">6-UUR CYCLE ALIGNMENT</div>
            <div className="matrix-sixhr">
              <span className="sixhr-check">✅</span>
              <span className="sixhr-text">
                {mu.sixHrSide} {fp(mu.sixHrLevel)} ({mu.sixHrCycle}) geraakt @ {mu.sixHrHitTime}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
