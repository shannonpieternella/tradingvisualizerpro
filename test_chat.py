"""Minimal chat server — direct Ollama access, no system prompt, no memory."""
import json
import httpx
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse

app = FastAPI()

HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Model Test</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: monospace; display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { padding: 8px 12px; border-radius: 6px; max-width: 80%; white-space: pre-wrap; word-break: break-word; }
  .user { background: #1f6feb; align-self: flex-end; }
  .ai   { background: #21262d; align-self: flex-start; }
  .info { color: #8b949e; font-size: 12px; align-self: center; }
  #preview { padding: 0 12px 8px; }
  #preview img { max-height: 120px; border-radius: 6px; border: 1px solid #30363d; }
  #preview button { background: none; border: none; color: #f85149; cursor: pointer; margin-left: 8px; font-size: 16px; vertical-align: middle; }
  #bar  { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #30363d; align-items: center; }
  #inp  { flex: 1; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; padding: 8px 12px; font-family: monospace; font-size: 14px; }
  #imgbtn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 10px; border-radius: 6px; cursor: pointer; font-size: 16px; }
  #btn  { background: #238636; border: none; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-family: monospace; }
  #btn:disabled, #imgbtn:disabled { opacity: 0.4; cursor: default; }
  #fileinp { display: none; }
</style>
</head>
<body>
<div id="log"><div class="msg info">qwen2.5:1.5b — directe chat — geen system prompt</div></div>
<div id="preview"></div>
<div id="bar">
  <button id="imgbtn" title="Afbeelding toevoegen">🖼</button>
  <input type="file" id="fileinp" accept="image/*">
  <input id="inp" placeholder="Type hier... (Enter = stuur)" autofocus>
  <button id="btn">Stuur</button>
</div>
<script>
const log = document.getElementById('log');
const inp = document.getElementById('inp');
const btn = document.getElementById('btn');
const imgbtn = document.getElementById('imgbtn');
const fileinp = document.getElementById('fileinp');
const preview = document.getElementById('preview');
let pendingImage = null; // base64 data URL

const ws = new WebSocket('ws://' + location.host + '/ws');
ws.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.type === 'text') {
    let el = log.querySelector('.ai.active');
    if (!el) { el = document.createElement('div'); el.className = 'msg ai active'; log.appendChild(el); }
    el.textContent += d.content;
  } else if (d.type === 'done') {
    const el = log.querySelector('.ai.active');
    if (el) el.classList.remove('active');
    btn.disabled = false;
    inp.disabled = false;
    imgbtn.disabled = false;
    inp.focus();
  } else if (d.type === 'info') {
    const el = document.createElement('div');
    el.className = 'msg info'; el.textContent = d.content; log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
};

imgbtn.onclick = () => fileinp.click();
fileinp.onchange = () => {
  const file = fileinp.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    pendingImage = ev.target.result; // data:image/...;base64,...
    preview.innerHTML = '<img src="' + pendingImage + '"><button onclick="clearImage()">✕</button>';
  };
  reader.readAsDataURL(file);
  fileinp.value = '';
};

function clearImage() {
  pendingImage = null;
  preview.innerHTML = '';
}

function send() {
  const text = inp.value.trim();
  if (!text && !pendingImage) return;

  // Show user message in log
  const el = document.createElement('div');
  el.className = 'msg user';
  if (pendingImage) {
    const img = document.createElement('img');
    img.src = pendingImage;
    img.style.cssText = 'max-height:80px;border-radius:4px;display:block;margin-bottom:4px';
    el.appendChild(img);
  }
  if (text) el.appendChild(document.createTextNode(text));
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;

  const payload = { content: text || 'Beschrijf deze afbeelding.' };
  if (pendingImage) payload.image = pendingImage;

  ws.send(JSON.stringify(payload));

  inp.value = '';
  clearImage();
  btn.disabled = true;
  inp.disabled = true;
  imgbtn.disabled = true;
}

btn.onclick = send;
inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

// Paste image from clipboard
document.addEventListener('paste', e => {
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (!item) return;
  const reader = new FileReader();
  reader.onload = ev => {
    pendingImage = ev.target.result;
    preview.innerHTML = '<img src="' + pendingImage + '"><button onclick="clearImage()">✕</button>';
  };
  reader.readAsDataURL(item.getAsFile());
});
</script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTML


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    history = []
    while True:
        raw = await websocket.receive_text()
        msg = json.loads(raw)
        text = msg.get("content", "").strip() or "Beschrijf deze afbeelding."
        image_data_url = msg.get("image")

        # Build content (text only, or text + image)
        if image_data_url:
            # Strip data URL prefix to get pure base64
            if "," in image_data_url:
                b64 = image_data_url.split(",", 1)[1]
            else:
                b64 = image_data_url
            content = [
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                {"type": "text", "text": text},
            ]
        else:
            content = text

        history.append({"role": "user", "content": content})

        import time
        t0 = time.time()
        await websocket.send_text(json.dumps({"type": "info", "content": "…denken…"}))

        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                "http://localhost:11434/v1/chat/completions",
                json={"model": "qwen2.5:1.5b", "messages": history, "max_tokens": 200, "options": {"num_ctx": 2048}},
            )
        data = resp.json()
        reply = data["choices"][0]["message"]["content"]
        elapsed = round(time.time() - t0, 1)

        # Store only text in history to keep context small
        history.append({"role": "assistant", "content": reply})

        await websocket.send_text(json.dumps({"type": "text", "content": reply}))
        await websocket.send_text(json.dumps({"type": "info", "content": f"⏱ {elapsed}s"}))
        await websocket.send_text(json.dumps({"type": "done"}))
