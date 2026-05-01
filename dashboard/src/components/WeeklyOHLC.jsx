import React, { useMemo } from "react";
import "./WeeklyOHLC.css";

const CANDLE_WIDTH  = 18;
const CANDLE_GAP    = 10;
const CHART_HEIGHT  = 140;
const WICK_WIDTH    = 1.5;

function priceToY(price, minP, maxP) {
  const range = maxP - minP;
  if (!range) return CHART_HEIGHT / 2;
  return CHART_HEIGHT - ((price - minP) / range) * CHART_HEIGHT;
}

function Candle({ candle, x, minP, maxP, isToday }) {
  const { open, high, low, close } = candle;
  const isBull  = close >= open;
  const color   = isToday ? "#00d4ff" : isBull ? "#26a659" : "#e84040";
  const bodyTop = priceToY(Math.max(open, close), minP, maxP);
  const bodyBot = priceToY(Math.min(open, close), minP, maxP);
  const bodyH   = Math.max(1, bodyBot - bodyTop);
  const wickTop = priceToY(high, minP, maxP);
  const wickBot = priceToY(low,  minP, maxP);
  const cx      = x + CANDLE_WIDTH / 2;

  return (
    <g>
      {/* Wick */}
      <line x1={cx} y1={wickTop} x2={cx} y2={wickBot}
        stroke={color} strokeWidth={WICK_WIDTH} />
      {/* Body */}
      <rect
        x={x} y={bodyTop} width={CANDLE_WIDTH} height={bodyH}
        fill={isBull ? color : color}
        stroke={color} strokeWidth={isToday ? 1.5 : 0.5}
        fillOpacity={isToday ? 0.85 : 0.7}
        rx={1}
      />
    </g>
  );
}

