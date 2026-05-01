"""FastAPI backend for TradingView AI Trading Assistant."""
import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

env_path = Path(__file__).parent.parent / ".env"
load_dotenv(env_path)

from cdp_tools import CDPSession
from claude_agent import ClaudeAgent
from memory_manager import MemoryManager
from mcp_server import build_mcp_app
from scheduler import TradingScheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent.parent
MEMORY_DIR = BASE_DIR / "memory"
CRON_DIR   = BASE_DIR / "cron"

cdp     = CDPSession()
memory  = MemoryManager(str(MEMORY_DIR))
agent: ClaudeAgent | None = None
scheduler: TradingScheduler | None = None

# Connected WebSocket clients for broadcast
connected_clients: set[WebSocket] = set()


async def broadcast(msg: dict):
    for ws in list(connected_clients):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            connected_clients.discard(ws)


def make_isolated_agent() -> ClaudeAgent:
    """Factory for fresh isolated agent (used by cron jobs)."""
    return ClaudeAgent(cdp, memory, scheduler)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global agent, scheduler
    logger.info("Startup: connecting CDP...")
    try:
        await cdp.connect(retries=20, delay=3.0)
        current_url = await cdp.execute_js("location.href")
        if "tradingview.com" not in str(current_url):
            logger.info("CDP connected. Navigating to TradingView...")
            await cdp.navigate("https://www.tradingview.com/chart/", wait=5.0)
        else:
            logger.info("CDP connected. Already on TradingView (%s), skipping navigate.", current_url)
    except Exception as e:
        logger.error("CDP startup error: %s", e)

    scheduler = TradingScheduler(
        jobs_file=str(CRON_DIR / "jobs.json"),
        broadcast_fn=broadcast,
        get_agent_fn=make_isolated_agent,
    )
    scheduler.start()

    agent = ClaudeAgent(cdp, memory, scheduler)
    logger.info("Agent ready.")

    # Keep qwen2.5:1.5b loaded — ping every 4 minutes so it never expires
    async def _keepalive_qwen():
        import httpx as _httpx
        while True:
            try:
                async with _httpx.AsyncClient(timeout=120) as c:
                    await c.post("http://localhost:11434/v1/chat/completions", json={
                        "model": "qwen2.5:1.5b",
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 1,
                        "options": {"num_ctx": 4096},
                    })
                logger.info("qwen keepalive ok.")
            except Exception as e:
                logger.warning("qwen keepalive failed: %s", e)
            await asyncio.sleep(240)  # every 4 minutes
    asyncio.create_task(_keepalive_qwen())

    mcp_token = os.getenv("MCP_TOKEN", "")
    mcp_asgi, mcp_session_manager = build_mcp_app(cdp, memory, scheduler, token=mcp_token or None)
    # Streamable HTTP app has internal route /mcp, mount at root so full path = /mcp
    app.mount("/", mcp_asgi)
    logger.info("MCP server mounted at /mcp (token %s)", "set" if mcp_token else "NOT SET")
    async with mcp_session_manager.run():
        yield

    scheduler.stop()
    logger.info("Shutdown.")


app = FastAPI(lifespan=lifespan, title="Trading Assistant")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    return (STATIC_DIR / "index.html").read_text()


@app.get("/health")
async def health():
    return {"status": "ok", "cdp_connected": not cdp._ws_is_closed()}


@app.get("/prompt", response_class=HTMLResponse)
async def show_prompt():
    prompt_file = Path(__file__).parent.parent.parent / "trading-assistant" / "monitor" / "monitor.js"
    # Read the STRATEGY_PROMPT from monitor.js
    try:
        src = Path("/opt/trading-assistant/monitor/monitor.js").read_text()
        start = src.find("const STRATEGY_PROMPT = `") + len("const STRATEGY_PROMPT = `")
        end = src.find("`;\n", start)
        prompt_text = src[start:end].strip()
    except Exception as e:
        prompt_text = f"Kon prompt niet laden: {e}"

    escaped = prompt_text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = f"""<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BLACKBULL Strategie Prompt</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    background: #040710;
    color: #e8edf5;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.7;
    padding: 24px 16px;
  }}
  h1 {{
    font-family: sans-serif;
    font-size: 16px;
    font-weight: 600;
    color: #4fc3f7;
    margin-bottom: 16px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }}
  pre {{
    background: #070b16;
    border: 1px solid rgba(99,179,237,0.15);
    border-radius: 8px;
    padding: 20px;
    white-space: pre-wrap;
    word-break: break-word;
    color: #c9d6e8;
    max-width: 860px;
  }}
</style>
</head>
<body>
<h1>📋 BLACKBULL Monitor — Strategie Prompt</h1>
<pre>{escaped}</pre>
</body>
</html>"""
    return html


