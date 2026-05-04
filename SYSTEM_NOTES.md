# BLACKBULL — System Notes & Operator Guide

> **Audience**: future Claude sessions + operator (Shannon).
> **Doel**: in 5 minuten zicht op wat dit systeem is, hoe het werkt, wat er recent is gefixt, waar de pijnpunten zitten, en hoe te debuggen.
>
> **Regel #1 voor toekomstige Claude sessies**: lees dit document eerst voordat je iets aanraakt. Sla geen stap over uit eigen aanname.

---

## 1. Wat is dit systeem

BLACKBULL is een liquidity-execution trading-assistant die fractal sweep-setups detecteert op 7 markten en signals naar MetaApi/CopyFactory stuurt voor multi-broker replicatie.

**7 markten**: NAS100, US500, US30, XAUUSD, GBPUSD, BTCUSD, ETHUSD.

**Drie fasen per setup**:
1. `SETUP_CREATED` (status `WAITING_PHASE2`) — sweep-pattern gevonden, wacht op Phase 2 entry-window
2. `ENTRY_TRIGGERED` (status `ACTIVE`) — entry candle gefired, signal naar broker, position open
3. `SL_HIT` / `TP1_HIT` / `TP2_HIT_RUNNER` / `TP3_HIT` (status `CLOSED_*`) — exit afgehandeld

**Hosting**: Hetzner box op `178.104.80.233`. Live dashboard: `http://178.104.80.233:8082/dashboard`. Admin: `http://178.104.80.233:8082/admin`.

---

## 2. Architectuur — file/proces topology

```
/opt/trading-assistant/                    LIVE
├── monitor/
│   ├── monitor.js                         hoofdorkest (3500+ regels). Cron elke minuut.
│   ├── copyfactory-bridge.js              MetaApi/CopyFactory dispatch
│   ├── lib-sl.mjs                         computeSweepSL + computeSweepTP (1R/2R/10R)
│   ├── continuation_confirmation.js       continuation-setup detection
│   ├── fetch_candles.mjs (in api/)        cron at xx:05 — pulls D/60/15 candles via MCP
│   ├── run.sh                             cron entrypoint, 300s timeout, eigen lockfile
│   ├── setup_<MK>.json                    active-slot per markt (één setup tegelijk)
│   ├── market_data_<MK>.json              dashboard-feed (geschreven elke tick)
│   ├── setup_log.json                     volledige history (10000 entries cap)
│   ├── debug_log.json                     last 500 events
│   ├── candles_*_<MK>.json                MCP-gefetchte candle cache
│   ├── sweep_state_<MK>.json              90M/6H/Daily high/low levels (CACHE — kan corrupt raken!)
│   ├── card_state_<MK>.json               which sweep-cards have been notified
│   └── scalp_*_<MK>.json                  active 22.5min / 5.625min scalp slot
├── api/
│   ├── server.js                          Express op :3001, systemd `trading-api.service`
│   ├── bias-engine.js                     getLiveFractalSignals + lock detection
│   └── metaapi-client.js                  MetaApi REST wrapper
├── dashboard/
│   ├── src/                               React + Vite SPA
│   └── dist/                              gebuilde assets (nginx serveert vanaf hier)
├── logs/
│   ├── monitor.log                        live monitor stdout (groot, ~500K+ regels)
│   ├── copyfactory.log                    SENT/ERROR per signal-leg dispatch
│   ├── api.log                            trading-api stdout
│   └── watchdog.log                       *5min: alert bij stale data
└── .env                                   secrets (MetaApi tokens, Mongo URI, etc.)

/opt/trading-assistant-staging/            STAGING (sandbox, geen cron, geen live trades)
└── (mirror van live structure, eigen MongoDB DB, COPY_LIVE=false)
```

**Externe diensten**:
- **MCP** = `https://178-104-80-233.sslip.io/mcp` — Chrome+TradingView scraper op deze box. Levert candles via HTTP. Single Chrome instance, max 1 chart-switch tegelijk.
- **MongoDB Atlas** (`tradingvisualizer` cluster) — mirror van setup_log + active_setups voor reboot-survival
- **MetaApi cloud** (CopyFactory) — repliceert master-strategy signals naar elke subscriber's broker-account

