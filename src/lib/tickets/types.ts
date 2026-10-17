import type { DepartmentId } from "../city";

// The contract every ticketing integration implements (memory, Trello, and later Jira, Monday, …).
// The agent only ever talks to this interface, so swapping systems never touches the agent.
export const STATUSES = ["reported", "in-progress", "scheduled", "fixed"] as const;
export type TicketStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<TicketStatus, string> = { reported: "Reported", "in-progress": "In progress", scheduled: "Scheduled", fixed: "Fixed" };

export type Contact = { name?: string; phone?: string };
export type Update = { on: string; text: string };
export type Ticket = {
  reference: string; department: DepartmentId; title: string; issue: string; location: string;
  status: TicketStatus; reportedOn: string; reporter: Contact; followers: Contact[]; updates: Update[]; url?: string;
};
export type NewTicket = { department: DepartmentId; title: string; issue: string; location: string; reporter: Contact };

export interface TicketSystem {
  readonly provider: string;
  create(ticket: NewTicket): Promise<Ticket>;
  get(reference: string): Promise<Ticket | null>;
  list(filter?: { department?: DepartmentId; open?: boolean }): Promise<Ticket[]>;
  follow(reference: string, contact: Contact): Promise<Ticket | null>;
}

export const REFERENCE_BASE = 1000;
export const toReference = (n: number) => `CD-${REFERENCE_BASE + n}`;
// "CD-1042", "cd 1042", "1 0 4 2" → 42; null when there are no digits.
export const referenceNumber = (spoken: string) => { const digits = spoken.replace(/\D/g, ""); return digits ? Number(digits) - REFERENCE_BASE : null; };
export const samePhone = (a?: string, b?: string) => { const d = (s?: string) => (s ?? "").replace(/\D/g, "").slice(-10); return d(a).length >= 7 && d(a) === d(b); };
export const involves = (t: Ticket, phone: string) => samePhone(t.reporter.phone, phone) || t.followers.some(f => samePhone(f.phone, phone));
export const isOpen = (t: Ticket) => t.status !== "fixed";
export const asStatus = (value: string): TicketStatus => STATUSES.find(s => s === value || STATUS_LABEL[s].toLowerCase() === value.trim().toLowerCase()) ?? "reported";
