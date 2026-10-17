import { city } from "./city";
import { chat as defaultChat, models, type Chat, type ChatResult } from "./llm";

// Yes/no gates: a small model answers one closed question with one token. The token's probability is the
// confidence, so "unsure" can fall through to the deep model instead of guessing.
export type GateResult = { id: string; yes: boolean; confidence: number };

export function parseYesNo({ content, top }: Pick<ChatResult, "content" | "top">): { yes: boolean; confidence: number } {
  if (!top?.length) return { yes: /^\s*yes/i.test(content ?? ""), confidence: 1 };
  const p = (re: RegExp) => top.filter(t => re.test(t.token)).reduce((sum, t) => sum + Math.exp(t.logprob), 0);
  const yes = p(/^\s*yes/i), no = p(/^\s*no/i);
  return yes + no === 0 ? { yes: false, confidence: 0 } : { yes: yes >= no, confidence: Math.max(yes, no) / (yes + no) };
}

export async function yesNo(question: string, context: string, { chat = defaultChat, signal }: { chat?: Chat; signal?: AbortSignal } = {}) {
  const result = await chat({
    model: models.gate(), maxTokens: 1, temperature: 0, logprobs: true, signal,
    messages: [
      { role: "system", content: `You classify calls to the ${city.shortName} city services phone line. Answer with exactly one word: yes or no.` },
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ],
  });
  return parseYesNo(result);
}

// Checked on every caller turn, before (and in parallel with) the deep model.
export const TURN_GATES = [
  { id: "emergency", question: "Does the caller's most recent message describe someone's life or safety in immediate danger right now (fire, crime in progress, medical emergency, gas leak, someone injured or trapped)? Answer no if that message only thanks, says goodbye, or confirms they are calling 911, and no for water main breaks, flooding or sewer overflows where nobody is hurt or trapped (the city has a 24-hour line for those)." },
  { id: "goodbye", question: "Is the caller clearly finished and ending the call (for example \"no, that's all\" or \"thanks, bye\")? Answer no if they are answering a question, giving details, correcting something, or still need help." },
] as const;

export async function runTurnGates(transcript: string, options: { chat?: Chat; signal?: AbortSignal } = {}): Promise<GateResult[]> {
  const context = `Conversation so far (most recent last):\n${transcript}`;
  const settled = await Promise.allSettled(TURN_GATES.map(async g => ({ id: g.id, ...(await yesNo(g.question, context, options)) })));
  settled.forEach((s, i) => s.status === "rejected" && console.warn(JSON.stringify({ event: "gate-error", gate: TURN_GATES[i].id, error: String(s.reason).slice(0, 200) })));
  return settled.flatMap(s => (s.status === "fulfilled" ? [s.value] : []));
}

// A confident gate answers the turn on its own; anything less leaves it to the deep model.
export function fastPath(results: GateResult[]): string | null {
  const confident = (id: string, min: number) => results.some(r => r.id === id && r.yes && r.confidence >= min);
  if (confident("emergency", 0.8)) return `If anyone is in danger right now, please hang up and call ${city.emergencyNumber.split("").join(" ")} immediately. I can't send emergency help from this line.`;
  if (confident("goodbye", 0.85)) return `Thank you for calling ${city.shortName} CityDesk. Take care, goodbye.`;
  return null;
}
