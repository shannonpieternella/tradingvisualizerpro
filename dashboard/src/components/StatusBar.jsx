import React from "react";
import "./StatusBar.css";

export default function StatusBar({ lastRefresh, scanMeta, error }) {
  const timeStr = lastRefresh
    ? lastRefresh.toLocaleTimeString("en-US", { hour12: false })
    : "—";

  return (
    <div className="status-bar">
      <div className="status-left">
        {error ? (
          <span className="status-error">⚠ {error}</span>
        ) : (
          <span className="status-ok">● Connected · Last sync {timeStr}</span>
        )}
      </div>
      {scanMeta && (
        <div className="status-right text-muted">
          {scanMeta.count} candles · {scanMeta.from} – {scanMeta.to} ET
        </div>
      )}
    </div>
  );
}
