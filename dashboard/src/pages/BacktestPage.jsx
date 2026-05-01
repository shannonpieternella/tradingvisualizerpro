import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./BacktestPage.css";

const MARKETS = ["NAS100","XAUUSD","US500","US30"];

function StatBox({ label, value, sub, color }) {
  return (
    <div className="bt-stat-box">
      <div className="bt-stat-label">{label}</div>
      <div className="bt-stat-value" style={color ? { color } : {}}>{value}</div>
      {sub && <div className="bt-stat-sub">{sub}</div>}
    </div>
  );
}

function OutcomeBadge({ outcome }) {
  const map = { WIN: "bt-win", LOSS: "bt-loss", NEUTRAL: "bt-neutral" };
  return <span className={`bt-outcome ${map[outcome] ?? "bt-neutral"}`}>{outcome}</span>;
}

function BiasBadge({ bias }) {
  const map = { BULLISH: "bt-bull", BEARISH: "bt-bear", NEUTRAL: "bt-neut" };
  return (
    <span className={`bt-bias ${map[bias] ?? "bt-neut"}`}>
      {bias === "BULLISH" ? "▲" : bias === "BEARISH" ? "▼" : "◆"} {bias}
    </span>
  );
}

export default function BacktestPage() {
  const { authFetch } = useAuth();
  const [market, setMarket]     = useState("NAS100");
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [running, setRunning]   = useState(false);
  const [error, setError]       = useState(null);
  const [runMsg, setRunMsg]     = useState(null);

  async function loadData(mkt = market) {
    setLoading(true);
    setError(null);
    try {
      const res  = await authFetch(`/api/backtest?market=${mkt}&limit=100`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function runBacktest() {
    setRunning(true);
    setRunMsg(null);
    try {
      const res  = await authFetch("/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setRunMsg(`${json.ran} simulaties uitgevoerd, ${json.saved} opgeslagen.`);
      await loadData();
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => { loadData(); }, [market]);

  const stats  = data?.stats;
  const logs   = data?.logs ?? [];
  const byDay  = data?.byDay ?? {};
  const bySignal = data?.bySignal ?? {};

  return (
    <div className="bt-root">
      <div className="bt-header">
        <div className="bt-header-left">
          <Link to="/dashboard" className="bt-back">← Dashboard</Link>
          <h1 className="bt-title">Backtest — Bias Engine</h1>
        </div>
        <div className="bt-header-right">
          <div className="bt-market-tabs">
            {MARKETS.map(m => (
              <button
                key={m}
                className={`bt-mkt-tab ${m === market ? "bt-mkt-active" : ""}`}
                onClick={() => setMarket(m)}
              >{m}</button>
            ))}
          </div>
          <button
            className="bt-run-btn"
            onClick={runBacktest}
            disabled={running}
          >
            {running ? <><span className="bt-spin" /> Bezig...</> : "▶ Run Backtest"}
          </button>
        </div>
      </div>

      {runMsg && <div className="bt-run-msg">{runMsg}</div>}
      {error  && <div className="bt-error"><span>⚠</span> {error}</div>}

      {/* Stats row */}
      {stats && (
        <div className="bt-stats-row">
          <StatBox label="Totaal" value={stats.total} />
          <StatBox label="Win Rate" value={`${stats.winRate}%`}
            color={stats.winRate >= 60 ? "#26a659" : stats.winRate >= 45 ? "#f5c518" : "#e84040"} />
          <StatBox label="Wins" value={stats.wins} color="#26a659" />
          <StatBox label="Losses" value={stats.losses} color="#e84040" />
        </div>
      )}

      {/* By Day breakdown */}
      {Object.keys(byDay).length > 0 && (
        <div className="bt-section">
          <div className="bt-section-title">Per Dag</div>
          <div className="bt-day-row">
            {["Monday","Tuesday","Wednesday","Thursday","Friday"].map(d => {
              const s = byDay[d];
              if (!s) return null;
              const wr = s.total > 0 ? (s.win / s.total * 100).toFixed(0) : 0;
              return (
                <div key={d} className="bt-day-card">
                  <div className="bt-day-name">{d.slice(0,3)}</div>
                  <div className="bt-day-wr" style={{ color: wr >= 60 ? "#26a659" : wr >= 45 ? "#f5c518" : "#e84040" }}>
                    {wr}%
                  </div>
                  <div className="bt-day-sub">{s.win}W / {s.loss}L</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* By Signal breakdown */}
      {Object.keys(bySignal).length > 0 && (
        <div className="bt-section">
          <div className="bt-section-title">Per Signaal</div>
          <div className="bt-signal-table">
            <div className="bt-signal-row bt-signal-head">
              <span>Signaal</span><span>Totaal</span><span>Wins</span><span>Win%</span>
            </div>
            {Object.entries(bySignal).map(([sig, s]) => {
              const wr = s.total > 0 ? (s.win / s.total * 100).toFixed(0) : 0;
              return (
                <div key={sig} className="bt-signal-row">
                  <span className="bt-signal-name">{sig.replace(/_/g," ")}</span>
                  <span>{s.total}</span>
                  <span style={{ color: "#26a659" }}>{s.win}</span>
                  <span style={{ color: wr >= 60 ? "#26a659" : wr >= 45 ? "#f5c518" : "#e84040" }}>{wr}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Trade log */}
      <div className="bt-section">
        <div className="bt-section-title">Trade Log ({logs.length})</div>
        {loading ? (
          <div className="bt-loading"><span className="bt-spin" /> Laden...</div>
        ) : logs.length === 0 ? (
          <div className="bt-empty">
            Nog geen backtest data. Klik "Run Backtest" om te starten.
          </div>
        ) : (
          <div className="bt-log-table">
            <div className="bt-log-head">
              <span>Datum</span>
              <span>Dag</span>
              <span>Bias</span>
              <span>Vertrouwen</span>
              <span>Signaal</span>
              <span>Prijs</span>
              <span>Move</span>
              <span>Uitkomst</span>
            </div>
            {logs.map((l, i) => {
              const move = l.bias === "BULLISH" ? l.bullishMove : l.bearishMove;
              return (
                <div key={i} className={`bt-log-row ${l.outcome === "WIN" ? "bt-row-win" : l.outcome === "LOSS" ? "bt-row-loss" : ""}`}>
                  <span className="bt-log-date">{l.date}</span>
                  <span className="bt-log-day">{l.dayName?.slice(0,3)}</span>
                  <span><BiasBadge bias={l.bias} /></span>
                  <span className="bt-log-conf">{l.confidence}%</span>
                  <span className="bt-log-sig">{l.primarySignal?.replace(/_/g," ") ?? "—"}</span>
                  <span className="bt-log-price">{l.priceAtEntry?.toFixed(0)}</span>
                  <span className={`bt-log-move ${move > 0 ? "bt-move-up" : "bt-move-dn"}`}>
                    {move > 0 ? "+" : ""}{move?.toFixed(2)}%
                  </span>
                  <span><OutcomeBadge outcome={l.outcome} /></span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
