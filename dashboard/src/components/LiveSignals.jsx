import React, { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useLiveData } from "../contexts/LiveDataContext.jsx";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./LiveSignals.css";

// View-tracker: fires POST /api/signal-view once per (market, tf, session)
// when the wrapped card has been visible for ≥1500ms. Uses IntersectionObserver
// for zero UX impact — user just scrolls, the view is logged silently.
function ViewTracker({ market, tf, setupId, children }) {
  const ref = useRef(null);
  const { authFetch } = useAuth();
  const sentRef = useRef(false);
  const enteredAtRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!ref.current || sentRef.current) return;
    const node = ref.current;
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !sentRef.current) {
        enteredAtRef.current = Date.now();
        timerRef.current = setTimeout(() => {
          if (sentRef.current) return;
          sentRef.current = true;
          const dwellMs = Date.now() - enteredAtRef.current;
          authFetch("/api/signal-view", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ market, tf, setupId, dwellMs }),
          }).catch(() => {});
        }, 1500);
      } else if (!entry.isIntersecting && timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }, { threshold: 0.5 });
    io.observe(node);
    return () => { io.disconnect(); if (timerRef.current) clearTimeout(timerRef.current); };
  }, [market, tf, setupId, authFetch]);

  return <div ref={ref} className="ls-view-tracker">{children}</div>;
}

const MARKET_LABELS = {
  NAS100: "NAS100", US500: "S&P 500", US30: "DOW", XAUUSD: "GOLD", GBPUSD: "CABLE", BTCUSD: "BTC/USD", ETHUSD: "ETH/USD",
};

// Entry windows (ET) — one per 6H cycle. Used as the fixed entry time for all timeframes.
// Times shifted to +15min from window-open: entry is taken on the OPEN of the
// 15-min candle that opens 15 min after the window opens (more stable than the
// volatile first candle at window-open).
const ENTRY_WINDOWS = ["02:45", "08:45", "14:45", "20:45"];
// Default entry time label for daily signals (when no specific sweep-derived window applies)
const DAILY_ENTRY_TIME = "06:00";

function fmtPrice(p, market) {
  if (p == null) return "—";
  if (typeof market === "string" && market.includes("GBP")) return Number(p).toFixed(5);
  if (Number(p) > 1000) return Number(p).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return Number(p).toFixed(5);
}

// Format a step time with date prefix in DD-MM-YYYY format (EU style) when the
// event isn't today. Today → just "HH:MM" to reduce noise.
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

function StatusBadge({ status }) {
  const map = {
    watching:     { label: "WACHT OP SWEEP",       cls: "ls-status-watch"   },
    bsl_swept:    { label: "SWEEP ✓ — wacht entry", cls: "ls-status-partial" },
    swept:        { label: "SWEEP ✓ — wacht entry", cls: "ls-status-swept"   },
    entry_active: { label: "ENTRY ACTIEF",           cls: "ls-status-active"  },
  };
  const s = map[status] ?? { label: status, cls: "" };
  return <span className={`ls-status-badge ${s.cls}`}>{s.label}</span>;
}

function OutcomeBadge({ outcome }) {
  if (!outcome || outcome === "OPEN") return <span className="ls-outcome-open">OPEN</span>;
  if (outcome === "WIN")  return <span className="ls-outcome-win">WIN ✅</span>;
  if (outcome === "LOSS") return <span className="ls-outcome-loss">LOSS ❌</span>;
  return null;
}

// Premium / Discount zone tag — small badge shown next to step-1 and step-2
// sweep prices on the card. Aligned with the setup direction (BUY=discount,
// SELL=premium) renders green; mis-aligned renders red. Falls back to neutral
// when daily/6H eq aren't available yet (early in a session).
function ZoneTag({ price, dailyEq, sixHEq, direction }) {
  if (price == null || (dailyEq == null && sixHEq == null)) return null;
  const zoneOf = (eq) => eq == null ? null : (price < eq ? "DISCOUNT" : "PREMIUM");
  const dZone = zoneOf(dailyEq);
  const hZone = zoneOf(sixHEq);
  const same  = dZone && hZone && dZone === hZone;
  const primary = same ? dZone : (dZone ?? hZone);
  if (!primary) return null;
  const aligned = direction === "BUY"
    ? primary === "DISCOUNT"
    : direction === "SELL"
      ? primary === "PREMIUM"
      : false;
  const cls = `ls-zone-tag ls-zone-${primary === "DISCOUNT" ? "d" : "p"} ${aligned ? "ls-zone-aligned" : ""}`;
  const label = primary === "DISCOUNT" ? "💧 DISC" : "🔥 PREM";
  const mixed = dZone && hZone && dZone !== hZone;
  return (
    <span className={cls} title={`Daily: ${dZone ?? "?"} | 6H: ${hZone ?? "?"}`}>
      {label}{mixed ? " ⚠" : ""}
    </span>
  );
}

