"""Chrome DevTools Protocol session and TradingView-specific tools."""
import asyncio
import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

import httpx
import pytz
import websockets
from websockets.connection import State
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)


class CDPSession:
    """Persistent CDP WebSocket session with auto-reconnect.

    Each instance binds to ONE Chrome page target. Multiple instances pointing
    to different tabs let us run truly parallel CDP traffic — no shared lock,
    no chart-switch races. tab_index selects which TradingView tab to attach
    to; if not enough tabs exist, connect() opens additional ones.
    """

    def __init__(self, tab_index: int = 0, target_url_filter: str = "tradingview.com",
                 new_tab_url: str = "https://www.tradingview.com/chart/"):
        self.tab_index = tab_index
        self.target_url_filter = target_url_filter
        self.new_tab_url = new_tab_url
        self.ws = None
        self._msg_id = 0
        self._pending: Dict[int, asyncio.Future] = {}
        self._listen_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
        self._target_id: Optional[str] = None

    async def _list_targets(self, client: httpx.AsyncClient) -> List[dict]:
        resp = await client.get("http://localhost:9222/json/list")
        return resp.json()

    def _matching_pages(self, targets: List[dict]) -> List[dict]:
        # Stable order: sort by id so tab_index → same physical tab across
        # reconnects (Chrome's /json/list order is otherwise insertion-based).
        pages = [
            t for t in targets
            if t.get("type") == "page"
            and self.target_url_filter in (t.get("url") or "")
        ]
        return sorted(pages, key=lambda t: t.get("id", ""))

    async def _ensure_tab(self, client: httpx.AsyncClient) -> dict:
        """Pick the Nth matching tab; create new tabs until Nth exists."""
        for spawn_attempt in range(self.tab_index + 1 + 2):  # +2 grace tries
            targets = await self._list_targets(client)
            pages = self._matching_pages(targets)
            if len(pages) > self.tab_index:
                return pages[self.tab_index]
            # Need more tabs. Chrome /json/new opens via PUT (older builds)
            # or GET (newer). Try PUT first, fall back to GET.
            url = f"http://localhost:9222/json/new?{self.new_tab_url}"
            try:
                await client.put(url)
            except Exception:
                try:
                    await client.get(url)
                except Exception as e:
                    logger.warning("CDP /json/new failed: %s", e)
            # Give the new tab a moment to load TradingView chart shell so
            # subsequent execute_js() calls don't race the page bootstrap.
            await asyncio.sleep(4.0)
        raise RuntimeError(
            f"CDP: could not find/create tab_index={self.tab_index} "
            f"matching '{self.target_url_filter}'"
        )

    async def connect(self, retries: int = 15, delay: float = 2.0):
        for attempt in range(retries):
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    page = await self._ensure_tab(client)

                self._target_id = page.get("id")
                ws_url = page["webSocketDebuggerUrl"]
                self.ws = await websockets.connect(
                    ws_url,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=50 * 1024 * 1024,
                )
                if self._listen_task:
                    self._listen_task.cancel()
                self._listen_task = asyncio.create_task(self._listen())
                await self.send("Page.enable")
                await self.send("Runtime.enable")
                logger.info("CDP connected (tab_index=%d, target=%s): %s",
                            self.tab_index, self._target_id, ws_url)
                return
            except Exception as exc:
                if attempt < retries - 1:
                    logger.warning("CDP connect attempt %d failed (tab=%d): %s",
                                   attempt + 1, self.tab_index, exc)
                    await asyncio.sleep(delay)
                else:
                    raise RuntimeError(
                        f"CDP connect failed after {retries} attempts "
                        f"(tab_index={self.tab_index}): {exc}"
                    )

    async def _listen(self):
        try:
            async for raw in self.ws:
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                msg_id = data.get("id")
                if msg_id is not None and msg_id in self._pending:
                    fut = self._pending.pop(msg_id)
                    if not fut.done():
                        fut.set_result(data)
        except (ConnectionClosed, asyncio.CancelledError, Exception):
            pass

    def _ws_is_closed(self) -> bool:
        """Check if WebSocket is closed (websockets 16+)."""
        if self.ws is None:
            return True
        try:
            return self.ws.state != State.OPEN
        except AttributeError:
            # Very old websockets: fallback to .closed
            return getattr(self.ws, "closed", True)

    async def send(self, method: str, params: Optional[dict] = None, timeout: float = 30.0) -> dict:
        async with self._lock:
            if self._ws_is_closed():
                await self.connect()

            self._msg_id += 1
            msg_id = self._msg_id

        message = {"id": msg_id, "method": method}
        if params:
            message["params"] = params

        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[msg_id] = fut

        await self.ws.send(json.dumps(message))
        result = await asyncio.wait_for(fut, timeout=timeout)

        if "error" in result:
            raise RuntimeError(f"CDP error [{method}]: {result['error']}")
        return result.get("result", {})

    async def execute_js(self, expression: str, timeout: float = 15.0) -> Any:
        result = await self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": True,
                "timeout": int(timeout * 1000),
            },
            timeout=timeout + 5,
        )
        if result.get("exceptionDetails"):
            details = result["exceptionDetails"]
            msg = details.get("exception", {}).get("description") or details.get("text", "JS error")
            raise RuntimeError(f"JS exception: {msg}")
        val = result.get("result", {})
        if val.get("type") == "undefined":
            return None
        return val.get("value")

    async def navigate(self, url: str, wait: float = 4.0):
        await self.send("Page.navigate", {"url": url})
        await asyncio.sleep(wait)

    async def screenshot(self) -> str:
        """Returns base64-encoded JPEG screenshot."""
        result = await self.send(
            "Page.captureScreenshot", {"format": "jpeg", "quality": 75}
        )
        return result.get("data", "")

    async def click(self, x: float, y: float):
        for ev in ("mousePressed", "mouseReleased"):
            await self.send(
                "Input.dispatchMouseEvent",
                {"type": ev, "x": x, "y": y, "button": "left", "clickCount": 1},
            )
        await asyncio.sleep(0.15)

    async def type_text(self, text: str, delay: float = 0.05):
        for char in text:
            await self.send("Input.dispatchKeyEvent", {"type": "char", "text": char})
            await asyncio.sleep(delay)

    async def press_key(self, key: str, code: Optional[str] = None, key_code: int = 0):
        code = code or (f"Key{key.upper()}" if len(key) == 1 else key)
        for ev in ("keyDown", "keyUp"):
            await self.send(
                "Input.dispatchKeyEvent",
                {"type": ev, "key": key, "code": code, "windowsVirtualKeyCode": key_code},
            )
        await asyncio.sleep(0.1)