export default function WeeklyOHLC({ weeklyCandles, dailyCandles, equalHighs, equalLows, currentPrice }) {
  // Show last 3 weekly candles + current week's daily candles
  const displayWeeks   = weeklyCandles.slice(-3);
  const currentWeekKey = displayWeeks[displayWeeks.length - 1]?.key;

  // Build display: weekly candles for W-2, W-1, then daily for W0
  const items = useMemo(() => {
    const result = [];
    // First 2 weekly candles (W-2, W-1)
    for (let i = 0; i < displayWeeks.length - 1; i++) {
      const w = displayWeeks[i];
      result.push({ type: "week", label: `W${i - (displayWeeks.length - 2)}`, ...w });
    }
    // Separator gap
    result.push({ type: "gap" });
    // Daily candles for current week
    const thisDays = dailyCandles.filter(d => {
      // rough match: same week key or last 5 days
      return d.startTs >= (displayWeeks[displayWeeks.length - 1]?.startTs ?? 0);
    }).slice(-5);
    const DAY_LABELS = { Monday:"Mon", Tuesday:"Tue", Wednesday:"Wed", Thursday:"Thu", Friday:"Fri" };
    for (const d of thisDays) {
      result.push({ type: "day", label: DAY_LABELS[d.dayName] ?? d.dayName.slice(0,3), isToday: d.isToday, ...d });
    }
    return result;
  }, [displayWeeks, dailyCandles]);

  // Compute price range for all visible candles
  const allPrices = items
    .filter(i => i.type !== "gap")
    .flatMap(i => [i.high, i.low]);
  allPrices.push(currentPrice);
  if (equalHighs) allPrices.push(...equalHighs.map(e => e.level));
  if (equalLows)  allPrices.push(...equalLows.map(e => e.level));

  const minP = Math.min(...allPrices) * 0.9995;
  const maxP = Math.max(...allPrices) * 1.0005;

  // Calculate total width
  let totalWidth = 0;
  const positions = [];
  for (const item of items) {
    if (item.type === "gap") { positions.push({ x: totalWidth, w: 8 }); totalWidth += 8; continue; }
    positions.push({ x: totalWidth, w: CANDLE_WIDTH });
    totalWidth += CANDLE_WIDTH + CANDLE_GAP;
  }
  const svgW = Math.max(totalWidth + 60, 300);

  return (
    <div className="wohlc-root">
      <div className="wohlc-header">
        <span className="wohlc-title">Weekly / Daily OHLC</span>
        <span className="wohlc-price">
          {currentPrice?.toLocaleString("en-US", { minimumFractionDigits: 1 })}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${svgW} ${CHART_HEIGHT + 28}`}
        className="wohlc-svg"
        style={{ width: "100%", height: CHART_HEIGHT + 28 }}
      >
        {/* Background grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => {
          const y = pct * CHART_HEIGHT;
          return <line key={pct} x1={0} y1={y} x2={svgW} y2={y}
            stroke="rgba(255,255,255,0.04)" strokeWidth={1} />;
        })}

        {/* Price level labels on right */}
        {[0, 0.5, 1].map(pct => {
          const price = minP + (maxP - minP) * (1 - pct);
          const y     = pct * CHART_HEIGHT;
          return (
            <text key={pct} x={svgW - 4} y={y + 4}
              fontSize={8} fill="rgba(255,255,255,0.3)"
              textAnchor="end">
              {price.toFixed(0)}
            </text>
          );
        })}

        {/* Equal high lines */}
        {equalHighs?.map((eq, i) => {
          const y = priceToY(eq.level, minP, maxP);
          return (
            <g key={`eqh${i}`}>
              <line x1={0} y1={y} x2={svgW - 40} y2={y}
                stroke="#00d4ff" strokeWidth={1}
                strokeDasharray="4 3" opacity={0.6} />
              <text x={svgW - 38} y={y + 3} fontSize={7} fill="#00d4ff" opacity={0.7}>
                EQH {eq.level.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* Equal low lines */}
        {equalLows?.map((eq, i) => {
          const y = priceToY(eq.level, minP, maxP);
          return (
            <g key={`eql${i}`}>
              <line x1={0} y1={y} x2={svgW - 40} y2={y}
                stroke="#ff5050" strokeWidth={1}
                strokeDasharray="4 3" opacity={0.6} />
              <text x={svgW - 38} y={y + 3} fontSize={7} fill="#ff5050" opacity={0.7}>
                EQL {eq.level.toFixed(0)}
              </text>
            </g>
          );
        })}

        {/* Current price line */}
        {currentPrice && (() => {
          const y = priceToY(currentPrice, minP, maxP);
          return (
            <g>
              <line x1={0} y1={y} x2={svgW} y2={y}
                stroke="#ffffff" strokeWidth={0.8}
                strokeDasharray="2 4" opacity={0.45} />
            </g>
          );
        })()}

        {/* Divider between weekly and daily */}
        {(() => {
          const gapIdx = items.findIndex(i => i.type === "gap");
          if (gapIdx < 0) return null;
          const gx = positions[gapIdx]?.x ?? 0;
          return (
            <line x1={gx + 3} y1={0} x2={gx + 3} y2={CHART_HEIGHT}
              stroke="rgba(255,255,255,0.12)" strokeWidth={1}
              strokeDasharray="2 3" />
          );
        })()}

        {/* Candles */}
        {items.map((item, i) => {
          if (item.type === "gap") return null;
          const pos = positions[i];
          return (
            <Candle
              key={i}
              candle={{ open: item.open, high: item.high, low: item.low, close: item.close }}
              x={pos.x}
              minP={minP}
              maxP={maxP}
              isToday={item.isToday}
            />
          );
        })}

        {/* Labels */}
        {items.map((item, i) => {
          if (item.type === "gap") return null;
          const pos = positions[i];
          const cx  = pos.x + CANDLE_WIDTH / 2;
          return (
            <text
              key={`lbl${i}`}
              x={cx} y={CHART_HEIGHT + 11}
              fontSize={7}
              fill={item.isToday ? "#00d4ff" : "rgba(255,255,255,0.35)"}
              textAnchor="middle"
              fontWeight={item.isToday ? "700" : "400"}
            >
              {item.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
