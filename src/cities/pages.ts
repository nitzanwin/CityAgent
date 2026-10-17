import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { activeCityId, type CityId } from ".";

// The city's website snapshot: src/cities/<id>/pages/*.md, written by scripts/scrape-city.ts, each with
// frontmatter (title, source, fetched, topic). Searched on demand by the agent's search_city_info tool,
// so the pages never bloat the prompt. Traced into the deployment by next.config.ts.
export type PageChunk = { title: string; heading: string; text: string; source: string; fetched: string; topic: string };

const STOP = new Set("a an and are at be by can do does for from how i in is it my of on or the to what when where who why with you your".split(" "));
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w));

export function parsePage(markdown: string): PageChunk[] {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = Object.fromEntries((fm?.[1] ?? "").split("\n").map(l => l.match(/^(\w+):\s*"?(.*?)"?\s*$/)).filter(Boolean).map(m => [m![1], m![2]]));
  const body = fm ? markdown.slice(fm[0].length) : markdown;
  // One chunk per section, so a result is a focused passage rather than a whole page.
  return body.split(/\n(?=#{1,3} )/).map(section => {
    const heading = section.match(/^#{1,3} (.*)/)?.[1].trim() ?? "";
    const text = section.replace(/^#{1,3} .*\n?/, "").replace(/\n{3,}/g, "\n\n").trim();
    return { title: meta.title ?? "", heading, text: text.slice(0, 1500), source: meta.source ?? "", fetched: meta.fetched ?? "", topic: meta.topic ?? "" };
  }).filter(c => c.text.length > 40);
}

// Plain keyword scoring (term frequency × rarity), with title and heading matches counting extra.
export function searchChunks(query: string, chunks: PageChunk[], limit = 3): PageChunk[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const tokenized = chunks.map(c => ({ c, body: words(c.text), head: words(`${c.title} ${c.heading}`) }));
  const df = (t: string) => tokenized.filter(x => x.body.includes(t) || x.head.includes(t)).length;
  const idf = Object.fromEntries(terms.map(t => [t, Math.log(1 + chunks.length / (1 + df(t)))]));
  return tokenized
    .map(({ c, body, head }) => ({ c, score: terms.reduce((s, t) => s + idf[t] * (Math.min(body.filter(w => w === t).length, 5) + 3 * head.filter(w => w === t).length), 0) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.c);
}

const cache = new Map<CityId, PageChunk[]>();
export function cityPages(id: CityId = activeCityId()): PageChunk[] {
  if (!cache.has(id)) {
    const dir = path.join(process.cwd(), "src/cities", id, "pages");
    try { cache.set(id, readdirSync(dir).filter(f => f.endsWith(".md")).flatMap(f => parsePage(readFileSync(path.join(dir, f), "utf8")))); }
    catch { cache.set(id, []); }
  }
  return cache.get(id)!;
}
