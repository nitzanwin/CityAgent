import { cityKnowledge } from "../cities/knowledge";
import { city, departmentName, departments } from "./city";
import { yesNo } from "./gates";
import { chat as defaultChat, models, type Chat, type LlmMessage, type ToolCall, type ToolSpec } from "./llm";
import { isOfficeOpen, nextOpening, spokenWhen } from "./routing";
import { involves, STATUS_LABEL, type Ticket, type TicketSystem } from "./tickets";

// The deep model: holds the conversation, decides what to do, calls tools, and phrases the result for speech.
export type Turn = { role: "user" | "assistant"; text: string };
export type AgentContext = {
  now: Date; callerNumber?: string; tickets: TicketSystem; chat?: Chat; signal?: AbortSignal;
  proceed?: Promise<boolean>; // resolves false when a yes/no gate already answered the turn
  say?: (text: string) => void; // speak a lead-in ("Let me check.") while tools run
  log?: (event: string, data?: object) => void;
};
export class Superseded extends Error {}

const MAX_STEPS = 5;
const spokenReference = (reference: string) => reference.replace(/[^A-Za-z0-9]/g, "").toUpperCase().split("").join(" ");
const summary = (t: Ticket) => ({
  reference: t.reference, spokenReference: spokenReference(t.reference), title: t.title, department: departmentName(t.department),
  location: t.location, status: STATUS_LABEL[t.status], reportedOn: t.reportedOn,
  updates: t.updates.slice(-3).map(u => u.text), otherCallersFollowing: t.followers.length,
});
const departmentIds = departments.map(d => d.id);
const fn = (name: string, description: string, properties: Record<string, object>, required: string[] = Object.keys(properties)): ToolSpec =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
const text = (description: string) => ({ type: "string", description });

export const TOOLS: ToolSpec[] = [
  fn("find_known_issue", "Check whether a reported problem is already known (an open ticket for the same problem at the same place). Call before opening any new ticket.",
    { issue: text("What is wrong, in a short sentence"), location: text("Where it is, as precisely as the caller said") }),
  fn("lookup_ticket", "Look up an existing ticket: by reference if the caller has one, otherwise by the caller's phone number.",
    { reference: text("The ticket reference, digits only (e.g. 1042), or an empty string to search by caller ID") }),
  fn("create_ticket", "Open a new ticket. Only after the caller confirmed the read-back.", {
    department: { type: "string", enum: departmentIds }, title: text("Short title, e.g. 'Pothole in the right lane'"),
    issue: text("What is wrong, in the caller's words"), location: text("Exact location"), name: text("Caller's name"), phone: text("Callback number"),
  }),
  fn("follow_ticket", "Add the caller to an existing ticket so they're contacted on updates (instead of opening a duplicate).",
    { reference: text("The existing ticket's reference"), name: text("Caller's name"), phone: text("Callback number") }),
  fn("transfer_call", "Transfer the call to a department's line. Only while the department is open.", { department: { type: "string", enum: departmentIds } }),
];

async function runTool(call: ToolCall, ctx: AgentContext): Promise<object> {
  const args = JSON.parse(call.function.arguments || "{}");
  const { tickets, now, callerNumber } = ctx;
  switch (call.function.name) {
    case "find_known_issue": {
      // One yes/no per open ticket, in parallel: "is this the same problem?"
      const open = (await tickets.list({ open: true })).slice(0, 12);
      const checks = await Promise.all(open.map(async t => ({ t, ...(await yesNo("Is the new report about the same problem at the same place as the existing ticket?",
        `New report: ${args.issue} — at ${args.location}\nExisting ticket: ${t.title}. ${t.issue} — at ${t.location}`, { chat: ctx.chat, signal: ctx.signal })) })));
      const match = checks.filter(c => c.yes && c.confidence >= 0.7).sort((a, b) => b.confidence - a.confidence)[0];
      return match ? { known: true, ticket: summary(match.t) } : { known: false };
    }
    case "lookup_ticket": {
      if (/\d/.test(args.reference ?? "")) {
        const t = await tickets.get(args.reference);
        return t ? { found: true, ticket: summary(t) } : { found: false, reason: "No ticket has that reference." };
      }
      if (!callerNumber) return { found: false, reason: "No reference given, and this call has no caller ID. Ask the caller for their reference." };
      const mine = (await tickets.list()).filter(t => involves(t, callerNumber)).slice(-3);
      return mine.length ? { found: true, tickets: mine.map(summary) } : { found: false, reason: "No tickets are linked to this phone number." };
    }
    case "create_ticket": {
      const t = await tickets.create({ department: args.department, title: args.title, issue: args.issue, location: args.location, reporter: { name: args.name, phone: args.phone } });
      const reopens = nextOpening(now);
      return {
        created: true, ticket: summary(t),
        followUp: isOfficeOpen(now) ? `${departmentName(t.department)} will review it today.` : `${departmentName(t.department)} will review it when they reopen${reopens ? ` ${spokenWhen(reopens, now)}` : ""}.`,
        contact: `They will contact ${args.name || "the caller"} at ${args.phone || "the number given"} when there's an update or it's fixed.`,
      };
    }
    case "follow_ticket": {
      const t = await tickets.follow(args.reference, { name: args.name, phone: args.phone });
      return t ? { added: true, ticket: summary(t) } : { added: false, reason: "No ticket has that reference." };
    }
    case "transfer_call": {
      const department = departments.find(d => d.id === args.department);
      if (!isOfficeOpen(now)) return { transferred: false, reason: "The department is closed right now." };
      return { transferred: false, simulated: true, department: department?.name, note: "Transfers are simulated in this demo: tell the caller you'd connect them now, and that no call is actually placed." };
    }
    default:
      return { error: `Unknown tool ${call.function.name}` };
  }
}