# ── OAuth discovery stubs (Claude.ai probes these before MCP) ─────────────────

@app.get("/.well-known/oauth-authorization-server")
async def oauth_metadata():
    base = "https://178-104-80-233.sslip.io"
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
    }

@app.post("/register")
async def oauth_register(body: dict = None):
    """Dynamic client registration stub — always accepts."""
    import uuid
    return {
        "client_id": str(uuid.uuid4()),
        "client_secret": "not-used",
        "redirect_uris": (body or {}).get("redirect_uris", []),
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }


_OAUTH_CODE = "mcp-auth-code"

@app.get("/oauth/authorize")
async def oauth_authorize(request: Request):
    """Immediately issues a fixed auth code and redirects back."""
    redirect_uri = request.query_params.get("redirect_uri", "")
    state = request.query_params.get("state", "")
    sep = "&" if "?" in redirect_uri else "?"
    return RedirectResponse(f"{redirect_uri}{sep}code={_OAUTH_CODE}&state={state}")


@app.post("/oauth/token")
async def oauth_token(request: Request):
    """Exchanges the auth code for the MCP_TOKEN as Bearer token."""
    mcp_token = os.getenv("MCP_TOKEN", "")
    return JSONResponse({
        "access_token": mcp_token,
        "token_type": "bearer",
        "expires_in": 3600 * 24 * 365,
    })


@app.get("/api/status")
async def status():
    if not agent:
        return {"status": "initializing"}
    try:
        from cdp_tools import TradingViewTools
        tv = TradingViewTools(cdp)
        return {
            "status": "ready",
            "symbol": await tv.get_current_symbol(),
            "timeframe": await tv.get_timeframe(),
            "timezone": await tv.get_timezone(),
        }
    except Exception as e:
        return {"status": "error", "detail": str(e)}


# ── Memory API ────────────────────────────────────────────────────────────────

@app.get("/api/memory/files")
async def memory_list_files():
    return {"files": memory.list_files()}


@app.get("/api/memory/file")
async def memory_read(filename: str):
    return {"content": memory.read_file(filename)}


@app.post("/api/memory/file")
async def memory_write(body: dict):
    result = memory.save_file_from_ui(body["filename"], body["content"])
    return {"result": result}


# ── Cron API ──────────────────────────────────────────────────────────────────

@app.get("/api/cron/jobs")
async def cron_list():
    return {"jobs": scheduler.list_jobs() if scheduler else []}


@app.post("/api/cron/jobs")
async def cron_add(body: dict):
    if not scheduler:
        return JSONResponse({"error": "scheduler not ready"}, 503)
    job = scheduler.add_job(body)
    return {"job": job}


@app.delete("/api/cron/jobs/{job_id}")
async def cron_remove(job_id: str):
    if scheduler:
        scheduler.remove_job(job_id)
    return {"ok": True}


@app.post("/api/cron/jobs/{job_id}/toggle")
async def cron_toggle(job_id: str):
    job = scheduler.toggle_job(job_id) if scheduler else None
    return {"job": job}


@app.post("/api/cron/jobs/{job_id}/run")
async def cron_run_now(job_id: str):
    if scheduler:
        scheduler.run_now(job_id)
    return {"ok": True}


# ── Direct CDP actions (no AI) ───────────────────────────────────────────────

