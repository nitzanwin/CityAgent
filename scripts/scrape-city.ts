// Scrapes a city's public website into Markdown pages for its city pack: src/cities/<id>/pages/<slug>.md.
// The list of pages lives in src/cities/<id>/sources.json; a source with a "feed" (RSS) becomes an events snapshot,
// and a PDF source is converted to text. Code sources (topic "code") keep their configured title, which carries the
// section number. Optional "slug" overrides the file name.
// Usage: npm run scrape:city -- bellevue [--topic code]   (--topic re-scrapes only that topic's pages)
import { load, type CheerioAPI } from "cheerio";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import { extractText, getDocumentProxy } from "unpdf";

type Source = { url: string; title: string; topic: string; feed?: string; slug?: string; note?: string };

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 CityDesk-demo (hackathon prototype)";
const MAIN = ["#block-bellevue-content", "main", "#main-content", ".region-content", "article"];
const JUNK = "script, style, noscript, img, picture, figure, svg, iframe, video, form, button, input, select, nav, header, footer, aside, .header-img, .visually-hidden, [aria-hidden=true], .breadcrumb, .contextual, .social-share, .field--name-field-header-image";
const MAX_BYTES = 15_000;

const args = process.argv.slice(2);
const topicFlag = args.indexOf("--topic");
const onlyTopic = topicFlag >= 0 ? args[topicFlag + 1] : undefined;
const city = args.find((a, i) => !a.startsWith("--") && i !== topicFlag + 1) ?? "bellevue";
const dir = path.join(process.cwd(), "src/cities", city);
const sources: Source[] = JSON.parse(readFileSync(path.join(dir, "sources.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchOk(url: string, accept: string): Promise<Response> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: accept } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}
const get = async (url: string) => (await fetchOk(url, "text/html,application/xml")).text();
const isPdf = (url: string) => /\.pdf($|\?)/i.test(url);

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
  let text = lines.join("\n").replace(/ /g, " ")
    .replace(/\\_/g, "_") // turndown escapes underscores, which breaks emails
    .replace(/^#+\s*$/gm, "") // headings left empty once their icon was removed
    .replace(/^<table.*<\/table>$/gm, "") // raw-HTML tables turndown couldn't convert (project timelines)
    .replace(/\n{3,}/g, "\n\n").trim();
  if (Buffer.byteLength(text) > MAX_BYTES) {
    const cut = text.slice(0, MAX_BYTES);
    text = `${cut.slice(0, Math.max(cut.lastIndexOf("\n\n"), MAX_BYTES / 2))}\n\n_[Truncated: the full page is at the source URL.]_`;
  }
  return text;
}

const frontmatter = (fields: Record<string, string>) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n`;

function slugFor(source: Source, used: Set<string>): string {
  if (source.slug) { used.add(source.slug); return source.slug; }
  const parts = new URL(source.url).pathname.split("/").filter(Boolean);
  let slug = parts.at(-1) ?? source.topic;
  if (used.has(slug) && parts.length > 1) slug = `${parts.at(-2)}-${slug}`;
  used.add(slug);
  return slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

// A code page is titled by its section ("Bellevue City Code 9.18 — …"); the city page's own heading is kept below it.
// A source's "note" (e.g. "City flyer from 2016…") is shown under the title, so dated material reads as dated.
function heading(source: Source, pageTitle: string): { title: string; subtitle: string } {
  const note = source.note ? `_${source.note}_\n\n` : "";
  if (source.topic !== "code") return { title: pageTitle || source.title, subtitle: note };
  return { title: source.title, subtitle: (pageTitle && pageTitle !== source.title ? `_City page: ${pageTitle}_\n\n` : "") + note };
}

async function scrapePage(source: Source): Promise<string> {
  const $ = load(await get(source.url));
  const { title, subtitle } = heading(source, $("h1").first().text().replace(/\s+/g, " ").trim());
  const main = mainContent($);
  main.find(JUNK).remove();
  main.find("h1").first().remove();
  const body = tidy(turndown.turndown(main.html() ?? ""));
  return frontmatter({ title, source: source.url, fetched: today, topic: source.topic }) + `# ${title}\n\n${subtitle}${body}\n`;
}

// PDFs (city flyers and brochures): text lines are re-joined into paragraphs, bullets become list items.
async function scrapePdf(source: Source): Promise<string> {
  const data = new Uint8Array(await (await fetchOk(source.url, "application/pdf")).arrayBuffer());
  const { text } = await extractText(await getDocumentProxy(data), { mergePages: true });
  const blocks: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\b[a-z]\d{3,5}[A-Z]?_\d{2}\.\d{2}_[a-z]+\b/g, "").replace(/\s+/g, " ").trim(); // drop print-shop codes
    if (!line) continue;
    const bullet = /^[•●▪◦]\s*/.test(line), last = blocks.length - 1;
    const startsNew = bullet || last < 0 || /[.:!?)]$/.test(blocks[last]) || (line === line.toUpperCase() && /[A-Z]{4}/.test(line));
    if (startsNew) blocks.push(bullet ? `- ${line.replace(/^[•●▪◦]\s*/, "")}` : line);
    else blocks[last] += (/\d$/.test(blocks[last]) && line.startsWith("-") ? "" : " ") + line;
  }
  const { title, subtitle } = heading(source, "");
  const body = tidy(blocks.map((b, i) => (b.startsWith("- ") ? b : `${i ? "\n" : ""}${b}\n`)).join("\n"));
  return frontmatter({ title, source: source.url, fetched: today, topic: source.topic }) + `# ${title}\n\n${subtitle}${body}\n`;
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
  // Slugs are assigned over the whole list, so a --topic run writes the same file names as a full run.
  const used = new Set<string>(), failed: string[] = [];
  const planned = sources.map(source => ({ source, slug: source.feed ? "events" : slugFor(source, used) }))
    .filter(({ source }) => !onlyTopic || source.topic === onlyTopic);
  for (const [i, { source, slug }] of planned.entries()) {
    if (i) await sleep(1000); // polite: one request a second
    try {
      const md = source.feed ? await scrapeEvents(source) : isPdf(source.url) ? await scrapePdf(source) : await scrapePage(source);
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
