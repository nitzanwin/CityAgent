import { runAgent, Superseded, type Turn } from "./agent";
import { cityEvents as defaultCityEvents, type CityEventSource } from "./city-events";
import { cityRequests as defaultCityRequests, type CityRequestSource } from "./city-requests";
import { fastPath, runTurnGates, type GateResult } from "./gates";
import { llmConfigured, type Chat } from "./llm";
import { replyFor, textOf, type ChatMessage } from "./reply";
import { ticketSystem, type TicketSystem } from "./tickets";

// One caller turn. The yes/no gates and the deep model start together: a confident gate answers at gate speed
// and the deep model is cancelled; otherwise the deep model's answer is used and the gates cost no extra time.
// With no model configured, or if the model fails, the rule-based reply keeps the call going.
export type ToolTrace = { name: string; ms: number; ok: boolean; args?: object; result?: object };
export type Trace = { path: string; ms: number; gates?: GateResult[]; tools: ToolTrace[]; error?: string };
export type ThinkContext = {
  now: Date; callerNumber?: string; say?: (text: string) => void; chat?: Chat; tickets?: TicketSystem; cityRequests?: CityRequestSource | null; events?: CityEventSource | null;
  trace?: (trace: Trace) => void; // test mode: the turn's path, gates and tool calls with arguments and results
};

export function toTurns(messages: ChatMessage[]): Turn[] {
  return messages.flatMap(m => (m.role === "user" || m.role === "assistant") && textOf(m.content).trim() ? [{ role: m.role, text: textOf(m.content).trim() }] : []);
}

export async function think(messages: ChatMessage[], ctx: ThinkContext): Promise<string> {
  const started = Date.now(), turns = toTurns(messages), tools: ToolTrace[] = [];
  // Logs keep tool names and timings only (no caller details); the full trace goes to ctx.trace in test mode.
  const log = (path: string, extra: { gates?: GateResult[]; error?: string } = {}) => {
    const ms = Date.now() - started;
    console.info(JSON.stringify({ event: "turn", path, ms, tools: tools.map(({ name, ms, ok }) => ({ name, ms, ok })), ...extra }));
    ctx.trace?.({ path, ms, tools, ...extra });
  };
  if (!turns.length || turns[turns.length - 1].role !== "user" || !llmConfigured()) {
    const reply = await replyFor(messages, ctx.now);
    log(llmConfigured() ? "empty" : "rules");
    return reply;
  }

  const tickets = ctx.tickets ?? ticketSystem();
  const cityRequests = ctx.cityRequests === undefined ? defaultCityRequests() : ctx.cityRequests;
  void tickets.list().catch(() => {}); // warm both caches while the models think
  void cityRequests?.open().catch(() => {});
  const transcript = turns.slice(-8).map(t => `${t.role === "user" ? "Caller" : "CityDesk"}: ${t.text}`).join("\n");
  const gates: Promise<GateResult[]> = runTurnGates(transcript, { chat: ctx.chat }).catch(() => []);
  const answered = gates.then(fastPath);
  const abort = new AbortController();
  const deep = runAgent(turns, {
    now: ctx.now, callerNumber: ctx.callerNumber, tickets, cityRequests, events: ctx.events === undefined ? defaultCityEvents() : ctx.events, chat: ctx.chat, signal: abort.signal, say: ctx.say,
    proceed: answered.then(fast => !fast), log: (_, data) => data && tools.push(data as ToolTrace),
  });

  const fast = await answered;
  if (fast) {
    abort.abort();
    deep.catch(() => {});
    log("gate", { gates: await gates });
    return fast;
  }
  try {
    const reply = await deep;
    log("agent", { gates: await gates });
    return reply;
  } catch (e) {
    if (e instanceof Superseded) throw e;
    // The rules only understand a single sentence, so mid-conversation they'd ignore everything said so far.
    const firstTurn = turns.filter(t => t.role === "user").length === 1;
    log(firstTurn ? "rules-fallback" : "retry", { error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    return firstTurn ? replyFor(messages, ctx.now) : "Sorry, I missed that. Could you say it again?";
  }
}
