import { runAgent, Superseded, type Turn } from "./agent";
import { fastPath, runTurnGates, type GateResult } from "./gates";
import { llmConfigured, type Chat } from "./llm";
import { replyFor, textOf, type ChatMessage } from "./reply";
import { ticketSystem, type TicketSystem } from "./tickets";

// One caller turn. The yes/no gates and the deep model start together: a confident gate answers at gate speed
// and the deep model is cancelled; otherwise the deep model's answer is used and the gates cost no extra time.
// With no model configured, or if the model fails, the rule-based reply keeps the call going.
export type ThinkContext = { now: Date; callerNumber?: string; say?: (text: string) => void; chat?: Chat; tickets?: TicketSystem };

export function toTurns(messages: ChatMessage[]): Turn[] {
  return messages.flatMap(m => (m.role === "user" || m.role === "assistant") && textOf(m.content).trim() ? [{ role: m.role, text: textOf(m.content).trim() }] : []);
}

export async function think(messages: ChatMessage[], ctx: ThinkContext): Promise<string> {
  const started = Date.now(), turns = toTurns(messages), tools: object[] = [];
  const log = (path: string, extra: object = {}) => console.info(JSON.stringify({ event: "turn", path, ms: Date.now() - started, tools, ...extra }));
  if (!turns.length || turns[turns.length - 1].role !== "user" || !llmConfigured()) {
    const reply = await replyFor(messages, ctx.now);
    log(llmConfigured() ? "empty" : "rules");
    return reply;
  }

  const transcript = turns.slice(-8).map(t => `${t.role === "user" ? "Caller" : "CityDesk"}: ${t.text}`).join("\n");
  const gates: Promise<GateResult[]> = runTurnGates(transcript, { chat: ctx.chat }).catch(() => []);
  const answered = gates.then(fastPath);
  const abort = new AbortController();
  const deep = runAgent(turns, {
    now: ctx.now, callerNumber: ctx.callerNumber, tickets: ctx.tickets ?? ticketSystem(), chat: ctx.chat, signal: abort.signal, say: ctx.say,
    proceed: answered.then(fast => !fast), log: (_, data) => data && tools.push(data),
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
    log("rules-fallback", { error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    return replyFor(messages, ctx.now);
  }
}
