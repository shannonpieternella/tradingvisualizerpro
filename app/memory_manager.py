"""OpenClaw-style markdown file memory system."""
import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

import pytz

logger = logging.getLogger(__name__)

EASTERN = pytz.timezone("America/New_York")

BOOTSTRAP_FILES = ["MEMORY.md", "STRATEGIES.md", "PATTERNS.md", "AGENTS.md", "ACTIONS.md"]

DEFAULT_CONTENTS = {
    "MEMORY.md": """# Memory
Feiten, voorkeuren en geleerde lessen. Claude schrijft hier naar toe wanneer de gebruiker iets wil onthouden.
""",
    "STRATEGIES.md": """# Trading Strategies
Hier staan alle trading strategieën die de gebruiker heeft geleerd aan Claude.

## Formaat
Elke strategie heeft:
- **Naam**: Korte naam
- **Setup**: Wat zoek je op de chart
- **Entry**: Wanneer ga je in
- **Stop**: Waar zet je de stop
- **Target**: Wat is het doel
- **Tijdframe**: Op welk tijdframe werkt dit
""",
    "PATTERNS.md": """# Chart Patterns
Bekende patronen die Claude moet herkennen bij chart analyse.
""",
    "AGENTS.md": """# Gedragsregels
Regels die bepalen hoe Claude zich gedraagt.

- Wees beknopt. Één zin na het uitvoeren van een taak.
- Zeg altijd welk symbool en tijdframe je analyseert.
- Neem alleen een screenshot als de gebruiker er expliciet om vraagt.
- Als navigatie mislukt, gebruik execute_javascript om de UI te verkennen.
- Sla feedback altijd op in het juiste geheugenbestand.
""",
    "ACTIONS.md": """# Chart Action Techniques

Bewezen methoden voor chart acties op TradingView. Lees dit VOOR complexe acties. Update dit NA een succesvolle actie.

## Datum Navigatie

### Methode 1: navigate_to_date tool (probeer altijd eerst)
- Gebruikt: `window.TradingViewApi._activeChartWidgetWV._value.setVisibleRange()`
- Resultaat bij succes: returns "Navigated to ..."
- Snelheid: ~1-2s
- Status: primaire methode

### Methode 2: Go-to-date dialog via DOM (fallback als methode 1 faalt)
- Knop selector: `[data-name="go-to-date"]` of `[aria-label="Go to date"]` of `[class*="goToDate"]`
- Input selector: `input[class*="goTo"]` of `[class*="dialog"] input`
- Datum formaat voor input: "30 Mar 2026 00:00" (dag maand jaar tijd)
- Status: fallback methode

### Methode 3: execute_javascript voor volledige DOM verkenning (laatste redmiddel)
- Gebruik als methode 1 en 2 falen
- Zoek knoppen: `JSON.stringify(Array.from(document.querySelectorAll('button')).map(b=>({t:b.innerText.trim().substring(0,30),n:b.getAttribute('data-name')})).filter(b=>b.t))`
- Zoek inputs: `JSON.stringify(Array.from(document.querySelectorAll('input')).map(i=>({ph:i.placeholder,cls:i.className.substring(0,40)})))`
- Na ontdekking: sla de werkende selector op in dit bestand

## Symbool Wisselen
- Gebruik altijd: `change_symbol` tool
- Snelheid: ~1-2s

## Tijdframe Wisselen
- Gebruik altijd: `change_timeframe` tool
- Snelheid: ~0.5s

## Chart Scrollen
- Gebruik altijd: `scroll_chart` tool (direction: left/right, bars: aantal)
- Vuistregel: 50 bars ≈ [vul in na ervaring met specifiek tijdframe]

## Bar Data Lezen
- Gebruik altijd: `get_bar_data` tool (count: max 100)
- Let op: data is meest recente bars, scroll eerst naar gewenste datum

## Geleerde Trucs (vul in na ontdekkingen)
- [Claude schrijft hier werkende JS snippets en DOM selectors na ontdekking]
""",
}


