import React, { useMemo } from "react";
import "./OrderFlowChart.css";

function fmtP(v) {
  if (v == null) return "";
  if (v < 10)    return v.toFixed(5);
  if (v < 100)   return v.toFixed(3);
  if (v < 10000) return v.toFixed(1);
  return v.toFixed(0);
}
function shortDate(dateStr) {
  if (!dateStr) return "";
  const [,mo,d] = dateStr.split("-");
  return `${parseInt(mo)}/${parseInt(d)}`;
}

const TYPE_COLOR = { HIGH: "#00ff88", LOW: "#ff3e5e", BOTH: "#f5c518", RANGE: "#7a8fa6" };

export default function OrderFlowChart({ moves = [], lockLevels = null, currentPrice = null, title = "Order Flow" }) {
  const visible = useMemo(() => moves.slice(-10), [moves]);

  const allPrices = useMemo(() => {
    const pts = [];
    for (const m of visible) {
      if (m.high) pts.push(m.high);
      if (m.low)  pts.push(m.low);
    }
    if (lockLevels?.bslLevel)  pts.push(lockLevels.bslLevel);
    if (lockLevels?.sslLevel)  pts.push(lockLevels.sslLevel);
    if (lockLevels?.lockLevel) pts.push(lockLevels.lockLevel);
    if (currentPrice)          pts.push(currentPrice);
    return pts;
  }, [visible, lockLevels, currentPrice]);

  if (!visible.length) return null;

  const W = 640, H = 220;
  const PAD = { top: 24, right: 80, bottom: 36, left: 12 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  const rawMin = Math.min(...allPrices);
  const rawMax = Math.max(...allPrices);
  const range  = rawMax - rawMin || 1;
  const minP   = rawMin - range * 0.08;
  const maxP   = rawMax + range * 0.08;

  const scaleY = p => chartH - ((p - minP) / (maxP - minP)) * chartH + PAD.top;
  const scaleX = i => PAD.left + (i / (visible.length - 1)) * chartW;

  // Build zigzag points: each move contributes either its high or low
  // For a HIGH move → mark the high (buyside taken)
  // For a LOW move  → mark the low  (sellside taken)
  // For BOTH        → mark both (low first, then high)
  const nodes = [];
  for (let i = 0; i < visible.length; i++) {
    const m = visible[i];
    const x = scaleX(i);
    if (m.type === "BOTH") {
      nodes.push({ x, y: scaleY(m.low),  price: m.low,  type: "LOW",  move: m, i });
      nodes.push({ x, y: scaleY(m.high), price: m.high, type: "HIGH", move: m, i });
    } else if (m.type === "HIGH") {
      nodes.push({ x, y: scaleY(m.high), price: m.high, type: "HIGH", move: m, i });
    } else if (m.type === "LOW") {
      nodes.push({ x, y: scaleY(m.low),  price: m.low,  type: "LOW",  move: m, i });
    } else {
      // RANGE — use midpoint
      const mid = (m.high + m.low) / 2;
      nodes.push({ x, y: scaleY(mid), price: mid, type: "RANGE", move: m, i });
    }
  }

  // Build polyline segments colored by direction
  const segments = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    const going = b.type === "HIGH" ? "up" : b.type === "LOW" ? "down" : "flat";
    segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, going });
  }

  // Horizontal level lines
  const levels = [];
  if (lockLevels?.bslLevel)  levels.push({ p: lockLevels.bslLevel,  label: `BSL ${fmtP(lockLevels.bslLevel)}`,  color: "#00ff88", dash: "6 3" });
  if (lockLevels?.sslLevel)  levels.push({ p: lockLevels.sslLevel,  label: `SSL ${fmtP(lockLevels.sslLevel)}`,  color: "#ff3e5e", dash: "6 3" });
  if (lockLevels?.lockLevel) levels.push({ p: lockLevels.lockLevel, label: `Lock ${fmtP(lockLevels.lockLevel)}`, color: "#f5c518", dash: "4 2" });
  if (currentPrice)          levels.push({ p: currentPrice,         label: `Now ${fmtP(currentPrice)}`,          color: "#7a8fa6", dash: "2 2" });

  return (
    <div className="ofc-root">
      <div className="ofc-title">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="ofc-svg" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => {
          const py = PAD.top + pct * chartH;
          return <line key={pct} x1={PAD.left} y1={py} x2={W - PAD.right} y2={py} stroke="#1e2d3d" strokeWidth="1" />;
        })}

        {/* Horizontal level lines */}
        {levels.map((lv, i) => {
          const ly = scaleY(lv.p);
          if (ly < PAD.top || ly > H - PAD.bottom) return null;
          return (
            <g key={i}>
              <line x1={PAD.left} y1={ly} x2={W - PAD.right} y2={ly}
                stroke={lv.color} strokeWidth="1.2" strokeDasharray={lv.dash} opacity="0.8" />
              <text x={W - PAD.right + 4} y={ly + 4} fill={lv.color} fontSize="9" fontFamily="monospace">{lv.label}</text>
            </g>
          );
        })}

        {/* Zigzag segments */}
        {segments.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            stroke={s.going === "up" ? "#00ff88" : s.going === "down" ? "#ff3e5e" : "#7a8fa6"}
            strokeWidth="2" opacity="0.85" />
        ))}

        {/* Nodes */}
        {nodes.map((n, i) => {
          const col  = TYPE_COLOR[n.type] ?? "#7a8fa6";
          const isHH = n.type === "HIGH";
          const isLL = n.type === "LOW";
          return (
            <g key={i}>
              {/* Diamond marker */}
              <polygon
                points={`${n.x},${n.y - 6} ${n.x + 5},${n.y} ${n.x},${n.y + 6} ${n.x - 5},${n.y}`}
                fill={col} opacity="0.9"
              />
              {/* HH / HL / LH / LL label above/below */}
              <text
                x={n.x} y={isHH ? n.y - 10 : n.y + 17}
                fill={col} fontSize="9" fontFamily="monospace" textAnchor="middle"
              >
                {isHH ? "BSL" : isLL ? "SSL" : n.type === "BOTH" ? "BOTH" : "—"}
              </text>
            </g>
          );
        })}

        {/* X-axis date labels */}
        {visible.map((m, i) => (
          <text key={i} x={scaleX(i)} y={H - 8}
            fill="#7a8fa6" fontSize="9" fontFamily="monospace" textAnchor="middle">
            {shortDate(m.date)}{m.dayName ? ` ${m.dayName.slice(0,2)}` : ""}
          </text>
        ))}

        {/* Move type badges on top axis */}
        {visible.map((m, i) => {
          const col = TYPE_COLOR[m.type] ?? "#7a8fa6";
          return (
            <text key={i} x={scaleX(i)} y={PAD.top - 6}
              fill={col} fontSize="8" fontFamily="monospace" textAnchor="middle" fontWeight="700">
              {m.type === "HIGH" ? "HH" : m.type === "LOW" ? "LL" : m.type === "BOTH" ? "BOTH" : "—"}
            </text>
          );
        })}
      </svg>

      {/* Legend */}
      <div className="ofc-legend">
        <span className="ofc-leg ofc-leg-bsl">BSL — buyside swept</span>
        <span className="ofc-leg ofc-leg-ssl">SSL — sellside swept</span>
        <span className="ofc-leg ofc-leg-both">BOTH — expansie dag</span>
        {lockLevels?.lockLevel && <span className="ofc-leg ofc-leg-lock">Lock bevestigd</span>}
      </div>
    </div>
  );
}
