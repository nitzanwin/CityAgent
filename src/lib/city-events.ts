import { city } from "./city";

// The city's own events calendar, read live (requirement 2: current events). Bellevue publishes an RSS feed whose
// items carry the event fields as HTML; which feed is configuration in the city pack. Cached for an hour.
export type CityEvent = { date: string; time: string; title: string; place: string; details: string; contact?: string; canceled: boolean };
export interface CityEventSource {
  readonly name: string;
  upcoming(from: Date, days: number): Promise<CityEvent[]>;
}

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
// The text of one Drupal field ("field--name-field-<name>"), without its label.
function field(html: string, name: string): string {
  const start = html.indexOf(`field--name-field-${name}`);
  if (start < 0) return "";
  const end = html.indexOf("field--name-", start + 20);
  const chunk = html.slice(html.indexOf(">", start) + 1, end < 0 ? undefined : html.lastIndexOf("<", end));
  return text(chunk.replace(/<div class="field__label">[\s\S]*?<\/div>/, ""));
}

export function parseEventsFeed(xml: string): CityEvent[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, item]) => {
    const html = decode(item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
    const date = html.match(/field--name-field-event-dates[\s\S]*?<time datetime="(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date || /^on$/i.test(field(html, "hide-from-city-calendar"))) return [];
    const allDay = /^on$/i.test(field(html, "all-day-event"));
    const place = [field(html, "location"), field(html, "address")].map(s => s.replace(/^Location\s*/i, "")).filter(Boolean).join(", ");
    const body = html.match(/field--name-body[\s\S]*?>([\s\S]*?)(?:<\/div>\s*){2}/)?.[1] ?? "";
    return [{ date, time: allDay ? "All day" : field(html, "event-time"), title: text(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""), place, details: text(body).replace(/^Description\s*/i, "").slice(0, 500), contact: html.match(/mailto:([^"?]+)/)?.[1], canceled: /^on$/i.test(field(html, "canceled")) }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: city.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export const eventsBetween = (events: CityEvent[], from: Date, days: number) => {
  const first = localDate(from), last = localDate(new Date(from.getTime() + days * 86_400_000));
  return events.filter(e => e.date >= first && e.date <= last);
};

export class RssEvents implements CityEventSource {
  readonly name = "city calendar";
  private cached?: { at: number; events: Promise<CityEvent[]> };
  constructor(private url: string, private http: typeof fetch = fetch, private ttlMs = 60 * 60_000) {}
  private all(): Promise<CityEvent[]> {
    if (!this.cached || Date.now() - this.cached.at > this.ttlMs) {
      const events = this.http(this.url, { cache: "no-store", signal: AbortSignal.timeout(5000), headers: { "User-Agent": "CityDesk-demo" } })
        .then(res => { if (!res.ok) throw new Error(`calendar feed returned ${res.status}`); return res.text(); }).then(parseEventsFeed);
      events.catch(() => { this.cached = undefined; });
      this.cached = { at: Date.now(), events };
    }
    return this.cached.events;
  }
  async upcoming(from: Date, days: number) { return eventsBetween(await this.all(), from, days); }
}

let source: CityEventSource | null | undefined;
export function cityEvents(): CityEventSource | null {
  if (source === undefined) {
    const feed = (city as { eventsFeed?: string }).eventsFeed;
    source = feed ? new RssEvents(feed) : null;
  }
  return source;
}
