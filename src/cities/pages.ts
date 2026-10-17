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
  // One chunk per section, so a result is a focused passage rather than a whole page; long sections (like the
  // events table) are split at line breaks, each piece keeping the section's heading and any table header.
  return body.split(/\n(?=#{1,3} )/).flatMap(section => {
    const heading = section.match(/^#{1,3} (.*)/)?.[1].trim() ?? "";
    const text = section.replace(/^#{1,3} .*\n?/, "").replace(/\n{3,}/g, "\n\n").trim();
    return splitText(text, 1500).map(piece => ({ title: meta.title ?? "", heading, text: piece, source: meta.source ?? "", fetched: meta.fetched ?? "", topic: meta.topic ?? "" }));
  }).filter(c => c.text.length > 40);
}

function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const lines = text.split("\n"), header = lines.findIndex(l => /^\|[-| :]+\|$/.test(l));
  const tableHead = header > 0 ? `${lines[header - 1]}\n${lines[header]}\n` : "";
  const pieces: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > max && current) { pieces.push(current.trimEnd()); current = line.startsWith("|") ? tableHead : ""; }
    current += `${line}\n`;
  }
  return [...pieces, current.trimEnd()].filter(Boolean);
}

// BM25 keyword ranking (rare words count more; long sections don't win just by repeating words), with matches in
// the page title or section heading counting extra.
export function searchChunks(query: string, chunks: PageChunk[], limit = 3): PageChunk[] {
  const terms = [...new Set(words(query))];
  if (!terms.length || !chunks.length) return [];
  const tokenized = chunks.map(c => ({ c, body: words(c.text), head: words(`${c.title} ${c.heading}`) }));
  const avgLength = tokenized.reduce((s, x) => s + x.body.length, 0) / tokenized.length;
  const df = (t: string) => tokenized.filter(x => x.body.includes(t) || x.head.includes(t)).length;
  const idf = Object.fromEntries(terms.map(t => [t, Math.log(1 + (chunks.length - df(t) + 0.5) / (df(t) + 0.5))]));
  const k1 = 1.2, b = 0.75;
  return tokenized
    .map(({ c, body, head }) => ({
      c,
      score: terms.reduce((s, t) => {
        const tf = body.filter(w => w === t).length, norm = k1 * (1 - b + b * body.length / avgLength);
        return s + idf[t] * ((tf * (k1 + 1)) / (tf + norm) + (head.includes(t) ? 1 : 0));
      }, 0),
    }))
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
