import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { replyFor } from "@/lib/reply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Vapi's custom-llm provider uses the configured URL as an OpenAI baseURL, so it POSTs to <url>/chat/completions.
// Configure the assistant's model URL as https://<host>/api/vapi.
const schema = z.looseObject({ model: z.string().optional(), stream: z.boolean().optional(), messages: z.array(z.looseObject({ role: z.string(), content: z.unknown().optional() })) });

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

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const content = await replyFor(parsed.data.messages, new Date());
  const id = `chatcmpl-${crypto.randomUUID()}`, created = Math.floor(Date.now() / 1000), model = parsed.data.model ?? "cityagent-rules";
  if (!parsed.data.stream) return NextResponse.json({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

  const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const stream = chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
