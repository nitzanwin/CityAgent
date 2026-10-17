"use client";
import { useState, useEffect, useRef } from "react";
import { city } from "@/lib/city";
import type { Decision } from "@/lib/routing";

type Entry = { role: "citizen" | "agent"; text: string; source?: string };
type Recognition = { lang: string; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void; stop: () => void };
type RecognitionCtor = new () => Recognition;
export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Entry[]>([{ role: "agent", text: "Welcome to Bellevue CityDesk. Ask a question about city services, or tell me about an issue you'd like to report." }]);
  const [simulation, setSimulation] = useState("2026-10-19T10:00");
  const [useSimulation, setUseSimulation] = useState(true);
  const [pending, setPending] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [lastDecision, setLastDecision] = useState<Decision | null>(null);
  const recognizer = useRef<Recognition | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  const speak = (text: string) => { if (voiceEnabled && "speechSynthesis" in window) { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } };
  async function send(text: string) {
    if (!text.trim() || pending) return;
    setPending(true); setInput(""); setMessages(prev => [...prev, { role: "citizen", text }]);
    try {
      const simulatedTime = useSimulation ? new Date(`${simulation}:00-07:00`).toISOString() : undefined;
      const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, simulatedTime }) });
      if (!res.ok) throw new Error("The agent is unavailable. Please retry.");
      const result: { decision: Decision } = await res.json();
      setLastDecision(result.decision);
      setMessages(prev => [...prev, { role: "agent", text: result.decision.response, source: result.decision.action === "answer" ? result.decision.source : undefined }]);
      speak(result.decision.response);
    } catch (error) { setMessages(prev => [...prev, { role: "agent", text: error instanceof Error ? error.message : "Unexpected error" }]); }
    finally { setPending(false); }
  }
  function listen() {
    if (listening) { recognizer.current?.stop(); setListening(false); return; }
    const browser = window as typeof window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Ctor) { alert("Speech recognition is not available in this browser. Try Chrome or use text input."); return; }
    const rec = new Ctor(); rec.lang = "en-US";
    rec.onresult = event => { const transcript = event.results[0]?.[0]?.transcript; if (transcript) void send(transcript); };
    rec.onend = () => setListening(false); rec.onerror = () => setListening(false);
    recognizer.current = rec; rec.start(); setListening(true);
  }
  async function ticket() {
    const latest = [...messages].reverse().find(m => m.role === "citizen")?.text;
    if (!latest || !lastDecision || lastDecision.action !== "ticket") return;
    setPending(true);
    try {
      const simulatedTime = useSimulation ? new Date(`${simulation}:00-07:00`).toISOString() : undefined;
      const res = await fetch("/api/agent", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({message:latest, simulatedTime, createTicket:true})});
      const result = await res.json();
      if (!res.ok || !result.ticket) throw new Error(result.error || "Ticket could not be created");
      setMessages(prev=>[...prev,{role:"agent",text:`Ticket ${result.ticket.id} created (${result.ticket.provider} mode).${result.ticket.url ? ` View: ${result.ticket.url}` : ""}`}]);
      setLastDecision(null);
    } catch(err){ setMessages(prev=>[...prev,{role:"agent",text:err instanceof Error ? err.message : "Ticket failed"}]); }
    finally {setPending(false);}
  }
  return <main className="shell">
    <header><div><div className="eyebrow">THREEFOLD AI · TAKE-HOME PROTOTYPE</div><h1>CityDesk <span>↗</span></h1><p>City services, simplified. A voice-enabled municipal concierge.</p></div><div className="status"><span className="dot"/>Prototype · Bellevue, WA</div></header>
    <section className="twoCol"><div className="panel chatPanel"><div className="panelHead"><div><h2>Citizen conversation</h2><p>Try typing or using your microphone</p></div><button className={`quiet ${voiceEnabled ? "active" : ""}`} onClick={()=>setVoiceEnabled(v=>!v)}>{voiceEnabled ? "🔊 Spoken replies on" : "🔈 Spoken replies off"}</button></div>
      <div className="messages">{messages.map((m,i)=><div className={`bubble ${m.role}`} key={i}><span className="role">{m.role === "agent" ? "CITYDESK" : "YOU"}</span><div>{m.text}</div>{m.source && <a href={m.source} target="_blank" rel="noreferrer">Official source ↗</a>}</div>)}{pending && <div className="loading">Working on it…</div>}<div ref={bottom}/></div>
      {lastDecision?.action === "ticket" && <div className="ticketAction"><span>Office closed · ticket recommended</span><button onClick={ticket} disabled={pending}>Create ticket ↗</button></div>}
      <form onSubmit={e=>{e.preventDefault();void send(input);}} className="composer"><button type="button" onClick={listen} aria-label="Speak" className={`mic ${listening?"recording":""}`}>{listening?"■":"🎙"}</button><input placeholder="Ask about a pothole, parks, events, local laws…" value={input} onChange={e=>setInput(e.target.value)}/><button type="submit" disabled={pending || !input.trim()}>Send →</button></form>
      <div className="prompts">{["I need to report a pothole", "What are the noise rules?", "What's happening in Bellevue?"].map(p=><button key={p} onClick={()=>void send(p)}>{p}</button>)}</div>
    </div><aside><div className="panel info"><div className="eyebrow">CONTROL CENTER</div><h2>Test routing decisions</h2><p>Change the simulated local time to test whether a citizen is transferred or offered a ticket.</p><label className="toggle"><input type="checkbox" checked={useSimulation} onChange={e=>setUseSimulation(e.target.checked)}/> Use simulated time</label><label className="fieldLabel" htmlFor="simulation">Bellevue date and time</label><input id="simulation" type="datetime-local" value={simulation} disabled={!useSimulation} onChange={e=>setSimulation(e.target.value)}/><p className="hint">Demo policy: weekdays, 8 AM–4 PM Pacific. Does not yet include verified city holidays or department-specific hours.</p>{lastDecision && <div className="decision"><div className="eyebrow">LATEST DECISION</div><strong>{lastDecision.action.toUpperCase()}</strong><div>Department: {lastDecision.department}</div>{lastDecision.action === "transfer" && <div>Mock number: {lastDecision.phone}</div>}</div>}</div>
      <div className="panel info"><div className="eyebrow">OFFICIAL LINKS</div><h2>Reference sources</h2>{city.sources.map(s=><a className="source" key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.label} <span>↗</span></a>)}<p className="hint">This starter uses safe source links and rule-based routing. Live knowledge retrieval, verified event details, and real phone transfers are intentionally not implemented yet.</p></div>
      <div className="panel info"><div className="eyebrow">WHAT'S NEXT</div><h2>Pluggable integrations</h2><p>Voice provider, knowledge retrieval and ticketing can be replaced independently. Trello is optional; unconfigured ticket creation returns a clearly labeled mock ID.</p></div></aside></section><footer>Experimental demo · Not an official City of Bellevue service · No real transfers are placed</footer>
  </main>;
}