@app.post("/api/action")
async def direct_action(body: dict):
    """Execute a CDP action directly without AI."""
    from cdp_tools import TradingViewTools
    tv = TradingViewTools(cdp)
    action = body.get("action")
    try:
        if action == "navigate_to_date":
            result = await tv.navigate_to_date(body["date"], body.get("time", "00:00"))
        elif action == "change_symbol":
            result = await tv.change_symbol(body["symbol"])
        elif action == "change_timeframe":
            result = await tv.change_timeframe(body["timeframe"])
        elif action == "get_chart_state":
            sym = await tv.get_current_symbol()
            tf  = await tv.get_timeframe()
            tz  = await tv.get_timezone()
            result = f"Symbol: {sym} | TF: {tf} | TZ: {tz}"
        elif action == "get_bar_data":
            data = await tv.get_bar_data(body.get("count", 10))
            result = data
        elif action == "scroll_chart":
            result = await tv.scroll_chart(body.get("direction","left"), body.get("bars",50))
        elif action == "auto_scale":
            result = await tv.auto_scale()
        elif action == "reset_zoom":
            result = await tv.reset_zoom()
        elif action == "take_screenshot":
            b64 = await tv.screenshot()
            return {"ok": True, "screenshot": b64}
        else:
            return {"ok": False, "error": f"Unknown action: {action}"}
        return {"ok": True, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Fetch bars for a specific date + time range ──────────────────────────────

@app.post("/api/fetch-day")
async def fetch_day(body: dict):
    """Navigate to a date, fetch bars, filter by time range (ET, HH:MM)."""
    from cdp_tools import TradingViewTools
    import asyncio

    date    = body.get("date", "")        # YYYY-MM-DD
    t_start = body.get("start", "00:00")  # HH:MM ET
    t_end   = body.get("end",   "23:59")  # HH:MM ET

    if not date:
        return {"ok": False, "error": "Geen datum opgegeven"}

    tv = TradingViewTools(cdp)

    # Navigate to start of range
    nav = await tv.navigate_to_date(date, t_start)
    logger.info("fetch-day navigate → %s", nav)
    await asyncio.sleep(3.0)

    # Read bars by timestamp range using JS directly
    # Convert date+time strings to UTC timestamps (ET = UTC-5 EST / UTC-4 EDT)
    # We use a generous window: all bars whose timestamp falls on the requested date
    js = f"""
    (function() {{
        try {{
            var bars = window._exposed_chartWidgetCollection
                ._chartModels._value[0].m_model._mainSeries.bars();
            var first = bars.firstIndex();
            var last  = bars.lastIndex();

            // Build date prefix to match against: we check all bars and filter by date string
            var result = [];
            for (var i = first; i <= last; i++) {{
                var b = bars.valueAt(i);
                if (!b) continue;
                var ts = b[0];
                // Convert timestamp to ET date string
                var d = new Date(ts * 1000);
                // ET offset: EST=-5, EDT=-4. Use toLocaleString for accuracy
                var etStr = d.toLocaleString('en-US', {{timeZone:'America/New_York',
                    year:'numeric', month:'2-digit', day:'2-digit',
                    hour:'2-digit', minute:'2-digit', hour12:false}});
                // etStr looks like "03/18/2026, 09:30"
                var parts = etStr.split(', ');
                var dateParts = parts[0].split('/');
                var dateStr = dateParts[2]+'-'+dateParts[0]+'-'+dateParts[1]; // YYYY-MM-DD
                var timeStr = parts[1].replace('24:', '00:');                 // HH:MM
                if (dateStr === '{date}' && timeStr >= '{t_start}' && timeStr <= '{t_end}') {{
                    result.push([ts, b[1], b[2], b[3], b[4], b[5]||0, dateStr, timeStr]);
                }}
            }}
            return JSON.stringify(result);
        }} catch(e) {{
            return JSON.stringify({{error: e.message}});
        }}
    }})()
    """
    raw = await cdp.execute_js(js)
    try:
        data = json.loads(raw)
    except Exception:
        return {"ok": False, "error": f"JS parse error: {raw[:200]}"}

    if isinstance(data, dict) and "error" in data:
        return {"ok": False, "error": data["error"]}

    if not isinstance(data, list):
        return {"ok": False, "error": "Geen lijst terug van JS"}

    bars = [
        {"time_et": f"{row[6]} {row[7]} ET", "timestamp": row[0],
         "open": row[1], "high": row[2], "low": row[3], "close": row[4], "volume": row[5]}
        for row in data
    ]

    logger.info("fetch-day %s %s-%s → %d bars", date, t_start, t_end, len(bars))
    return {"ok": True, "result": bars, "total_fetched": len(bars)}


# ── Chart analyst chat (bar data as context, no tools) ───────────────────────

@app.post("/api/chart-chat")
async def chart_chat(body: dict):
    """AI chat with OHLC bar data as system context. Same approach as test_chat."""
    import httpx as _httpx

    bars: list = body.get("bars", [])
    history: list = body.get("history", [])
    user_msg: str = body.get("message", "").strip()

    if not user_msg:
        return {"ok": False, "error": "No message"}
    if not bars:
        return {"ok": False, "error": "No bar data — fetch candles first"}

    # All bars in compact CSV (time only HH:MM to save tokens)
    rows = ["time,O,H,L,C"]
    for b in bars:
        t = b.get('time_et', '').split(' ')[1] if ' ' in b.get('time_et','') else b.get('time_et','')
        rows.append(f"{t},{b.get('open',0):.2f},{b.get('high',0):.2f},{b.get('low',0):.2f},{b.get('close',0):.2f}")
    data_csv = "\n".join(rows)

    system_prompt = f"You are a trading analyst. All {len(bars)} OHLC bars (5-min):\n{data_csv}\nRules: NEVER abbreviate, summarize or skip data. NEVER use '...' or 'and so on'. Always output ALL data completely. Never truncate your response."
    logger.info("chart-chat context (%d bars, ~%d chars):\n%s", len(bars), len(system_prompt), system_prompt)

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history[-4:])
    messages.append({"role": "user", "content": user_msg})

    async def stream_response():
        # Stuur candle data naar browser console voordat AI antwoord geeft
        yield f"data: {json.dumps({'console': {'label': f'CANDLE DATA naar AI ({len(bars)} bars)', 'csv': data_csv, 'bars': bars}})}\n\n"
        try:
            async with _httpx.AsyncClient(timeout=180) as client:
                async with client.stream("POST", "http://localhost:11434/v1/chat/completions", json={
                    "model": "qwen2.5:1.5b",
                    "messages": messages,
                    "stream": True,
                    "options": {"num_ctx": 4096},
                }) as resp:
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        chunk_str = line[6:]
                        if chunk_str == "[DONE]":
                            yield "data: [DONE]\n\n"
                            return
                        try:
                            token = json.loads(chunk_str)["choices"][0]["delta"].get("content", "")
                            if token:
                                yield f"data: {json.dumps({'t': token})}\n\n"
                        except Exception:
                            pass
        except Exception as e:
            logger.error("chart-chat stream error: %s", e)
            yield f"data: {json.dumps({'e': str(e)})}\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream",
                             headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})


