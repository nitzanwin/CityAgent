import { city, departments, type DepartmentId } from "./city";
import { decide, selectDepartment } from "./routing";
import { createTicket, type TicketInput, type TicketResult } from "./tickets";

export type ChatMessage = { role: string; content?: unknown };
type CreateTicket = (input: TicketInput) => Promise<TicketResult>;

const TICKET_OFFER = "Would you like me to open a service ticket";
const YES = /\b(yes|yeah|yep|yup|sure|please|ok|okay|go ahead|do it|absolutely)\b/i;
const NO = /\b(no|nope|nah|don'?t|not now)\b/i;
// Spoken versions of the answers: a caller can't click a link, so name the place instead.
const SPOKEN_SOURCE: Record<string, string> = {
  [city.sources[2].url]: "For current events, the best place to look is the events calendar on the City of Bellevue's website. I can't read out live listings yet.",
  [city.sources[1].url]: "That's covered by the Bellevue Municipal Code, which you can find on the city's website. I can't confirm a specific rule over the phone yet.",
  [city.sources[0].url]: "You'll find that on the City of Bellevue's website. I can also help you report an issue to the right department.",
};

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(part => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join(" ");
  return "";
}

// Safety net: whatever the branch, never read a link aloud.
export const withoutUrls = (text: string) => text.replace(/\b(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:gov|com|org|net|codes)\b\S*/gi, "the city's website");
const departmentName = (id: DepartmentId) => departments.find(d => d.id === id)?.name ?? "General Services";
const spokenReference = (id: string) => id.replace(/[^a-z0-9]/gi, "").slice(-6).toUpperCase().split("").join(" ");

export async function replyFor(messages: ChatMessage[], now: Date, ticket: CreateTicket = createTicket): Promise<string> {
  return withoutUrls(await compose(messages, now, ticket));
}

async function compose(messages: ChatMessage[], now: Date, ticket: CreateTicket): Promise<string> {
  const turns = messages.filter(m => m.role === "user" || m.role === "assistant").map(m => ({ role: m.role, text: textOf(m.content).trim() }));
  const last = turns.findLastIndex(t => t.role === "user");
  const said = last >= 0 ? turns[last].text : "";
  if (!said) return "Sorry, I didn't catch that. How can I help you today?";

  const earlier = turns.slice(0, last);
  if (earlier.findLast(t => t.role === "assistant")?.text.includes(TICKET_OFFER)) {
    if (NO.test(said)) return "No problem, I won't open a ticket. Is there anything else I can help you with?";
    if (YES.test(said)) {
      const issue = earlier.findLast(t => t.role === "user")?.text || said;
      const department = selectDepartment(issue);
      try {
        const result = await ticket({ department: department.id, title: issue.slice(0, 80), description: issue });
        return `Done. I've opened a ticket for ${department.name}. Your reference ends in ${spokenReference(result.id)}. Is there anything else I can help you with?`;
      } catch {
        return "Sorry, I couldn't open the ticket just now, so nothing was filed. Please try again a little later.";
      }
    }
  }

  const decision = decide(said, now);
  if (decision.action === "answer") return SPOKEN_SOURCE[decision.source ?? ""] ?? decision.response;
  if (decision.action === "transfer") return `I'd transfer you to ${departmentName(decision.department)} now. This is a demo, so no call is placed. Is there anything else I can help with?`;
  return `${departmentName(decision.department)} is closed right now. ${TICKET_OFFER} so they can follow up? Please say yes or no.`;
}
