import React, { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "../components/LiveSignals.css"; // reuse ls-card styling for visual parity
import "./JournalPage.css";

const MARKETS    = ["", "NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
const DIRECTIONS = ["", "BUY", "SELL"];
const OUTCOMES   = ["", "WIN", "LOSS"];
const TFS        = ["", "daily", "6H", "90min"];
const DOW_LABELS = ["Zondag", "Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag"];
// Lock alignment is hard-pinned to "with" on this page — only met-lock setups
// are journalled here, and the user does not want a UI choice for it.
const FORCED_LOCK = "with";

function fmtPrice(p, market) {
  if (p == null) return "—";
  if (typeof market === "string" && market.includes("GBP")) return Number(p).toFixed(5);
  if (Number(p) > 1000) return Number(p).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return Number(p).toFixed(5);
}

function fmtStepTime(tsSec, fallbackHHMM) {
  if (!tsSec) return fallbackHHMM ?? null;
  const d = new Date(tsSec * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(d).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const nowParts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const hhmm = `${parts.hour}:${parts.minute}`;
  const sameDay = parts.year === nowParts.year && parts.month === nowParts.month && parts.day === nowParts.day;
  if (sameDay) return hhmm;
  return `${parts.day}-${parts.month}-${parts.year} ${hhmm}`;
}

function StatTile({ label, value, sub, tone }) {
  return (
    <div className={`jp-stat ${tone ? `jp-stat-${tone}` : ""}`}>
      <div className="jp-stat-label">{label}</div>
      <div className="jp-stat-value">{value}</div>
      {sub != null && <div className="jp-stat-sub">{sub}</div>}
    </div>
  );
}

function Outcome({ outcome }) {
  if (outcome === "WIN")  return <span className="jp-outcome win">WIN ✅</span>;
  if (outcome === "LOSS") return <span className="jp-outcome loss">LOSS ❌</span>;
  return null;
}

function TradeCard({ s }) {
  const isBuy   = s.direction === "BUY";
  const outcome = s.outcome ?? null;
  const label   = s.source ?? s.tf ?? "—";
  const fp      = p => fmtPrice(p, s.market);
  const risk    = (s.entry != null && s.sl != null) ? Math.abs(s.entry - s.sl) : null;
  // rMulti is stored directly by verifyOutcome: 1 = hit TP1, 2 = hit TP2, -1 = SL.
  // Fall back to price-derived R if missing (older entries).
  const rewardR = (() => {
    if (s.rMulti != null) return s.rMulti;
    if (!risk) return null;
    if (outcome === "WIN"  && (s.outcomePrice ?? s.tp1) != null) {
      return +(Math.abs((s.outcomePrice ?? s.tp1) - s.entry) / risk).toFixed(2);
    }
    if (outcome === "LOSS") return -1;
    return null;
  })();
  const pnlPts = (() => {
    if (!outcome) return null;
    if (outcome === "WIN"  && s.outcomePrice != null) {
      return isBuy ? s.outcomePrice - s.entry : s.entry - s.outcomePrice;
    }
    if (outcome === "LOSS" && s.sl != null) {
      return isBuy ? s.sl - s.entry : s.entry - s.sl;
    }
    return null;
  })();

  const cardCls = outcome === "WIN"  ? "ls-card-win"
                : outcome === "LOSS" ? "ls-card-loss"
                : "";

  return (
    <div className={`ls-card jp-trade ${isBuy ? "ls-buy" : "ls-sell"} ${cardCls}`}>
      <div className="ls-card-header">
        <span className="jp-card-market">{s.market}</span>
        <span className="ls-tf-label">{label}</span>
        <span className={`ls-dir ${isBuy ? "ls-dir-buy" : "ls-dir-sell"}`}>
          {isBuy ? "▲ BUY" : "▼ SELL"}
        </span>
        {outcome === "WIN"  && (
          <span className="ls-outcome-win">
            WIN ✅ {s.rMulti === 2 ? "@2R" : s.rMulti === 1 ? "@1R" : ""}
          </span>
        )}
        {outcome === "LOSS" && <span className="ls-outcome-loss">LOSS ❌</span>}
        {s.lockAlignment && (
          <span className={`jp-lock-badge jp-lock-${s.lockAlignment}`}>
            {s.lockAlignment === "with"    && `🔒 met lock (${s.lockAtEntry === "BULLISH" ? "▲" : "▼"})`}
            {s.lockAlignment === "against" && `⚠ tegen lock (${s.lockAtEntry === "BULLISH" ? "▲" : "▼"})`}
            {s.lockAlignment === "none"    && "○ geen lock"}
          </span>
        )}
        {s.datetime && <span className="jp-card-date">{s.datetime}</span>}
      </div>

      <div className="ls-steps">
        <div className="ls-step ls-step-done">
          <span className="ls-step-num">1</span>
          <span className="ls-step-text">
            {isBuy ? <>{label} BSL <b>{fp(s.bslLevel)}</b></> : <>{label} SSL <b>{fp(s.sslLevel)}</b></>}
            {(s.step1Ts || s.step1Time) && <span className="ls-step-time"> @ {fmtStepTime(s.step1Ts, s.step1Time)}</span>}
          </span>
        </div>
        <div className="ls-step ls-step-done">
          <span className="ls-step-num">2</span>
          <span className="ls-step-text">
            {isBuy ? <>{label} SSL sweep <b>{fp(s.sweepPrice ?? s.sslLevel)}</b></>
                   : <>{label} BSL sweep <b>{fp(s.sweepPrice ?? s.bslLevel)}</b></>}
            {(s.step2Ts || s.step2Time) && <span className="ls-step-time"> @ {fmtStepTime(s.step2Ts, s.step2Time)}</span>}
            {s.cycleLabel && <span className="ls-step-cycle"> [{s.cycleLabel}]</span>}
          </span>
        </div>
        <div className={`ls-step ${s.entry != null ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">3</span>
          <span className="ls-step-text">
            Entry
            {s.entry != null && <> <b>{fp(s.entry)}</b></>}
            {(s.entryTs || s.entryTime) && <span className="ls-step-time"> @ {fmtStepTime(s.entryTs != null ? s.entryTs / 1000 : null, s.entryTime)}</span>}
            {!s.entryTime && !s.entryTs && s.entryWindowTime && <span className="ls-step-time"> om {s.entryWindowTime}</span>}
          </span>
        </div>
      </div>

      {s.entry != null && s.sl != null && (
        <div className="ls-levels">
          <div className="ls-level-row ls-level-entry">
            <span className="ls-lv-label">Entry</span>
            <span className="ls-lv-val">{fp(s.entry)}</span>
          </div>
          <div className="ls-level-row ls-level-sl">
            <span className="ls-lv-label">SL</span>
            <span className="ls-lv-val">{fp(s.sl)}</span>
            {risk && <span className="ls-lv-extra">{risk.toFixed(1)} pts risico</span>}
          </div>
          {s.tp1 != null && (
            <div className="ls-level-row ls-level-tp">
              <span className="ls-lv-label">TP1 1R</span>
              <span className="ls-lv-val">{fp(s.tp1)}</span>
              {s.tp1Hit && <span className="ls-lv-extra">✓ hit</span>}
            </div>
          )}
          {s.tp2 != null && (
            <div className="ls-level-row ls-level-tp">
              <span className="ls-lv-label">TP2 2R</span>
              <span className="ls-lv-val">{fp(s.tp2)}</span>
              {s.tp2Hit && <span className="ls-lv-extra">✓ hit</span>}
            </div>
          )}
        </div>
      )}

      {(rewardR != null || pnlPts != null) && (
        <div className="jp-result-strip">
          {rewardR != null && (
            <span className={`jp-result-r ${rewardR >= 0 ? "pos" : "neg"}`}>
              {rewardR >= 0 ? "+" : ""}{rewardR}R
            </span>
          )}
          {pnlPts != null && (
            <span className={`jp-result-pnl ${pnlPts >= 0 ? "pos" : "neg"}`}>
              {pnlPts >= 0 ? "+" : ""}{pnlPts.toFixed(1)} pt
            </span>
          )}
          {s.outcomeTime && <span className="jp-result-time">Closed {s.outcomeTime}</span>}
          {s.outcomePrice != null && <span className="jp-result-price">@ {fp(s.outcomePrice)}</span>}
        </div>
      )}
    </div>
  );
}

export default function JournalPage() {
  const { authFetch, user } = useAuth();
  const [filters, setFilters] = useState({
    market: "", direction: "", tf: "", outcome: "", entryWindow: "", day: "", from: "", to: "",
  });
  const [items, setItems]   = useState([]);
  const [total, setTotal]   = useState(0);
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 50;

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) { if (v !== "" && v != null) p.set(k, v); }
    p.set("lockAlignment", FORCED_LOCK);
    return p.toString();
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams(qs);
        p.set("limit", String(PAGE_SIZE));
        p.set("offset", String(offset));
        const [listRes, statsRes] = await Promise.all([
          authFetch(`/api/journal?${p.toString()}`).then(r => r.json()),
          authFetch(`/api/journal/stats?${qs}`).then(r => r.json()),
        ]);
        if (cancelled) return;
        if (listRes.ok) { setItems(listRes.items ?? []); setTotal(listRes.total ?? 0); }
        if (statsRes.ok) setStats(statsRes);
      } catch (e) {
        console.warn("journal fetch:", e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authFetch, qs, offset]);

  function updateFilter(k, v) {
    setOffset(0);
    setFilters(f => ({ ...f, [k]: v }));
  }
  function reset() {
    setOffset(0);
    setFilters({ market: "", direction: "", tf: "", outcome: "", entryWindow: "", day: "", from: "", to: "" });
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page  = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="jp-wrap">
      <header className="jp-header">
        <div className="jp-header-left">
          <Link to="/dashboard" className="jp-back">← Dashboard</Link>
          <h1 className="jp-title">📓 Trade Journal</h1>
        </div>
        <div className="jp-header-right">{user?.name}</div>
      </header>

      {stats && (
        <div className="jp-stats-row">
          <StatTile label="Closed trades" value={stats.total} />
          <StatTile label="Wins"     value={stats.wins}   tone="win" />
          <StatTile label="Losses"   value={stats.losses} tone="loss" />
          <StatTile label="Win rate" value={stats.winRate != null ? `${stats.winRate}%` : "—"} />
          <StatTile label="Avg R"    value={stats.avgR != null ? (stats.avgR >= 0 ? `+${stats.avgR}` : stats.avgR) : "—"} tone={stats.avgR > 0 ? "win" : stats.avgR < 0 ? "loss" : null} />
        </div>
      )}

      <div className="jp-filters">
        <label>
          <span>Markt</span>
          <select value={filters.market} onChange={e => updateFilter("market", e.target.value)}>
            {MARKETS.map(m => <option key={m} value={m}>{m || "Alle"}</option>)}
          </select>
        </label>
        <label>
          <span>TF</span>
          <select value={filters.tf} onChange={e => updateFilter("tf", e.target.value)}>
            {TFS.map(t => <option key={t} value={t}>{t || "Alle"}</option>)}
          </select>
        </label>
        <label>
          <span>Richting</span>
          <select value={filters.direction} onChange={e => updateFilter("direction", e.target.value)}>
            {DIRECTIONS.map(d => <option key={d} value={d}>{d || "Beide"}</option>)}
          </select>
        </label>
        <label>
          <span>Outcome</span>
          <select value={filters.outcome} onChange={e => updateFilter("outcome", e.target.value)}>
            {OUTCOMES.map(o => <option key={o} value={o}>{o || "Alle"}</option>)}
          </select>
        </label>
        <label>
          <span>Entry window (ET)</span>
          <select value={filters.entryWindow} onChange={e => updateFilter("entryWindow", e.target.value)}>
            <option value="">Alle</option>
            {(stats?.entryWindows ?? []).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>
          <span>Dag (ET)</span>
          <select value={filters.day} onChange={e => updateFilter("day", e.target.value)}>
            <option value="">Alle</option>
            {DOW_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </label>
        <label>
          <span>Van</span>
          <input type="date" value={filters.from} onChange={e => updateFilter("from", e.target.value)} />
        </label>
        <label>
          <span>Tot</span>
          <input type="date" value={filters.to} onChange={e => updateFilter("to", e.target.value)} />
        </label>
        <button className="jp-reset" onClick={reset}>Reset</button>
      </div>

      {stats?.byMarket && Object.keys(stats.byMarket).length > 1 && (
        <div className="jp-breakdown">
          <div className="jp-breakdown-title">Per markt</div>
          <div className="jp-breakdown-grid">
            {Object.entries(stats.byMarket).map(([mk, s]) => (
              <div key={mk} className="jp-bd-tile">
                <span className="jp-bd-mk">{mk}</span>
                <span className="jp-bd-wl">{s.wins}W / {s.losses}L</span>
                <span className="jp-bd-wr">{s.winRate != null ? `${s.winRate}%` : "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats?.byEntryWindow && Object.keys(stats.byEntryWindow).length > 0 && (
        <div className="jp-breakdown">
          <div className="jp-breakdown-title">Per entry window (ET)</div>
          <div className="jp-breakdown-grid">
            {Object.entries(stats.byEntryWindow)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([t, s]) => (
                <div key={t} className="jp-bd-tile">
                  <span className="jp-bd-mk">{t}</span>
                  <span className="jp-bd-wl">{s.wins}W / {s.losses}L</span>
                  <span className="jp-bd-wr">
                    {s.winRate != null ? `${s.winRate}%` : "—"}
                    {s.avgR != null && (
                      <span className={`jp-bd-r ${s.avgR >= 0 ? "pos" : "neg"}`}>
                        {" "}· {s.avgR >= 0 ? "+" : ""}{s.avgR}R
                      </span>
                    )}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {stats?.byDow && stats.byDow.some(d => d.wins + d.losses + d.open > 0) && (
        <div className="jp-breakdown">
          <div className="jp-breakdown-title">Per dag van de week (ET)</div>
          <div className="jp-breakdown-grid">
            {stats.byDow.map((s, i) => {
              const total = s.wins + s.losses;
              const wr = total ? Math.round(s.wins / total * 100) : null;
              return (
                <div key={i} className="jp-bd-tile">
                  <span className="jp-bd-mk">{DOW_LABELS[i]}</span>
                  <span className="jp-bd-wl">{s.wins}W / {s.losses}L</span>
                  <span className="jp-bd-wr">{wr != null ? `${wr}%` : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="jp-list-head">
        <span>{total} afgesloten trade{total === 1 ? "" : "s"}</span>
        {loading && <span className="jp-loading">laden…</span>}
      </div>

      <div className="jp-cards">
        {items.length === 0 && !loading && <div className="jp-empty">Geen afgesloten trades (WIN/LOSS) voor deze filters.</div>}
        {items.map(s => (
          <Link key={s.id ?? s.ts} to={`/journal/${encodeURIComponent(s.id ?? s.ts)}`} className="jp-card-link">
            <TradeCard s={s} />
          </Link>
        ))}
      </div>

      {total > PAGE_SIZE && (
        <div className="jp-pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Vorige</button>
          <span>Pagina {page} / {pages}</span>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Volgende →</button>
        </div>
      )}
    </div>
  );
}