# ── Fast AI action extractor (no tools, just JSON output) ────────────────────

EXTRACT_SYSTEM = """You are a trading chart command parser. Convert user input to JSON.

Output ONLY a single JSON object, no explanation, no markdown.

Available actions:
{"action":"navigate_to_date","date":"YYYY-MM-DD","time":"HH:MM"}
{"action":"change_symbol","symbol":"SYMBOL"}
{"action":"change_timeframe","timeframe":"1m|5m|15m|1h|4h|D|W"}
{"action":"get_chart_state"}
{"action":"get_bar_data","count":30}
{"action":"scroll_chart","direction":"left|right","bars":50}
{"action":"auto_scale"}
{"action":"reset_zoom"}
{"action":"take_screenshot"}
{"action":"unknown","reason":"..."}

Rules:
- Dates always YYYY-MM-DD format, current year is 2026
- Times always HH:MM 24h Eastern Time
- Timeframe: map "5 minuten"->5m, "uur"->1h, "dag"->D, "week"->W
- If unclear: {"action":"unknown","reason":"..."}
- Output ONLY JSON, nothing else"""

@app.post("/api/ai-action")
async def ai_action(body: dict):
    """Fast AI: extract parameters → execute CDP action directly."""
    import httpx as _httpx
    import json as _json
    from cdp_tools import TradingViewTools

    user_msg = body.get("message", "").strip()
    if not user_msg:
        return {"ok": False, "error": "No message"}

    # Step 1: Ask model to extract JSON params only
    try:
        async with _httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "http://localhost:11434/v1/chat/completions",
                json={
                    "model": "gemma4:e2b-it-q4_K_M",
                    "messages": [
                        {"role": "system", "content": EXTRACT_SYSTEM},
                        {"role": "user", "content": user_msg},
                    ],
                    "max_tokens": 600,
                    "options": {"num_ctx": 2048, "temperature": 0},
                },
            )
        data = resp.json()
        msg_data = data["choices"][0]["message"]
        raw = msg_data.get("content") or msg_data.get("reasoning", "")
        raw = raw.strip()

        # Extract JSON from response
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        if start == -1 or end == 0:
            return {"ok": False, "error": f"No JSON in response: {raw[:100]}"}

        parsed = _json.loads(raw[start:end])
    except Exception as e:
        return {"ok": False, "error": f"Parse error: {type(e).__name__}: {e}"}

    action = parsed.get("action")
    if action == "unknown":
        return {"ok": False, "error": parsed.get("reason", "Onbekend commando"), "parsed": parsed}

    # Step 2: Execute directly via CDP
    tv = TradingViewTools(cdp)
    try:
        if action == "navigate_to_date":
            result = await tv.navigate_to_date(parsed["date"], parsed.get("time", "00:00"))
        elif action == "change_symbol":
            result = await tv.change_symbol(parsed["symbol"])
        elif action == "change_timeframe":
            result = await tv.change_timeframe(parsed["timeframe"])
        elif action == "get_chart_state":
            sym = await tv.get_current_symbol()
            tf  = await tv.get_timeframe()
            result = f"Symbol: {sym} | TF: {tf}"
        elif action == "get_bar_data":
            result = await tv.get_bar_data(parsed.get("count", 10))
        elif action == "scroll_chart":
            result = await tv.scroll_chart(parsed.get("direction","left"), parsed.get("bars",50))
        elif action == "auto_scale":
            result = await tv.auto_scale()
        elif action == "reset_zoom":
            result = await tv.reset_zoom()
        elif action == "take_screenshot":
            b64 = await tv.screenshot()
            return {"ok": True, "action": parsed, "screenshot": b64}
        else:
            return {"ok": False, "error": f"Onbekende actie: {action}", "parsed": parsed}

        return {"ok": True, "action": parsed, "result": result}
    except Exception as e:
        return {"ok": False, "error": str(e), "parsed": parsed}


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)
    logger.info("WS client connected (%d total)", len(connected_clients))
    current_task: asyncio.Task | None = None

    async def run_agent(content: str):
        try:
            async for chunk in agent.process(content):
                await websocket.send_text(json.dumps(chunk))
        except asyncio.CancelledError:
            await websocket.send_text(json.dumps({"type": "system", "content": "Gestopt."}))
            await websocket.send_text(json.dumps({"type": "done"}))
        except Exception as e:
            logger.error("Agent error: %s", e)
            await websocket.send_text(json.dumps({"type": "error", "content": str(e)}))

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg.get("type") == "abort":
                if current_task and not current_task.done():
                    current_task.cancel()
                    logger.info("Agent task aborted by user")
                continue

            if msg.get("type") == "clear":
                if agent:
                    agent.clear_history()
                await websocket.send_text(json.dumps({"type": "system", "content": "Gesprek gewist."}))
                continue

            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            content = msg.get("content", "").strip()
            if not content or not agent:
                continue

            # Cancel any still-running task before starting a new one
            if current_task and not current_task.done():
                current_task.cancel()

            current_task = asyncio.create_task(run_agent(content))

    except WebSocketDisconnect:
        if current_task and not current_task.done():
            current_task.cancel()
    finally:
        connected_clients.discard(websocket)
        logger.info("WS client disconnected (%d remaining)", len(connected_clients))