class MemoryManager:
    def __init__(self, memory_dir: str):
        self.dir = Path(memory_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "memory").mkdir(exist_ok=True)
        self._init_defaults()

    def _init_defaults(self):
        for fname, content in DEFAULT_CONTENTS.items():
            p = self.dir / fname
            if not p.exists():
                p.write_text(content, encoding="utf-8")

    # ── Bootstrap context (injected into every Claude session) ─────────────

    # Per-file character budgets — ACTIONS.md gets its own slice so it
    # never crowds out the other files even when it grows large.
    _FILE_BUDGETS: dict = {"ACTIONS.md": 1800}

    def load_context(self, max_chars: int = 5000) -> str:
        """Return combined content of bootstrap files for context injection."""
        parts = []
        remaining = max_chars
        for fname in BOOTSTRAP_FILES:
            fpath = self.dir / fname
            if not fpath.exists():
                continue
            content = fpath.read_text(encoding="utf-8").strip()
            # Skip files that are basically empty (just the header)
            if len(content) < 80:
                continue
            budget = self._FILE_BUDGETS.get(fname, remaining)
            chunk = f"### {fname}\n{content}"
            cap = min(budget, remaining)
            if len(chunk) > cap:
                chunk = chunk[:cap] + "\n…[truncated]"
                parts.append(chunk)
                remaining -= cap
                continue
            parts.append(chunk)
            remaining -= len(chunk)
        # Also add today's daily log if it has content
        today_log = self._today_log_path()
        if today_log.exists():
            log_content = today_log.read_text(encoding="utf-8").strip()
            if len(log_content) > 80 and remaining > 200:
                entry = f"### Vandaag ({today_log.name})\n{log_content}"
                if len(entry) > remaining:
                    entry = entry[:remaining] + "\n…"
                parts.append(entry)
        return "\n\n".join(parts)

    # ── File operations ────────────────────────────────────────────────────

    def read_file(self, filename: str) -> str:
        p = self._resolve(filename)
        if not p.exists():
            return f"Bestand niet gevonden: {filename}"
        return p.read_text(encoding="utf-8")

    def write_file(self, filename: str, content: str) -> str:
        p = self._resolve(filename)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        logger.info("Memory write: %s (%d chars)", filename, len(content))
        return f"Geschreven: {filename}"

    def append_file(self, filename: str, content: str) -> str:
        p = self._resolve(filename)
        p.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(EASTERN).strftime("%Y-%m-%d %H:%M ET")
        entry = f"\n\n<!-- {timestamp} -->\n{content.strip()}\n"
        with p.open("a", encoding="utf-8") as f:
            f.write(entry)
        logger.info("Memory append: %s", filename)
        return f"Toegevoegd aan {filename}"

    def daily_log(self, content: str) -> str:
        return self.append_file(f"memory/{self._today_log_path().name}", content)

    def search(self, query: str) -> str:
        query_lower = query.lower()
        results = []
        for fpath in sorted(self.dir.rglob("*.md")):
            text = fpath.read_text(encoding="utf-8")
            lines = text.splitlines()
            matches = [
                f"  {i+1}: {line.strip()}"
                for i, line in enumerate(lines)
                if query_lower in line.lower()
            ]
            if matches:
                rel = fpath.relative_to(self.dir)
                results.append(f"**{rel}**\n" + "\n".join(matches[:5]))
        return "\n\n".join(results) if results else f"Niets gevonden voor: {query}"

    def list_files(self) -> list[str]:
        files = []
        for fpath in sorted(self.dir.rglob("*.md")):
            rel = str(fpath.relative_to(self.dir))
            files.append(rel)
        return files

    def get_file_content(self, filename: str) -> str:
        return self.read_file(filename)

    def save_file_from_ui(self, filename: str, content: str) -> str:
        return self.write_file(filename, content)

    # ── Helpers ────────────────────────────────────────────────────────────

    def _resolve(self, filename: str) -> Path:
        # Safety: no path traversal
        clean = filename.lstrip("/").replace("..", "")
        return self.dir / clean

    def _today_log_path(self) -> Path:
        today = datetime.now(EASTERN).strftime("%Y-%m-%d")
        return self.dir / "memory" / f"{today}.md"
