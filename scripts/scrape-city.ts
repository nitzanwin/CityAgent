// Scrapes a city's public website into Markdown pages for its city pack: src/cities/<id>/pages/<slug>.md.
// The list of pages lives in src/cities/<id>/sources.json; a source with a "feed" (RSS) becomes an events snapshot.
// Usage: npm run scrape:city -- bellevue
import { load, type CheerioAPI } from "cheerio";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

type Source = { url: string; title: string; topic: string; feed?: string };

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 CityDesk-demo (hackathon prototype)";
const MAIN = ["#block-bellevue-content", "main", "#main-content", ".region-content", "article"];
const JUNK = "script, style, noscript, img, picture, figure, svg, iframe, video, form, button, input, select, nav, header, footer, aside, .header-img, .visually-hidden, [aria-hidden=true], .breadcrumb, .contextual, .social-share, .field--name-field-header-image";
const MAX_BYTES = 15_000;

const city = process.argv[2] ?? "bellevue";
const dir = path.join(process.cwd(), "src/cities", city);
const sources: Source[] = JSON.parse(readFileSync(path.join(dir, "sources.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function get(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced", emDelimiter: "_" });
turndown.use(tables);
// Keep a link's text, drop its URL; a mailto/tel link whose text hides the address keeps the address.
turndown.addRule("linkText", {
  filter: "a",
  replacement: (content, node) => {
    const href = (node as HTMLAnchorElement).getAttribute("href") ?? "";
    const text = content.trim();
    const email = href.startsWith("mailto:") ? href.slice(7).split("?")[0] : "", phone = href.startsWith("tel:") ? href.slice(4) : "";
    if (email && !text.includes("@")) return text ? `${text} (${email})` : `Email: ${email}`;
    if (phone && !/\d{3}/.test(text)) return text ? `${text} (${phone})` : `Phone: ${phone}`;
    return text;
  },
});

function mainContent($: CheerioAPI) {
  for (const selector of MAIN) {
    const el = $(selector).first();
    if (el.length && el.text().replace(/\s+/g, " ").trim().length > 200) return el;
  }
  return $("body");
}

function tidy(markdown: string): string {
  const lines = markdown.split("\n")
    .map(l => l.replace(/\s+$/, "").replace(/^(\s*)-\s{2,}/, "$1- "))
    .filter(l => !/^(Header Image|Share this page|Print|Social Media|Subscribe|Alerts|No events found\.?|-|\*)$/i.test(l.trim()));
  let text = lines.join("\n").replace(/ /g, " ").replace(/\\_/g, "_") // turndown escapes underscores, which breaks emails.replace(/^#+\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  if (Buffer.byteLength(text) > MAX_BYTES) {
    const cut = text.slice(0, MAX_BYTES);
    text = `${cut.slice(0, Math.max(cut.lastIndexOf("\n\n"), MAX_BYTES / 2))}\n\n_[Truncated: the full page is at the source URL.]_`;
  }
  return text;
}

const frontmatter = (fields: Record<string, string>) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`;

function slugFor(source: Source, used: Set<string>): string {
  const parts = new URL(source.url).pathname.split("/").filter(Boolean);
  let slug = parts.at(-1) ?? source.topic;
  if (used.has(slug) && parts.length > 1) slug = `${parts.at(-2)}-${slug}`;
  used.add(slug);
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

async function scrapePage(source: Source): Promise<string> {
  const $ = load(await get(source.url));
  const title = $("h1").first().text().replace(/\s+/g, " ").trim() || source.title;
  const main = mainContent($);
  main.find(JUNK).remove();
  main.find("h1").first().remove();
  const body = tidy(turndown.turndown(main.html() ?? ""));
  return frontmatter({ title, source: source.url, fetched: today, topic: source.topic }) + `# ${title}\n\n${body}\n`;
}

// Events: the calendar page is client-rendered (FullCalendar); its RSS feed carries each event's fields as HTML.
async function scrapeEvents(source: Source): Promise<string> {
  const $ = load(await get(source.feed!), { xml: true });
  const field = (d: CheerioAPI, name: string) => d(`.field--name-field-${name} .field__item`).first().text().replace(/\s+/g, " ").trim()
    || d(`.field--name-field-${name}`).first().text().replace(/\s+/g, " ").trim();
  const rows = $("item").toArray().flatMap(item => {
    const d = load($(item).find("description").text());
    if (/^on$/i.test(field(d, "hide-from-city-calendar")) ) return [];
    const date = d(".field--name-field-event-dates time").first().attr("datetime")?.slice(0, 10) ?? "";
    if (!date || date < today) return [];
    const place = [field(d, "location").replace(/^Location\s*/i, ""), field(d, "address").replace(/^Location\s*/i, "")].filter(Boolean).join(", ");
    const canceled = /^on$/i.test(field(d, "canceled"));
    const allDay = /^on$/i.test(field(d, "all-day-event"));
    return [{ date, time: allDay ? "All day" : field(d, "event-time"), title: $(item).find("title").first().text().trim() + (canceled ? " (canceled)" : ""), place }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  const cell = (s: string) => s.replace(/\|/g, "/");
  const table = ["| Date | Time | Event | Where |", "|---|---|---|---|", ...rows.map(r => `| ${r.date} | ${cell(r.time)} | ${cell(r.title)} | ${cell(r.place)} |`)].join("\n");
  return frontmatter({ title: source.title, source: source.url, fetched: today, topic: "events" })
    + `# ${source.title}\n\nUpcoming events on the city calendar as of ${today} (a snapshot; the live calendar is on the city's website).\n\n${table}\n`;
}

async function main() {
  const out = path.join(dir, "pages");
  mkdirSync(out, { recursive: true });
  const used = new Set<string>(), failed: string[] = [];
  for (const [i, source] of sources.entries()) {
    if (i) await sleep(1000); // polite: one request a second
    const slug = source.feed ? "events" : slugFor(source, used);
    try {
      const md = source.feed ? await scrapeEvents(source) : await scrapePage(source);
      writeFileSync(path.join(out, `${slug}.md`), md);
      console.log(`${String(Buffer.byteLength(md)).padStart(6)} B  ${source.topic.padEnd(22)} ${slug}.md`);
    } catch (e) {
      failed.push(`${source.url}: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`  FAILED  ${source.topic.padEnd(22)} ${source.url}`);
    }
  }
  if (failed.length) console.log(`\n${failed.length} failed:\n${failed.join("\n")}`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
