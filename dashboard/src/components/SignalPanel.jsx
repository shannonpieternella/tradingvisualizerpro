import React from "react";
import "./SignalPanel.css";

export default function SignalPanel({ signal, activeTrade, currentPrice, marketLabel = "NAS100" }) {
  if (!signal) return null;
  const { active, upcoming, recent } = signal;
  const hasActive   = active?.length > 0;
  const hasUpcoming = upcoming?.length > 0;
  const hasRecent   = recent?.length > 0;

  return (
    <div className="signal-panel">
      {/* ── No signal ── */}
      {!hasActive && !hasUpcoming && !hasRecent && (
        <div className="card signal-standby">
          <div className="standby-inner">
            <span className="standby-dot" />
            <span className="standby-label">STANDBY · {marketLabel}</span>
            <span className="standby-sub">No entry window open · Watching for setup</span>
          </div>
        </div>
      )}

      {/* ── Active signal ── */}
      {hasActive && active.map((s, i) => (
        <ActiveSignalCard key={i} s={s} currentPrice={currentPrice} marketLabel={marketLabel} />
      ))}

      {/* ── Upcoming signal ── */}
      {!hasActive && hasUpcoming && upcoming.map((s, i) => (
        <UpcomingSignalCard key={i} s={s} />
      ))}

      {/* ── Recent (missed) signals ── */}
      {hasRecent && recent.map((s, i) => (
        <RecentSignalCard key={i} s={s} />
      ))}

      {/* ── Active trade badge (if signal AND trade coexist) ── */}
      {hasActive && activeTrade && (
        <div className={`trade-active-note ${activeTrade.type === "LONG" ? "note-long" : "note-short"}`}>
          ▶ Trade actief: {activeTrade.type} {activeTrade.cycle} · entry {activeTrade.entry}
        </div>
      )}
    </div>
  );
}

function ActiveSignalCard({ s, currentPrice, marketLabel = "NAS100" }) {
  const isLong = s.type === "LONG";
  const dist   = isLong ? currentPrice - s.entry : s.entry - currentPrice;
  const atLevel = Math.abs(dist) < 5;

  return (
    <div className={`signal-alert ${isLong ? "alert-long" : "alert-short"}`}>
      {/* Top banner */}
      <div className="alert-banner">
        <div className="alert-type">
          <span className="alert-arrow">{isLong ? "▲" : "▼"}</span>
          <span className="alert-type-text">{s.type}</span>
          <span className="alert-cycle-tag">{s.cycle}</span>
        </div>
        <div className="alert-window-badge">
          <span className="alert-window-dot" />
          <span className="alert-window-text">{marketLabel} · OPEN t/m {s.until} ET</span>
        </div>
      </div>

      {/* Entry level — hero number */}
      <div className="alert-entry-hero">
        {s.level != null && s.level !== s.entry && (
          <span className="alert-trigger-label">
            TRIGGER LEVEL: {s.level?.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </span>
        )}
        <span className="alert-entry-label">ENTRY PRICE (30% range)</span>
        <span className="alert-entry-price">{s.entry?.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
        <span className={`alert-entry-dist ${atLevel ? "dist-at" : dist > 0 ? "dist-away" : "dist-through"}`}>
          {atLevel ? "● AT ENTRY"
            : dist > 0 ? `${Math.abs(dist).toFixed(1)} pts ${isLong ? "above" : "below"} entry`
            : `${Math.abs(dist).toFixed(1)} pts through entry`}
        </span>
      </div>

      {/* SL + TP ladder */}
      <div className="alert-ladder">
        <LadderRow icon="🛑" label="STOP LOSS" value={s.slReady && s.sl != null ? s.sl : null} placeholder={`TBD · na ${s.slReadyAt} ET`} color="red" />
        <div className="ladder-divider" />
        <LadderRow icon="🎯" label={`TP1 ${s.tp1Cycle ? `(${s.tp1Cycle})` : ""}`} value={s.tp1} color="green" />
        <LadderRow icon="🎯" label={`TP2 ${s.tp2Cycle ? `(${s.tp2Cycle})` : ""}`} value={s.tp2} color="green" />
        <LadderRow icon="🏁" label="TP DAY"  value={s.tpDay} color="yellow" />
      </div>
    </div>
  );
}

function UpcomingSignalCard({ s }) {
  const isLong = s.type === "LONG";
  return (
    <div className={`signal-upcoming ${isLong ? "upcoming-long" : "upcoming-short"}`}>
      <div className="upcoming-header">
        <span className="upcoming-bell">🔔</span>
        <div>
          <div className="upcoming-title">{s.type} SETUP INCOMING</div>
          <div className="upcoming-sub">{s.cycle} · Window: {s.window} ET</div>
        </div>
        <div className={`upcoming-arrow ${isLong ? "ua-long" : "ua-short"}`}>
          {isLong ? "▲" : "▼"}
        </div>
      </div>
      <div className="upcoming-level">
        <span className="ul-label">Level</span>
        <span className="ul-price mono">{s.level?.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
      </div>
    </div>
  );
}

function RecentSignalCard({ s }) {
  const isLong = s.type === "LONG";
  return (
    <div className={`signal-recent ${isLong ? "recent-long" : "recent-short"}`}>
      <div className="recent-header">
        <div className="recent-left">
          <span className={`recent-arrow ${isLong ? "ra-long" : "ra-short"}`}>{isLong ? "▲" : "▼"}</span>
          <div>
            <div className="recent-title">{s.type} · {s.cycle}</div>
            <div className="recent-sub">Window: {s.window} ET · gesloten om {s.closedAt}</div>
          </div>
        </div>
        <div className="recent-badges">
          <span className="recent-badge-gemist">GEMIST</span>
          <span className="recent-ago">{s.agoMin}m geleden</span>
        </div>
      </div>
      <div className="recent-level">
        <span className="rl-label">Entry level</span>
        <span className="rl-price mono">{s.entry?.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
      </div>
    </div>
  );
}

function LadderRow({ icon, label, value, placeholder, color }) {
  const colorMap = { red: "lr-red", green: "lr-green", yellow: "lr-yellow" };
  return (
    <div className={`ladder-row ${colorMap[color] || ""}`}>
      <span className="lr-icon">{icon}</span>
      <span className="lr-label">{label}</span>
      <span className="lr-value mono">
        {value != null
          ? value.toLocaleString("en-US", { minimumFractionDigits: 2 })
          : <span className="lr-tbd">{placeholder ?? "—"}</span>}
      </span>
    </div>
  );
}
