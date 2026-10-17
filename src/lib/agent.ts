import { cityKnowledge } from "../cities/knowledge";
import { cityPages, searchChunks, type PageChunk } from "../cities/pages";
import { city, departmentName, departments } from "./city";
import type { CityEventSource } from "./city-events";
import type { CityRequest, CityRequestSource } from "./city-requests";
import { yesNo } from "./gates";
import { chat as defaultChat, models, type Chat, type LlmMessage, type ToolCall, type ToolSpec } from "./llm";
import { isOfficeOpen, nextOpening, spokenWhen } from "./routing";
import { involves, samePhone, STATUS_LABEL, type Ticket, type TicketSystem } from "./tickets";

// The deep model: holds the conversation, decides what to do, calls tools, and phrases the result for speech.
export type Turn = { role: "user" | "assistant"; text: string };
export type AgentContext = {
  now: Date; callerNumber?: string; tickets: TicketSystem; chat?: Chat; signal?: AbortSignal;
  cityRequests?: CityRequestSource | null; // the city's own 311 system, read-only
  pages?: PageChunk[]; // the city's website snapshot (defaults to src/cities/<id>/pages)
  events?: CityEventSource | null; // the city's live events calendar
  proceed?: Promise<boolean>; // resolves false when a yes/no gate already answered the turn
  say?: (text: string) => void; // speak a lead-in ("Let me check.") while tools run
  log?: (event: string, data?: object) => void;
};
export class Superseded extends Error {}

const MAX_STEPS = 5;
const LEAD_IN_ONLY = /^(let me|one moment|just a moment|give me a (second|moment)|i'll (check|look|add|open))[^.?!]{0,40}[.!]?$/i;
// Promises the caller hears ("let me check", "I'll connect you") and the tools that must back them in the same turn.
const PROMISES: [RegExp, string[]][] = [
  [/\b(i'?ll (transfer|connect) you|i'?m (transferring|connecting) you|(transferring|connecting) you( now)?|please hold)\b/i, ["transfer_call"]],
  [/\b(let me (check|look|see|find)|i'?m checking)\b/i, ["find_known_issue", "lookup_ticket", "search_city_info", "upcoming_events"]],
  [/\b(i'?ll add you|i'?m adding you)\b/i, ["follow_ticket"]],
];
const unkept = (said: string, called: Set<string>) => PROMISES.find(([promise, tools]) => promise.test(said) && !tools.some(t => called.has(t)));
const spokenReference = (reference: string) => reference.replace(/[^A-Za-z0-9]/g, "").toUpperCase().split("").join(" ");
const summary = (t: Ticket) => ({
  reference: t.reference, spokenReference: spokenReference(t.reference), title: t.title, department: departmentName(t.department),
  location: t.location, status: STATUS_LABEL[t.status], reportedOn: t.reportedOn,
  updates: t.updates.slice(-3).map(u => u.text), otherCallersFollowing: t.followers.length,
});
const citySummary = (r: CityRequest) => ({ system: r.system, reference: r.reference, title: r.title, department: departmentName(r.department), location: r.location, status: STATUS_LABEL[r.status], reportedOn: r.reportedOn });
const TICKET_NOTE = "Tell the caller the reference (spokenReference), the status, the latest update and what happens next.";
const CITY_NOTE = "Already in the city's own 311 system. CityDesk can't add the caller to it: tell them it's already been reported to the city, when, and its status. Offer a CityDesk ticket only if they have something new to add.";
const departmentIds = departments.map(d => d.id);
// Requirement 5: whether to route or open a ticket is decided by business hours, never by the model.
export function nextStep(now: Date): { step: "transfer" | "ticket"; why: string } {
  if (isOfficeOpen(now)) return { step: "transfer", why: "Departments are open now, so the rule is to transfer the caller." };
  const reopens = nextOpening(now);
  return { step: "ticket", why: `Departments are closed now${reopens ? ` until ${spokenWhen(reopens, now)}` : ""}, so the rule is to open a ticket.` };
}
// "NE 8th St at 112th Ave NE" → ["8", "112"]: the words that identify a place, without street-type filler.
const FILLER = new Set(["at", "and", "the", "of", "on", "near", "by", "in", "st", "street", "ave", "avenue", "rd", "road", "way", "blvd", "boulevard", "dr", "drive", "pl", "place", "ct", "court", "ln", "pkwy", "parkway", "hwy", "highway", "ne", "nw", "se", "sw", "n", "s", "e", "w", "corner", "intersection", "between", "block", "right", "middle", "lane"]);
export const placeWords = (location: string) => [...new Set(location.toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, "$1").split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w)))];
const fn = (name: string, description: string, properties: Record<string, object>, required: string[] = Object.keys(properties)): ToolSpec =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
const text = (description: string) => ({ type: "string", description });

