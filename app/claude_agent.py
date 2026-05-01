"""Ollama/Gemma agent with TradingView tool calling, memory and cron scheduling."""
import json
import logging
import os
from typing import AsyncGenerator, Optional

from openai import AsyncOpenAI

from cdp_tools import CDPSession, TradingViewTools
from memory_manager import MemoryManager

logger = logging.getLogger(__name__)

OLLAMA_BASE_URL = "http://localhost:11434/v1"
MODEL = "gemma4:e2b-it-q4_K_M"

MAX_HISTORY_TOKENS = 10_000
MAX_TOOL_RESULT    = 20_000

TOOLS: list[dict] = [
    # ── Chart tools ──────────────────────────────────────────────────────
    {
        "name": "get_chart_state",
        "description": "Geef huidig symbool, tijdframe en tijdzone van de chart.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "change_symbol",
        "description": "Wissel het handelssymbool op de chart.",
        "input_schema": {
            "type": "object",
            "properties": {"symbol": {"type": "string"}},
            "required": ["symbol"],
        },
    },
    {
        "name": "change_timeframe",
        "description": "Wissel het tijdframe (1m 5m 15m 1h 4h D W).",
        "input_schema": {
            "type": "object",
            "properties": {"timeframe": {"type": "string"}},
            "required": ["timeframe"],
        },
    },
    {
        "name": "navigate_to_date",
        "description": "Navigeer de chart naar een specifieke datum/tijd (Eastern Time). Gebruik ALTIJD deze tool voor datumnavigatie — werkt via de go-to-date dialog. Geef datum als YYYY-MM-DD en tijd als HH:MM (24h ET).",
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "YYYY-MM-DD"},
                "time": {"type": "string", "description": "HH:MM (24h ET)"},
            },
            "required": ["date"],
        },
    },
    {
        "name": "get_bar_data",
        "description": "Lees OHLCV bars van de chart.",
        "input_schema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "Aantal bars (standaard 30, max 100)"},
            },
        },
    },
    {
        "name": "take_screenshot",
        "description": (
            "Maak een screenshot van de huidige chart. Gebruik dit:\n"
            "1. Wanneer de gebruiker er expliciet om vraagt.\n"
            "2. Na datum navigatie, symbool wissel of tijdframe wissel — om te VERIFIËREN dat de actie correct is uitgevoerd voordat je het opslaat in ACTIONS.md.\n"
            "Gebruik het NIET na elke willekeurige actie, alleen voor verificatie en gebruikersverzoeken."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "scroll_chart",
        "description": "Scroll de chart links (verleden) of rechts (heden).",
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["left", "right"]},
                "bars": {"type": "integer"},
            },
            "required": ["direction"],
        },
    },
    {
        "name": "auto_scale",
        "description": "Zet auto scale aan/uit.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "reset_zoom",
        "description": "Reset tijdschaal zoom.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "execute_javascript",
        "description": (
            "Voer JavaScript uit in de browser. Gebruik dit om te VERKENNEN en ONTDEKKEN:\n"
            "• Alle data-name knoppen: JSON.stringify(Array.from(document.querySelectorAll('[data-name]')).map(e=>e.getAttribute('data-name')))\n"
            "• Knoppen met tekst: JSON.stringify(Array.from(document.querySelectorAll('button')).map(b=>({t:b.innerText.trim().substring(0,30),n:b.getAttribute('data-name')})).filter(b=>b.t))\n"
            "• TV API methoden: JSON.stringify(Object.keys(window.TradingViewApi||{}))\n"
            "• Klik element: document.querySelector('[data-name=\"X\"]').click(); 'clicked'\n"
        ),
        "input_schema": {
            "type": "object",
            "properties": {"code": {"type": "string"}},
            "required": ["code"],
        },
    },
    # ── Memory tools ─────────────────────────────────────────────────────
    {
        "name": "read_memory",
        "description": "Lees een geheugenbestand (MEMORY.md, STRATEGIES.md, PATTERNS.md, AGENTS.md, of memory/YYYY-MM-DD.md).",
        "input_schema": {
            "type": "object",
            "properties": {"filename": {"type": "string"}},
            "required": ["filename"],
        },
    },
    {
        "name": "write_memory",
        "description": (
            "Overschrijf een geheugenbestand volledig met nieuwe inhoud. Gebruik dit voor:\n"
            "- OPRUIMEN: verwijder verouderde, foute of tegenstrijdige entries.\n"
            "- CONSOLIDEREN: meerdere entries over hetzelfde onderwerp samenvoegen tot één correcte entry.\n"
            "- CORRIGEREN: als een opgeslagen methode niet werkt → herschrijf het bestand zonder die methode.\n"
            "Werkwijze: 1) lees het bestand met read_memory, 2) verwijder/update de foute delen, 3) schrijf de schone versie terug.\n"
            "Gebruik append_memory alleen voor echt NIEUWE informatie die nog niet in het bestand staat."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "append_memory",
        "description": (
            "Voeg tekst toe aan een geheugenbestand. Gebruik dit ALLEEN als de informatie nog niet bestaat in het bestand.\n"
            "EERST controleren: lees het bestand en check of er al een entry over hetzelfde onderwerp is.\n"
            "- Als er al een entry is over hetzelfde onderwerp → gebruik write_memory om te corrigeren/consolideren, NIET append.\n"
            "- Als de informatie echt nieuw is → gebruik append.\n"
            "Bestanden: strategieën → STRATEGIES.md, gedrag/correcties → AGENTS.md, feiten → MEMORY.md, patronen → PATTERNS.md, daglog → memory/YYYY-MM-DD.md"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string"},
                "content": {"type": "string", "description": "Tekst om toe te voegen (markdown formaat)"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "search_memory",
        "description": "Zoek door alle geheugenbestanden op een keyword.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    # ── Cron tools ────────────────────────────────────────────────────────
    {
        "name": "add_cron_job",
        "description": (
            "Maak een geplande taak aan die periodiek de chart analyseert en je waarschuwt.\n"
            "Gebruik type='interval' met interval_minutes voor elke X minuten.\n"
            "Gebruik type='cron' met cron='0 9 * * 1-5' voor specifieke tijden.\n"
            "De message is wat Claude elke keer uitvoert (bijv. 'Analyseer NAS100 5m op VWAP pullback setup')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Naam van de taak"},
                "message": {"type": "string", "description": "Opdracht die periodiek wordt uitgevoerd"},
                "type": {"type": "string", "enum": ["interval", "cron"]},
                "interval_minutes": {"type": "integer", "description": "Voor type=interval: elke X minuten"},
                "cron": {"type": "string", "description": "Voor type=cron: cron expressie bijv '0 9 * * 1-5'"},
            },
            "required": ["name", "message", "type"],
        },
    },
    {
        "name": "list_cron_jobs",
        "description": "Toon alle geplande taken.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "remove_cron_job",
        "description": "Verwijder een geplande taak op basis van ID of naam.",
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
    {
        "name": "toggle_cron_job",
        "description": "Pauzeer of hervat een geplande taak.",
        "input_schema": {
            "type": "object",
            "properties": {"job_id": {"type": "string"}},
            "required": ["job_id"],
        },
    },
]

# OpenAI/Ollama tool format (input_schema → parameters)
_TOOLS_OAI = [
    {
        "type": "function",
        "function": {
            "name": t["name"],
            "description": t["description"],
            "parameters": t["input_schema"],
        },
    }
    for t in TOOLS
]

BASE_SYSTEM_PROMPT = """\
Je bent een AI trading assistent. Je bestuurt een live TradingView chart via CDP (Chrome DevTools Protocol).

## Tools en wanneer te gebruiken

**Chart acties — gebruik altijd de tool, niet zelf JS schrijven:**
- `get_chart_state` → huidig symbool + tijdframe + timezone
- `change_symbol("EURUSD")` → symbool wisselen
- `change_timeframe("5m")` → tijdframe wisselen (1m 5m 15m 1h 4h D W)
- `navigate_to_date(date="2024-01-15", time="09:30")` → naar datum/tijd navigeren (ET)
- `get_bar_data(count=50)` → OHLCV bars lezen
- `scroll_chart(direction="left", bars=50)` → scrollen
- `auto_scale()` / `reset_zoom()` → view aanpassen
- `take_screenshot()` → screenshot (alleen op verzoek of ter verificatie)
- `execute_javascript(code="...")` → eigen JS als tool faalt

**Geheugen:**
- `read_memory("ACTIONS.md")` → bewezen methodes (lees dit bij twijfel)
- `append_memory` / `write_memory` → opslaan wat werkt
- Bestanden: STRATEGIES.md, PATTERNS.md, MEMORY.md, AGENTS.md

**Planning:** `add_cron_job` / `list_cron_jobs` / `remove_cron_job` / `toggle_cron_job`

## Regels
- Tijden zijn America/New_York (Eastern) tenzij anders gevraagd
- Na een actie: één korte bevestiging
- Bij fout: lees ACTIONS.md of gebruik execute_javascript
"""


class ClaudeAgent:
    def __init__(
        self,
        cdp: CDPSession,
        memory_mgr: Optional[MemoryManager] = None,
        scheduler=None,
    ):
        self.cdp = cdp
        self.tv = TradingViewTools(cdp)
        self.memory = memory_mgr
        self.scheduler = scheduler
        self.history: list[dict] = []

    def _get_client(self) -> AsyncOpenAI:
        return AsyncOpenAI(base_url=OLLAMA_BASE_URL, api_key="ollama")

    def clear_history(self):
        self.history = []

    def _build_system_prompt(self) -> str:
        if not self.memory:
            return BASE_SYSTEM_PROMPT

        # Inject ACTIONS.md prominently at the TOP — before other memory —
        # so Haiku sees it immediately without needing a tool call.
        actions_content = ""
        try:
            raw = self.memory.read_file("ACTIONS.md").strip()
            if len(raw) > 100:
                # Cap at 2500 chars so it doesn't crowd out everything else
                if len(raw) > 1200:
                    raw = raw[:1200] + "\n…[truncated]"
                actions_content = f"\n\n## ⚡ ACTIONS.MD — BEWEZEN CHART TECHNIEKEN (gebruik dit direct, geen verkenning)\n{raw}"
        except Exception:
            pass

        ctx = self.memory.load_context(max_chars=800)
        memory_block = f"\n\n## Je Geheugen\n{ctx}" if ctx else ""

        return f"{BASE_SYSTEM_PROMPT}{actions_content}{memory_block}"

    # ── Token management ─────────────────────────────────────────────────

    def _estimate_tokens(self, messages: list) -> int:
        total = 1200  # system prompt estimate
        for msg in messages:
            content = msg.get("content") or ""
            if isinstance(content, str):
                total += len(content)
            for tc in msg.get("tool_calls") or []:
                total += len(json.dumps(tc))
        return total // 4

    def _trim_history(self):
        while len(self.history) > 2:
            if self._estimate_tokens(self.history) <= MAX_HISTORY_TOKENS:
                break
            self.history = self.history[2:]
        # Remove orphaned tool messages at start (OpenAI format)
        while self.history and self.history[0].get("role") == "tool":
            self.history = self.history[1:]

    def _cap_result(self, result: str) -> str:
        if len(result) > MAX_TOOL_RESULT:
            return result[:MAX_TOOL_RESULT] + f"\n…[{len(result)-MAX_TOOL_RESULT} chars ingekort]"
        return result

    # ── Tool execution ───────────────────────────────────────────────────

    async def _run_tool(self, name: str, inp: dict) -> tuple[str, Optional[str]]:
        screenshot = None

        # Chart tools
        if name == "get_chart_state":
            sym = await self.tv.get_current_symbol()
            tf  = await self.tv.get_timeframe()
            tz  = await self.tv.get_timezone()
            text = f"Symbool: {sym} | Tijdframe: {tf} | Tijdzone: {tz}"

        elif name == "change_symbol":
            text = await self.tv.change_symbol(inp["symbol"])

        elif name == "change_timeframe":
            text = await self.tv.change_timeframe(inp["timeframe"])

        elif name == "navigate_to_date":
            text = await self.tv.navigate_to_date(inp["date"], inp.get("time", "00:00"))

        elif name == "get_bar_data":
            count = min(inp.get("count", 30), 100)
            data  = await self.tv.get_bar_data(count)
            text  = json.dumps(data, indent=None) if isinstance(data, list) else str(data)
            if isinstance(data, list):
                logger.info("[bar_data] === VOLLEDIGE CANDLE DATA (%d bars) ===", len(data))
                for bar in data:
                    logger.info("[bar_data] %s", json.dumps(bar))
                logger.info("[bar_data] === EINDE CANDLE DATA ===")
                self._pending_console_log = {"label": f"CANDLE DATA naar AI ({len(data)} bars)", "data": data}

        elif name == "take_screenshot":
            screenshot = await self.tv.screenshot()
            text = "Screenshot gemaakt."

        elif name == "scroll_chart":
            text = await self.tv.scroll_chart(inp.get("direction", "left"), inp.get("bars", 50))

        elif name == "auto_scale":
            text = await self.tv.auto_scale()

        elif name == "reset_zoom":
            text = await self.tv.reset_zoom()

        elif name == "execute_javascript":
            try:
                result = await self.cdp.execute_js(inp["code"], timeout=12.0)
                text = str(result) if result is not None else "undefined"
            except Exception as e:
                text = f"JS fout: {e}"

        # Memory tools
        elif name == "read_memory":
            text = self.memory.read_file(inp["filename"]) if self.memory else "Geen geheugen."

        elif name == "write_memory":
            text = self.memory.write_file(inp["filename"], inp["content"]) if self.memory else "Geen geheugen."

        elif name == "append_memory":
            text = self.memory.append_file(inp["filename"], inp["content"]) if self.memory else "Geen geheugen."

        elif name == "search_memory":
            text = self.memory.search(inp["query"]) if self.memory else "Geen geheugen."

        # Cron tools
        elif name == "add_cron_job":
            if not self.scheduler:
                text = "Scheduler niet beschikbaar."
            else:
                job = self.scheduler.add_job(inp)
                text = f"Taak aangemaakt: {job['name']} (id={job['id']})"

        elif name == "list_cron_jobs":
            if not self.scheduler:
                text = "Scheduler niet beschikbaar."
            else:
                jobs = self.scheduler.list_jobs()
                if not jobs:
                    text = "Geen taken gepland."
                else:
                    lines = [f"- [{j['id']}] {j['name']} ({'actief' if j.get('active') else 'gepauzeerd'}) — {j.get('type','interval')} {j.get('interval_minutes','?')}m" for j in jobs]
                    text = "\n".join(lines)

        elif name == "remove_cron_job":
            if not self.scheduler:
                text = "Scheduler niet beschikbaar."
            else:
                ok = self.scheduler.remove_job(inp["job_id"])
                text = "Taak verwijderd." if ok else "Taak niet gevonden."

        elif name == "toggle_cron_job":
            if not self.scheduler:
                text = "Scheduler niet beschikbaar."
            else:
                job = self.scheduler.toggle_job(inp["job_id"])
                text = f"Taak {'geactiveerd' if job and job.get('active') else 'gepauzeerd'}." if job else "Taak niet gevonden."

        else:
            text = f"Onbekend tool: {name}"

        return text, screenshot

    # ── Main loop ────────────────────────────────────────────────────────

    async def process(self, user_message: str) -> AsyncGenerator[dict, None]:
        import asyncio
        client = self._get_client()
        self.history.append({"role": "user", "content": user_message})
        history_len_before = len(self.history)

        system_prompt = self._build_system_prompt()

        try:
            iteration = 0
            while iteration < 12:
                iteration += 1
                self._trim_history()
                est = self._estimate_tokens(self.history)
                logger.info("[tokens] ~%d input tokens (iter %d)", est, iteration)
                yield {"type": "debug", "content": f"~{est} input tokens"}

                messages = [{"role": "system", "content": system_prompt}] + self.history

                logger.info("[context] === VOLLEDIGE CONTEXT NAAR AI (iter %d) ===", iteration)
                for i, msg in enumerate(messages):
                    role = msg.get("role", "?")
                    content = msg.get("content") or ""
                    tool_calls = msg.get("tool_calls", [])
                    if role == "system":
                        logger.info("[context] [%d] SYSTEM (%d chars): %s", i, len(content), content[:300])
                    elif role == "user":
                        logger.info("[context] [%d] USER: %s", i, content[:500])
                    elif role == "assistant":
                        if tool_calls:
                            calls = ", ".join(f"{tc['function']['name']}({json.dumps(tc['function'].get('arguments', {}))})" for tc in tool_calls)
                            logger.info("[context] [%d] ASSISTANT (tool calls): %s", i, calls)
                        else:
                            logger.info("[context] [%d] ASSISTANT: %s", i, content[:500])
                    elif role == "tool":
                        logger.info("[context] [%d] TOOL RESULT (%d chars — exact naar AI):\n%s", i, len(content), content)
                logger.info("[context] === EINDE CONTEXT (%d berichten) ===", len(messages))

                try:
                    response = await client.chat.completions.create(
                        model=MODEL,
                        messages=messages,
                        tools=_TOOLS_OAI,
                        tool_choice="auto",
                        extra_body={"options": {"num_ctx": 16384}},
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    err = str(e)
                    logger.error("[api] %s", err)
                    if "400" in err:
                        self.history = []
                        yield {"type": "error", "content": f"History gereset vanwege API fout. Herhaal je vraag.\n{err}"}
                    else:
                        yield {"type": "error", "content": err}
                    return

                choice = response.choices[0]
                msg = choice.message

                # Build assistant message for history (OpenAI format)
                assistant_msg: dict = {"role": "assistant", "content": msg.content or (msg.model_extra or {}).get("reasoning") or ""}
                if msg.tool_calls:
                    assistant_msg["tool_calls"] = [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in msg.tool_calls
                    ]
                self.history.append(assistant_msg)

                # gemma4 puts answer in content after thinking; fallback to model_extra reasoning
                text_out = msg.content or (msg.model_extra or {}).get("reasoning") or ""
                reasoning = (msg.model_extra or {}).get("reasoning", "")
                logger.info("[response] === AI ANTWOORD (iter %d, finish=%s) ===", iteration, choice.finish_reason)
                if reasoning:
                    logger.info("[response] REASONING (%d chars):\n%s", len(reasoning), reasoning)
                if text_out:
                    logger.info("[response] CONTENT (%d chars):\n%s", len(text_out), text_out)
                else:
                    logger.info("[response] (geen content)")
                logger.info("[response] === EINDE ANTWOORD ===")
                if text_out:
                    yield {"type": "text", "content": text_out}
                elif not msg.tool_calls:
                    yield {"type": "text", "content": "(geen antwoord — probeer opnieuw)"}

                if not msg.tool_calls or choice.finish_reason == "stop":
                    break

                for tc in msg.tool_calls:
                    name = tc.function.name
                    try:
                        inp = json.loads(tc.function.arguments)
                    except Exception:
                        inp = {}

                    yield {"type": "status", "content": f"**{name}**({tc.function.arguments[:60]})…"}
                    logger.info("[tool] %s %s", name, inp)

                    try:
                        text_result, screenshot_b64 = await self._run_tool(name, inp)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        text_result, screenshot_b64 = f"Tool fout: {exc}", None

                    logger.info("[result] %s → %s", name, text_result[:150])

                    if screenshot_b64:
                        yield {"type": "screenshot", "data": screenshot_b64}

                    if hasattr(self, "_pending_console_log"):
                        yield {"type": "console_log", "label": self._pending_console_log["label"], "data": self._pending_console_log["data"]}
                        del self._pending_console_log

                    # OpenAI format: one "tool" message per call
                    self.history.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": self._cap_result(text_result),
                    })

            yield {"type": "done"}

        except asyncio.CancelledError:
            self.history = self.history[:history_len_before - 1]
            logger.info("process() cancelled — history rolled back")
            raise
