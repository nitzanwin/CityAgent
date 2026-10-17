import type { DepartmentId } from "./city";
export type TicketInput = { department: DepartmentId; title: string; description: string };
export type TicketResult = { id: string; url?: string; provider: "mock" | "trello" };
export async function createTicket(input: TicketInput): Promise<TicketResult> {
  const { TRELLO_API_KEY: key, TRELLO_TOKEN: token, TRELLO_LIST_ID: listId } = process.env;
  if (!key || !token || !listId) return { id: `demo-${crypto.randomUUID().slice(0, 8)}`, provider: "mock" };
  const url = new URL("https://api.trello.com/1/cards");
  url.searchParams.set("key", key);
  url.searchParams.set("token", token);
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idList: listId, name: `[${input.department}] ${input.title}`, desc: input.description }), cache: "no-store" });
  if (!response.ok) throw new Error(`Ticket provider returned ${response.status}`);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("id" in data) || typeof data.id !== "string") throw new Error("Invalid ticket response");
  const card = data as { id: string; shortUrl?: string };
  return { id: card.id, url: card.shortUrl, provider: "trello" };
}