---

## 3. Cron config (kritisch voor begrip)

```cron
# Elke minuut: live monitor (sequentiële scan van 7 markten, ~90 sec per tick)
* * * * * flock -n /tmp/mcp.global.lock /opt/trading-assistant/monitor/run.sh

# Elk uur xx:05: bulk candle fetch (D + 1H + 15m), wait-mode voor lock
5 * * * * flock -w 600 /tmp/mcp.global.lock bash -c "... fetch_candles.mjs ..."

# Elke 5 min: watchdog → Discord alert bij stale data
*/5 * * * * /opt/trading-assistant/monitor/watchdog.sh

# Elke 6h xx:50 UTC: Chrome+MCP herstart (memory bloat preventie)
50 */6 * * * supervisorctl restart trading-assistant:chromium trading-assistant:trading-app

# Vrijdag 21:05: weekly backtest
5 21 * * 1-5 cd /opt/trading-assistant/monitor && node weekly-backtest-v2.mjs --apply
```

**Belangrijk**: Staging cron entries zijn **DISABLED** sinds 2026-05-04. Stond elke minuut te vechten met live om dezelfde lock waardoor live ticks gemist werden. Voor handmatige test van staging: `cd /opt/trading-assistant-staging/monitor && node monitor.js`. Backup van origineel crontab: `/tmp/crontab.backup.<ts>`.

**Tick cadence**:
- Eén tick duurt ~90 sec (7 markten × ~13 sec elk, sequentieel met 3s wait)
- Cron op xx:00 → tick acquireert lock → loopt tot xx+1:30
- Cron op xx+1:00 → lock bezet → exit silent (`flock -n`)
- Cron op xx+2:00 → lock vrij → nieuwe tick
- → live runt **eens per ~2 min**, niet elke minuut. Acceptable voor 90M/6H setups.

---

## 4. Trigger flow — wanneer wordt entry gevuld

In `monitor.js` `analyzeMarket(marketKey, candles, ...)`:

```
1. loadSetup(marketKey)              → activeSetup uit Mongo (of disk fallback)
2. RECOVERY-CHECK #1 (regels 2552-2615)
   ├─ ACTIVE + entryTriggered + !metaApiDispatched
   │  → re-fire MetaApi dispatch + Discord notify (PHANTOM-ACTIVE recovery)
   └─ recompute TP3 als die mist
3. RECOVERY-CHECK #2 (regels 2618-2680)
   ├─ WAITING_PHASE2 + entryWindowTs < 30 min oud + entry candle in data
   │  → late-fire via fireEntryTrigger (MISSED-TRIGGER recovery)
4. Card-events processing (sweep detection)
5. SETUP_CREATED block — nieuwe setup bouwen als sweep-pattern + lock-bias matcht
6. WAITING_PHASE2 trigger block (regels 3027+):
   ├─ phaseInfo.inPhase2 + entryCandleTs in candles + !entryTriggered
   │  → mutate ACTIVE + computeSweepSL + computeSweepTP → fireEntryTrigger
7. ACTIVE monitoring (regels 3110+) — TP/SL/runner-BE check
8. writeMarketData(marketKey, ...)   → market_data_<MK>.json voor dashboard
```

`fireEntryTrigger` = single-source-of-truth fan-out. ALLE side-effects bundeled:
1. logEvent ENTRY_TRIGGERED → debug_log + monitor.log
2. patchSetupLog → setup_log.json
3. updateWeeklyRecap
4. saveSetup → disk + Mongo
5. **cfNotifySignal (awaited!)** — 3 PUTs naar CopyFactory (TP1/TP2/TP3)
6. dispatch.ok check → metaApiDispatched flag op `true` (alleen bij volledige broker-acceptatie)
7. sendDiscordTradeEvent ENTRY_TRIGGERED (alleen bij ok)

Failed dispatch → `METAAPI_DISPATCH_FAILED` log → recovery retried elke tick.

