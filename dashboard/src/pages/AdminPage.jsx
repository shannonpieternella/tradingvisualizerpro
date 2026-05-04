import React, { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./AdminPage.css";

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtRel(d) {
  if (!d) return "nooit";
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "zojuist";
  if (m < 60) return `${m}m geleden`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}u geleden`;
  const dd = Math.floor(h / 24);
  return `${dd}d geleden`;
}

function StatCard({ label, value, sub }) {
  return (
    <div className="ap-stat">
      <div className="ap-stat-label">{label}</div>
      <div className="ap-stat-value">{value}</div>
      {sub && <div className="ap-stat-sub">{sub}</div>}
    </div>
  );
}

function Bar({ value, max, label }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="ap-bar-row">
      <div className="ap-bar-label">{label}</div>
      <div className="ap-bar-track"><div className="ap-bar-fill" style={{ width: `${pct}%` }} /></div>
      <div className="ap-bar-value">{value}</div>
    </div>
  );
}

export default function AdminPage() {
  const { authFetch, user } = useAuth();
  const [tab, setTab]               = useState("analytics"); // analytics | users | brokers | vnc
  const [users, setUsers]           = useState([]);
  const [analytics, setAnalytics]   = useState(null);
  const [brokers, setBrokers]       = useState(null);
  const [days, setDays]             = useState(30);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [vncKey, setVncKey]         = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [uRes, aRes] = await Promise.all([
        authFetch("/api/admin/users").then(r => r.json()),
        authFetch(`/api/admin/signal-analytics?days=${days}`).then(r => r.json()),
      ]);
      if (!uRes.ok) throw new Error(uRes.error || "users failed");
      if (!aRes.ok) throw new Error(aRes.error || "analytics failed");
      setUsers(uRes.users);
      setAnalytics(aRes);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch, days]);

  const refreshBrokers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch("/api/admin/broker-analytics").then(r => r.json());
      if (!r.ok) throw new Error(r.error || "brokers failed");
      setBrokers(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { refresh(); }, [refresh]);
  // Lazy-load broker analytics when the tab is opened (3 MetaApi calls per
  // account — only fetch when actually viewing).
  useEffect(() => { if (tab === "brokers" && !brokers) refreshBrokers(); }, [tab, brokers, refreshBrokers]);

  // Trade tab state
  const [positions, setPositions] = useState([]);
  const [tradeForm, setTradeForm] = useState({ market: "ETHUSD", direction: "SELL", entry: "", sl: "", volume: "" });

  // Live TP preview — same 1R/2R/10R rule as the server's computeSweepTP, so
  // the form mirrors what'll actually be dispatched. Returns null until both
  // entry + sl are valid numbers and on the correct side of each other.
  const tpPreview = (() => {
    const e = Number(tradeForm.entry);
    const s = Number(tradeForm.sl);
    if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(s) || s <= 0) return null;
    const isBuy = tradeForm.direction === "BUY";
    if (isBuy && s >= e) return { error: "SL moet onder entry voor BUY" };
    if (!isBuy && s <= e) return { error: "SL moet boven entry voor SELL" };
    const risk = Math.abs(e - s);
    const dec = e > 100 ? 1 : 5;
    const fmt = v => v.toFixed(dec);
    return {
      risk: fmt(risk),
      tp1:  fmt(isBuy ? e + risk        : e - risk),
      tp2:  fmt(isBuy ? e + risk * 2    : e - risk * 2),
      tp3:  fmt(isBuy ? e + risk * 10   : e - risk * 10),
    };
  })();
  const [tradeMsg,  setTradeMsg]  = useState(null);
  const [posLoading, setPosLoading] = useState(false);
  const refreshPositions = useCallback(async () => {
    setPosLoading(true);
    try {
      const r = await authFetch("/api/admin/positions").then(r => r.json());
      if (r.ok) setPositions(r.positions);
    } finally { setPosLoading(false); }
  }, [authFetch]);
  useEffect(() => { if (tab === "trade") refreshPositions(); }, [tab, refreshPositions]);

  async function submitTrade(e) {
    e.preventDefault();
    setTradeMsg(null);
    // Server auto-computes TP1/TP2/TP3 (1R/2R/10R) from entry+sl using the
    // same formula as the auto-engine. Operator only needs entry + sl.
    const body = {
      market:    tradeForm.market,
      direction: tradeForm.direction,
      sl:  Number(tradeForm.sl),
      ...(tradeForm.entry  !== "" ? { entry:  Number(tradeForm.entry)  } : {}),
      ...(tradeForm.volume !== "" ? { volume: Number(tradeForm.volume) } : {}),
    };
    try {
      const r = await authFetch("/api/admin/manual-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "trade failed");
      const okLegs = r.legs.filter(l => l.ok).length;
      setTradeMsg({ ok: true, text: `✓ ${tradeForm.market} ${tradeForm.direction} verstuurd — ${okLegs}/${r.legs.length} legs OK (setupId ${r.setupId})` });
      setTimeout(refreshPositions, 8000);
    } catch (err) {
      setTradeMsg({ ok: false, text: `⚠ ${err.message}` });
    }
  }

  async function closePosition(p) {
    if (!confirm(`Sluit ${p.symbol} ${p.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"} ${p.volume} op ${p.userName ?? p.login}?`)) return;
    try {
      const r = await authFetch("/api/admin/close-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: p.accountId, positionId: p.positionId }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "close failed");
      setTradeMsg({ ok: true, text: `✓ Position ${p.positionId} closed` });
      refreshPositions();
    } catch (err) {
      setTradeMsg({ ok: false, text: `⚠ ${err.message}` });
    }
  }

  async function closeAllSymbol(symbol) {
    if (!confirm(`Sluit ALLE ${symbol} posities op alle subscribers?`)) return;
    try {
      const r = await authFetch("/api/admin/close-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || "close failed");
      setTradeMsg({ ok: true, text: `✓ ${symbol}: ${r.closed.length} closed${r.failed?.length ? `, ${r.failed.length} failed` : ""}` });
      refreshPositions();
    } catch (err) {
      setTradeMsg({ ok: false, text: `⚠ ${err.message}` });
    }
  }

  if (!user?.isAdmin) {
    return <div className="ap-wrap"><div className="ap-error">⚠ Alleen admins.</div></div>;
  }

  return (
    <div className="ap-wrap">
      <header className="ap-header">
        <div className="ap-header-left">
          <Link to="/dashboard" className="ap-back">← Dashboard</Link>
          <div>
            <h1>Admin</h1>
            <p className="ap-sub">Users + signal-engagement analytics</p>
          </div>
        </div>
        <div className="ap-controls">
          <select value={days} onChange={e => setDays(parseInt(e.target.value))} className="ap-select">
            <option value={1}>laatste 24u</option>
            <option value={7}>laatste 7 dagen</option>
            <option value={30}>laatste 30 dagen</option>
            <option value={90}>laatste 90 dagen</option>
          </select>
          <button className="ap-btn" onClick={refresh} disabled={loading}>{loading ? "…" : "↻ refresh"}</button>
        </div>
      </header>

      <nav className="ap-tabs">
        <button className={tab === "analytics" ? "ap-tab-active" : ""} onClick={() => setTab("analytics")}>
          📊 Analytics
        </button>
        <button className={tab === "users" ? "ap-tab-active" : ""} onClick={() => setTab("users")}>
          👥 Users ({users.length})
        </button>
        <button className={tab === "brokers" ? "ap-tab-active" : ""} onClick={() => setTab("brokers")}>
          💼 Brokers{brokers ? ` (${brokers.totals.accounts})` : ""}
        </button>
        <button className={tab === "trade" ? "ap-tab-active" : ""} onClick={() => setTab("trade")}>
          ⚡ Trade
        </button>
        <button className={tab === "vnc" ? "ap-tab-active" : ""} onClick={() => setTab("vnc")}>
          🖥️ Browser (VNC)
        </button>
      </nav>

      {error && <div className="ap-error">⚠ {error}</div>}

      {tab === "analytics" && analytics && (
        <section>
          <div className="ap-stats-row">
            <StatCard label="Totaal views" value={analytics.stats.totalViews.toLocaleString()} sub="all-time" />
            <StatCard label="Vandaag" value={analytics.stats.todayViews.toLocaleString()} sub="signal-views" />
            <StatCard label="Unieke viewers" value={analytics.stats.uniqueViewers.toLocaleString()} sub="all-time" />
            <StatCard label="Users" value={users.length.toLocaleString()} sub="totaal geregistreerd" />
          </div>

          <div className="ap-grid">
            <div className="ap-card">
              <h3>Views per dag</h3>
              {analytics.perDay.length === 0
                ? <div className="ap-empty">Nog geen views in deze periode</div>
                : (() => {
                    const max = Math.max(...analytics.perDay.map(d => d.views));
                    return analytics.perDay.map(d => (
                      <Bar key={d.date} value={d.views} max={max} label={`${d.date} · ${d.uniqueUsers} users`} />
                    ));
                  })()
              }
            </div>

            <div className="ap-card">
              <h3>Top markets / TF</h3>
              {analytics.perMarket.length === 0
                ? <div className="ap-empty">Nog geen data</div>
                : (() => {
                    const max = Math.max(...analytics.perMarket.map(m => m.views));
                    return analytics.perMarket.slice(0, 12).map((m, i) => (
                      <Bar
                        key={`${m.market}-${m.tf}-${i}`}
                        value={m.views}
                        max={max}
                        label={`${m.market} · ${m.tf} · ${m.uniqueUsers} viewers · ${m.avgDwellMs ?? 0}ms avg`}
                      />
                    ));
                  })()
              }
            </div>
          </div>

          <div className="ap-card">
            <h3>Top 50 active users</h3>
            {analytics.perUser.length === 0
              ? <div className="ap-empty">Nog geen views in deze periode</div>
              : (
                <table className="ap-table">
                  <thead>
                    <tr><th>#</th><th>Email</th><th>Views</th><th>Markets</th><th>Laatste view</th></tr>
                  </thead>
                  <tbody>
                    {analytics.perUser.map((u, i) => (
                      <tr key={u.userId}>
                        <td>{i + 1}</td>
                        <td>{u.email || "—"}</td>
                        <td><b>{u.views}</b></td>
                        <td>{u.markets}</td>
                        <td>{fmtRel(u.lastView)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </div>

          <div className="ap-card">
            <h3>Per user × markt — wie kijkt naar welke markets</h3>
            {(!analytics.userMarketMatrix || analytics.userMarketMatrix.length === 0)
              ? <div className="ap-empty">Nog geen data</div>
              : (() => {
                  const allMarkets = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
                  return (
                    <div className="ap-matrix-wrap">
                      <table className="ap-table ap-table-compact ap-matrix">
                        <thead>
                          <tr>
                            <th>Email</th>
                            <th>Totaal</th>
                            {allMarkets.map(m => <th key={m}>{m}</th>)}
                            <th>Laatst</th>
                          </tr>
                        </thead>
                        <tbody>
                          {analytics.userMarketMatrix.map(u => {
                            const map = Object.fromEntries((u.byMarket ?? []).map(b => [b.market, b.views]));
                            return (
                              <tr key={u._id}>
                                <td>{u.email || "—"}</td>
                                <td><b>{u.totalViews}</b></td>
                                {allMarkets.map(m => (
                                  <td key={m} className={map[m] ? "ap-cell-active" : "ap-cell-empty"}>
                                    {map[m] ?? "·"}
                                  </td>
                                ))}
                                <td>{fmtRel(u.lastView)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
            }
          </div>

          <div className="ap-card">
            <h3>Recent activity (laatste 100 views)</h3>
            {analytics.recent.length === 0
              ? <div className="ap-empty">Nog geen activity</div>
              : (
                <table className="ap-table ap-table-compact">
                  <thead>
                    <tr><th>Tijd</th><th>Email</th><th>Markt</th><th>TF</th><th>Dwell</th></tr>
                  </thead>
                  <tbody>
                    {analytics.recent.map(r => (
                      <tr key={r._id}>
                        <td>{fmtRel(r.timestamp)}</td>
                        <td>{r.email || "—"}</td>
                        <td>{r.market}</td>
                        <td>{r.tf}</td>
                        <td>{r.dwellMs ? `${r.dwellMs}ms` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            }
          </div>
        </section>
      )}

      {tab === "brokers" && (
        <section>
          <div className="ap-stats-row">
            <StatCard label="Subscribers"  value={brokers?.totals.accounts ?? "—"} sub={brokers ? `${brokers.totals.connected} verbonden` : ""} />
            <StatCard label="Open posities" value={brokers?.totals.openPositions ?? "—"} sub="totaal" />
            <StatCard label="Sum balance"  value={brokers ? `$${brokers.totals.balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"} />
            <StatCard label="Sum equity"   value={brokers ? `$${brokers.totals.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"} />
            <StatCard
              label="Floating PnL"
              value={brokers ? `${brokers.totals.floatingPnl >= 0 ? "+" : ""}$${brokers.totals.floatingPnl.toFixed(2)}` : "—"}
              sub={brokers ? (brokers.totals.floatingPnl >= 0 ? "↑ in winst" : "↓ in verlies") : ""}
            />
          </div>

          <div className="ap-card">
            <div className="ap-vnc-head">
              <h3>Per account</h3>
              <div className="ap-vnc-actions">
                <span className="ap-stat-sub">{brokers?.fetchedAt ? `bijgewerkt ${fmtRel(brokers.fetchedAt)}` : ""}</span>
                <button className="ap-btn" onClick={refreshBrokers} disabled={loading}>{loading ? "…" : "↻ refresh"}</button>
              </div>
            </div>
            {!brokers
              ? <div className="ap-empty">{loading ? "Laden…" : "Nog geen data"}</div>
              : brokers.accounts.length === 0
                ? <div className="ap-empty">Nog geen broker-accounts gekoppeld.</div>
                : (
                  <table className="ap-table">
                    <thead>
                      <tr>
                        <th>User</th><th>Broker / login</th><th>Status</th>
                        <th>Balance</th><th>Equity</th><th>Open</th><th>Float PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {brokers.accounts.map(a => {
                        const ok = a.connectionStatus === "CONNECTED" && a.state === "DEPLOYED";
                        return (
                          <tr key={a.id}>
                            <td>{a.userName || a.userEmail || "—"}</td>
                            <td>{a.broker} · {a.login}<br /><span className="ap-stat-sub">{a.server}</span></td>
                            <td>
                              <span className={`bp-pill bp-pill-${ok ? "ok" : "bad"}`}>
                                {ok ? "Verbonden" : (a.state || a.connectionStatus || "—")}
                              </span>
                              {!a.copyEnabled && <div className="ap-stat-sub">copy uit</div>}
                            </td>
                            <td>{a.balance != null ? `${a.currency || "$"}${a.balance.toFixed(2)}` : "—"}</td>
                            <td>{a.equity  != null ? `${a.currency || "$"}${a.equity.toFixed(2)}`  : "—"}</td>
                            <td>{a.positions.length}</td>
                            <td className={a.floatingPnl >= 0 ? "ap-cell-active" : "ap-cell-empty"}>
                              {a.floatingPnl >= 0 ? "+" : ""}{a.floatingPnl.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
            }
          </div>

          {brokers?.accounts.some(a => a.positions.length > 0) && (
            <div className="ap-card">
              <h3>Open posities</h3>
              <table className="ap-table ap-table-compact">
                <thead>
                  <tr>
                    <th>User</th><th>Symbol</th><th>Dir</th><th>Lot</th>
                    <th>Open</th><th>Now</th><th>SL</th><th>TP</th><th>PnL</th><th>Geopend</th>
                  </tr>
                </thead>
                <tbody>
                  {brokers.accounts.flatMap(a =>
                    a.positions.map(p => (
                      <tr key={`${a.id}-${p.id}`}>
                        <td>{a.userName || a.userEmail || a.login}</td>
                        <td>{p.symbol}</td>
                        <td>{p.type === "POSITION_TYPE_BUY" ? "▲ BUY" : "▼ SELL"}</td>
                        <td>{p.volume}</td>
                        <td>{p.openPrice}</td>
                        <td>{p.currentPrice}</td>
                        <td>{p.stopLoss ?? "—"}</td>
                        <td>{p.takeProfit ?? "—"}</td>
                        <td className={p.profit >= 0 ? "ap-cell-active" : "ap-cell-empty"}>
                          {p.profit >= 0 ? "+" : ""}{(p.profit ?? 0).toFixed(2)}
                        </td>
                        <td>{fmtRel(p.time)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "trade" && (
        <section>
          <div className="ap-card">
            <h3>Manual trade — direct CopyFactory signal</h3>
            <p className="ap-vnc-hint">
              Vul alleen <b>entry</b> en <b>SL</b> in — TP1 (1R), TP2 (2R) en TP3 (10R runner) worden automatisch berekend met dezelfde formule als de auto-engine. Verstuurt 3 legs naar CopyFactory; subscribers krijgen ze met hun eigen risk-scaling. Entry leeg laten = huidige market price.
              <br /><b>Lock bias-mode</b> filtert alleen welke richting de auto-engine accepteert; voor een directe handmatige trade gebruik dit formulier.
            </p>
            <form className="ap-trade-form" onSubmit={submitTrade}>
              <div className="ap-trade-row">
                <label>Markt
                  <select value={tradeForm.market} onChange={e => setTradeForm(f => ({ ...f, market: e.target.value }))}>
                    {["NAS100","US500","US30","XAUUSD","GBPUSD","BTCUSD","ETHUSD"].map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label>Richting
                  <div className="ap-dir-toggle">
                    <button type="button"
                      className={`ap-dir-btn ${tradeForm.direction === "BUY" ? "ap-dir-buy" : ""}`}
                      onClick={() => setTradeForm(f => ({ ...f, direction: "BUY" }))}>▲ BUY</button>
                    <button type="button"
                      className={`ap-dir-btn ${tradeForm.direction === "SELL" ? "ap-dir-sell" : ""}`}
                      onClick={() => setTradeForm(f => ({ ...f, direction: "SELL" }))}>▼ SELL</button>
                  </div>
                </label>
                <label>Volume <span className="ap-label-hint">(lots, optioneel)</span>
                  <input type="number" step="0.01" placeholder="0.01" value={tradeForm.volume}
                    onChange={e => setTradeForm(f => ({ ...f, volume: e.target.value }))} />
                </label>
              </div>
              <div className="ap-trade-divider">Entry + SL</div>
              <div className="ap-trade-row">
                <label>Entry <span className="ap-label-hint">(leeg = market)</span>
                  <input type="number" step="0.0001" placeholder="market price" value={tradeForm.entry}
                    onChange={e => setTradeForm(f => ({ ...f, entry: e.target.value }))} />
                </label>
                <label>Stop Loss
                  <input type="number" step="0.0001" required placeholder="—" value={tradeForm.sl}
                    onChange={e => setTradeForm(f => ({ ...f, sl: e.target.value }))} />
                </label>
              </div>
              <div className="ap-trade-divider">Auto-TP (1R · 2R · 10R)</div>
              <div className="ap-trade-row" style={{ alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                {tpPreview?.error ? (
                  <span className="ap-trade-err">⚠ {tpPreview.error}</span>
                ) : tpPreview ? (
                  <>
                    <span><b>Risk:</b> {tpPreview.risk} pts</span>
                    <span><b>TP1:</b> {tpPreview.tp1}</span>
                    <span><b>TP2:</b> {tpPreview.tp2}</span>
                    <span><b>TP3:</b> {tpPreview.tp3}</span>
                  </>
                ) : (
                  <span className="ap-label-hint">Vul entry + SL voor auto-berekening</span>
                )}
              </div>
              <div className="ap-trade-actions">
                <button type="submit" className="ap-btn-primary">⚡ Verstuur signal</button>
                {tradeMsg && <span className={tradeMsg.ok ? "ap-trade-ok" : "ap-trade-err"}>{tradeMsg.text}</span>}
              </div>
            </form>
          </div>

          <div className="ap-card">
            <div className="ap-vnc-head">
              <h3>Open posities ({positions.length})</h3>
              <div className="ap-vnc-actions">
                <button className="ap-btn" onClick={refreshPositions} disabled={posLoading}>
                  {posLoading ? "…" : "↻ refresh"}
                </button>
              </div>
            </div>
            {positions.length === 0 ? (
              <div className="ap-empty">Geen open posities op subscribers.</div>
            ) : (
              <table className="ap-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Login</th>
                    <th>Symbol</th>
                    <th>Type</th>
                    <th>Vol</th>
                    <th>Open</th>
                    <th>Now</th>
                    <th>SL</th>
                    <th>TP</th>
                    <th>P&amp;L</th>
                    <th>Tijd</th>
                    <th>Sluit</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(p => (
                    <tr key={`${p.accountId}-${p.positionId}`}>
                      <td>{p.userName ?? "—"}</td>
                      <td>{p.login}</td>
                      <td><b>{p.symbol}</b></td>
                      <td>{p.type === "POSITION_TYPE_BUY" ? "BUY" : "SELL"}</td>
                      <td>{p.volume}</td>
                      <td>{p.openPrice}</td>
                      <td>{p.currentPrice ?? "—"}</td>
                      <td>{p.stopLoss ?? "—"}</td>
                      <td>{p.takeProfit ?? "—"}</td>
                      <td style={{ color: p.profit > 0 ? "#0a7" : p.profit < 0 ? "#c33" : undefined }}>
                        {p.profit != null ? p.profit.toFixed(2) : "—"}
                      </td>
                      <td>{fmtRel(p.time)}</td>
                      <td><button className="ap-btn-small" onClick={() => closePosition(p)}>Sluit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {positions.length > 0 && (
              <div className="ap-trade-row" style={{ marginTop: "12px" }}>
                {[...new Set(positions.map(p => p.symbol))].map(sym => (
                  <button key={sym} className="ap-btn" onClick={() => closeAllSymbol(sym)}>
                    Sluit alle {sym} ({positions.filter(p => p.symbol === sym).length})
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {tab === "vnc" && (
        <section>
          <div className="ap-card">
            <div className="ap-vnc-head">
              <h3>Live TradingView browser</h3>
              <div className="ap-vnc-actions">
                <a className="ap-btn" href="/novnc/vnc.html?autoconnect=1&resize=scale" target="_blank" rel="noopener">↗ open in nieuw tabblad</a>
                <button className="ap-btn" onClick={() => setVncKey(k => k + 1)}>↻ herlaad</button>
              </div>
            </div>
            <p className="ap-vnc-hint">
              Hier zie je live wat de monitor in Chrome doet (symbol-switches per cyclus). <b>Niet zelf in de chart klikken</b> — dat verstoort de scan.
            </p>
            <iframe
              key={vncKey}
              className="ap-vnc-frame"
              src="/novnc/vnc.html?autoconnect=1&resize=scale"
              title="noVNC TradingView browser"
            />
          </div>
        </section>
      )}

      {tab === "users" && (
        <section>
          <div className="ap-card">
            <h3>Alle users ({users.length})</h3>
            <table className="ap-table">
              <thead>
                <tr>
                  <th>Naam</th>
                  <th>Email</th>
                  <th>Geregistreerd</th>
                  <th>Logins</th>
                  <th>Last login</th>
                  <th>Signal views</th>
                  <th>Last view</th>
                  <th>Admin</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u._id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{fmtDate(u.createdAt)}</td>
                    <td>{u.loginCount}</td>
                    <td>{fmtRel(u.lastLogin)}</td>
                    <td><b>{u.signalViews}</b></td>
                    <td>{fmtRel(u.lastSignalView)}</td>
                    <td>{u.isAdmin ? "✓" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
