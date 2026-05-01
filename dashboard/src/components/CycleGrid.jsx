import React from "react";
import "./CycleGrid.css";

const CYCLE_ORDER = ["C1", "C2", "C3", "C4"];
const CYCLE_TIMES = {
  C1: "18:00–00:00", C2: "00:00–06:00", C3: "06:00–12:00", C4: "12:00–18:00"
};

export default function CycleGrid({ cycles, prevC4, activeCycle, currentPrice }) {
  const ordered = CYCLE_ORDER.map(name => cycles?.find(c => c.name === name)).filter(Boolean);

  return (
    <div className="cycle-section">
      <div className="card-title" style={{marginBottom: "12px"}}>
        <span>Cycle Overview</span>
        <span className="cycle-active-badge">Active: {activeCycle}</span>
      </div>

      {prevC4 && (
        <div className="prev-cycle-row">
          <CycleCard cycle={prevC4} currentPrice={currentPrice} isPrev />
        </div>
      )}

      <div className="cycle-grid">
        {ordered.map(cyc => (
          <CycleCard
            key={cyc.name}
            cycle={cyc}
            currentPrice={currentPrice}
            isActive={cyc.name === activeCycle}
          />
        ))}
      </div>
    </div>
  );
}

function CycleCard({ cycle, currentPrice, isActive, isPrev }) {
  if (!cycle) return null;
  const { name, label, status, high, low, highTime, lowTime, hitHigh, hitLow, entryHigh, entryLow } = cycle;

  const noData = status === "no_data";
  const range = high != null && low != null ? (high - low).toFixed(1) : null;

  // Distance from current price to high/low
  const distHigh = high != null ? (high - currentPrice).toFixed(1) : null;
  const distLow  = low  != null ? (currentPrice - low).toFixed(1) : null;
  const nearHigh = distHigh != null && Math.abs(distHigh) < 25;
  const nearLow  = distLow  != null && Math.abs(distLow)  < 25;

  return (
    <div className={`cycle-card ${isActive ? "cycle-active" : ""} ${isPrev ? "cycle-prev" : ""} ${noData ? "cycle-nodata" : ""}`}>
      {/* Header */}
      <div className="cc-header">
        <div className="cc-name-group">
          <span className="cc-name">{isPrev ? "prevC4" : name}</span>
          {isActive && <span className="cc-active-dot" />}
          {isPrev && <span className="cc-prev-tag">Yesterday</span>}
        </div>
        <div className="cc-label">{isPrev ? "12:00–18:00" : (CYCLE_TIMES[name] || label)}</div>
        <span className={`cc-status-badge ${status === "active" ? "status-active" : status === "complete" ? "status-done" : "status-none"}`}>
          {status === "active" ? "LIVE" : status === "complete" ? "DONE" : "NO DATA"}
        </span>
      </div>

      {noData ? (
        <div className="cc-nodata-msg text-muted">Cycle not yet started</div>
      ) : (
        <>
          {/* High / Low */}
          <div className="cc-hl-grid">
            <div className={`cc-hl cc-high ${nearHigh ? "near-level" : ""}`}>
              <span className="hl-label">HIGH</span>
              <span className="hl-value mono">{high?.toFixed(2)}</span>
              <span className="hl-time text-muted">{highTime}</span>
              {distHigh != null && (
                <span className={`hl-dist mono ${nearHigh ? "text-yellow" : "text-muted"}`}>
                  {distHigh > 0 ? `↑ ${distHigh}` : `↓ ${Math.abs(distHigh)}`} pts
                </span>
              )}
            </div>
            <div className="cc-range">
              <span className="range-val text-muted mono">{range} pts</span>
            </div>
            <div className={`cc-hl cc-low ${nearLow ? "near-level" : ""}`}>
              <span className="hl-label">LOW</span>
              <span className="hl-value mono">{low?.toFixed(2)}</span>
              <span className="hl-time text-muted">{lowTime}</span>
              {distLow != null && (
                <span className={`hl-dist mono ${nearLow ? "text-yellow" : "text-muted"}`}>
                  {distLow > 0 ? `↓ ${distLow}` : `↑ ${Math.abs(distLow)}`} pts
                </span>
              )}
            </div>
          </div>

          {/* Hit detection + Entry windows (only for complete cycles) */}
          {status === "complete" && (
            <div className="cc-hits">
              <HitRow side="HIGH" hit={hitHigh} entry={entryHigh} />
              <HitRow side="LOW"  hit={hitLow}  entry={entryLow}  />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HitRow({ side, hit, entry }) {
  const isHit = hit != null;
  const entryStatus = entry?.status;
  const entryColor = entryStatus === "open" ? "text-green" :
                     entryStatus === "upcoming" ? "text-purple" : "text-muted";

  return (
    <div className="hit-row">
      <span className={`hit-side ${side === "HIGH" ? "side-short" : "side-long"}`}>{side}</span>
      <span className={`hit-status ${isHit ? "text-green" : "text-muted"}`}>
        {isHit ? `✓ ${hit.time}` : "○ not hit"}
      </span>
      {isHit && entry && (
        <span className={`entry-status ${entryColor}`}>
          {entryStatus === "open"     ? `⏳ Window open · ${entry.label}` :
           entryStatus === "upcoming" ? `🔔 Upcoming · ${entry.label}` :
           entryStatus === "passed"   ? `✔ Was open · ${entry.label}` : ""}
        </span>
      )}
    </div>
  );
}