export const TOOLS: ToolSpec[] = [
  fn("find_known_issue", "Check whether a reported problem is already known: an open CityDesk ticket, or a request already in the city's own 311 system, for the same problem at the same place. Call before opening any new ticket.",
    { department: { type: "string", enum: departmentIds }, issue: text("What is wrong, in a short sentence"), location: text("Where it is, as precisely as the caller said") }),
  fn("lookup_ticket", "Look up an existing ticket: by reference if the caller has one, otherwise by the caller's phone number.",
    {
      reference: text("Digits only: a CityDesk reference (e.g. 1042) or a city 311 request number (e.g. 18808602); empty to search by phone number"),
      phone: text("A phone number the caller gave to search by; empty to use caller ID"),
    }),
  fn("create_ticket", "Open a new ticket. Only after the caller confirmed the read-back.", {
    department: { type: "string", enum: departmentIds }, title: text("Short title, e.g. 'Pothole in the right lane'"),
    issue: text("What is wrong, in the caller's words"), location: text("Exact location"), name: text("Caller's name"), phone: text("Callback number"),
  }),
  fn("follow_ticket", "Add the caller to an existing ticket so they're contacted on updates (instead of opening a duplicate).",
    { reference: text("The existing ticket's reference"), name: text("Caller's name"), phone: text("Callback number") }),
  fn("transfer_call", "Transfer the call to a department's line, only while departments are open. Saying you're transferring does nothing: call this tool.", { department: { type: "string", enum: departmentIds } }),
  fn("upcoming_events", "The city's events calendar, live: meetings, celebrations, classes, City Hall closures. Use for any question about events or what's happening.", {
    days: { type: "integer", description: "How many days ahead to look, 1 to 60 (14 if the caller didn't say)" },
    query: text("Optional word to filter by, e.g. 'council' or 'park'; empty for everything"),
  }),
  fn("search_city_info", "Search a saved snapshot of the city's website for facts the city knowledge doesn't cover: phone numbers, hours, programs, how to do something, upcoming events. Each result says the date the page was saved.",
    { query: text("What to look up, in a few words, e.g. 'garbage pickup missed' or 'events this weekend'") }),
];

