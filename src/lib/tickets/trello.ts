import { asStatus, referenceNumber, STATUS_LABEL, toReference, type Contact, type NewTicket, type Ticket, type TicketStatus, type TicketSystem } from "./types";

// Trello as the ticketing system: one board, one list per status (Reported, In progress, Scheduled, Fixed),
// one card per ticket. The card description holds the fields; comments are the updates staff post.
type Card = { id: string; name: string; desc: string; idList: string; idShort: number; shortUrl: string };
type Board = { lists: { id: string; name: string }[]; cards: Card[]; actions: { date: string; data: { text?: string; card?: { id: string } } }[] };
type Fields = { department: string; location: string; reportedOn: string; reporter: Contact; followers: Contact[]; issue: string };

const contactText = (c: Contact) => [c.name, c.phone && `(${c.phone})`].filter(Boolean).join(" ");
const parseContact = (text: string): Contact => {
  const m = text.trim().match(/^(.*?)\s*(?:\(([^)]*)\))?$/);
  return { ...(m?.[1] && { name: m[1] }), ...(m?.[2] && { phone: m[2] }) };
};

export function formatDesc(f: Fields): string {
  return [`Department: ${f.department}`, `Location: ${f.location}`, `Reported: ${f.reportedOn}`, `Reporter: ${contactText(f.reporter)}`,
    `Followers: ${f.followers.map(contactText).join("; ")}`, "", f.issue].join("\n");
}

export function parseDesc(desc: string): Fields {
  const [head, ...rest] = desc.split(/\n\s*\n/);
  const field = (name: string) => head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1].trim() ?? "";
  return {
    department: field("Department") || "general", location: field("Location"), reportedOn: field("Reported"),
    reporter: parseContact(field("Reporter")), followers: field("Followers").split(";").filter(s => s.trim()).map(parseContact),
    issue: rest.join("\n\n").trim(),
  };
}

export class TrelloTickets implements TicketSystem {
  readonly provider = "trello";
  private cached?: { at: number; board: Promise<Board> };
  constructor(private key: string, private token: string, private boardId: string, private http: typeof fetch = fetch) {}

  private async api<T>(method: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`https://api.trello.com/1${path}`);
    for (const [k, v] of Object.entries({ ...params, key: this.key, token: this.token })) url.searchParams.set(k, v);
    const res = await this.http(url, { method, cache: "no-store" });
    if (!res.ok) throw new Error(`Trello ${method} ${path} returned ${res.status}`);
    return res.json() as Promise<T>;
  }

  // One request returns lists, open cards and comments; reused for 5 seconds so a single call turn doesn't refetch.
  private board(): Promise<Board> {
    if (!this.cached || Date.now() - this.cached.at > 5000) {
      const board = this.api<Board>("GET", `/boards/${this.boardId}`, { lists: "open", list_fields: "name", cards: "open", card_fields: "name,desc,idList,idShort,shortUrl", actions: "commentCard", actions_limit: "1000" });
      board.catch(() => { this.cached = undefined; });
      this.cached = { at: Date.now(), board };
    }
    return this.cached.board;
  }

  private toTicket(card: Card, board: Board): Ticket {
    const f = parseDesc(card.desc);
    const list = board.lists.find(l => l.id === card.idList);
    const updates = board.actions.filter(a => a.data.card?.id === card.id && a.data.text).map(a => ({ on: a.date.slice(0, 10), text: a.data.text! })).reverse();
    return { reference: toReference(card.idShort), title: card.name, status: asStatus(list?.name ?? ""), url: card.shortUrl, updates, ...f };
  }

  private async card(reference: string) {
    const n = referenceNumber(reference), board = await this.board();
    const card = board.cards.find(c => c.idShort === n);
    return card ? { card, board } : null;
  }

  private async listId(status: TicketStatus) {
    const list = (await this.board()).lists.find(l => l.name.trim().toLowerCase() === STATUS_LABEL[status].toLowerCase());
    if (!list) throw new Error(`Trello board has no "${STATUS_LABEL[status]}" list`);
    return list.id;
  }

  async create(t: NewTicket) {
    const reportedOn = new Date().toISOString().slice(0, 10);
    const desc = formatDesc({ department: t.department, location: t.location, reportedOn, reporter: t.reporter, followers: [], issue: t.issue });
    const card = await this.api<Card>("POST", "/cards", { idList: await this.listId("reported"), name: t.title, desc, pos: "top" });
    this.cached = undefined;
    return { ...t, reference: toReference(card.idShort), status: "reported" as const, reportedOn, followers: [], updates: [], url: card.shortUrl };
  }

  async get(reference: string) {
    const found = await this.card(reference);
    return found ? this.toTicket(found.card, found.board) : null;
  }

  async list(filter: { department?: string; open?: boolean } = {}) {
    const board = await this.board();
    return board.cards.map(c => this.toTicket(c, board)).filter(t => (!filter.department || t.department === filter.department) && (!filter.open || t.status !== "fixed"));
  }

  async follow(reference: string, contact: Contact) {
    const found = await this.card(reference);
    if (!found) return null;
    const ticket = this.toTicket(found.card, found.board);
    ticket.followers.push(contact);
    await this.api("PUT", `/cards/${found.card.id}`, { desc: formatDesc(ticket) });
    await this.api("POST", `/cards/${found.card.id}/actions/comments`, { text: `Another caller reported this${contact.name ? `: ${contact.name}` : ""}. They'll be contacted on updates.` });
    this.cached = undefined;
    return ticket;
  }
}
