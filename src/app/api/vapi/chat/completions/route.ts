import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { think, type Trace } from "@/lib/brain";
import { fixtureCityRequests, fixtureEvents, testClock, testTickets } from "@/lib/test-mode";
import { withoutUrls } from "@/lib/reply";
import { forSpeech } from "@/lib/speech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vapi's custom-llm provider uses the configured URL as an OpenAI baseURL, so it POSTs to <url>/chat/completions.
// Configure the assistant's model URL as https://<host>/api/vapi.
const caller = z.looseObject({ number: z.string().optional() }).optional();
const schema = z.looseObject({
  model: z.string().optional(), stream: z.boolean().optional(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown().optional() })),
  call: z.looseObject({ customer: caller }).optional(), customer: caller,
});

function matches(value: string | null | undefined, secret: string) {
  if (!value) return false;
  const a = Buffer.from(value), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The secret arrives as the custom-llm credential's API key (Authorization: Bearer), or as an x-vapi-secret model header.
function authorized(request: Request) {
  const secret = process.env.VAPI_LLM_SECRET;
  if (!secret) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return matches(bearer, secret) || matches(request.headers.get("x-vapi-secret"), secret);
}

const FAILED = "Sorry, something went wrong on my side. Could you say that again?";

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { messages, stream } = parsed.data;
  const callerNumber = parsed.data.call?.customer?.number ?? parsed.data.customer?.number;
  const id = `chatcmpl-${crypto.randomUUID()}`, created = Math.floor(Date.now() / 1000), model = parsed.data.model ?? "cityagent";
  // Test mode (evals only; the secret is already required): simulated clock, isolated tickets, fixed 311 data, trace.
  const test = request.headers.get("x-cityagent-test");
  const now = (test && testClock(request.headers.get("x-cityagent-now"))) || new Date();
  const testContext = test ? { tickets: await testTickets(test), cityRequests: fixtureCityRequests, events: fixtureEvents } : {};
  let trace: Trace | undefined;
  const think_ = (say: (text: string) => void) =>
    think(messages, { now, callerNumber, say, ...testContext, ...(test && { trace: (t: Trace) => { trace = t; } }) }).catch(() => FAILED);

  if (!stream) {
    const parts: string[] = [];
    parts.push(await think_(text => parts.push(text)));
    const content = forSpeech(withoutUrls(parts.join(" ")));
    return NextResponse.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], ...(trace && { cityagent: trace }) });
  }

  // Streamed: a lead-in ("Let me check that.") goes out as soon as the agent reaches for a tool, the answer follows.
  const encoder = new TextEncoder();
  const chunk = (delta: object, finish_reason: string | null) => encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const body$ = new ReadableStream({
    async start(controller) {
      let first = true;
      const say = (text: string) => { controller.enqueue(chunk(first ? { role: "assistant", content: forSpeech(withoutUrls(text)) } : { content: ` ${forSpeech(withoutUrls(text))}` }, null)); first = false; };
      say(await think_(say));
      controller.enqueue(chunk({}, "stop"));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body$, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
