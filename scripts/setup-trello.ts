// Creates the CityDesk Trello board: one list per ticket status, seeded with the city's known issues.
// Usage: TRELLO_API_KEY=… TRELLO_TOKEN=… npx tsx scripts/setup-trello.ts   (prints TRELLO_BOARD_ID)
import { cityPack } from "../src/cities";
import { asStatus, STATUS_LABEL, STATUSES } from "../src/lib/tickets/types";
import { formatDesc } from "../src/lib/tickets/trello";

const { TRELLO_API_KEY: key, TRELLO_TOKEN: token } = process.env;
if (!key || !token) { console.error("Set TRELLO_API_KEY and TRELLO_TOKEN first."); process.exit(1); }

async function trello<T>(method: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://api.trello.com/1${path}`);
  for (const [k, v] of Object.entries({ ...params, key: key!, token: token! })) url.searchParams.set(k, v);
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function main() {
  const { config, knownIssues } = cityPack();
  const board = await trello<{ id: string; shortUrl: string }>("POST", "/boards", { name: `CityDesk — ${config.shortName} (demo)`, defaultLists: "false", prefs_permissionLevel: "private" });
  const lists: Record<string, string> = {};
  for (const status of STATUSES) lists[status] = (await trello<{ id: string }>("POST", "/lists", { name: STATUS_LABEL[status], idBoard: board.id, pos: "bottom" })).id;

  // Created in order, so card idShort 1, 2, 3… become references CD-1001, CD-1002, CD-1003…
  for (const issue of knownIssues) {
    const desc = formatDesc({ department: issue.department, location: issue.location, reportedOn: issue.reportedOn, reporter: {}, followers: [], issue: issue.issue });
    const card = await trello<{ id: string; idShort: number }>("POST", "/cards", { idList: lists[asStatus(issue.status)], name: issue.title, desc, pos: "bottom" });
    for (const text of issue.updates) await trello("POST", `/cards/${card.id}/actions/comments`, { text });
    console.log(`  CD-${1000 + card.idShort}  ${issue.title}`);
  }
  console.log(`\nBoard: ${board.shortUrl}\nTRELLO_BOARD_ID=${board.id}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