---

## 5. Bug history (chronologisch wat is gefixt)

### Pre-2026-05-04 (vóór deze sessie)

- TP3 runner @ 10R + Sunday-night fix + auto-recovery watchdog (commit `730fa11`)
- Scalp 22.5min + 5.625min cycle building (commit `b486d9b`)
- PD filter: loose OR (commit `dde0342`)
- Premium/Discount entry-zone filter (commit `50a8278`)

### 2026-05-04 — robust dispatch hardening (commits `24d5f21`, `5168129`)

**Symptoom**: Mongo had US500/US30 als ACTIVE maar geen MetaApi-signal en geen Discord "entry gevuld". Alleen GBPUSD ging cleanly door op 02:45 ET.

**Root causes**:
1. `cfNotifySignal` was fire-and-forget, errors silent geswallowed in `sendOneLeg` try/catch → `metaApiDispatched=true` werd zelfs gezet bij broker reject
2. `cron run.sh` had 300s timeout — bij vasthangen werd cron tick gekild halverwege dispatch (saveSetup mongo write klaar, cfNotifySignal HTTP-call nog onderweg → silent miss)
3. `patchSetupLog` was silent no-op bij ontbrekend setup id (verborg desync bugs)
4. Geen recovery-pad voor phantom-active (Mongo=ACTIVE maar broker=niets)
5. Geen late-fire pad voor stuck WAITING_PHASE2 setups (Phase 2 venster verlopen → setup hangt eeuwig)
6. Sweep-state US500 was corrupt — 18 levels van foreign markets (1.34, 2315, 4622, 79217) → genereerde bogus 90M SELL `US500-90M-1777658565143` (entry 4622.1, sl 7255.3) tegen bullish bias
7. Staging cron stond te vechten met live om dezelfde lock → live miste 50% van ticks (zoals 02:46 + 02:47 → race ging niet auto-recover)
8. Late-fire cap was 24h → US30 fired 1.3h late tegen markt die al weg was, instant SL

**Fixes** (alle in commit `24d5f21` + `5168129`):

| Fix | File:Regels | Wat |
|---|---|---|
| Bridge `{ok, results}` contract | `monitor/copyfactory-bridge.js:106-160` | Caller weet of broker echt accepteerde |
| `dispatch.ok` check in fireEntryTrigger | `monitor/monitor.js:2017-2042` | Flag alleen op true bij volledige acceptatie |
| Recovery-pad #1 (phantom-active) | `monitor/monitor.js:2552-2615` | Re-fire ACTIVE+entryTriggered+!metaApiDispatched |
| Recovery-pad #2 (late-fire) | `monitor/monitor.js:2618-2680` | Cap 30 min (was 24h, te risky) |
| `patchSetupLog` warning bij missing id | `monitor/monitor.js:330-340` | Geen silent no-op meer |
| Admin manual-trade endpoint | `api/server.js:2611-2685` | POST + auto TP1/2/3 berekening |
| Admin positions GET + close-position POST | `api/server.js:1356-1450` | Lijst + bulk close |
| Dashboard auto-TP form | `dashboard/src/pages/AdminPage.jsx:96-145, 478-525` | Entry+SL → live preview TPs |
| LiveSignals "Entry geschat" TP3 | `dashboard/src/components/LiveSignals.jsx:375-405` | TP3 row toegevoegd |
| Sweep-state cleanup | (data fix) | 18 corrupt levels weg uit `sweep_state_US500.json` |
| Bogus 90M SELL cancelled | (data fix) | `US500-90M-1777658565143` → CANCELLED in setup_log |
| Staging cron disabled | crontab | Live krijgt nu 2x meer ticks |

---

## 6. Bekende limitaties & wat NOG handmatig moet

