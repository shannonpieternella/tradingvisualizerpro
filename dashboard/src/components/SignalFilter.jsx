import React from "react";
import "./SignalFilter.css";

export default function SignalFilter({ filter, onChange, goldenCycle = "C3", autonomousFilter = false, onAutonomousToggle }) {
  const { dir, matrixOnly, cycle } = filter;

  const setDir       = v => onChange({ ...filter, dir: v });
  const setCycle     = v => onChange({ ...filter, cycle: v });
  const toggleMatrix = () => onChange({ ...filter, matrixOnly: !matrixOnly });

  return (
    <div className="sf-bar">
      {/* Richting */}
      <div className="sf-group">
        <button className={`sf-pill ${dir === "ALL" ? "sf-active" : ""}`} onClick={() => setDir("ALL")}>Alles</button>
        <button className={`sf-pill sf-buy  ${dir === "BUY"  ? "sf-active" : ""}`} onClick={() => setDir("BUY")}>▲ BUY</button>
        <button className={`sf-pill sf-sell ${dir === "SELL" ? "sf-active" : ""}`} onClick={() => setDir("SELL")}>▼ SELL</button>
        {onAutonomousToggle && (
          <button
            className={`sf-pill sf-auto ${autonomousFilter ? "sf-active sf-auto-on" : ""}`}
            onClick={onAutonomousToggle}
            title="Autonomous Bias Filter — zet automatisch BUY/SELL op basis van de weekbias"
          >
            ⚡ Auto
          </button>
        )}
      </div>

      <div className="sf-sep" />

      {/* Matrix toggle */}
      <button className={`sf-pill sf-matrix ${matrixOnly ? "sf-active" : ""}`} onClick={toggleMatrix}>
        🔓 Matrix
      </button>

      <div className="sf-sep" />

      {/* Cycle — golden cycle krijgt een kroon badge */}
      <div className="sf-group">
        <button className={`sf-pill ${cycle === "ALL" ? "sf-active" : ""}`} onClick={() => setCycle("ALL")}>Alle C</button>
        {["C1","C2","C3","C4"].map(c => (
          <button
            key={c}
            className={`sf-pill ${cycle === c ? "sf-active" : ""} ${c === goldenCycle ? "sf-golden" : ""}`}
            onClick={() => setCycle(c)}
            title={c === goldenCycle ? "Golden Cycle — meest winstgevend vandaag" : ""}
          >
            {c}{c === goldenCycle && <span className="sf-crown">👑</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
