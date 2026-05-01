import React from "react";
import "./TradeProgress.css";

export default function TradeProgress({ trade, progress, currentPrice, marketLabel = "NAS100" }) {
  if (!trade) return (
    <div className="tp-empty">
      <span className="tp-empty-icon">📭</span>
      <span className="tp-empty-label">Geen actieve trade</span>
      <span className="tp-empty-sub">Wacht op een entry window</span>
    </div>
  );

  const isLong = trade.type === "LONG";
  const {
    pnl, slDist, isStopped, oppHit,
    tp1Hit, tp2Hit, tpDayHit,
    tp1Dist, tp2Dist, tpDayDist,
    trendStr, status,
  } = progress || {};

  const isClosedOpposite = oppHit?.hit;
  const isClosed = isStopped || isClosedOpposite;

  // Progress % from entry toward TP1
  const entryToTP1 = trade.tp1 != null ? Math.abs(trade.tp1 - trade.entry) : null;
  const progressPct = entryToTP1 && pnl != null
    ? Math.min(100, Math.max(-40, (pnl / entryToTP1) * 100))
    : 0;

  // Status display
  const statusLabel = isStopped         ? "STOPPED"
    : isClosedOpposite                  ? "CLOSED"
    : tp2Hit || tpDayHit                ? "TARGET BEREIKT"
    : tp1Hit                            ? "TP1 GERAAKT"
    : pnl > 0                           ? "WINSTGEVEND"
    : pnl < 0                           ? "DRAWDOWN"
    : "BREAKEVEN";

  const statusColor = isClosed          ? "status-closed"
    : tp2Hit || tpDayHit                ? "status-win"
    : tp1Hit                            ? "status-tp1"
    : pnl > 0                           ? "status-win"
    : pnl < 0                           ? "status-loss"
    : "status-flat";

  return (
    <div className={`trade-monitor ${isClosed ? "monitor-closed" : isLong ? "monitor-long" : "monitor-short"}`}>

      {/* ── Header bar ── */}
      <div className="tm-header">
        <div className="tm-direction">
          <span className={`tm-dir-arrow ${isLong ? "dir-long" : "dir-short"}`}>{isLong ? "▲" : "▼"}</span>
          <div className="tm-dir-labels">
            <span className="tm-dir-type">{trade.type}</span>
            <span className="tm-dir-cycle">{marketLabel} · {trade.cycle} · {trade.entryWindow} ET</span>
          </div>
        </div>
        <div className={`tm-status-badge ${statusColor}`}>{statusLabel}</div>
      </div>

      {/* ── P&L hero ── */}
      <div className="tm-pnl-section">
        <div className="tm-pnl-label">ONGEREALISEERDE P&L</div>
        <div className={`tm-pnl-value ${isClosed ? "pnl-closed" : pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : "pnl-flat"}`}>
          {pnl != null ? (pnl >= 0 ? "+" : "") + pnl + " pts" : "—"}
        </div>
        {isStopped && <div className="tm-pnl-sub stopped-sub">🔴 Stop loss geraakt</div>}
        {isClosedOpposite && <div className="tm-pnl-sub closed-sub">🔄 {oppHit.reason}</div>}
      </div>

      {/* ── Progress ruler: SL ←——[price]——→ TP1 ── */}
      {!isClosed && entryToTP1 && (
        <div className="tm-ruler">
          <div className="ruler-labels">
            <span className="rl-sl text-red">SL {trade.sl ?? "TBD"}</span>
            <span className="rl-entry text-muted">ENTRY</span>
            <span className="rl-tp1 text-green">TP1 {trade.tp1}</span>
          </div>
          <div className="ruler-track">
            <div className="ruler-sl-zone" />
            <div
              className={`ruler-fill ${pnl >= 0 ? "ruler-fill-win" : "ruler-fill-loss"}`}
              style={{ width: `${Math.min(100, Math.abs(progressPct))}%`, ...(pnl < 0 ? { right: "50%", left: "auto" } : { left: "50%" }) }}
            />
            <div className="ruler-center-line" />
            <div
              className="ruler-price-dot"
              style={{ left: `${Math.min(95, Math.max(5, 50 + progressPct / 2))}%` }}
            />
          </div>
          <div className="ruler-pct text-muted mono">{progressPct.toFixed(0)}% naar TP1</div>
        </div>
      )}

      {/* ── Levels table ── */}
      <div className="tm-levels">
        <TmLevel
          label="Entry" value={trade.entry}
          tag={null} tagColor={null}
          isEntry
        />
        <TmLevel
          label="Stop Loss" value={trade.sl}
          tag={isStopped ? "GERAAKT" : slDist != null ? `${slDist} pts veilig` : null}
          tagColor={isStopped ? "red" : slDist != null && slDist < 15 ? "yellow" : "green"}
          isSL
        />
        <div className="tm-levels-divider" />
        <TmLevel
          label={`TP1${trade.tp1Cycle ? ` · ${trade.tp1Cycle}` : ""}`}
          value={trade.tp1}
          tag={tp1Hit ? "GERAAKT ✅" : tp1Dist != null ? `${tp1Dist} pts` : null}
          tagColor={tp1Hit ? "hit" : "muted"}
        />
        <TmLevel
          label={`TP2${trade.tp2Cycle ? ` · ${trade.tp2Cycle}` : ""}`}
          value={trade.tp2}
          tag={tp2Hit ? "GERAAKT ✅" : tp2Dist != null ? `${tp2Dist} pts` : null}
          tagColor={tp2Hit ? "hit" : "muted"}
        />
        <TmLevel
          label="TP Dag"
          value={trade.tpDay}
          tag={tpDayHit ? "GERAAKT ✅" : tpDayDist != null ? `${tpDayDist} pts` : null}
          tagColor={tpDayHit ? "hit" : "muted"}
          isDayTarget
        />
      </div>

      {/* ── Trend ── */}
      {trendStr && (
        <div className="tm-trend">
          <span className="tm-trend-label">Trend 8 candles</span>
          <span className="tm-trend-chars mono">{trendStr}</span>
        </div>
      )}
    </div>
  );
}

function TmLevel({ label, value, tag, tagColor, isEntry, isSL, isDayTarget }) {
  const tagClass = {
    red: "tag-red", yellow: "tag-yellow", green: "tag-green",
    hit: "tag-hit", muted: "tag-muted",
  }[tagColor] || "tag-muted";

  return (
    <div className={`tm-level-row ${isEntry ? "row-entry" : ""} ${isSL ? "row-sl" : ""} ${isDayTarget ? "row-day" : ""}`}>
      <span className="tml-label">{label}</span>
      <span className="tml-value mono">
        {value != null ? value.toLocaleString("en-US", { minimumFractionDigits: 2 }) : "TBD"}
      </span>
      {tag && <span className={`tml-tag ${tagClass}`}>{tag}</span>}
    </div>
  );
}