| Scenario | Recovery? | Actie als 't gebeurt |
|---|---|---|
| Cron tick gekild mid-dispatch | ✅ Recovery-pad #1 binnen 1 tick (~2 min) | niets |
| Eerste tick miste MCP-candle | ✅ 2e tick pakt 'm | niets |
| WAITING_PHASE2 stuck < 30 min | ✅ Recovery-pad #2 (late-fire) | niets |
| Broker tijdelijke 5xx/timeout | ✅ Auto retry elke tick | niets |
| WAITING_PHASE2 stuck > 30 min | ❌ Cap is 30 min | `/admin` → Trade tab → handmatig firen |
| Broker rejecteert structureel (verkeerd symbol, no margin) | ❌ Retry blijft falen | Root cause fixen (mapping in `copyfactory-bridge.js:51`, margin opwaarderen) |
| MCP volledig down > 30 min | ❌ Geen candles, geen trigger | MCP herstellen → setup pakt evt. via late-fire |
| Live monitor proces dood | ❌ Cron tries maar geen output | systemctl status, logs checken, evt. Chrome herstart |

**Mongoose duplicate active_setup**: één setup per markt — als nieuwere setup overrules oude, oude blijft als orphan in setup_log. `verifyOrphanedActives` (regel 366) ruimt dat op door late-fire of outcome-verify.

---

## 7. Common debug commands

```bash
# Wat draait de monitor nu?
ps -ef | grep monitor.js | grep -v grep

# Volg live entries real-time
tail -f /opt/trading-assistant/logs/monitor.log | grep -E "ENTRY_TRIGGERED|METAAPI|RECOVERY|TRADE_ACTIVE"

# Welke MetaApi signals zijn echt verstuurd?
tail -50 /opt/trading-assistant/logs/copyfactory.log

# Status van een specifieke markt
python3 -c "
import json
md = json.load(open('/opt/trading-assistant/monitor/market_data_US500.json'))
a = md.get('activeSetup',{})
print(f\"id={a.get('id')} status={a.get('status')} dispatched={a.get('metaApiDispatched')}\")
print(f\"entry={a.get('entry')} sl={a.get('sl')} tp1={a.get('tp1')} tp2={a.get('tp2')} tp3={a.get('tp3')}\")
"

# Tick frequentie van de monitor (zou elke ~2 min moeten zijn)
grep "AM ET$\|PM ET$" /opt/trading-assistant/logs/monitor.log | tail -10

# Failed dispatches sinds X
grep "METAAPI_DISPATCH_FAILED\|ERROR sending signal" /opt/trading-assistant/logs/monitor.log | tail -20

# Restart api zonder downtime impact
systemctl restart trading-api && sleep 3 && systemctl is-active trading-api

# Build dashboard na frontend wijziging
cd /opt/trading-assistant/dashboard && npm run build
```

---

## 7b. Symptoom → Diagnose → Fix (debug playbook)

Voor elk waargenomen symptoom: hoe achterhaal je waar het fout ging en wat je kunt doen.

### 🔴 Symptoom: "Setup staat ACTIVE op dashboard maar geen positie in broker"

```bash
# Stap 1: weten we ECHT dat er een dispatch gepoogd is?
grep "<MARKET>" /opt/trading-assistant/logs/copyfactory.log | tail -10
# Als je SENT lines ziet → bridge stuurde naar CopyFactory
# Als je ERROR lines ziet → broker rejecteerde, foutmelding staat erbij
# Als je niets ziet → fireEntryTrigger heeft cfNotifySignal nooit aangeroepen

# Stap 2: heeft monitor.js de dispatch wel uitgevoerd?
grep "<MARKET>" /opt/trading-assistant/logs/monitor.log | grep -E "ENTRY_TRIGGERED|METAAPI" | tail -10
# ENTRY_TRIGGERED + geen METAAPI_DISPATCH_FAILED → bridge call moet succesvol zijn
# ENTRY_TRIGGERED + METAAPI_DISPATCH_FAILED → broker rejected, kijk reden
# Geen ENTRY_TRIGGERED → trigger heeft niet gevuurd, ga naar volgend symptoom

# Stap 3: state per file vergelijken — desync detecteren
python3 -c "
import json
mk = 'US500'  # ← pas aan
disk = json.load(open(f'/opt/trading-assistant/monitor/setup_{mk}.json'))
md = json.load(open(f'/opt/trading-assistant/monitor/market_data_{mk}.json')).get('activeSetup',{})
print('disk    :', disk.get('status'), 'entryTriggered=', disk.get('entryTriggered'), 'dispatched=', disk.get('metaApiDispatched'))
print('memdata :', md.get('status'), 'entryTriggered=', md.get('entryTriggered'), 'dispatched=', md.get('metaApiDispatched'))
"
# Als beide hetzelfde zeggen → state is consistent
# Als ze verschillen → je hebt een phantom-active. Recovery-pad #1 zou 'm volgende tick moeten oplossen.
```

