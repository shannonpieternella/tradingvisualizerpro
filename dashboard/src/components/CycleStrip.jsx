import React, { useState } from "react";
import "./CycleStrip.css";

const CYCLE_ORDER = ["C1", "C2", "C3", "C4"];
const CYCLE_TIMES = {
  C1: "18–00", C2: "00–06", C3: "06–12", C4: "12–18",
};

export default function CycleStrip({ cycles, prevC4, activeCycle, currentPrice, cycles90 }) {
  const [show90, setShow90] = useState(false);

  const ordered  = CYCLE_ORDER.map(name => cycles?.find(c => c.name === name)).filter(Boolean);
  const allCycles = prevC4 ? [{ ...prevC4, isPrev: true }, ...ordered] : ordered;

  // Group 90-min cycles by their parent 6h cycle
  const cycles90Grouped = {};
  if (cycles90?.length) {
    for (const c of cycles90) {
      const parent = c.parentCycle ?? c.name?.replace(/\.\d+$/, "") ?? "?";
      if (!cycles90Grouped[parent]) cycles90Grouped[parent] = [];
      cycles90Grouped[parent].push(c);
    }
  }
  const has90 = cycles90?.length > 0;

  return (
    <div className="cycle-strip-wrapper">
      <div className="cycle-strip-header">
        <span className="strip-label">6H Cycles</span>
        <div className="strip-header-right">
          {has90 && (
            <button className="strip-toggle strip-90-btn" onClick={() => setShow90(v => !v)}>
              {show90 ? "◀ 6H" : "▶ 90min"}
            </button>
          )}
        </div>
      </div>

      {/* 6H Cycles */}
      {!show90 && (
        <div className="cycle-strip">
          {allCycles.map(cyc => (
            <CycleCell
              key={cyc.name + (cyc.isPrev ? "-prev" : "")}
              cyc={cyc}
              isActive={cyc.name === activeCycle}
              currentPrice={currentPrice}
            />
          ))}
        </div>
      )}

      {/* 90-min cycles */}
      {show90 && has90 && (
        <div className="cycle-90-grid">
          {CYCLE_ORDER.map(parentName => {
            const subs = cycles90Grouped[parentName];
            if (!subs?.length) return null;
            const isParentActive = parentName === activeCycle;
            return (
              <div key={parentName} className={`cycle-90-group ${isParentActive ? "group-active" : ""}`}>
                <div className="cycle-90-parent-label">{parentName} <span className="c90-time">{CYCLE_TIMES[parentName]} ET</span></div>
                <div className="cycle-90-cells">
                  {subs.map((c, i) => (
                    <Cycle90Cell key={i} cyc={c} currentPrice={currentPrice} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CycleCell({ cyc, isActive, currentPrice }) {
  const noData     = cyc.status === "no_data";
  const isComplete = cyc.status === "complete";
  const isPrev     = cyc.isPrev;

  const distHigh = cyc.high != null ? (cyc.high - currentPrice).toFixed(1) : null;
  const distLow  = cyc.low  != null ? (currentPrice - cyc.low).toFixed(1) : null;
  const nearHigh = distHigh != null && Math.abs(distHigh) < 50;
  const nearLow  = distLow  != null && Math.abs(distLow)  < 50;

  const highEntry = cyc.entryHigh?.status;
  const lowEntry  = cyc.entryLow?.status;

  return (
    <div className={`cycle-cell ${isActive ? "cell-active" : ""} ${isPrev ? "cell-prev" : ""} ${noData ? "cell-nodata" : ""}`}>
      <div className="cell-top">
        <span className="cell-name">{isPrev ? "prev" : cyc.name}</span>
        {isActive && <span className="cell-live-dot" />}
        <span className={`cell-badge ${isActive ? "badge-live" : isComplete ? "badge-done" : "badge-empty"}`}>
          {isActive ? "LIVE" : isComplete ? "✓" : "—"}
        </span>
      </div>

      {noData ? (
        <span className="cell-nodata-txt">—</span>
      ) : (
        <>
          <div className={`cell-level cell-high ${nearHigh ? "cell-near" : ""}`}>
            <span className="cell-hl-label">H</span>
            <span className="cell-hl-val">{cyc.high?.toFixed(0)}</span>
            {distHigh != null && <span className={`cell-dist ${nearHigh ? "dist-near" : ""}`}>{distHigh > 0 ? `+${distHigh}` : distHigh}</span>}
            {isComplete && cyc.hitHigh && <span className="cell-hit-dot hit-short" title={`Hit @ ${cyc.hitHigh.time}`}>▼</span>}
            {isComplete && highEntry === "open" && <span className="cell-window-dot open-win" />}
            {isComplete && highEntry === "upcoming" && <span className="cell-window-dot upcoming-win" />}
          </div>

          <div className={`cell-level cell-low ${nearLow ? "cell-near" : ""}`}>
            <span className="cell-hl-label">L</span>
            <span className="cell-hl-val">{cyc.low?.toFixed(0)}</span>
            {distLow != null && <span className={`cell-dist ${nearLow ? "dist-near" : ""}`}>{distLow > 0 ? `-${distLow}` : `+${Math.abs(distLow)}`}</span>}
            {isComplete && cyc.hitLow && <span className="cell-hit-dot hit-long" title={`Hit @ ${cyc.hitLow.time}`}>▲</span>}
            {isComplete && lowEntry === "open" && <span className="cell-window-dot open-win" />}
            {isComplete && lowEntry === "upcoming" && <span className="cell-window-dot upcoming-win" />}
          </div>

          {CYCLE_TIMES[cyc.name] && (
            <div className="cell-time-label">{CYCLE_TIMES[cyc.name]} ET</div>
          )}
        </>
      )}
    </div>
  );
}

function Cycle90Cell({ cyc, currentPrice }) {
  const noData     = !cyc.high && !cyc.low;
  const isComplete = cyc.status === "complete" || (cyc.high && cyc.low);
  const distHigh   = cyc.high != null ? +(cyc.high - currentPrice).toFixed(1) : null;
  const distLow    = cyc.low  != null ? +(currentPrice - cyc.low).toFixed(1)  : null;
  const nearHigh   = distHigh != null && Math.abs(distHigh) < 30;
  const nearLow    = distLow  != null && Math.abs(distLow)  < 30;

  return (
    <div className={`c90-cell ${noData ? "c90-nodata" : ""} ${cyc.isActive ? "c90-active" : ""}`}>
      <div className="c90-name">{cyc.name ?? cyc.label ?? "?"}</div>
      {noData ? (
        <span className="c90-nd">—</span>
      ) : (
        <>
          <div className={`c90-level c90-high ${nearHigh ? "c90-near" : ""}`}>
            <span className="c90-lbl">H</span>
            <span className="c90-val">{cyc.high?.toFixed(0)}</span>
            {cyc.hitHigh && <span className="c90-hit hit-short">▼</span>}
          </div>
          <div className={`c90-level c90-low ${nearLow ? "c90-near" : ""}`}>
            <span className="c90-lbl">L</span>
            <span className="c90-val">{cyc.low?.toFixed(0)}</span>
            {cyc.hitLow && <span className="c90-hit hit-long">▲</span>}
          </div>
          {cyc.timeLabel && <div className="c90-time-lbl">{cyc.timeLabel}</div>}
        </>
      )}
    </div>
  );
}