async function runTool(call: ToolCall, ctx: AgentContext): Promise<object> {
  const args = JSON.parse(call.function.arguments || "{}");
  const { tickets, now, callerNumber } = ctx;
  switch (call.function.name) {
    case "find_known_issue": {
      // Rules first: open CityDesk tickets and the city's own open requests whose location shares a word (street,
      // number, place), closest first. Then one yes/no per remaining candidate, in parallel: "is this the same problem?"
      const where = placeWords(args.location);
      const [ours, theirs] = await Promise.all([
        tickets.list({ open: true }),
        ctx.cityRequests?.open().catch(e => { ctx.log?.("tool", { name: "city-requests", ok: false, error: String(e).slice(0, 120) }); return []; }) ?? [],
      ]);
      const all = [
        ...ours.map(t => ({ title: t.title, issue: t.issue, location: t.location, department: t.department, result: () => ({ known: true, source: "ticket", ticket: summary(t), note: TICKET_NOTE }) })),
        ...theirs.map(r => ({ title: r.title, issue: r.title, location: r.location, department: r.department, result: () => ({ known: true, source: "city", request: citySummary(r), note: CITY_NOTE }) })),
      ];
      const sameDepartment = (c: { department: string }) => Number(c.department === args.department);
      const candidates = all.map(c => ({ c, overlap: placeWords(c.location).filter(w => where.includes(w)).length })).filter(x => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap || sameDepartment(b.c) - sameDepartment(a.c)).slice(0, 3).map(x => x.c);
      const checks = await Promise.all(candidates.map(async c => ({ c, ...(await yesNo("Is the new report about the same problem at the same place as the existing report?",
        `New report: ${args.issue} — at ${args.location}\nExisting report: ${c.title}. ${c.issue} — at ${c.location}`, { chat: ctx.chat, signal: ctx.signal })) })));
      const match = checks.filter(c => c.yes && c.confidence >= 0.7).sort((a, b) => b.confidence - a.confidence)[0];
      return match ? match.c.result() : { known: false, nextStep: nextStep(now) };
    }
    case "lookup_ticket": {
      const digits = String(args.reference ?? "").replace(/\D/g, "");
      if (digits.length >= 6 && ctx.cityRequests) {
        const r = await ctx.cityRequests.get(digits);
        return r ? { found: true, source: "city", request: citySummary(r), note: CITY_NOTE } : { found: false, reason: "The city's 311 system has no request with that number." };
      }
      if (digits) {
        const t = await tickets.get(args.reference);
        return t ? { found: true, ticket: summary(t), note: TICKET_NOTE } : { found: false, reason: "No ticket has that reference." };
      }
      const phone = /\d{7}/.test(String(args.phone ?? "").replace(/\D/g, "")) ? String(args.phone) : callerNumber;
      if (!phone) return { found: false, reason: "No reference given, and this call has no caller ID. Ask the caller for their reference or the phone number they gave when reporting." };
      const mine = (await tickets.list()).filter(t => involves(t, phone)).slice(-3);
      const linked = (t: Ticket) => ({ ...summary(t), caller: `This number ${samePhone(t.reporter.phone, phone) ? "reported this ticket" : "follows this ticket"}, so they'll already be contacted on updates.` });
      return mine.length ? { found: true, tickets: mine.map(linked), note: TICKET_NOTE } : { found: false, reason: "No CityDesk tickets are linked to this phone number. The city's own 311 requests can only be looked up by their request number." };
    }
    case "create_ticket": {
      const rule = nextStep(now);
      if (rule.step === "transfer") return { created: false, reason: `${rule.why} Offer to transfer them (transfer_call) instead of opening a ticket.` };
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
      const department = departments.find(d => d.id === args.department) ?? departments.find(d => d.id === "general")!;
      const rule = nextStep(now);
      if (rule.step === "ticket") return { transferred: false, reason: `${rule.why} Offer to open a ticket instead.` };
      return { transferred: true, simulated: true, department: department.name, phone: department.phone, note: `The transfer is simulated in this demo: tell the caller you're connecting them to ${department.name} at ${department.phone}.` };
    }
    case "upcoming_events": {
      const days = Math.min(Math.max(Number(args.days) || 14, 1), 60), query = String(args.query ?? "").toLowerCase().trim();
      const spokenDate = (d: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${d}T12:00:00Z`));
      try {
        const events = (await (ctx.events ?? null)?.upcoming(now, days)) ?? null;
        if (events) {
          const matching = events.filter(e => !query || `${e.title} ${e.place} ${e.details}`.toLowerCase().includes(query));
          return { source: "the city's calendar, live", days, events: matching.slice(0, 10).map(e => ({ ...e, date: spokenDate(e.date) })), more: Math.max(matching.length - 10, 0) };
        }
      } catch (e) {
        ctx.log?.("tool", { name: "city-events", ok: false, error: String(e).slice(0, 120) });
      }
      // Calendar unreachable: fall back to the saved snapshot, which says how old it is.
      const hits = searchChunks(`events ${query}`, ctx.pages ?? cityPages());
      return { source: "saved snapshot of the city's calendar", results: hits.map(h => ({ text: h.text, asOf: h.fetched })) };
    }
    case "search_city_info": {
      const hits = searchChunks(args.query ?? "", ctx.pages ?? cityPages());
      return hits.length
        ? { found: true, results: hits.map(h => ({ page: h.title, section: h.heading, text: h.text, asOf: h.fetched })) }
        : { found: false, reason: "Nothing in the city's website snapshot matches. Point the caller to the city's website." };
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
- At most two short sentences per turn (the read-back may be longer), in plain spoken English. No lists, markdown, emojis or web addresses; say "the city's website" instead.
- Ask one question at a time.
- When you call a tool, also write a very short spoken lead-in, such as "Let me check that." Never say you're checking something unless you call the tool in the same turn.
- Never say you have added, opened or changed anything unless a tool result in this conversation confirms it. When you have what a tool needs, call it in that same turn.
- Whenever you tell the caller about a ticket, say its reference (spokenReference).
- Tool results are not kept between turns; only what you said aloud is. For any detail you haven't already said (a reference, a time, a place, a phone number), call the tool again instead of recalling or guessing.
- Never invent ticket references, statuses, dates, phone numbers, laws or events. Use only tool results and the city knowledge below.

Be genuinely helpful, like a good receptionist:
- Answer the question the caller asked first (look it up if you need to), then offer to help further.
- Don't ask permission to share what you know: if you have the number, place, hours or rule, say it in the same turn instead of asking "would you like the number?"
- For any question about rules, laws, permits or the city code, call search_city_info before answering; never answer a rule from memory.
- Give the concrete answer: the phone number, address, hours or next step. Never answer with only "check the city's website"; if you mention it, also say who to call and their number.
- If what the caller wants is unclear, ask one short question to find out before answering (for example, a "residence card" could mean a green card, a state ID, or proof of address).
- If it isn't a city service, say so and who handles it (see "Not handled by the city" in the city knowledge).
- Only offer information you actually have in the city knowledge or a tool result; don't offer a number or detail and then not have it.
- If you can't do something yourself, offer the best next step: the right number, an in-person option that's open, or a ticket so the right department calls them back. If the caller asks whether you can help, say what you can do, not what you can't.

When the caller reports a problem:
1. In your first reply about a problem, always tell them which department handles it and what that department covers, for example "That's Transportation; they look after potholes, streetlights and traffic signals."
2. As soon as you know what and where, call find_known_issue in that same turn, before asking anything else. If it's a CityDesk ticket, say so, give its status and latest update, and offer to add them so they're contacted when it's fixed (follow_ticket). If it's already in the city's own 311 system, say it's already been reported to the city, when, and its status; you can't add them to it. Don't open a duplicate.
3. Whether to transfer or open a ticket is a business-hours rule, not your choice (find_known_issue returns it as nextStep, and the tools enforce it). Open: offer to transfer the call (transfer_call) and don't open a ticket. Closed: say so and when they reopen, and explain that you can open a ticket and the department will contact them when they're back. Mention that for something urgent where nobody is in danger they can call the city's 24-hour line at ${city.urgentLine.phone} (${city.urgentLine.covers}), and for danger, 911.
4. To open a ticket, collect one at a time whatever you don't have yet: what's wrong, exactly where, their name, and a callback number.
5. Read back all four details in one sentence and ask them to confirm. Only call create_ticket after a clear yes.
6. After creating it, give the reference using spokenReference, say which department will follow up and when, and that they'll be contacted at their number when there's an update or it's fixed.

When the caller asks about an existing ticket or report, call lookup_ticket right away: with their reference if they gave one, otherwise with an empty reference to search by caller ID (when the call has one). Ask for a reference or number only if that finds nothing. Tell them its status, the latest update and what happens next.

For events, meetings or "what's happening", call upcoming_events (it's live) and give dates, times and places.

When the caller asks a general question, answer from the city knowledge below if it covers it; otherwise call search_city_info before saying you don't know, and only then point them to the city's website. search_city_info results are a snapshot of the city's website from their asOf date: for events, schedules and anything time-sensitive, say it's as of that date and may have changed.

Right now: ${clock} in ${city.shortName}. ${hours}
Caller ID: ${callerNumber ? `${callerNumber}. If the caller agrees, use it as their callback number.` : "none (web call); ask for a callback number."}

Departments:
${departments.map(d => `- ${d.name} (${d.id}): ${d.covers}. Phone ${d.phone}, ${d.hours}.`).join("\n")}
Police non-emergency: ${city.policeNonEmergency}. Emergencies: 911.

City knowledge:
${cityKnowledge()}`;
}

// If the model fails after a ticket was already created or followed, the caller must still hear that it happened.
function confirmation(name: string, result: Record<string, unknown>): string | null {
  const ticket = result.ticket as { spokenReference: string; department: string } | undefined;
  if (name === "create_ticket" && result.created && ticket) return `I've opened your ticket. Your reference is ${ticket.spokenReference}. ${result.followUp} ${result.contact}`;
  if (name === "follow_ticket" && result.added && ticket) return `I've added you to ticket ${ticket.spokenReference}, so ${ticket.department} will contact you when there's an update.`;
  return null;
}

export async function runAgent(turns: Turn[], ctx: AgentContext): Promise<string> {
  const chat = ctx.chat ?? defaultChat;
  const messages: LlmMessage[] = [{ role: "system", content: systemPrompt(ctx) }, ...turns.map(t => ({ role: t.role, content: t.text }))];
  let done: string | null = null;
  const called = new Set<string>();
  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await chat({ model: models.agent(), messages, tools: TOOLS, temperature: 0.3, signal: ctx.signal }).catch(e => {
      if (done && !ctx.signal?.aborted) return { content: done, toolCalls: [] };
      throw e;
    });
    if (!reply.toolCalls.length) {
      const said = reply.content?.trim() ?? "";
      // A promise with no tool behind it ("let me check", "I'll connect you") would be a lie to the caller: make the
      // model act. A bare lead-in is still spoken; a longer reply is replaced by what the model does next.
      if (unkept(said, called) && step < MAX_STEPS - 1) {
        if (LEAD_IN_ONLY.test(said)) ctx.say?.(said);
        ctx.log?.("tool", { name: "promise-without-tool", ms: 0, ok: false });
        messages.push({ role: "assistant", content: said }, { role: "system", content: "You promised an action but called no tool. Call the tool now (find_known_issue to check, transfer_call to transfer, follow_ticket to add, create_ticket to open, lookup_ticket to look up), or if something is missing, ask the caller for it without promising the action." });
        continue;
      }
      return said || "Sorry, could you say that again?";
    }
    // Tools have side effects (tickets), so they wait until the gates have had their say.
    if (ctx.proceed && !(await ctx.proceed)) throw new Superseded();
    // Something is always said before a tool runs, so the caller never sits in silence.
    if (reply.content?.trim()) ctx.say?.(reply.content.trim());
    else if (step === 0) ctx.say?.("One moment.");
    messages.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      called.add(call.function.name);
      const started = Date.now();
      const result = await runTool(call, ctx).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
      ctx.log?.("tool", { name: call.function.name, ms: Date.now() - started, ok: !("error" in result), args: JSON.parse(call.function.arguments || "{}"), result });
      done = confirmation(call.function.name, result as Record<string, unknown>) ?? done;
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "Sorry, I'm having trouble with that one. Could you say it a different way?";
}
