import React, { useState, useEffect, useRef } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { createChart, CandlestickSeries, LineSeries } from "lightweight-charts";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./TradeReplayPage.css";

function fmtPrice(p, market) {
  if (p == null) return "—";
  if (typeof market === "string" && market.includes("GBP")) return Number(p).toFixed(5);
  if (Number(p) > 1000) return Number(p).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return Number(p).toFixed(5);
}

export default function TradeReplayPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { authFetch } = useAuth();
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await authFetch(`/api/journal/${encodeURIComponent(id)}/chart`);
        const j = await r.json();
        if (cancelled) return;
        if (!j.ok) throw new Error(j.error ?? "failed to load");
        setData(j);
      } catch (e) { if (!cancelled) setError(e.message); }
    })();
    return () => { cancelled = true; };
  }, [authFetch, id]);

  useEffect(() => {
    if (!data || !containerRef.current) return;
    const s = data.setup;
    const isBuy = s.direction === "BUY";
    const bullColor = "#4ade80", bearColor = "#f87171";
    const entryTsSec = s.entryTs ? (s.entryTs > 1e12 ? s.entryTs/1000 : s.entryTs) : null;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0a1118" }, textColor: "#c9d3e3", fontSize: 12 },
      grid:   { vertLines: { color: "#1a2332" }, horzLines: { color: "#1a2332" } },
      width: containerRef.current.clientWidth,
      height: 540,
      timeScale: {
        visible: true, timeVisible: true, secondsVisible: false,
        borderColor: "#2d3e5c", borderVisible: true, ticksVisible: true,
        rightOffset: 12, barSpacing: 8, minBarSpacing: 2,
      },
      rightPriceScale: {
        borderColor: "#2d3e5c", borderVisible: true, visible: true,
        autoScale: true, mode: 0,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      crosshair: { mode: 1 },
      localization: {
        timeFormatter: t => new Date(t * 1000).toLocaleString("en-US", {
          timeZone: "America/New_York", hourCycle: "h23",
          weekday: "short", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit",
        }),
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: bullColor, downColor: bearColor,
      borderUpColor: bullColor, borderDownColor: bearColor,
      wickUpColor: bullColor, wickDownColor: bearColor,
      // Force the price scale to auto-fit to THIS series' visible high/low.
      autoscaleInfoProvider: (original) => {
        const r = original();
        // Pad 10% above/below so candles fill the pane nicely.
        if (!r?.priceRange) return r;
        const { minValue, maxValue } = r.priceRange;
        const span = maxValue - minValue;
        return { ...r, priceRange: { minValue: minValue - span * 0.1, maxValue: maxValue + span * 0.1 } };
      },
    });
    // Sort + dedupe candles by timestamp — lightweight-charts requires strictly increasing time.
    const seen = new Set();
    const sorted = [...data.candles].sort((a, b) => a.time - b.time)
      .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    candleSeries.setData(sorted);

    const lastTs = sorted[sorted.length - 1]?.time;
    const addRay = (fromTs, price, color, label, style, width) => {
      if (price == null || !fromTs || !lastTs) return;
      const sr = chart.addSeries(LineSeries, {
        color, lineWidth: width, lineStyle: style,
        priceLineVisible: false, lastValueVisible: true, title: label,
        crosshairMarkerVisible: false,
        // Don't let the ray lines influence the candle-series auto-scale.
        // Otherwise a far-away TP2 level squashes candles flat.
        autoscaleInfoProvider: () => null,
      });
      sr.setData([{ time: fromTs, value: price }, { time: lastTs, value: price }]);
    };
    // Anchor BSL/SSL lines on the candle that DEFINED the level (the candle
    // whose high == bslLevel, or low == sslLevel). This way the ray visibly
    // emerges from the wick that set the liquidity — much easier for users
    // to trace the relationship between the level and the eventual sweep.
    const findCandleAt = (level, side) => {
      if (level == null || !sorted.length) return null;
      const tol = Math.max(Math.abs(level) * 1e-5, 1e-6);
      for (const c of sorted) {
        const v = side === "high" ? c.high : c.low;
        if (Math.abs(v - level) <= tol) return c;
      }
      // Fallback: nearest match within a more generous tolerance.
      let best = null, bestDiff = Infinity;
      for (const c of sorted) {
        const v = side === "high" ? c.high : c.low;
        const d = Math.abs(v - level);
        if (d < bestDiff) { bestDiff = d; best = c; }
      }
      return best && bestDiff <= Math.abs(level) * 5e-4 ? best : null;
    };
    // Only draw a level line when its leg has actually fired — matches what
    // the setup card shows. For BUY: BSL=step1 hit, SSL=step2 sweep (entry).
    // For SELL: SSL=step1 hit, BSL=step2 sweep. Entry/SL/TP only after entry.
    const bslCandle  = findCandleAt(s.bslLevel, "high");
    const sslCandle  = findCandleAt(s.sslLevel, "low");
    const bslLegTs   = isBuy ? s.step1Ts : s.step2Ts;
    const sslLegTs   = isBuy ? s.step2Ts : s.step1Ts;
    const bslStart   = bslLegTs ? (bslCandle?.time ?? bslLegTs) : null;
    const sslStart   = sslLegTs ? (sslCandle?.time ?? sslLegTs) : null;
    const tradeStart = entryTsSec || null;
    addRay(bslStart,  s.bslLevel,  "#5e8fd6", "BSL",    3, 1);
    addRay(sslStart,  s.sslLevel,  "#d65e8f", "SSL",    3, 1);
    addRay(tradeStart, s.entry,     "#ffc850", "Entry",  0, 2);
    addRay(tradeStart, s.sl,        "#ff4d4d", "SL",     0, 2);
    addRay(tradeStart, s.tp1,       "#4ade80", "TP1 1R", 0, 2);
    addRay(tradeStart, s.tp2,       "#22c55e", "TP2 2R", 0, 2);

    const toMarker = (ts, pos, color, shape, text) => ts ? ({ time: ts, position: pos, color, shape, text }) : null;
    const markers = [
      toMarker(s.step1Ts,  "belowBar", "#5e8fd6", "arrowUp", isBuy ? "1: BSL hit" : "1: SSL hit"),
      toMarker(s.step2Ts,  isBuy ? "belowBar" : "aboveBar", "#d65e8f", isBuy ? "arrowDown" : "arrowUp", isBuy ? "2: SSL sweep" : "2: BSL sweep"),
      toMarker(entryTsSec, isBuy ? "belowBar" : "aboveBar", "#ffc850", "circle", "Entry"),
    ].filter(Boolean);
    import("lightweight-charts").then(({ createSeriesMarkers }) => {
      try { createSeriesMarkers(candleSeries, markers); } catch {}
    });

    // Fit all candles to view — user can zoom in manually if they want a
    // tighter view around the setup.
    chart.timeScale().fitContent();

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth, height: 540 });
    };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, [data]);

  if (error) return <div className="tr-wrap"><div className="tr-error">⚠ {error}</div></div>;
  if (!data) return <div className="tr-wrap"><div className="tr-loading">laden…</div></div>;

  const s = data.setup;
  const isBuy = s.direction === "BUY";
  const risk  = (s.entry && s.sl) ? Math.abs(s.entry - s.sl) : null;
  const fp    = p => fmtPrice(p, s.market);

  return (
    <div className="tr-wrap">
      <header className="tr-header">
        <button onClick={() => navigate(-1)} className="tr-back">← Terug</button>
        <h1 className="tr-title">
          {s.market} {s.direction} {s.source}
          <span className={`tr-badge ${isBuy ? "buy" : "sell"}`}>{isBuy ? "▲ BUY" : "▼ SELL"}</span>
          {s.outcome === "WIN"  && <span className="tr-outcome win">WIN ✅ {s.rMulti === 2 ? "@2R" : s.rMulti === 1 ? "@1R" : ""}</span>}
          {s.outcome === "LOSS" && <span className="tr-outcome loss">LOSS ❌</span>}
          {!s.outcome && <span className="tr-outcome open">OPEN</span>}
        </h1>
        <span className="tr-datetime">{s.datetime}</span>
      </header>

      <div className="tr-info-bar">
        <div className="tr-info-tile"><span className="tr-info-lbl">Cycle</span><span className="tr-info-val">{s.cycleLabel ?? "—"}</span></div>
        <div className="tr-info-tile"><span className="tr-info-lbl">BSL</span><span className="tr-info-val">{fp(s.bslLevel)}</span></div>
        <div className="tr-info-tile"><span className="tr-info-lbl">SSL</span><span className="tr-info-val">{fp(s.sslLevel)}</span></div>
        <div className="tr-info-tile"><span className="tr-info-lbl">Entry</span><span className="tr-info-val">{fp(s.entry)}</span></div>
        <div className="tr-info-tile"><span className="tr-info-lbl">SL</span><span className="tr-info-val loss-col">{fp(s.sl)}</span></div>
        <div className="tr-info-tile"><span className="tr-info-lbl">TP1 1R</span><span className="tr-info-val win-col">{fp(s.tp1)} {s.tp1Hit ? "✓" : ""}</span></div>
        <div className="tr-info-tile"><span className="tr-info-lbl">TP2 2R</span><span className="tr-info-val win-col">{fp(s.tp2)} {s.tp2Hit ? "✓" : ""}</span></div>
        {risk && <div className="tr-info-tile"><span className="tr-info-lbl">Risk</span><span className="tr-info-val">{risk.toFixed(1)}pt</span></div>}
      </div>

      <div ref={containerRef} className="tr-chart" />

      <div className="tr-legend">
        <span><span className="tr-dot" style={{ background: "#5e8fd6" }} /> BSL</span>
        <span><span className="tr-dot" style={{ background: "#d65e8f" }} /> SSL</span>
        <span><span className="tr-dot" style={{ background: "#ffc850" }} /> Entry</span>
        <span><span className="tr-dot" style={{ background: "#ff4d4d" }} /> SL</span>
        <span><span className="tr-dot" style={{ background: "#4ade80" }} /> TP1 1R</span>
        <span><span className="tr-dot" style={{ background: "#22c55e" }} /> TP2 2R</span>
      </div>
    </div>
  );
}