export function systemPrompt({ now, callerNumber }: Pick<AgentContext, "now" | "callerNumber">): string {
  const open = isOfficeOpen(now), reopens = nextOpening(now);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: city.timezone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  const hours = open ? "Departments are open now." : `Departments are closed now; they reopen ${reopens ? spokenWhen(reopens, now) : "on the next working day"}.`;
  return `You are CityDesk, the phone receptionist for the City of ${city.name}. This is a demo, not an official city service. You are on a live phone call: everything you write is spoken aloud.

How to speak:
- One to three short sentences per turn, in plain spoken English. No lists, markdown, emojis or web addresses; say "the city's website" instead.
- Ask one question at a time.
- When you call a tool, also write a very short spoken lead-in, such as "Let me check that."
- Never invent ticket references, statuses, dates, phone numbers, laws or events. Use only tool results and the city knowledge below.

When the caller reports a problem:
1. Tell them which department handles it and what that department covers, for example "That's Public Works; they look after roads, potholes and sidewalks."
2. As soon as you know what and where, call find_known_issue. If it's already known, say so, give its status and latest update, and offer to add them so they're contacted when it's fixed (follow_ticket). Don't open a duplicate.
3. If departments are open, offer to transfer the call. If they're closed, say so and when they reopen, and explain that you can open a ticket and the department will contact them when they're back. Mention that for something urgent where nobody is in danger they can call the city's urgent line at ${city.urgentLine.phone}, and for danger, 911.
4. To open a ticket, collect one at a time: what's wrong, exactly where, their name, and a callback number.
5. Read the details back in one sentence and ask them to confirm. Only call create_ticket after a clear yes.
6. After creating it, give the reference using spokenReference, say which department will follow up and when, and that they'll be contacted at their number when there's an update or it's fixed.

When the caller asks about an existing ticket or report, call lookup_ticket (with their reference if they have one). Tell them its status, the latest update and what happens next.

When the caller asks a general question, answer from the city knowledge if it covers it; otherwise point them to the city's website.

Right now: ${clock} in ${city.shortName}. ${hours}
Caller ID: ${callerNumber ? `${callerNumber}. If the caller agrees, use it as their callback number.` : "none (web call); ask for a callback number."}

Departments:
${departments.map(d => `- ${d.name} (${d.id}): ${d.covers}.`).join("\n")}

City knowledge:
${cityKnowledge()}`;
}

export async function runAgent(turns: Turn[], ctx: AgentContext): Promise<string> {
  const chat = ctx.chat ?? defaultChat;
  const messages: LlmMessage[] = [{ role: "system", content: systemPrompt(ctx) }, ...turns.map(t => ({ role: t.role, content: t.text }))];
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chat({ model: models.agent(), messages, tools: TOOLS, temperature: 0.3, signal: ctx.signal });
    if (!reply.toolCalls.length) return reply.content?.trim() || "Sorry, could you say that again?";
    // Tools have side effects (tickets), so they wait until the gates have had their say.
    if (ctx.proceed && !(await ctx.proceed)) throw new Superseded();
    if (reply.content?.trim()) ctx.say?.(reply.content.trim());
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const started = Date.now();
      const result = await runTool(call, ctx).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
      ctx.log?.("tool", { name: call.function.name, ms: Date.now() - started, ok: !("error" in result) });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "Sorry, I'm having trouble with that one. Could you say it a different way?";
}
