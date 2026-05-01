# Chart Action Techniques

Bewezen methoden voor TradingView chart acties.
**Lees dit VOOR complexe acties. Herschrijf via write_memory als iets niet werkt — append nooit foute methodes.**

---

## ❌ navigate_to_date TOOL — NIET GEBRUIKEN voor datum+tijd
- Bug: zet de tijd in het datumveld. Gebruik de handmatige JS methode hieronder.

---

## ✅ DATUM + TIJD NAVIGATIE (definitief werkend, getest 2026-04-03)

**5 stappen, geen verkenning nodig:**

### Stap 1 — Open dialoog
```js
document.querySelector('[data-name="go-to-date"]').click()
```

### Stap 2 — Datum invullen (formaat: YYYY-MM-DD)
```js
(function(){ const i=document.querySelectorAll('input'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i[1],'2026-03-30'); i[1].dispatchEvent(new Event('input',{bubbles:true})); i[1].dispatchEvent(new Event('change',{bubbles:true})); i[1].dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return 'datum:'+i[1].value; })()
```
→ Vervang `2026-03-30` door gewenste datum. Formaat altijd YYYY-MM-DD.

### Stap 3 — Tijd invullen (inputs[2])
```js
(function(){ const i=document.querySelectorAll('input'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; const t=i[2]; t.focus(); s.call(t,'08:30'); t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true})); t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true})); t.blur(); return 'tijd:'+t.value; })()
```
→ Vervang `08:30` door gewenste tijd (HH:MM, 24h ET).

### Stap 4 — Screenshot: controleer datum EN tijd correct zijn

### Stap 5 — Bevestigen
```js
document.querySelector('[data-name="submit-button"]').click()
```

**Kritieke regels:**
- inputs[1] = datumveld, inputs[2] = tijdveld
- Datumformaat: YYYY-MM-DD (bijv. 2026-03-30)
- Stap 4 verplicht: screenshot VOOR je submit klikt
- Gebruik altijd IIFE (function(){...})() — voorkomt JS fouten

---

## ✅ SYMBOOL WISSELEN
- Tool: change_symbol — werkt altijd, ~1-2s

## ✅ TIJDFRAME WISSELEN
- Tool: change_timeframe — werkt altijd, ~0.5s

## ✅ CHART SCROLLEN
- Tool: scroll_chart (direction: left/right, bars: aantal)

## ✅ BAR DATA LEZEN
- Tool: get_bar_data (count: max 100)
- Let op: geeft meest recente bars — scroll eerst naar gewenste datum

---

## 📋 TRADINGVIEW KNOPPEN & DATA-NAMES (volledig overzicht 2026-04-03)

### 🔝 Header Toolbar
| data-name | Functie |
|---|---|
| open-indicators-dialog | Indicators, metrics & strategies openen |
| save-load-menu | Layouts beheren |
| header-toolbar-quick-search | Snelzoeken |
| header-toolbar-properties | Instellingen/Settings |
| header-toolbar-fullscreen | Fullscreen mode |

### 📐 Tekentool Groepen (linker sidebar)
| data-name | Functie |
|---|---|
| linetool-group-cursors | Cursors groep |
| linetool-group-trend-line | Trendlijn groep |
| linetool-group-gann-and-fibonacci | Gann & Fibonacci groep |
| linetool-group-patterns | Patronen groep |
| linetool-group-prediction-and-measurement | Voorspelling & meting groep |
| linetool-group-geometric-shapes | Geometrische vormen groep |
| linetool-group-annotation | Annotaties groep |
| linetool-group-font-icons | Iconen groep |

### 🛠 Tekentool Acties
| data-name | Functie |
|---|---|
| measure | Meten tool |
| zoom | Inzoomen |
| magnet-button | Magneet mode (snap naar OHLC) |
| drawginmode | Keep drawing (blijf tekenen) |
| lockAllDrawings | Vergrendel alle tekeningen |
| hide-all | Verberg alle tekeningen |
| removeAllDrawingTools | Verwijder alle tekeningen |

### 📅 Datum Ranges (onderin chart)
| data-name | Functie |
|---|---|
| date-ranges-menu | Datum range menu |
| date-range-tab-1D | 1 dag (1min intervals) |
| date-range-tab-5D | 5 dagen (5min intervals) |
| date-range-tab-1M | 1 maand (30min intervals) |
| date-range-tab-3M | 3 maanden (1h intervals) |
| date-range-tab-6M | 6 maanden (2h intervals) |
| date-range-tab-YTD | Year to date (1dag intervals) |
| date-range-tab-12M | 1 jaar (1dag intervals) |
| date-range-tab-60M | 5 jaar (1week intervals) |
| date-range-tab-ALL | Alle data (1maand intervals) |
| go-to-date | Ga naar specifieke datum/tijd |
| time-zone-menu | Tijdzone instellen |

### 📊 Rechter Sidebar Panels
| data-name | Functie |
|---|---|
| base | Watchlist, details & nieuws |
| alerts | Alerts beheren |
| object_tree | Object tree & data window |
| union_chats | Chats |
| screener-dialog-button | Screeners |
| pine-dialog-button | Pine Script editor |
| calendar-dialog-button | Kalenders |
| community-hub-button | Community |
| notifications-button | Notificaties |
| help-button | Help Center |
| toggle-visibility-button | Panel open/dicht |
| toggle-maximize-button | Panel maximaliseren |

### ⚡ Zonder data-name maar aanroepbaar via title
| title | Functie |
|---|---|
| Symbol Search | Symbool zoeken |
| Switch data type | Data type wisselen |
| Compare or Add Symbol | Symbool vergelijken/toevoegen |
| Create Alert | Alert aanmaken |
| Bar Replay | Bar replay starten |
| Toggle auto scale | Auto scale aan/uit |
| Toggle log scale | Log scale aan/uit |
| Take a snapshot | Screenshot |

---

## Geleerde Trucs
<!-- Claude voegt hier nieuwe ontdekkingen toe na verificatie via screenshot -->
