"""Remote MCP server — mounts as ASGI sub-app inside the FastAPI app.

Claude.ai connects via SSE to: https://<host>/mcp/sse?token=<MCP_TOKEN>
"""
import json
import logging
from typing import Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)

# ── Token gate middleware ──────────────────────────────────────────────────────

_SECRET_TOKEN: Optional[str] = None


_AUTHORIZED_SESSIONS: set = set()


class _TokenGate:
    """
    Guards the SSE endpoint with ?token=<SECRET>.
    Once a session is authorised via SSE, the matching messages/ POST is allowed.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        from urllib.parse import parse_qs
        qs = parse_qs(scope.get("query_string", b"").decode())

        # Check token from multiple possible locations
        headers = dict(scope.get("headers", []))
        auth = headers.get(b"authorization", b"").decode()
        bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else None
        x_api_key = headers.get(b"x-api-key", b"").decode().strip()
        query_token = qs.get("token", [None])[0]
        provided_token = bearer or x_api_key or query_token

        # Log all headers for debugging
        all_headers = {k.decode(): v.decode() for k, v in scope.get("headers", [])
                       if k.lower() not in (b"cookie",)}
        logger.info("MCP request — path: %s | provided_token: %r | headers: %s",
                    scope.get("path"), provided_token[:8] if provided_token else None, all_headers)

        if False and _SECRET_TOKEN:  # auth temporarily disabled
            if provided_token != _SECRET_TOKEN:
                await _send_403(send)
                return

        await self.app(scope, receive, send)


async def _send_403(send):
    await send({"type": "http.response.start", "status": 403,
                "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": b"Forbidden"})


def _make_session_tracker(original_send):
    """Intercepts SSE 'endpoint' event to register the session_id."""
    async def tracked_send(message):
        if message.get("type") == "http.response.body":
            body = message.get("body", b"").decode(errors="ignore")
            # SSE endpoint event: "data: /mcp/messages/?session_id=XXXX"
            for line in body.splitlines():
                if line.startswith("data:") and "session_id=" in line:
                    sid = line.split("session_id=")[-1].strip()
                    _AUTHORIZED_SESSIONS.add(sid)
                    logger.info("MCP session authorised: %s", sid)
        await original_send(message)
    return tracked_send


# ── Public factory ─────────────────────────────────────────────────────────────

def build_mcp_app(cdp, memory, scheduler, token: Optional[str] = None) -> ASGIApp:
    """
    Build the FastMCP ASGI sub-app.
    Called once from main.py lifespan after cdp/memory/scheduler are ready.
    Returns an ASGI app to mount at /mcp.
    """
    global _SECRET_TOKEN
    _SECRET_TOKEN = token or None

    from cdp_tools import TradingViewTools
    tv = TradingViewTools(cdp)

    mcp = FastMCP(
        name="TradingView Controller",
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=False
        ),
    )

    # ── Chart tools ────────────────────────────────────────────────────────────

    @mcp.tool(description="Get current symbol, timeframe and timezone of the chart.")
    async def get_chart_state() -> str:
        sym = await tv.get_current_symbol()
        tf  = await tv.get_timeframe()
        tz  = await tv.get_timezone()
        return f"Symbol: {sym} | Timeframe: {tf} | Timezone: {tz}"

    @mcp.tool(description="Change the chart symbol (e.g. NAS100, AAPL, BTCUSD).")
    async def change_symbol(symbol: str) -> str:
        return await tv.change_symbol(symbol)

    @mcp.tool(description="Change timeframe: 1m 5m 15m 1h 4h D W")
    async def change_timeframe(timeframe: str) -> str:
        return await tv.change_timeframe(timeframe)

    @mcp.tool(description=(
        "Navigate chart to a specific date/time (Eastern Time). "
        "date format: YYYY-MM-DD, time format: HH:MM (24h). "
        "NOTE: use the JS method from ACTIONS.md if this fails."
    ))
    async def navigate_to_date(date: str, time: str = "00:00") -> str:
        return await tv.navigate_to_date(date, time)

    @mcp.tool(description="Get OHLCV bar data from the chart. No upper limit on count. A full NY session (18:00 prev day to 16:50) is ~1430 1-min bars. Default 390.")
    async def get_bar_data(count: int = 390) -> str:
        data = await tv.get_bar_data(count)
        return json.dumps(data) if isinstance(data, list) else str(data)

    @mcp.tool(description=(
        "Navigate to a specific date and fetch all OHLCV candles within a time range (Eastern Time). "
        "date: YYYY-MM-DD, start: HH:MM, end: HH:MM. "
        "Returns all candles for that date between start and end time. "
        "Use this to analyze historical trading sessions."
    ))
    async def get_bars_for_date(date: str, start: str = "06:00", end: str = "16:00") -> str:
        import asyncio
        await tv.navigate_to_date(date, start)
        await asyncio.sleep(3.0)

        js = f"""
        (function() {{
            try {{
                var bars = window._exposed_chartWidgetCollection
                    ._chartModels._value[0].m_model._mainSeries.bars();
                var first = bars.firstIndex();
                var last  = bars.lastIndex();
                var result = [];
                for (var i = first; i <= last; i++) {{
                    var b = bars.valueAt(i);
                    if (!b) continue;
                    var d = new Date(b[0] * 1000);
                    var etStr = d.toLocaleString('en-US', {{timeZone:'America/New_York',
                        year:'numeric', month:'2-digit', day:'2-digit',
                        hour:'2-digit', minute:'2-digit', hour12:false}});
                    var parts = etStr.split(', ');
                    var dp = parts[0].split('/');
                    var dateStr = dp[2]+'-'+dp[0]+'-'+dp[1];
                    var timeStr = parts[1].replace('24:', '00:');
                    if (dateStr === '{date}' && timeStr >= '{start}' && timeStr <= '{end}') {{
                        result.push({{time: timeStr, open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5]||0}});
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
            return f"Parse error: {raw[:200]}"

        if isinstance(data, dict) and "error" in data:
            return f"Error: {data['error']}"

        if not data:
            return f"Geen candles gevonden voor {date} {start}-{end} ET."

        # Format as CSV for easy reading by Claude
        lines = [f"OHLCV candles for {date} {start}-{end} ET ({len(data)} bars):"]
        lines.append("time,open,high,low,close,volume")
        for b in data:
            lines.append(f"{b['time']},{b['open']:.2f},{b['high']:.2f},{b['low']:.2f},{b['close']:.2f},{b['volume']}")
        return "\n".join(lines)

    @mcp.tool(description="Take a screenshot of the current chart for verification.")
    async def take_screenshot() -> str:
        b64 = await tv.screenshot()
        return f"data:image/jpeg;base64,{b64}"

    @mcp.tool(description="Scroll chart left (past) or right (present).")
    async def scroll_chart(direction: str = "left", bars: int = 50) -> str:
        return await tv.scroll_chart(direction, bars)

    @mcp.tool(description="Toggle auto scale on the chart.")
    async def auto_scale() -> str:
        return await tv.auto_scale()

    @mcp.tool(description="Reset the time scale zoom.")
    async def reset_zoom() -> str:
        return await tv.reset_zoom()

    @mcp.tool(description=(
        "Execute JavaScript in the browser. Use for DOM exploration and "
        "advanced chart control when built-in tools fail. Always return a string."
    ))
    async def execute_javascript(code: str) -> str:
        try:
            result = await cdp.execute_js(code, timeout=12.0)
            return str(result) if result is not None else "undefined"
        except Exception as e:
            return f"JS error: {e}"

    # ── Memory tools ───────────────────────────────────────────────────────────

    @mcp.tool(description="Read a memory file (MEMORY.md, STRATEGIES.md, PATTERNS.md, AGENTS.md, ACTIONS.md, memory/YYYY-MM-DD.md).")
    async def read_memory(filename: str) -> str:
        return memory.read_file(filename) if memory else "Memory not available."

    @mcp.tool(description="Overwrite a memory file. Use for cleanup/consolidation of outdated entries.")
    async def write_memory(filename: str, content: str) -> str:
        return memory.write_file(filename, content) if memory else "Memory not available."

    @mcp.tool(description="Append new content to a memory file. Only for truly new info not already in the file.")
    async def append_memory(filename: str, content: str) -> str:
        return memory.append_file(filename, content) if memory else "Memory not available."

    @mcp.tool(description="Search all memory files for a keyword.")
    async def search_memory(query: str) -> str:
        return memory.search(query) if memory else "Memory not available."

    # ── Cron / scheduler tools ─────────────────────────────────────────────────

    @mcp.tool(description=(
        "Add a scheduled job. type='interval' with interval_minutes, "
        "or type='cron' with cron expression (ET timezone)."
    ))
    async def add_cron_job(
        name: str,
        message: str,
        type: str,
        interval_minutes: int = 15,
        cron: str = "",
    ) -> str:
        if not scheduler:
            return "Scheduler not available."
        job_def = {"name": name, "message": message, "type": type,
                   "interval_minutes": interval_minutes}
        if cron:
            job_def["cron"] = cron
        job = scheduler.add_job(job_def)
        return f"Job created: {job['name']} (id={job['id']})"

    @mcp.tool(description="List all scheduled cron jobs.")
    async def list_cron_jobs() -> str:
        if not scheduler:
            return "Scheduler not available."
        jobs = scheduler.list_jobs()
        if not jobs:
            return "No jobs scheduled."
        lines = []
        for j in jobs:
            sched = j.get("cron") or f"every {j.get('interval_minutes','?')}m"
            status = "active" if j.get("active") else "paused"
            lines.append(f"[{j['id']}] {j['name']} ({status}) — {sched} | runs: {j.get('run_count',0)}")
        return "\n".join(lines)

    @mcp.tool(description="Remove a scheduled cron job by ID.")
    async def remove_cron_job(job_id: str) -> str:
        if not scheduler:
            return "Scheduler not available."
        return "Job removed." if scheduler.remove_job(job_id) else "Job not found."

    @mcp.tool(description="Pause or resume a scheduled cron job by ID.")
    async def toggle_cron_job(job_id: str) -> str:
        if not scheduler:
            return "Scheduler not available."
        job = scheduler.toggle_job(job_id)
        if not job:
            return "Job not found."
        return f"Job {'activated' if job.get('active') else 'paused'}."

    # ── Return ASGI app wrapped in token gate ──────────────────────────────────

    # Streamable HTTP transport (new standard, required by OpenAI Agent Builder)
    http_starlette = mcp.streamable_http_app()
    # Return both the ASGI app and the session_manager so main.py can run
    # session_manager.run() inside its own lifespan context.
    return _TokenGate(http_starlette), mcp.session_manager