### 🔴 Symptoom: "Geen Discord 'entry gevuld' message verschenen"

Discord notify wordt verstuurd in `fireEntryTrigger` regel 2036, alleen na succesvolle dispatch. Controleer:

```bash
# Heeft fireEntryTrigger überhaupt gelopen?
grep "<MARKET>.*ENTRY_TRIGGERED" /opt/trading-assistant/logs/monitor.log | tail -3

# Was de dispatch successvol?
grep "<MARKET>" /opt/trading-assistant/logs/copyfactory.log | tail -3

# Heeft Discord webhook errors gegeven?
grep "DISCORD\|webhook" /opt/trading-assistant/logs/monitor.log | tail -10
```

Als ENTRY_TRIGGERED logged + dispatch SENT lines + geen webhook errors → Discord is verstuurd, maar mogelijk webhook URL is dood of channel is gewijzigd. Check `.env` voor `DISCORD_WEBHOOK`.

### 🔴 Symptoom: "Setup blijft eeuwig in WAITING_PHASE2"

```bash
# Stap 1: bestaat de setup nog in setup_log?
python3 -c "
import json
log = json.load(open('/opt/trading-assistant/monitor/setup_log.json'))
matches = [s for s in log if s.get('market')=='US500' and s.get('status')=='WAITING_PHASE2']
for s in matches: print(s.get('id'), 'createdTs:', s.get('createdTs'))
"

# Stap 2: heeft de setup een geldige entryWindowTs?
# Als entryWindowTs > 30 min geleden: late-fire cap overschreden, alleen handmatig
# Als entryWindowTs < 30 min geleden: late-fire zou moeten firen volgende tick

# Stap 3: heeft de tick recent gelopen voor deze markt?
awk '/^\[..:.. ET\] \| US500/' /opt/trading-assistant/logs/monitor.log | tail -5
# Geen recente events → monitor draait niet of skipt deze markt (chart-switch failed?)
```

### 🔴 Symptoom: "Broker rejecteert dispatch (Symbol not found / margin / volume)"

```bash
# Foutmelding in copyfactory.log
grep "ERROR sending signal" /opt/trading-assistant/logs/copyfactory.log | tail -5
```

Veelvoorkomende redenen + fix:

| Error | Oorzaak | Fix |
|---|---|---|
| `Symbol US500 not found` | Broker noemt 't anders | Aanpassen `MASTER_SYMBOL_MAP` in `copyfactory-bridge.js:51` |
| `It is not allowed to update signal symbol` | Oude signalId met andere symbol | Wachten tot oude signal expired (60 sec) of nieuwe setupId |
| `Trade signal has expired` | `time` field > 60 sec oud | Bridge zet nu `new Date().toISOString()` per send, zou niet moeten gebeuren — wel mogelijk bij massive cron-delay |
| `Insufficient margin` | Subscriber heeft te weinig free margin | Operator moet z'n broker-account opwaarderen of riskValue verlagen |
| `Volume below minimum` | Subscriber's riskValue scaling × 0.01 < broker min lot | riskValue verhogen in BrokerAccount config |
| `Invalid stops` | SL/TP te dichtbij entry voor broker minimum-stop-distance | Setup heroverwegen, dit is markt+broker-specifiek |

### 🔴 Symptoom: "Cron-ticks lopen niet op verwachte cadence"