function SignalCard({ label, sig, market, activeSetup, currentPrice, dailyEq = null, sixHEq = null, hasPinnedActive = false, hasRecentClose = null }) {
  if (!sig) return null;

  const isBuy    = sig.type === "BUY";
  const fp       = p => fmtPrice(p, market);
  const isActive = sig.status === "entry_active";

  // Overlay activeSetup state (from monitor) onto the card
  const setup    = activeSetup;
  // hasRecentClose ("WIN"|"LOSS"|null) lets a recently-closed setup colour the
  // card and badge even when no setup is overlaid on it (orphan cycle case).
  const isClosed = setup?.status === "CLOSED_SL" || setup?.status === "CLOSED_TP2" || !!hasRecentClose;
  const isLive   = setup?.status === "ACTIVE";

  // A step is "done" only when we have an actual hit timestamp/time for it.
  // An activeSetup's existence alone is NOT proof — the monitor can create
  // setups from partial sweep patterns (e.g. only the second leg fired),
  // so showing step-1 green without an actual hit time is misleading.
  const setupStep1Confirmed = !!(setup && (setup.step1Ts || setup.step1Time));
  const setupStep2Confirmed = !!(setup && (setup.step2Ts || setup.step2Time));
  const bslDone  = setupStep1Confirmed || sig.status === "bsl_swept" || sig.status === "swept" || sig.triggered || sig.bslHit;
  const sslDone  = setupStep2Confirmed || sig.status === "swept" || sig.triggered || sig.sslHit;

  // Step display values: when an activeSetup exists it is the ground truth —
  // use its stored bslLevel/sslLevel/times/cycleLabel (captured at signal creation)
  // so the card stays correct across session rollovers where live cycles shift.
  // Only fall back to the live signal when no setup is present.
  // BSL is always the cycle high (sell-side stops above), SSL is the cycle low
  // (buy-side stops below) — irrespective of trade direction.
  const effBslLevel = setup?.bslLevel ?? sig.bslLevel;
  const effSslLevel = setup?.sslLevel ?? sig.sslLevel;
  const effStep1Time  = setup?.step1Time  ?? sig.bslHitTime;
  const effStep2Time  = setup?.step2Time  ?? sig.sweepTime ?? sig.sslHitTime;
  const effCycleLabel      = setup?.cycleLabel ?? sig.cycleLabel;
  // In cross-cycle scenarios (step-1 in older cycle, step-2 target in newer cycle),
  // buildSignal passes a separate step1CycleLabel. When absent it defaults to cycleLabel.
  const effStep1CycleLabel = sig.step1CycleLabel ?? effCycleLabel;
  const isWaiting  = setup?.status === "WAITING_PHASE2";
  const outcome    = setup?.status === "CLOSED_TP2" ? "WIN"
                   : setup?.status === "CLOSED_SL"  ? "LOSS"
                   : sig.outcome ?? hasRecentClose ?? null;

  // Helper: is current NY time past the entry window?
  const pastEntryWindow = !!(sig.entryTimeLabel && (() => {
    try {
      const [h, m] = sig.entryTimeLabel.split(":").map(Number);
      const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      return et.getHours() * 60 + et.getMinutes() >= h * 60 + m;
    } catch { return false; }
  })());

  // Entry window pending: hide live progress until the fixed entry time (90min card)
  const entryWindowPending = !!(isLive && sig.entryTimeLabel && !pastEntryWindow);

  // Entry window open: BOTH sweeps done + past entry time + no activeSetup (6H/Daily cards).
  // "bsl_swept" status means only step-1 is swept (step-2 still pending) — that is NOT
  // a valid entry trigger. Only "swept" (both legs done in correct order) counts.
  const entryWindowOpen = !setup && pastEntryWindow && sig.status === "swept";

  // Live progress
  const price   = currentPrice;
  const risk    = setup?.entry && setup?.sl ? Math.abs(setup.entry - setup.sl) : null;
  const pnlPts  = isLive && !entryWindowPending && price && setup?.entry
                  ? (isBuy ? price - setup.entry : setup.entry - price) : null;
  const pnlR    = risk && pnlPts != null ? pnlPts / risk : null;
  const toTP    = isLive && !entryWindowPending && price && setup?.tp1 ? Math.abs(setup.tp1 - price) : null;
  const toSL    = isLive && !entryWindowPending && price && setup?.sl  ? Math.abs(price - setup.sl)  : null;

  const cardCls = isClosed
    ? (outcome === "WIN" ? "ls-card-win" : "ls-card-loss")
    : isActive || isLive ? "ls-active" : "";

  return (
    <div className={`ls-card ${isBuy ? "ls-buy" : "ls-sell"} ${cardCls}`}>
      <div className="ls-card-header">
        <span className="ls-tf-label">{label}</span>
        <span className={`ls-dir ${isBuy ? "ls-dir-buy" : "ls-dir-sell"}`}>
          {isBuy ? "▲ BUY" : "▼ SELL"}
        </span>
        {outcome
          ? <OutcomeBadge outcome={outcome} />
          : entryWindowPending
            ? <span className="ls-status-badge ls-status-watch">WACHT {sig.entryTimeLabel}</span>
            : entryWindowOpen || isLive
              ? <StatusBadge status="entry_active" />
              : <StatusBadge status={isWaiting ? "swept" : sig.status} />
        }
        {sig.lockStrength > 0 && <span className="ls-lock-strength">Lock ×{sig.lockStrength}</span>}
      </div>

      <div className="ls-steps">
        <div className={`ls-step ${bslDone ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">1</span>
          <span className="ls-step-text">
            {isBuy ? <>{label} BSL <b>{fp(effBslLevel)}</b></> : <>{label} SSL <b>{fp(effSslLevel)}</b></>}
            {effStep1Time && <span className="ls-step-time"> @ {effStep1Time}</span>}
            {effStep1CycleLabel && <span className="ls-step-cycle"> [{effStep1CycleLabel}]</span>}
            {bslDone && (
              <ZoneTag
                price={isBuy ? effBslLevel : effSslLevel}
                dailyEq={dailyEq} sixHEq={sixHEq} direction={sig.type}
              />
            )}
          </span>
        </div>
        <div className={`ls-step ${sslDone ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">2</span>
          <span className="ls-step-text">
            {isBuy
              ? <>{label} SSL sweep <b>{fp(setup?.sweepPrice ?? effSslLevel)}</b></>
              : <>{label} BSL sweep <b>{fp(setup?.sweepPrice ?? effBslLevel)}</b></>
            }
            {effStep2Time && <span className="ls-step-time"> @ {effStep2Time}</span>}
            {effCycleLabel && <span className="ls-step-cycle"> [{effCycleLabel}]</span>}
            {sslDone && (
              <ZoneTag
                price={setup?.sweepPrice ?? (isBuy ? effSslLevel : effBslLevel)}
                dailyEq={dailyEq} sixHEq={sixHEq} direction={sig.type}
              />
            )}
          </span>
        </div>
        <div className={`ls-step ${(isActive || isLive || entryWindowOpen) ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">3</span>
          <span className="ls-step-text">
            Entry
            {/* During WAITING_PHASE2 we don't know the entry price yet — entry is
                TIME-BASED: executes at the entry window (e.g. 20:30) at whatever the
                market price is at that moment. Only show the price after the trade
                has actually triggered (ACTIVE/CLOSED). */}
            {(isLive || isClosed) && setup?.entry && <> <b>{fp(setup.entry)}</b></>}
            {(isLive || isClosed) && setup?.entryTime && (
              <span className="ls-step-time"> @ {setup.entryTime}</span>
            )}
            {isWaiting && (setup?.entryWindowTs || setup?.entryWindowTime) && (
              <span className="ls-step-time"> om {fmtStepTime(setup.entryWindowTs, setup.entryWindowTime)} ⏳ (tijd-gebaseerd)</span>
            )}
            {/* Fallback: WAITING setup created when all of today's P2 windows had
                already passed used to save null entryWindow* — show the signal-
                level computed entry time so step 3 isn't blank. */}
            {isWaiting && !setup?.entryWindowTs && !setup?.entryWindowTime && sig.entryTimeLabel && (
              <span className="ls-step-time"> om {sig.entryTimeLabel} ⏳ (tijd-gebaseerd)</span>
            )}
            {!setup && sig.entryTimeLabel && (
              <span className="ls-step-time"> @ {sig.entryTimeLabel}</span>
            )}
          </span>
        </div>
      </div>

      {/* Levels from activeSetup */}
      {setup?.entry && setup?.sl && (
        <div className="ls-levels">
          <div className="ls-level-row ls-level-entry">
            <span className="ls-lv-label">Entry</span>
            <span className="ls-lv-val">{fp(setup.entry)}</span>
          </div>
          <div className="ls-level-row ls-level-sl">
            <span className="ls-lv-label">SL</span>
            <span className="ls-lv-val">{fp(setup.sl)}</span>
            {risk && <span className="ls-lv-extra">{risk.toFixed(1)} pts risico</span>}
          </div>
          <div className="ls-level-row ls-level-tp">
            <span className="ls-lv-label">TP1 1R</span>
            <span className="ls-lv-val">{fp(setup.tp1)}</span>
            {setup.tp1Hit && <span className="ls-lv-extra">✓ hit</span>}
          </div>
          {setup.tp2 != null && (
            <div className="ls-level-row ls-level-tp">
              <span className="ls-lv-label">TP2 2R</span>
              <span className="ls-lv-val">{fp(setup.tp2)}</span>
              {setup.tp2Hit && <span className="ls-lv-extra">✓ hit</span>}
            </div>
          )}
        </div>
      )}

      {/* Live progress bar */}
      {isLive && pnlPts != null && risk && (
        <div className="ls-progress">
          <div className="ls-prog-row">
            <span className="ls-prog-price">{fp(price)}</span>
            <span className={`ls-prog-pnl ${pnlPts >= 0 ? "pos" : "neg"}`}>
              {pnlPts >= 0 ? "+" : ""}{pnlPts.toFixed(1)}pt
            </span>
            <span className={`ls-prog-r ${pnlR >= 0 ? "pos" : "neg"}`}>
              {pnlR >= 0 ? "+" : ""}{pnlR.toFixed(2)}R
            </span>
          </div>
          <div className="ls-prog-bar-wrap">
            <span className="ls-prog-sl-lbl">SL</span>
            <div className="ls-prog-track">
              <div
                className={`ls-prog-fill ${pnlPts >= 0 ? "pos" : "neg"}`}
                style={{ width: `${Math.min(100, Math.max(0, Math.abs(pnlR ?? 0) / 2 * 100))}%` }}
              />
            </div>
            <span className="ls-prog-tp-lbl">TP</span>
          </div>
          <div className="ls-prog-dists">
            <span className="neg">−{toSL?.toFixed(1)}pt</span>
            <span className="pos">+{toTP?.toFixed(1)}pt</span>
          </div>
        </div>
      )}

      {/* Synthesized progress for cards whose entry window is open but no
          monitor-managed setup exists yet (typically the Daily card). Entry
          price comes from sig.entryCandleOpen (actual open at entry time, e.g.
          06:00 ET for daily). If unavailable, falls back to sig.sslLevel/bslLevel.
          Skip when:
            - a pinned ACTIVE setup with matching tf+direction is already shown
              (otherwise user sees two different entry prices for the same trade)
            - a recently CLOSED setup (SL or TP) for this cycle exists — the
              trade has already played out; don't show "ENTRY ACTIEF" again */}
      {entryWindowOpen && !setup && !hasPinnedActive && !hasRecentClose && price && sig.sslLevel && sig.bslLevel && (() => {
        const entryV = Number(sig.entryCandleOpen ?? (isBuy ? sig.sslLevel : sig.bslLevel));
        const sweepV = Number(sig.sweepLevel ?? (isBuy ? sig.sslLevel : sig.bslLevel));
        const buf    = entryV > 10000 ? 5 : entryV > 1000 ? 2 : entryV > 10 ? 0.5 : 0.0005;
        const slV    = isBuy ? sweepV - buf : sweepV + buf;
        const riskV  = Math.abs(entryV - slV);
        if (!riskV) return null;
        const tp1V   = isBuy ? entryV + 1 * riskV : entryV - 1 * riskV;
        const tp2V   = isBuy ? entryV + 2 * riskV : entryV - 2 * riskV;
        const tpV    = tp1V;  // alias for existing refs below
        const pnlV   = isBuy ? price - entryV : entryV - price;
        const pnlRV  = pnlV / riskV;
        const toTPv  = Math.abs(tpV - price);
        const toSLv  = Math.abs(price - slV);
        return (
          <>
            <div className="ls-levels">
              <div className="ls-level-row ls-level-entry">
                <span className="ls-lv-label">Entry (geschat)</span>
                <span className="ls-lv-val">{fp(entryV)}</span>
              </div>
              <div className="ls-level-row ls-level-sl">
                <span className="ls-lv-label">SL</span>
                <span className="ls-lv-val">{fp(slV)}</span>
                <span className="ls-lv-extra">{riskV.toFixed(1)} pts risico</span>
              </div>
              <div className="ls-level-row ls-level-tp">
                <span className="ls-lv-label">TP1 1R</span>
                <span className="ls-lv-val">{fp(tp1V)}</span>
              </div>
              <div className="ls-level-row ls-level-tp">
                <span className="ls-lv-label">TP2 2R</span>
                <span className="ls-lv-val">{fp(tp2V)}</span>
              </div>
            </div>
            <div className="ls-progress">
              <div className="ls-prog-row">
                <span className="ls-prog-price">{fp(price)}</span>
                <span className={`ls-prog-pnl ${pnlV >= 0 ? "pos" : "neg"}`}>
                  {pnlV >= 0 ? "+" : ""}{pnlV.toFixed(1)}pt
                </span>
                <span className={`ls-prog-r ${pnlRV >= 0 ? "pos" : "neg"}`}>
                  {pnlRV >= 0 ? "+" : ""}{pnlRV.toFixed(2)}R
                </span>
              </div>
              <div className="ls-prog-bar-wrap">
                <span className="ls-prog-sl-lbl">SL</span>
                <div className="ls-prog-track">
                  <div
                    className={`ls-prog-fill ${pnlV >= 0 ? "pos" : "neg"}`}
                    style={{ width: `${Math.min(100, Math.max(0, Math.abs(pnlRV) / 2 * 100))}%` }}
                  />
                </div>
                <span className="ls-prog-tp-lbl">TP</span>
              </div>
              <div className="ls-prog-dists">
                <span className="neg">−{toSLv.toFixed(1)}pt</span>
                <span className="pos">+{toTPv.toFixed(1)}pt</span>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}

// Returns the best reference cycle/day from a most-recent-first candidates array.
// Priority:
//   1. Most recent where step-1 done but step-2 NOT yet (in-progress — most actionable)
//   2. Most recent where both done in correct order, within first 3 candidates (fresh complete)
//   3. Most recent (watching — waiting for step-1)
function findBestCandleRef(candidates, dir) {
  if (!candidates.length) return null;
  if (!dir) return candidates[0];
  const isBuy = dir === "BUY";
  // Prefer the most recent complete sweep (both steps done). When ts is absent
  // (e.g. daily levels that store only date strings), treat both-hit as valid.
  const freshComplete = candidates.slice(0, 3).find(c => {
    if (!c.hitHigh || !c.hitLow) return false;
    const hts = c.hitHigh.ts ?? 0;
    const lts = c.hitLow.ts  ?? 0;
    if (hts === 0 && lts === 0) return true; // no timestamps → accept if both swept
    return isBuy ? hts < lts : lts < hts;
  });
  if (freshComplete) return freshComplete;
  // Fall back to the most recent candle with at least step 1 done (in progress).
  const inProgress = candidates.find(c => {
    const step1 = isBuy ? c.hitHigh != null : c.hitLow != null;
    const step2 = isBuy ? c.hitLow  != null : c.hitHigh != null;
    return step1 && !step2;
  });
  if (inProgress) return inProgress;
  return candidates[0];
}

// Entry window based on WHEN the sweep happened — fixed, not current-time.
// Window-open is at :30, but entry is taken on the +15min candle, so labels are :45.
function entryWindowForSweepTime(timeStr) {
  if (!timeStr) return null;
  try {
    const [h, m] = timeStr.split(":").map(Number);
    const mins = h * 60 + m;
    const ENTRIES = [
      { mins:  2 * 60 + 30, label: "02:45" },
      { mins:  8 * 60 + 30, label: "08:45" },
      { mins: 14 * 60 + 30, label: "14:45" },
      { mins: 20 * 60 + 30, label: "20:45" },
    ];
    const next = ENTRIES.find(e => e.mins > mins);
    return next ? next.label : "02:45"; // after 20:30 → next session
  } catch { return null; }
}

// Fallback for cards still waiting on a sweep — preview the NEXT entry window
// from current ET time so step 3 always shows when entry would fire.
function nextEntryWindowFromNow() {
  try {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const mins = et.getHours() * 60 + et.getMinutes();
    const ENTRIES = [
      { mins:  2 * 60 + 30, label: "02:45" },
      { mins:  8 * 60 + 30, label: "08:45" },
      { mins: 14 * 60 + 30, label: "14:45" },
      { mins: 20 * 60 + 30, label: "20:45" },
    ];
    const next = ENTRIES.find(e => e.mins > mins);
    return next ? next.label : "02:45";
  } catch { return "02:45"; }
}

// Build a signal from any N-1 cycle (generic for 90min, 6H, daily)
function buildSignal(dir, lockStrength, bslLevel, sslLevel, hitHigh, hitLow, cycleLabel, step1CycleLabel, entryTimeLabel) {
  if (!dir || bslLevel == null || sslLevel == null) return null;
  const isBuy = dir === "BUY";
  const bslSwept = !!hitHigh;
  const sslSwept = !!hitLow;

  let status;
  if (isBuy) {
    // BUY: step 1 = BSL swept, step 2 = SSL swept (in that order).
    // When ts is absent (daily levels use date strings), treat both-hit as correct order.
    const hts = hitHigh?.ts ?? 0, lts = hitLow?.ts ?? 0;
    const correctOrder = bslSwept && sslSwept && (hts === 0 && lts === 0 ? true : hts < lts);
    if (correctOrder)  status = "swept";
    else if (bslSwept) status = "bsl_swept";
    else               status = "watching";
  } else {
    // SELL: step 1 = SSL swept, step 2 = BSL swept (in that order).
    const lts = hitLow?.ts ?? 0, hts = hitHigh?.ts ?? 0;
    const correctOrder = sslSwept && bslSwept && (lts === 0 && hts === 0 ? true : lts < hts);
    if (correctOrder)  status = "swept";
    else if (sslSwept) status = "bsl_swept";
    else               status = "watching";
  }

  const step2SweepTime = isBuy ? hitLow?.time  : hitHigh?.time;

  // Entry-time label rule:
  //   - explicit override (Daily card uses 06:00) → use as-is
  //   - status "swept" (both legs done in correct order) → window AFTER step2
  //     (this is when entry actually fires for a fresh sweep)
  //   - "bsl_swept" / "watching" → next window FROM CURRENT TIME (step2 not
  //     done yet; the post-step1 window from a prior day would be stale).
  const computedEntryTime = entryTimeLabel
    ?? (status === "swept"
        ? (entryWindowForSweepTime(step2SweepTime) ?? nextEntryWindowFromNow())
        : nextEntryWindowFromNow());

  return {
    type:            dir,
    status,
    lockStrength:    lockStrength ?? 0,
    bslLevel:        Number(bslLevel).toFixed(bslLevel > 100 ? 1 : 5),
    sslLevel:        Number(sslLevel).toFixed(sslLevel > 100 ? 1 : 5),
    bslHitTime:      isBuy ? hitHigh?.time : hitLow?.time,
    sweepLevel:      isBuy ? (sslSwept ? hitLow?.price  : null) : (bslSwept ? hitHigh?.price : null),
    sweepTime:       isBuy ? (sslSwept ? hitLow?.time   : null) : (bslSwept ? hitHigh?.time  : null),
    cycleLabel,
    step1CycleLabel:  step1CycleLabel ?? cycleLabel,
    entryTimeLabel:   computedEntryTime,
  };
}

function getDir(allowedDirection, lockState) {
  return allowedDirection ?? (lockState?.direction === "BULLISH" ? "BUY" : lockState?.direction === "BEARISH" ? "SELL" : null);
}

function build90MinSignal(md) {
  const cycles90 = md?.cycles90 ?? [];
  const dir = getDir(md?.allowedDirection, md?.lockState);
  const completed = [...cycles90]
    .filter(c => c.high != null && c.low != null && c.complete)
    .sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
  if (!completed.length) {
    const any = [...cycles90].filter(c => c.high != null).sort((a, b) => (b.index ?? 0) - (a.index ?? 0));
    if (!any.length) return null;
    const c = any[0];
    return buildSignal(dir, md?.lockState?.strength, c.high, c.low, c.hitHigh, c.hitLow, `${c.startTime}–${c.endTime ?? "now"}`, null);
  }

  const isBuy      = dir === "BUY";
  const mostRecent = completed[0];

  // Cross-cycle: step-1 hit from whichever cycle it happened,
  // step-2 target from the most recent cycle (nearest levels).
  const step1Cycle = dir ? completed.find(c =>
    isBuy ? c.hitHigh != null : c.hitLow != null
  ) : null;

  if (step1Cycle && step1Cycle.startTime !== mostRecent.startTime) {
    const prev = {
      high:    isBuy ? step1Cycle.high : mostRecent.high,
      low:     isBuy ? mostRecent.low  : step1Cycle.low,
      hitHigh: isBuy ? step1Cycle.hitHigh : mostRecent.hitHigh,
      hitLow:  isBuy ? mostRecent.hitLow  : step1Cycle.hitLow,
    };
    const step1Label = `${step1Cycle.startTime}–${step1Cycle.endTime ?? "now"}`;
    const step2Label = `${mostRecent.startTime}–${mostRecent.endTime ?? "now"}`;
    return buildSignal(dir, md?.lockState?.strength, prev.high, prev.low, prev.hitHigh, prev.hitLow, step2Label, step1Label);
  }

  const best = findBestCandleRef(completed, dir) ?? mostRecent;
  return buildSignal(dir, md?.lockState?.strength, best.high, best.low, best.hitHigh, best.hitLow, `${best.startTime}–${best.endTime ?? "now"}`, null);
}

function build6HSignal(md) {
  const cycles6H = md?.cycles6H ?? [];
  const dir = getDir(md?.allowedDirection, md?.lockState);
  const completed = [...cycles6H]
    .filter(c => c.status === "complete" && c.high != null)
    .reverse();
  if (!completed.length) return null;

  const isBuy      = dir === "BUY";
  const mostRecent = completed[0];

  // Cross-cycle ref: step-1 hit from whichever cycle it happened,
  // step-2 target from the most recent cycle's levels (nearest price).
  const step1Cycle = dir ? completed.find(c =>
    isBuy ? c.hitHigh != null : c.hitLow != null
  ) : null;

  let prev, step1Label;
  if (step1Cycle && step1Cycle.name !== mostRecent.name) {
    prev = {
      name:    mostRecent.name,
      label:   mostRecent.label ?? mostRecent.name,
      high:    isBuy ? step1Cycle.high  : mostRecent.high,
      low:     isBuy ? mostRecent.low   : step1Cycle.low,
      hitHigh: isBuy ? step1Cycle.hitHigh : mostRecent.hitHigh,
      hitLow:  isBuy ? mostRecent.hitLow  : step1Cycle.hitLow,
    };
    step1Label = step1Cycle.name ?? step1Cycle.label;
  } else {
    prev = findBestCandleRef(completed.slice(0, 2), dir) ?? mostRecent;
    step1Label = null;
  }

  return buildSignal(dir, md?.lockState?.strength, prev.high, prev.low, prev.hitHigh, prev.hitLow, prev.name ?? prev.label, step1Label);
}

// Expose the actual 06:00 ET candle open as the entry reference, supplied by
// monitor.js via market_data. Used by the Daily card's synthesized progress.
function attachDailyEntry(md, sig) {
  if (!sig) return sig;
  return { ...sig, entryCandleOpen: md?.dailyEntryOpen ?? null, entryCandleTs: md?.dailyEntryTs ?? null };
}

// Returns true if the daily pattern (latest of step1/step2) is "fresh" — i.e. the
// next 06:00 ET entry window after the last sweep is still in the future. Once
// 06:00 passes after a completed sweep, the pattern is consumed and re-displaying
// it as ENTRY ACTIEF is misleading (entry would have already triggered).
function isDailyPatternFresh(step1Ts, step2Ts) {
  const lastTs = Math.max(step1Ts ?? 0, step2Ts ?? 0);
  if (!lastTs) return true;  // no timestamps → don't filter (legacy data)
  // Next 06:00 ET strictly after lastTs.
  const lastEt = new Date(new Date(lastTs * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const sixAm = new Date(lastEt);
  sixAm.setHours(6, 0, 0, 0);
  if (sixAm <= lastEt) sixAm.setDate(sixAm.getDate() + 1);
  // ET-now via locale roundtrip
  const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return nowEt < sixAm;
}

function buildDailySignal(md) {
  const dailyLevels = md?.dailyLevels ?? [];
  const dir = getDir(md?.allowedDirection, md?.lockState);
  if (!dir || !dailyLevels.length) return null;

  const todayStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
  });

  // Look back up to 14 trading days. dailyLevels may contain historical key dates from
  // lockState — we cap at 14 to avoid stale refs but allow finding a sweep pattern that
  // completed across non-consecutive days (e.g. SSL hit Apr 20, BSL hit Apr 22).
  const candidates = [...dailyLevels].reverse()
    .filter(d => d.date !== todayStr && d.high != null)
    .slice(0, 14);
  if (!candidates.length) return null;

  const isBuy      = dir === "BUY";
  const mostRecent = candidates[0];

  // Cross-day logic — mirrors build6HSignal / build90MinSignal. When step-1 was
  // swept in an older day but the most recent day has different (newer) levels,
  // the step-2 target shifts to the newest day's levels. This makes the signal
  // update automatically when a new daily range forms.
  const step1Cycle = candidates.find(c =>
    isBuy ? c.hitHigh != null : c.hitLow != null
  );

  if (step1Cycle && step1Cycle.date !== mostRecent.date) {
    const prev = {
      date:    mostRecent.date,
      high:    isBuy ? step1Cycle.high    : mostRecent.high,
      low:     isBuy ? mostRecent.low     : step1Cycle.low,
      hitHigh: isBuy ? step1Cycle.hitHigh : mostRecent.hitHigh,
      hitLow:  isBuy ? mostRecent.hitLow  : step1Cycle.hitLow,
    };
    // Freshness gate: if both legs swept and the next 06:00 entry has already
    // passed, the pattern is consumed — don't render it as ENTRY ACTIEF.
    const s1Ts = isBuy ? prev.hitHigh?.ts : prev.hitLow?.ts;
    const s2Ts = isBuy ? prev.hitLow?.ts  : prev.hitHigh?.ts;
    if (s1Ts && s2Ts && !isDailyPatternFresh(s1Ts, s2Ts)) return null;
    return buildSignal(dir, md?.lockState?.strength, prev.high, prev.low, prev.hitHigh, prev.hitLow, prev.date, step1Cycle.date, DAILY_ENTRY_TIME);
  }

  const prev = findBestCandleRef(candidates, dir) ?? mostRecent;
  const s1Ts = isBuy ? prev.hitHigh?.ts : prev.hitLow?.ts;
  const s2Ts = isBuy ? prev.hitLow?.ts  : prev.hitHigh?.ts;
  if (s1Ts && s2Ts && !isDailyPatternFresh(s1Ts, s2Ts)) return null;
  return buildSignal(dir, md?.lockState?.strength, prev.high, prev.low, prev.hitHigh, prev.hitLow, prev.date, null, DAILY_ENTRY_TIME);
}

// Setups kept visible above the live 3-card row:
//   - still open (WAITING_PHASE2 / ACTIVE) → always pin, no matter how old
//   - recently closed (CLOSED_SL / CLOSED_TP2) → pin for 48h so W/L is reviewable
// Dashboard pinned row = ACTIVE trades only. WAITING sits on the live TF card;
// closed trades (WIN/LOSS) live in the /journal page — no duplicate history here.
function pickPinnedSetups(setupHistory, activeSetup) {
  const hist = setupHistory ?? [];
  const result = hist.filter(s => s.status === "ACTIVE");
  // Fallback: surface live activeSetup if the log entry is legacy (no status).
  if (activeSetup && activeSetup.status === "ACTIVE") {
    const already = result.some(s =>
      (s.id && activeSetup.id && s.id === activeSetup.id) ||
      (s.source === (activeSetup.source ?? activeSetup.tf) && s.direction === activeSetup.direction && s.status === activeSetup.status)
    );
    if (!already) {
      result.unshift({
        id:          activeSetup.id ?? `live-${activeSetup.tf ?? "x"}-${activeSetup.createdTs ?? 0}`,
        market:      activeSetup.market,
        direction:   activeSetup.direction,
        source:      activeSetup.source ?? activeSetup.tf,
        tf:          activeSetup.tf,
        bslLevel:    activeSetup.bslLevel,
        sslLevel:    activeSetup.sslLevel,
        entry:       activeSetup.entry,
        sweepPrice:  activeSetup.sweepPrice,
        step1Time:   activeSetup.step1Time,
        step2Time:   activeSetup.step2Time,
        step1Ts:     activeSetup.step1Ts,
        step2Ts:     activeSetup.step2Ts,
        cycleLabel:  activeSetup.cycleLabel,
        status:      activeSetup.status,
        sl:          activeSetup.sl,
        tp1:         activeSetup.tp1,
        tp2:         activeSetup.tp2,
        entryTime:   activeSetup.entryTime,
        entryWindowTime: activeSetup.entryWindowTime,
        entryWindowTs:   activeSetup.entryWindowTs,
        ts:          activeSetup.createdTs ?? 0,
      });
    }
  }
  return result;
}

function PinnedCard({ s, market, currentPrice }) {
  const isBuy   = s.direction === "BUY";
  const fp      = p => fmtPrice(p, market);
  const isOpen  = s.status === "ACTIVE" || s.status === "WAITING_PHASE2";
  const isLive  = s.status === "ACTIVE";
  const outcome = s.outcome ?? (s.status === "CLOSED_TP2" ? "WIN" : s.status === "CLOSED_SL" ? "LOSS" : null);
  const label   = s.source ?? s.tf ?? "—";

  const risk   = (s.entry != null && s.sl != null) ? Math.abs(s.entry - s.sl) : null;
  const pnlPts = (isLive && currentPrice != null && s.entry != null)
                 ? (isBuy ? currentPrice - s.entry : s.entry - currentPrice) : null;
  const pnlR   = (risk && pnlPts != null) ? pnlPts / risk : null;
  const toTP   = (isLive && currentPrice != null && s.tp1 != null) ? Math.abs(s.tp1 - currentPrice) : null;
  const toSL   = (isLive && currentPrice != null && s.sl  != null) ? Math.abs(currentPrice - s.sl)  : null;

  const cardCls = outcome === "WIN"  ? "ls-card-win"
                : outcome === "LOSS" ? "ls-card-loss"
                : isLive              ? "ls-active"
                : "";

  return (
    <div className={`ls-card ls-pinned ${isBuy ? "ls-buy" : "ls-sell"} ${cardCls}`}>
      <div className="ls-card-header">
        <span className="ls-tf-label">{label}</span>
        <span className={`ls-dir ${isBuy ? "ls-dir-buy" : "ls-dir-sell"}`}>
          {isBuy ? "▲ BUY" : "▼ SELL"}
        </span>
        {outcome
          ? <OutcomeBadge outcome={outcome} />
          : s.status === "WAITING_PHASE2"
            ? <span className="ls-status-badge ls-status-watch">WACHT {s.entryWindowTime ?? s.window ?? "entry"}</span>
            : <StatusBadge status="entry_active" />}
        <span className="ls-pinned-tag" title="Blijft zichtbaar tot TP/SL (of 48u na sluiten)">📌</span>
      </div>

      <div className="ls-steps">
        <div className={`ls-step ${(s.step1Ts || s.step1Time) ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">1</span>
          <span className="ls-step-text">
            {isBuy ? <>{label} BSL <b>{fp(s.bslLevel)}</b></> : <>{label} SSL <b>{fp(s.sslLevel)}</b></>}
            {(s.step1Ts || s.step1Time)
              ? <span className="ls-step-time"> @ {fmtStepTime(s.step1Ts, s.step1Time)}</span>
              : <span className="ls-step-time ls-step-missing"> — niet gesweept</span>}
          </span>
        </div>
        <div className={`ls-step ${(s.step2Ts || s.step2Time) ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">2</span>
          <span className="ls-step-text">
            {isBuy ? <>{label} SSL sweep <b>{fp(s.sweepPrice ?? s.sslLevel)}</b></>
                   : <>{label} BSL sweep <b>{fp(s.sweepPrice ?? s.bslLevel)}</b></>}
            {(s.step2Ts || s.step2Time) && <span className="ls-step-time"> @ {fmtStepTime(s.step2Ts, s.step2Time)}</span>}
            {s.cycleLabel && <span className="ls-step-cycle"> [{s.cycleLabel}]</span>}
          </span>
        </div>
        <div className={`ls-step ${(isLive || outcome) ? "ls-step-done" : "ls-step-wait"}`}>
          <span className="ls-step-num">3</span>
          <span className="ls-step-text">
            Entry
            {s.entry != null && (isLive || outcome) && <> <b>{fp(s.entry)}</b></>}
            {(s.entryTs || s.entryTime) && <span className="ls-step-time"> @ {fmtStepTime(s.entryTs != null ? s.entryTs / 1000 : null, s.entryTime)}</span>}
            {!s.entryTime && !s.entryTs && (s.entryWindowTs || s.entryWindowTime) && (
              <span className="ls-step-time"> om {fmtStepTime(s.entryWindowTs, s.entryWindowTime)}</span>
            )}
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

      {isLive && pnlPts != null && risk && (
        <div className="ls-progress">
          <div className="ls-prog-row">
            <span className="ls-prog-price">{fp(currentPrice)}</span>
            <span className={`ls-prog-pnl ${pnlPts >= 0 ? "pos" : "neg"}`}>
              {pnlPts >= 0 ? "+" : ""}{pnlPts.toFixed(1)}pt
            </span>
            <span className={`ls-prog-r ${pnlR >= 0 ? "pos" : "neg"}`}>
              {pnlR >= 0 ? "+" : ""}{pnlR.toFixed(2)}R
            </span>
          </div>
          <div className="ls-prog-bar-wrap">
            <span className="ls-prog-sl-lbl">SL</span>
            <div className="ls-prog-track">
              <div
                className={`ls-prog-fill ${pnlPts >= 0 ? "pos" : "neg"}`}
                style={{ width: `${Math.min(100, Math.max(0, Math.abs(pnlR ?? 0) / 2 * 100))}%` }}
              />
            </div>
            <span className="ls-prog-tp-lbl">TP</span>
          </div>
          <div className="ls-prog-dists">
            <span className="neg">−{toSL?.toFixed(1)}pt</span>
            <span className="pos">+{toTP?.toFixed(1)}pt</span>
          </div>
        </div>
      )}

      {outcome && (
        <div className="ls-pinned-close">
          {s.outcomeTime ? <span className="ls-pinned-close-time">Closed @ {s.outcomeTime}</span> : null}
          {s.outcomePrice != null && <span className="ls-pinned-close-price">{fp(s.outcomePrice)}</span>}
        </div>
      )}
    </div>
  );
}

function MarketBlock({ market, liveData }) {
  const md           = liveData?.[market];
  const currentPrice = md?.currentPrice ?? null;
  const allowed      = md?.allowedDirection ?? null;

  // Daily + 6H equilibrium for the per-step ZoneTag rendered on each card.
  // Daily eq = today's running high+low / 2 (from the isToday entry monitor.js
  // continuously updates from 18:00 ET). 6H eq = currently-active 6H cycle's
  // running range; falls back to the most recent completed 6H if no active.
  const _today  = (md?.dailyLevels ?? []).find(d => d?.isToday);
  const dailyEq = (_today && _today.high != null && _today.low != null)
    ? (_today.high + _today.low) / 2
    : null;
  const _activeSixH = (md?.cycles6H ?? []).find(c => c?.status === "active" && c.high != null && c.low != null)
    ?? [...(md?.cycles6H ?? [])].reverse().find(c => c?.status === "complete" && c.high != null && c.low != null);
  const sixHEq = _activeSixH ? (_activeSixH.high + _activeSixH.low) / 2 : null;

  const dailySig  = attachDailyEntry(md, buildDailySignal(md));
  const sixHSig   = build6HSignal(md);
  const ninetyMin = build90MinSignal(md);

  // Filter signals by allowedDirection
  const daily  = dailySig  && (!allowed || dailySig.type  === allowed) ? dailySig  : null;
  const sixH   = sixHSig   && (!allowed || sixHSig.type   === allowed) ? sixHSig   : null;
  const ninety = ninetyMin && (!allowed || ninetyMin.type === allowed) ? ninetyMin : null;

  const pinned = pickPinnedSetups(md?.setupHistory, md?.activeSetup);

  if (!daily && !sixH && !ninety && !pinned.length) return null;

  const rawSetup = md?.activeSetup ?? null;

  // If this setup is already shown in the pinned row, don't also overlay it on
  // the live TF card — otherwise the user sees the exact same trade twice.
  const pinnedIds  = new Set(pinned.map(s => s.id).filter(Boolean));
  const pinnedKeys = new Set(pinned.map(s => `${s.source ?? s.tf}-${s.direction}-${s.status}`));
  const isPinned = s => s && ((s.id && pinnedIds.has(s.id)) ||
                              pinnedKeys.has(`${s.source ?? s.tf}-${s.direction}-${s.status}`));

  // Closed trades (WIN/LOSS) live in /journal, not on the live dashboard. Only
  // waiting + active setups should attach to their TF card.
  const isClosedStatus = rawSetup && (rawSetup.status === "CLOSED_SL" || rawSetup.status === "CLOSED_TP2");
  const attachable = rawSetup && !isClosedStatus && !isPinned(rawSetup);

  // Only attach setup to the card whose timeframe matches.
  const dailySetup  = attachable && rawSetup.tf === "daily" && daily  && rawSetup.direction === daily.type  ? rawSetup : null;
  const sixHSetup   = attachable && rawSetup.tf === "6H"    && sixH   && rawSetup.direction === sixH.type   ? rawSetup : null;
  const ninetySetup = attachable && rawSetup.tf === "90min" && ninety && rawSetup.direction === ninety.type ? rawSetup : null;
  const activeSetup = dailySetup ?? sixHSetup ?? ninetySetup;

  // For each TF card: is there a pinned ACTIVE setup that already shows the
  // real entry/SL? If yes, the card's synthesized "Entry (geschat)" block is
  // suppressed to avoid showing two different entry prices for the same trade.
  const hasPinnedActiveFor = (tf, dir) => pinned.some(s =>
    s.status === "ACTIVE" && (s.tf === tf || s.source === tf) && s.direction === dir);
  const dailyHasPinned  = daily  ? hasPinnedActiveFor("daily", daily.type)  : false;
  const sixHHasPinned   = sixH   ? hasPinnedActiveFor("6H",    sixH.type)   : false;
  const ninetyHasPinned = ninety ? hasPinnedActiveFor("90min", ninety.type) : false;

  // For each TF card: is there a recently CLOSED setup for THIS cycle? Returns
  // "WIN" | "LOSS" | null. A trade that already played out (SL or TP) shouldn't
  // re-show as "ENTRY ACTIEF" via the synthesized geschat block — the cycle is
  // consumed. Match on tf + direction + entryTime + last 12h (covers entry-window
  // turnaround across cycle boundaries).
  const hasRecentCloseFor = (tf, dir, entryTimeLabel) => {
    if (!entryTimeLabel) return null;
    const cutoffMs = Date.now() - 12 * 3600 * 1000;
    const hit = (md?.setupHistory ?? []).find(s =>
      (s.tf === tf || s.source === tf) &&
      s.direction === dir &&
      (s.status === "CLOSED_SL" || s.status === "CLOSED_TP2") &&
      s.entryTime === entryTimeLabel &&
      (s.entryTs ?? 0) > cutoffMs
    );
    return hit ? (hit.status === "CLOSED_TP2" ? "WIN" : "LOSS") : null;
  };
  const dailyRecentClose  = daily  ? hasRecentCloseFor("daily", daily.type,  daily.entryTimeLabel)  : null;
  const sixHRecentClose   = sixH   ? hasRecentCloseFor("6H",    sixH.type,   sixH.entryTimeLabel)   : null;
  const ninetyRecentClose = ninety ? hasRecentCloseFor("90min", ninety.type, ninety.entryTimeLabel) : null;

  const hasActive = (activeSetup && ["ACTIVE","CLOSED_SL","CLOSED_TP2"].includes(activeSetup.status))
                    || pinned.some(s => s.status === "ACTIVE");

  // Order Flow confluence bias (daily × 6H lock) — the actual direction decision
  const flow = md?.orderFlowBias ?? null;
  const flowState = flow?.state ?? "NEUTRAL";
  const flowScore = flow?.score ?? 0;
  const flowClass = flowState.includes("STRONG_BULL")  ? "ls-flow-strong-bull"
                  : flowState.includes("STRONG_BEAR")  ? "ls-flow-strong-bear"
                  : flowState.includes("BULL_pullback")? "ls-flow-bull-weak"
                  : flowState.includes("BEAR_bounce")  ? "ls-flow-bear-weak"
                  : flowState.includes("BULL")         ? "ls-flow-bull"
                  : flowState.includes("BEAR")         ? "ls-flow-bear"
                  : "ls-flow-neutral";

  return (
    <div className={`ls-market-block ${hasActive ? "ls-market-active" : ""}`}>
      <div className="ls-market-title">
        <span className="ls-market-name">{MARKET_LABELS[market] ?? market}</span>
        {flow && (
          <span className={`ls-flow-badge ${flowClass}`} title={flow.note}>
            {flowState.replace("_", " ")} · {flowScore}
          </span>
        )}
        {hasActive && <span className="ls-market-active-badge">● ENTRY ACTIEF</span>}
      </div>

      {pinned.length > 0 && (
        <div className="ls-pinned-row">
          <div className="ls-pinned-label">📌 ACTIEVE SETUPS</div>
          <div className="ls-cards-row">
            {pinned.map(s => (
              <React.Fragment key={s.id ?? `${s.source}-${s.ts}`}>
                <PinnedCard s={s} market={market} currentPrice={currentPrice} />
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      <div className="ls-cards-row">
        {/* Live TF cards are read-only previews — chart-replay lives on the
            journal page only. Wrapped in ViewTracker so admin can see who
            actually scrolls to which signal. */}
        <ViewTracker market={market} tf="daily"  setupId={dailySetup?.id}>
          <SignalCard label="Daily" sig={daily}  market={market} activeSetup={dailySetup}   currentPrice={currentPrice} dailyEq={dailyEq} sixHEq={sixHEq} hasPinnedActive={dailyHasPinned}  hasRecentClose={dailyRecentClose} />
        </ViewTracker>
        <ViewTracker market={market} tf="6H"     setupId={sixHSetup?.id}>
          <SignalCard label="6H"    sig={sixH}   market={market} activeSetup={sixHSetup}    currentPrice={currentPrice} dailyEq={dailyEq} sixHEq={sixHEq} hasPinnedActive={sixHHasPinned}   hasRecentClose={sixHRecentClose} />
        </ViewTracker>
        <ViewTracker market={market} tf="90min"  setupId={ninetySetup?.id}>
          <SignalCard label="90min" sig={ninety} market={market} activeSetup={ninetySetup}  currentPrice={currentPrice} dailyEq={dailyEq} sixHEq={sixHEq} hasPinnedActive={ninetyHasPinned} hasRecentClose={ninetyRecentClose} />
        </ViewTracker>
      </div>
    </div>
  );
}

export default function LiveSignals({ activeMarket = null }) {
  const { markets: liveData, refreshing, error, refresh, lastRefresh } = useLiveData();

  const MARKETS = ["NAS100", "US500", "US30", "XAUUSD", "GBPUSD", "BTCUSD", "ETHUSD"];
  const marketsToShow = activeMarket ? [activeMarket] : MARKETS;
  const hasData = liveData && Object.keys(liveData).length > 0;

  if (!hasData && !lastRefresh) {
    return <div className="ls-loading"><div className="ls-spinner" /> Live signals laden...</div>;
  }
  if (error && !hasData) {
    return <div className="ls-error">⚠ {error} <button onClick={refresh}>↻</button></div>;
  }

  return (
    <div className="ls-wrap">
      <div className="ls-section-header">
        <span className="ls-section-icon">⚡</span>
        <span className="ls-section-title">LIVE FRACTAL SIGNALS</span>
        <span className="ls-section-sub">Daily · 6H · 90min sweep context</span>
        <button className="ls-refresh-btn" onClick={refresh} disabled={refreshing}>↻</button>
      </div>
      {marketsToShow.map(mkt => (
        <MarketBlock key={mkt} market={mkt} liveData={liveData} />
      ))}
    </div>
  );
}
