import React, { useState, useRef, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext.jsx";
import "./MentorBlock.css";

function getStaticMessage(activeTrade, progress, name) {
  const n = name ? `, ${name.split(" ")[0]}` : "";
  if (!activeTrade) return {
    icon: "🧘", title: `Geduld is je voorsprong${n}`,
    body: "Geen actieve trade. De markt beloont degene die wacht op high-probability setups. Blijf gedisciplineerd — de volgende cyclus is in opbouw.",
    color: "cyan",
  };
  if (progress?.oppHit?.hit) return {
    icon: "🔄", title: `Nieuwe ${progress.oppHit.newType} kans${n}`,
    body: `${progress.oppHit.reason}. Je vorige trade is gesloten. Zoek een verse ${progress.oppHit.newType} setup in het volgende Phase 2 window.`,
    color: "purple",
  };
  if (progress?.isStopped) return {
    icon: "🔄", title: `Verlies geaccepteerd${n}, ga door`,
    body: "Stop loss geraakt. Dat is geen falen — het is de prijs van traden. Reset, heroverweeg, bereid je voor op de volgende setup.",
    color: "red",
  };
  if (progress?.tpDayHit) return {
    icon: "🏆", title: `Dagdoel bereikt${n}!`,
    body: "TP Day geraakt. Boek je winst. Je werk zit erop voor vandaag.",
    color: "yellow",
  };
  if (progress?.tp1Hit) return {
    icon: "✅", title: `Eerste target geraakt${n} — vergrendel winst`,
    body: "Overweeg gedeeltelijk te sluiten en SL naar breakeven te verplaatsen. De trade is nu risicovrij.",
    color: "green",
  };
  if (progress?.pnl < -20) return {
    icon: "🛡", title: `Drawdown${n} — vertrouw de structuur`,
    body: `${Math.abs(progress.pnl)} pts drawdown maar SL houdt. Exit alleen als SL geraakt wordt, niet uit angst.`,
    color: "orange",
  };
  if (progress?.pnl > 30) return {
    icon: "🔥", title: `Trade loopt${n} — blijf erin`,
    body: `+${progress.pnl} pts winst. Sluit niet vroeg. Vertrouw je targets en het proces.`,
    color: "green",
  };
  if (progress?.pnl > 0) return {
    icon: "📈", title: `In winst${n} — houd de lijn`,
    body: `+${progress.pnl} pts. Laat de markt werken. Niet aanraken.`,
    color: "green",
  };
  return {
    icon: "⚡", title: `Trade is live${n} — voer het plan uit`,
    body: `${activeTrade.type} trade in ${activeTrade.cycle} is actief. Vertrouw de analyse, je SL en je targets.`,
    color: "cyan",
  };
}

export default function MentorBlock({ activeTrade, progress, market = "NAS100", filter = null, activeTab = null, userName = null }) {
  const { authFetch } = useAuth();
  const { icon, title, body, color } = getStaticMessage(activeTrade, progress, userName);
  const firstName = userName?.split(" ")[0] ?? null;
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  useEffect(() => {
    if (chatOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [chatOpen]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg = { role: "user", content: text };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setStreaming(true);

    // Add empty assistant message to stream into
    const assistantIdx = newHistory.length;
    setMessages(prev => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await authFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: messages.slice(-10),
          market,
          marketTab: activeTab,
          filter: filter ?? { dir: "ALL", matrixOnly: false, cycle: "ALL" },
          userName,
        }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const json = JSON.parse(line);
            if (json.token) {
              setMessages(prev => {
                const updated = [...prev];
                updated[assistantIdx] = {
                  ...updated[assistantIdx],
                  content: (updated[assistantIdx]?.content || "") + json.token,
                };
                return updated;
              });
            }
            if (json.error) {
              setMessages(prev => {
                const updated = [...prev];
                updated[assistantIdx] = { role: "assistant", content: `Error: ${json.error}` };
                return updated;
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        updated[assistantIdx] = { role: "assistant", content: `Connection error: ${err.message}` };
        return updated;
      });
    } finally {
      setStreaming(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className={`card mentor-card mentor-${color}`}>
      <div className="card-title">
        Trading Mentor
        <button
          className={`chat-toggle-btn ${chatOpen ? "chat-open" : ""}`}
          onClick={() => setChatOpen(o => !o)}
        >
          {chatOpen ? "✕ close" : "💬 Ask mentor"}
        </button>
      </div>

      {/* Static coaching message */}
      <div className="mentor-content">
        <div className="mentor-icon">{icon}</div>
        <div className="mentor-text">
          <div className="mentor-title">{title}</div>
          <div className="mentor-body">{body}</div>
        </div>
      </div>

      {/* Chat section */}
      {chatOpen && (
        <div className="mentor-chat">
          <div className="chat-divider" />

          {/* Message thread */}
          <div className="chat-thread">
            {messages.length === 0 && (
              <div className="chat-empty">
                <p>
                  {firstName ? `Hé ${firstName}! ` : ""}
                  {filter?.matrixOnly ? "🔓 Matrix-only filter actief." :
                   filter?.dir !== "ALL" ? `${filter.dir === "BUY" ? "▲ BUY" : "▼ SELL"} filter actief.` :
                   filter?.cycle !== "ALL" ? `${filter.cycle} filter actief.` :
                   "Stel me alles over de huidige trade, signalen of strategie."}
                </p>
                <div className="chat-suggestions">
                  {(filter?.matrixOnly
                    ? ["Welke matrix setups zijn er nu?", "Hoe sterk is de alignment?", "Wanneer is het entry window?", "Waarom deze bias?"]
                    : filter?.dir === "BUY"
                    ? ["Beste BUY setup nu?", "Wat is het risico op de BUY?", "Wanneer is het BUY window open?", "Waarom bullish bias?"]
                    : filter?.dir === "SELL"
                    ? ["Beste SELL setup nu?", "Wat is het risico op de SELL?", "Wanneer is het SELL window open?", "Waarom bearish bias?"]
                    : filter?.cycle !== "ALL"
                    ? [`${filter?.cycle} setup uitleggen`, `Wanneer is ${filter?.cycle} actief?`, "Entry window nu open?", "Waarom deze bias?"]
                    : ["Waarom deze bias?", "Leg de week structuur uit", "Wat zijn de EQH/EQL niveaus?", "Welke setup nu?", "Leg de cycle structuur uit"]
                  ).map(s => (
                    <button key={s} className="suggestion-btn" onClick={() => { setInput(s); inputRef.current?.focus(); }}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`chat-msg ${msg.role === "user" ? "msg-user" : "msg-ai"}`}>
                {msg.role === "assistant" && <span className="msg-avatar">🧠</span>}
                <div className="msg-bubble">
                  {msg.content || (streaming && i === messages.length - 1 ? <span className="typing-cursor" /> : "")}
                </div>
                {msg.role === "user" && <span className="msg-avatar msg-avatar-user">{firstName ?? "Jij"}</span>}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form className="chat-input-row" onSubmit={sendMessage}>
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask your mentor..."
              rows={1}
              disabled={streaming}
            />
            <button
              type="submit"
              className={`chat-send-btn ${streaming ? "sending" : ""}`}
              disabled={streaming || !input.trim()}
            >
              {streaming ? <span className="send-spinner" /> : "↑"}
            </button>
          </form>
          <div className="chat-hint">Enter to send · Shift+Enter for newline</div>
        </div>
      )}
    </div>
  );
}