# ── TradingView helpers ───────────────────────────────────────────────────────

_TF_MAP = {
    "1m": "1", "1": "1",
    "3m": "3", "3": "3",
    "5m": "5", "5": "5",
    "15m": "15", "15": "15",
    "30m": "30", "30": "30",
    "1h": "60", "60": "60", "H": "60", "1H": "60",
    "2h": "120", "2H": "120",
    "4h": "240", "4H": "240",
    "D": "D", "1d": "D", "1D": "D",
    "W": "W", "1W": "W",
    "M": "M", "1M": "M",
}

_EASTERN = pytz.timezone("America/New_York")


def _to_timestamp(date_str: str, time_str: str = "00:00") -> int:
    """Convert Eastern date/time string to UTC Unix timestamp."""
    dt = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
    dt_east = _EASTERN.localize(dt, is_dst=None)
    return int(dt_east.timestamp())


def _ts_to_eastern(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=_EASTERN).strftime("%Y-%m-%d %H:%M %Z")


class TradingViewTools:
    def __init__(self, cdp: CDPSession):
        self.cdp = cdp

    # ── Read state ────────────────────────────────────────────────────────────

    async def get_current_symbol(self) -> str:
        try:
            return await self.cdp.execute_js(
                "window.TradingViewApi._activeChartWidgetWV._value.symbol()"
            )
        except Exception:
            return "unknown"

    async def get_timeframe(self) -> str:
        try:
            return await self.cdp.execute_js(
                "window.TradingViewApi._activeChartWidgetWV._value.resolution()"
            )
        except Exception:
            return "unknown"

    async def get_timezone(self) -> str:
        try:
            return await self.cdp.execute_js(
                "window.TradingViewApi._activeChartWidgetWV._value.getTimezone()"
            )
        except Exception:
            return "unknown"

    # ── Change symbol ─────────────────────────────────────────────────────────

    async def change_symbol(self, symbol: str) -> str:
        symbol_upper = symbol.upper()

        # Try TV API first
        try:
            res = await self.cdp.execute_js(f"""
                (function() {{
                    try {{
                        var c = window.TradingViewApi._activeChartWidgetWV._value;
                        c.setSymbol('{symbol_upper}');
                        return 'api_ok';
                    }} catch(e) {{ return 'err:' + e.message; }}
                }})()
            """)
            if res == "api_ok":
                await asyncio.sleep(2)
                actual = await self.get_current_symbol()
                return f"Symbol changed to {actual}"
        except Exception:
            pass

        # Fallback: use the search widget
        try:
            await self.cdp.execute_js("""
                (function() {
                    var btn = document.querySelector('[data-name="symbol-search-items-dialog-button"]')
                           || document.querySelector('.js-button-text.button-merBkM5y')
                           || document.querySelector('[class*="symbolInput"]');
                    if (btn) btn.click();
                })()
            """)
            await asyncio.sleep(0.5)

            # Type in any visible search input
            await self.cdp.execute_js(f"""
                (function() {{
                    var inp = document.querySelector('input[data-role="search"]')
                            || document.querySelector('input[placeholder*="ymbol"]')
                            || document.querySelector('input[placeholder*="earch"]');
                    if (!inp) return;
                    inp.focus();
                    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    setter.call(inp, '{symbol_upper}');
                    inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                }})()
            """)
            await asyncio.sleep(1.2)
            await self.cdp.press_key("Enter", "Enter", 13)
            await asyncio.sleep(2)
            actual = await self.get_current_symbol()
            return f"Symbol changed to {actual}"
        except Exception as e:
            return f"Symbol change error: {e}"

    # ── Change timeframe ──────────────────────────────────────────────────────

    async def change_timeframe(self, timeframe: str) -> str:
        tf = _TF_MAP.get(timeframe, timeframe)

        # Try TV API
        try:
            res = await self.cdp.execute_js(f"""
                (function() {{
                    try {{
                        window.TradingViewApi._activeChartWidgetWV._value.setResolution('{tf}');
                        return 'ok';
                    }} catch(e) {{ return 'err:' + e.message; }}
                }})()
            """)
            if res == "ok":
                await asyncio.sleep(1)
                return f"Timeframe set to {timeframe} ({tf})"
        except Exception:
            pass

        # Fallback: click toolbar button
        clicked = await self.cdp.execute_js(f"""
            (function() {{
                var btns = Array.from(document.querySelectorAll(
                    '[data-value="{tf}"], button[class*="item"]'
                ));
                var btn = btns.find(b => b.textContent.trim() === '{tf}'
                               || b.getAttribute('data-value') === '{tf}');
                if (btn) {{ btn.click(); return 'clicked'; }}
                return 'not_found';
            }})()
        """)
        await asyncio.sleep(1)
        return f"Timeframe {timeframe}: {clicked}"

    # ── Navigate to date/time ─────────────────────────────────────────────────

    async def navigate_to_date(self, date_str: str, time_str: str = "00:00") -> str:
        """Navigate chart to date/time in Eastern Time. Tries multiple methods."""
        # ── Parse timestamp (handle DST gracefully) ───────────────────────────
        try:
            target_ts = _to_timestamp(date_str, time_str)
        except Exception:
            try:
                dt = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
                target_ts = int(_EASTERN.localize(dt, is_dst=False).timestamp())
            except Exception as e:
                return f"Ongeldige datum/tijd: {e}"

        tf_raw = await self.get_timeframe()
        tf_seconds = {
            "1": 60, "3": 180, "5": 300, "15": 900, "30": 1800,
            "60": 3600, "120": 7200, "240": 14400, "D": 86400, "W": 604800,
        }.get(tf_raw, 300)

        # Show target date near right side: 80 bars before, 20 after
        from_ts = target_ts - tf_seconds * 80
        to_ts   = target_ts + tf_seconds * 20

        # ── Method 1: TradingView API setVisibleRange ─────────────────────────
        res1 = await self.cdp.execute_js(f"""
            (function() {{
                try {{
                    var c = window.TradingViewApi._activeChartWidgetWV._value;
                    if (typeof c.setVisibleRange !== 'function')
                        return 'no_setVisibleRange';
                    c.setVisibleRange({{from: {from_ts}, to: {to_ts}}});
                    return 'ok';
                }} catch(e) {{ return 'err:' + e.message; }}
            }})()
        """)
        await asyncio.sleep(1.5)

        if res1 == "ok":
            return f"Navigated to {date_str} {time_str} ET"

        # ── Method 2: go-to-date dialog — proven working method ──────────────
        opened = await self.cdp.execute_js("""
            (function() {
                var btn = document.querySelector('[data-name="go-to-date"]');
                if (btn) { btn.click(); return 'opened'; }
                return 'not_found';
            })()
        """)
        await asyncio.sleep(1.2)

        if opened == "opened":
            setter_js = "Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set"

            # Fill date field (inputs[1]) — format: YYYY-MM-DD
            date_result = await self.cdp.execute_js(f"""
                (function() {{
                    var inputs = document.querySelectorAll('input');
                    var el = null;
                    for (var j = 0; j < inputs.length; j++) {{
                        if (inputs[j] instanceof HTMLInputElement) {{ el = inputs[j]; if (j >= 1) break; }}
                    }}
                    // prefer index 1 if it exists
                    if (inputs.length > 1 && inputs[1] instanceof HTMLInputElement) el = inputs[1];
                    if (!el) return 'no_input';
                    var s = {setter_js};
                    s.call(el, '{date_str}');
                    el.dispatchEvent(new Event('input', {{bubbles:true}}));
                    el.dispatchEvent(new Event('change', {{bubbles:true}}));
                    return 'date:' + el.value;
                }})()
            """)
            await asyncio.sleep(0.5)

            # Fill time field (inputs[2]) — format: HH:MM
            time_result = await self.cdp.execute_js(f"""
                (function() {{
                    var inputs = document.querySelectorAll('input');
                    if (inputs.length < 3) return 'no_time_input';
                    var el = inputs[2];
                    if (!(el instanceof HTMLInputElement)) return 'not_input';
                    var s = {setter_js};
                    s.call(el, '{time_str}');
                    el.dispatchEvent(new Event('input', {{bubbles:true}}));
                    el.dispatchEvent(new Event('change', {{bubbles:true}}));
                    el.blur();
                    return 'time:' + el.value;
                }})()
            """)
            await asyncio.sleep(0.5)

            # Submit
            await self.cdp.execute_js("""
                (function() {
                    var btn = document.querySelector('[data-name="submit-button"]');
                    if (btn) btn.click();
                })()
            """)
            await asyncio.sleep(1.5)
            return f"Navigated to {date_str} {time_str} ET via dialog ({date_result}, {time_result})"

        # ── Method 3: navigate via chart URL (page reload) ────────────────────
        try:
            symbol = await self.get_current_symbol()
            tf_url = tf_raw if tf_raw else "D"
            url = (
                f"https://www.tradingview.com/chart/"
                f"?symbol={symbol}&interval={tf_url}"
            )
            await self.cdp.navigate(url, wait=5.0)
            # After reload, try setVisibleRange again
            res3 = await self.cdp.execute_js(f"""
                (function() {{
                    try {{
                        var c = window.TradingViewApi._activeChartWidgetWV._value;
                        c.setVisibleRange({{from: {from_ts}, to: {to_ts}}});
                        return 'ok_after_reload';
                    }} catch(e) {{ return 'err:' + e.message; }}
                }})()
            """)
            await asyncio.sleep(1.5)
            if res3 and "ok" in res3:
                return f"Navigated to {date_str} {time_str} ET (after reload)"
            return f"Navigatie gefaald. Method1={res1}, Dialog={clicked}, Method3={res3}"
        except Exception as e:
            return f"Navigatie gefaald. Method1={res1}, Dialog={clicked}, Error={e}"

    # ── Bar data ──────────────────────────────────────────────────────────────

    async def get_bar_data(self, count: int = 100, from_index: Optional[int] = None) -> Any:
        js = f"""
        (function() {{
            try {{
                var bars = window._exposed_chartWidgetCollection
                    ._chartModels._value[0].m_model._mainSeries.bars();
                var first = bars.firstIndex();
                var last  = bars.lastIndex();
                var startIdx = {from_index if from_index is not None
                                else f'Math.max(first, last - {count})'};
                var result = [];
                for (var i = startIdx; i <= last; i++) {{
                    var b = bars.valueAt(i);
                    if (b) result.push(b);
                }}
                return JSON.stringify(result);
            }} catch(e) {{
                return JSON.stringify({{error: e.message}});
            }}
        }})()
        """
        raw = await self.cdp.execute_js(js)
        try:
            data = json.loads(raw)
            if isinstance(data, dict) and "error" in data:
                return f"Bar data error: {data['error']}"
            if isinstance(data, list):
                result = []
                for bar in data:
                    if isinstance(bar, list) and len(bar) >= 5:
                        result.append({
                            "time_et": _ts_to_eastern(bar[0]),
                            "timestamp": bar[0],
                            "open": bar[1],
                            "high": bar[2],
                            "low": bar[3],
                            "close": bar[4],
                            "volume": bar[5] if len(bar) > 5 else 0,
                        })
                return result
        except Exception:
            pass
        return raw

    # ── Chart controls ────────────────────────────────────────────────────────

    async def scroll_chart(self, direction: str = "left", bars: int = 50) -> str:
        delta_x = -120 * bars if direction == "left" else 120 * bars
        await self.cdp.execute_js(f"""
            (function() {{
                var canvas = document.querySelector('canvas.chart-gui-wrapper')
                          || document.querySelector('canvas[class*="chart"]')
                          || document.querySelector('canvas');
                if (!canvas) return;
                var r = canvas.getBoundingClientRect();
                var cx = r.left + r.width / 2;
                var cy = r.top  + r.height / 2;
                canvas.dispatchEvent(new WheelEvent('wheel', {{
                    bubbles: true, cancelable: true,
                    deltaX: {delta_x}, deltaY: 0,
                    clientX: cx, clientY: cy
                }}));
            }})()
        """)
        await asyncio.sleep(0.3)
        return f"Scrolled {direction} {bars} bars"

    async def auto_scale(self) -> str:
        res = await self.cdp.execute_js("""
            (function() {
                var btn = document.querySelector('[data-name="toggle auto scale"]')
                       || document.querySelector('[title*="Auto scale"]')
                       || document.querySelector('[title*="auto scale"]');
                if (btn) { btn.click(); return 'clicked'; }
                return 'not_found';
            })()
        """)
        await asyncio.sleep(0.3)
        return f"Auto scale: {res}"

    async def reset_zoom(self) -> str:
        res = await self.cdp.execute_js("""
            (function() {
                try {
                    window.TradingViewApi._activeChartWidgetWV._value
                        .executeActionById('timeScaleReset');
                    return 'ok';
                } catch(e) { return 'err:' + e.message; }
            })()
        """)
        await asyncio.sleep(0.3)
        return f"Reset zoom: {res}"

    async def screenshot(self) -> str:
        return await self.cdp.screenshot()
