import { NextResponse } from "next/server";
import { z } from "zod";
import { decide } from "@/lib/routing";
import { createTicket } from "@/lib/tickets";
const schema = z.object({ message: z.string().trim().min(3).max(1500), simulatedTime: z.iso.datetime({ offset: true }).optional(), createTicket: z.boolean().default(false) });
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  const { message, simulatedTime } = parsed.data;
  const decision = decide(message, simulatedTime ? new Date(simulatedTime) : new Date());
  if (decision.action !== "ticket" || !parsed.data.createTicket) return NextResponse.json({ decision });
  try {
    const ticket = await createTicket({ department: decision.department, title: decision.title, description: message });
    return NextResponse.json({ decision, ticket });
  } catch {
    return NextResponse.json({ decision, error: "Ticket creation failed. Please retry; no ticket was confirmed." }, { status: 502 });
  }
}
