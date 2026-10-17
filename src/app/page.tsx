"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type Vapi from "@vapi-ai/web";

type Status = "idle" | "connecting" | "live" | "ended";
const publicKey = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY;
const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
const configured = Boolean(publicKey && assistantId);
const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
// The SDK reports failures as nested objects; a denied microphone is the one the caller can fix.
const describe = (error: unknown) => /notallowed|permission|denied/i.test(JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) ?? String(error))
  ? "Allow microphone access to make the call." : "The call couldn't connect. Please try again.";

const PhoneIcon = () => <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>;
const MicIcon = ({ off }: { off: boolean }) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{off
  ? <><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></>
  : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></>}</svg>;

export default function Home() {
  const vapi = useRef<Vapi | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(configured ? null : "Calling isn't set up yet.");

  useEffect(() => () => { void vapi.current?.stop(); }, []);
  useEffect(() => {
    if (status !== "live") return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [status]);

  // Loaded on first call: the SDK needs the browser, so it stays out of the server render.
  async function client() {
    if (vapi.current) return vapi.current;
    const { default: VapiClient } = await import("@vapi-ai/web");
    const v = new VapiClient(publicKey!);
    v.on("call-start", () => { setSeconds(0); setStatus("live"); });
    v.on("call-end", () => { setStatus(s => (s === "idle" ? s : "ended")); setSpeaking(false); setLevel(0); setMuted(false); });
    v.on("speech-start", () => setSpeaking(true));
    v.on("speech-end", () => setSpeaking(false));
    v.on("volume-level", setLevel);
    v.on("error", e => { setError(describe(e)); setStatus("idle"); setLevel(0); });
    vapi.current = v;
    return v;
  }

  async function start() {
    setError(null); setSeconds(0); setStatus("connecting");
    try { if (!(await (await client()).start(assistantId))) throw new Error("Call not started"); }
    catch (e) { setError(describe(e)); setStatus("idle"); }
  }
  function end() { void vapi.current?.stop(); setStatus("ended"); setLevel(0); }
  function toggleMute() { if (!vapi.current) return; vapi.current.setMuted(!muted); setMuted(!muted); }

  const inCall = status === "connecting" || status === "live";
  const line = { idle: "City services line", connecting: "Calling…", live: clock(seconds), ended: `Call ended · ${clock(seconds)}` }[status];
  const hint = error ?? (status === "live" ? (muted ? "You're muted" : speaking ? "CityDesk is speaking" : "Listening…") : status === "idle" ? "Uses your microphone" : "");

  return <main className={`call ${status}`}>
    <section className="caller">
      <div className="avatar" style={{ "--level": level } as CSSProperties}><span className="ring"/><span className="face">CD</span></div>
      <h1>Bellevue CityDesk</h1>
      <p className="status" aria-live="polite">{line}</p>
      <p className={`hint ${error ? "error" : ""}`} aria-live="polite">{hint}</p>
    </section>
    <section className="controls">
      {inCall ? <>
        <div className="control"><button className="round mute" onClick={toggleMute} disabled={status !== "live"} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"}><MicIcon off={muted}/></button>{muted ? "Unmute" : "Mute"}</div>
        <div className="control"><button className="round end" onClick={end} aria-label="End call"><PhoneIcon/></button>End</div>
      </> : <div className="control"><button className="round start" onClick={start} disabled={!configured} aria-label="Start call"><PhoneIcon/></button>{status === "ended" ? "Call again" : "Start call"}</div>}
    </section>
    <footer>Demo · Not an official City of Bellevue service</footer>
  </main>;
}
