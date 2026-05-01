import React, { useEffect, useRef, useState } from "react";
import "./PriceBar.css";

export default function PriceBar({ data, marketState }) {
  const { currentPrice, currentTime, activeCycle, dailyHigh, dailyLow, nowEtH } = data;
  const marketLabel = marketState?.current ?? "NAS100";
  const prevPrice = useRef(currentPrice);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (prevPrice.current !== currentPrice) {
      setFlash(currentPrice > prevPrice.current ? "up" : "down");
      prevPrice.current = currentPrice;
      const t = setTimeout(() => setFlash(null), 800);
      return () => clearTimeout(t);
    }
  }, [currentPrice]);

  const CYCLES = ["C1","C2","C3","C4"];
  const cycleLabels = { C1: "18:00", C2: "00:00", C3: "06:00", C4: "12:00" };
  const cycleIdx = CYCLES.indexOf(activeCycle);

  return (
    <div className="price-bar">
      {/* Live price */}
      <div className={`price-main ${flash ? `flash-${flash}` : ""}`}>
        <span className="price-label">{marketLabel}</span>
        <span className="price-value mono">{currentPrice?.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
        <span className="price-time text-muted mono">{currentTime} ET</span>
      </div>

      <div className="price-divider" />

      {/* Daily range */}
      <div className="price-stat">
        <span className="stat-label">Day High</span>
        <span className="stat-value mono text-green">{dailyHigh?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "—"}</span>
      </div>
      <div className="price-stat">
        <span className="stat-label">Day Low</span>
        <span className="stat-value mono text-red">{dailyLow?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "—"}</span>
      </div>

      <div className="price-divider" />

      {/* Cycle progress */}
      <div className="cycle-tracker">
        <span className="stat-label">Cycle</span>
        <div className="cycle-dots">
          {CYCLES.map((c, i) => (
            <div key={c} className={`cycle-dot ${i < cycleIdx ? "done" : i === cycleIdx ? "active" : "future"}`} title={`${c} ${cycleLabels[c]} ET`}>
              <span className="cycle-dot-label">{c}</span>
            </div>
          ))}
        </div>
        <span className="stat-value">{activeCycle}</span>
      </div>

      <div className="price-divider" />

      {/* ET time indicator */}
      <div className="price-stat">
        <span className="stat-label">ET Now</span>
        <span className="stat-value mono">{formatETHour(nowEtH)}</span>
      </div>
    </div>
  );
}

function formatETHour(h) {
  if (h == null) return "—";
  const hh = Math.floor(h) % 24;
  const mm = Math.round((h % 1) * 60);
  return `${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`;
}