```bash
# Hoeveel ticks per uur?
grep "AM ET$\|PM ET$" /opt/trading-assistant/logs/monitor.log | tail -30 | awk '{print $1}'

# Is er een proces dat de lock vasthoudt?
ls -la /tmp/mcp.global.lock /tmp/blackbull_monitor.lock
fuser /tmp/mcp.global.lock 2>&1   # processen die lock vasthouden
ps -ef | grep -E "monitor.js|fetch_candles" | grep -v grep

# Is staging cron weer per ongeluk aangezet?
crontab -l | grep -i staging
# Als regels terug zijn → iemand heeft 'm geherinstalleerd. Backup ligt in /tmp/crontab.backup.<ts>

# Is Chrome/MCP gezond?
ps -ef | grep chromium | grep -v grep | wc -l    # zou >0 moeten zijn
curl -s http://178-104-80-233.sslip.io/mcp/health 2>&1 | head -5  # of via MCP_URL
```

### 🔴 Symptoom: "Dashboard cards laten verkeerde data zien"

```bash
# Dashboard leest market_data_<MK>.json. Vergelijk wat dashboard zegt met file:
cat /opt/trading-assistant/monitor/market_data_US500.json | python3 -m json.tool | head -50

# Hoe oud is de data?
ls -la /opt/trading-assistant/monitor/market_data_US500.json
# Mtime > 5 min oud → monitor heeft niet recent voor deze markt gedraaid

# Dashboard cache kan ook oud zijn — hard refresh in browser (Ctrl+Shift+R)
# API caches zelf 60 sec — wacht of restart trading-api
```

### 🔴 Symptoom: "TP3 leg verschijnt niet in broker (alleen TP1+TP2)"

Veelvoorkomende oorzaak: **broker netting-mode** — drie BUY signals met zelfde symbol+direction worden gemerged tot 1 of 2 posities ondanks verschillende `magic` numbers.

```bash
# Ons systeem stuurde wel 3 legs?
grep "<MARKET>" /opt/trading-assistant/logs/copyfactory.log | tail -5
# Drie SENT lines met TP1/TP2/TP3 + drie verschillende signalIds → wij zijn klaar

# Wat doet CopyFactory met de signals → bekijk MetaApi cloud dashboard
# https://app.metaapi.cloud → CopyFactory → master strategy → external signals
```

Diagnose verder vereist toegang tot MetaApi dashboard. Als 't broker-netting is, geen software-fix mogelijk aan onze kant — dat is broker account configuration (hedging-account ipv netting-account).

---

## 7c. Log-file betekenis (cheat sheet)

```
/opt/trading-assistant/logs/
├── monitor.log         elke cron-tick: per-market scan output, ENTRY_TRIGGERED, TRADE_ACTIVE,
│                       PHASE_TRANSITION, STRUCTURE_BUILT, METAAPI_RECOVERY, METAAPI_DISPATCH_FAILED
│
├── copyfactory.log     elke SENT/ERROR per leg-dispatch. Format:
│                       [ISO-time] SENT signal → MARKET DIR SYMBOL LEG entry=X sl=Y tp=Z | signalId=8char
│                       Of: ERROR sending signal | ... | HTTP NNN: {error message}
│
├── api.log             trading-api stdout (Express server)
│
├── watchdog.log        */5 min check op stale data, alert via Discord
│
└── chrome_restart.log  6h Chrome restart cycle output

/opt/trading-assistant/monitor/
├── debug_log.json      laatste 500 events (gerold buffer). Format:
│                       { time, ts, market, event, details, state }
│                       Sneller te queryen dan monitor.log voor dashboard live-feed
│
└── fetch_candles.log   xx:05 hourly candle fetch output (MCP)
```

**Quick log-queries**:

```bash
# Laatste 20 events voor één markt uit debug_log
python3 -c "
import json
log = json.load(open('/opt/trading-assistant/monitor/debug_log.json'))
us500 = [e for e in log if e.get('market')=='US500'][:20]
for e in us500: print(f\"{e['time']} | {e['event']:25} | {e['details'][:80]}\")
"

# Alle recovery events sinds gisteren
grep -E "METAAPI_RECOVERY|LATE-FIRE|METAAPI_DISPATCH_FAILED" /opt/trading-assistant/logs/monitor.log | tail -30

# Tick duur per cron run
grep "Liquidity Execution Engine\|All markets analyzed" /opt/trading-assistant/logs/monitor.log | tail -20
```

