import { cityPack } from "../../cities";
import type { DepartmentId } from "../city";
import { MemoryTickets } from "./memory";
import { TrelloTickets } from "./trello";
import type { TicketSystem } from "./types";

export * from "./types";
export { MemoryTickets } from "./memory";
export { TrelloTickets } from "./trello";

// Which ticketing system is active is configuration: Trello when its keys are set, otherwise the in-memory store.
let system: TicketSystem | undefined;
export function ticketSystem(): TicketSystem {
  if (system) return system;
  const { TRELLO_API_KEY: key, TRELLO_TOKEN: token, TRELLO_BOARD_ID: board } = process.env;
  system = key && token && board ? new TrelloTickets(key, token, board) : new MemoryTickets(cityPack().knownIssues);
  return system;
}

// Kept for the rule-based fallback (src/lib/reply.ts) and the starter's /api/agent route.
export type TicketInput = { department: DepartmentId; title: string; description: string };
export type TicketResult = { id: string; url?: string; provider: string };
export async function createTicket(input: TicketInput): Promise<TicketResult> {
  const ticket = await ticketSystem().create({ department: input.department, title: input.title, issue: input.description, location: "", reporter: {} });
  return { id: ticket.reference, url: ticket.url, provider: ticketSystem().provider };
}
