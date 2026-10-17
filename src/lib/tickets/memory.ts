import type { KnownIssue } from "../../cities";
import { asStatus, isOpen, referenceNumber, toReference, type Contact, type NewTicket, type Ticket, type TicketSystem } from "./types";

// In-process store seeded with the city's known issues. Used when no real ticketing system is configured:
// fine for local runs and tests, but on serverless hosting it resets whenever the instance does.
export class MemoryTickets implements TicketSystem {
  readonly provider = "memory";
  private tickets: Ticket[];
  constructor(seed: KnownIssue[], private today = () => new Date().toISOString().slice(0, 10)) {
    this.tickets = seed.map((k, i) => ({
      reference: toReference(i + 1), department: k.department, title: k.title, issue: k.issue, location: k.location,
      status: asStatus(k.status), reportedOn: k.reportedOn, reporter: {}, followers: [], updates: k.updates.map(text => ({ on: k.reportedOn, text })),
    }));
  }
  async create(input: NewTicket) {
    const ticket: Ticket = { ...input, reference: toReference(this.tickets.length + 1), status: "reported", reportedOn: this.today(), followers: [], updates: [] };
    this.tickets.push(ticket);
    return structuredClone(ticket);
  }
  async get(reference: string) {
    const n = referenceNumber(reference);
    const ticket = this.tickets.find(t => referenceNumber(t.reference) === n);
    return ticket ? structuredClone(ticket) : null;
  }
  async list(filter: { department?: string; open?: boolean } = {}) {
    return structuredClone(this.tickets.filter(t => (!filter.department || t.department === filter.department) && (!filter.open || isOpen(t))));
  }
  async follow(reference: string, contact: Contact) {
    const n = referenceNumber(reference);
    const ticket = this.tickets.find(t => referenceNumber(t.reference) === n);
    if (!ticket) return null;
    ticket.followers.push(contact);
    return structuredClone(ticket);
  }
}