---

## 8. Manuele interventie procedures

### Setup handmatig firen (auto-trigger faalt of cap overschreden)

`http://178.104.80.233:8082/admin` → ⚡ Trade tab:
1. Markt + BUY/SELL kiezen
2. Entry leeg laten = market price (of expliciete waarde typen)
3. SL invoeren
4. TP1/TP2/TP3 worden auto-berekend (1R/2R/10R) — preview verschijnt onder de inputs
5. Submit → CopyFactory krijgt 3 legs

### Open positie sluiten

Zelfde admin tab, "Open posities" sectie:
- "Sluit" per positie
- "Sluit alle US500" knop voor bulk per symbool

### Phantom-active manueel forceren resync

```bash
# Verwijder metaApiDispatched flag → recovery pad #1 fired weer op volgende tick
python3 -c "
import json
fp = '/opt/trading-assistant/monitor/setup_US500.json'
s = json.load(open(fp))
s['metaApiDispatched'] = False
json.dump(s, open(fp,'w'), indent=2)
"
```

### Restart staging voor manuele test

```bash
cd /opt/trading-assistant-staging/monitor && node monitor.js
# Niet via cron! Dat is permanent disabled.
```

---

## 9. Live testing checklist voor volgende echte system-entry

Bij eerstvolgende auto-trigger op een markt met fresh setup:

- [ ] `ENTRY_TRIGGERED` log binnen ~1-2 min na entry candle → in `monitor.log`
- [ ] `SENT signal → <MARKET> ... TP1/TP2/TP3` → in `copyfactory.log` (3 legs!)
- [ ] Discord "entry gevuld" message
- [ ] Positie open in broker
- [ ] `metaApiDispatched: true` in `setup_<MK>.json`

Mis je één van de 5 → nieuwe failure mode. Check:
- `METAAPI_DISPATCH_FAILED` events in monitor.log
- `ERROR sending signal` lines in copyfactory.log
- broker rejection reasons (in MetaApi dashboard)

---

## 10. Future work (NIET nu doen, alleen als nodig)

- **Markets parallelliseren in monitor.js** — kan tick van 90s naar ~30s krimpen, maar MCP chart-switch is bottleneck (1 tegelijk)
- **MetaApi streaming integratie** — sub-sec latency ipv 1-2 min, vervangt cron-based polling. Multi-week refactor.
- **Aparte MCP-instance voor staging** — als staging weer actief moet draaien
- **Symbol mapping verifiëren** — `copyfactory-bridge.js:51` heeft `US500: "SPX500"`. Werkt voor LiquidMarkets master? Bij broker-rejection eerste plek om te checken.
- **24h cap heroverwegen** — recovery cap is nu 30 min. Voor 6H setups misschien 1-2u? Trade-off: late-fire vs stale fire.

---

## 11. Memory / Claude session continuity

Dit document is ZELF de "memory". Bij elke nieuwe Claude sessie:

1. Lees dit volledig voordat je iets aanraakt
2. Check git log: `cd /opt/trading-assistant && git log --oneline -10` voor recente commits
3. Status van running services: `systemctl status trading-api`, `crontab -l`
4. Recent failures: `grep -E "METAAPI_DISPATCH_FAILED|ERROR" /opt/trading-assistant/logs/monitor.log | tail -20`

Bij elke significante fix/wijziging: **update dit document** in de bug-history sectie + commit + push.

Locatie auto-memory voor Claude (persoonlijk per Shannon's account): `/root/.claude/projects/-root/memory/MEMORY.md` + losse files per onderwerp. Dit overlapt met SYSTEM_NOTES.md — SYSTEM_NOTES.md is de gedeelde, in-repo, authoritative versie. MEMORY.md mag verwijzen.

---

**Laatst bijgewerkt**: 2026-05-04, na fix-sessie (commits `24d5f21` + `5168129` + crontab edit).
