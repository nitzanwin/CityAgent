import { city } from "./city";
import type { TicketStatus } from "./tickets";

// The city's own service requests (its 311 system), read-only. Lets the agent say "that's already reported to
// the city" from real data. Which system and how its fields map is configuration in the city pack.
export type CityRequest = { system: string; reference: string; department: string; title: string; location: string; status: TicketStatus; reportedOn: string };
export interface CityRequestSource {
  readonly name: string;
  open(): Promise<CityRequest[]>;
  get(id: string): Promise<CityRequest | null>;
}

type ArcGis311Config = {
  provider: "arcgis-311"; name: string; url: string;
  fields: { id: string; type: string; status: string; address: string; department: string; created: string };
  openStatuses: string[]; inProgressStatuses: string[]; fixedStatuses: string[]; departments: Record<string, string>;
};
type Feature = { attributes: Record<string, string | number | null> };

// An ArcGIS feature layer of 311 requests (Bellevue's MyBellevue; many US cities publish theirs the same way).
export class ArcGis311 implements CityRequestSource {
  private cached?: { at: number; requests: Promise<CityRequest[]> };
  constructor(private config: ArcGis311Config, private http: typeof fetch = fetch, private ttlMs = 10 * 60_000) {}
  get name() { return this.config.name; }

  private async query(where: string, limit: number): Promise<CityRequest[]> {
    const url = new URL(`${this.config.url}/query`);
    const params = { where, outFields: Object.values(this.config.fields).join(","), orderByFields: `${this.config.fields.created} DESC`, resultRecordCount: String(limit), returnGeometry: "false", f: "json" };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.http(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${this.config.name} returned ${res.status}`);
    const body = await res.json() as { features?: Feature[]; error?: { message: string } };
    if (body.error) throw new Error(`${this.config.name}: ${body.error.message}`);
    return (body.features ?? []).map(f => this.toRequest(f.attributes));
  }

  private toRequest(a: Feature["attributes"]): CityRequest {
    const { fields, departments, inProgressStatuses, fixedStatuses } = this.config;
    const text = (field: string) => String(a[field] ?? "").trim();
    const status = text(fields.status).toLowerCase();
    return {
      system: this.config.name, reference: `${this.config.name} ${text(fields.id)}`, title: text(fields.type),
      department: departments[text(fields.department)] ?? "general",
      // "108th Ave NE & NE 39th St, Bellevue, WA 98004, USA" → "108th Ave NE & NE 39th St"
      location: text(fields.address).replace(new RegExp(`\\s*,\\s*${city.shortName}\\b.*$`, "i"), ""),
      status: fixedStatuses.includes(status) ? "fixed" : inProgressStatuses.includes(status) ? "in-progress" : "reported",
      reportedOn: a[fields.created] ? new Date(Number(a[fields.created])).toISOString().slice(0, 10) : "",
    };
  }

  // All open requests, cached for ten minutes (a few hundred rows in one request).
  open(): Promise<CityRequest[]> {
    if (!this.cached || Date.now() - this.cached.at > this.ttlMs) {
      const quoted = this.config.openStatuses.map(s => `'${s.replace(/'/g, "''")}'`).join(",");
      const requests = this.query(`${this.config.fields.status} IN (${quoted})`, 2000);
      requests.catch(() => { this.cached = undefined; });
      this.cached = { at: Date.now(), requests };
    }
    return this.cached.requests;
  }

  async get(id: string): Promise<CityRequest | null> {
    const digits = id.replace(/\D/g, "");
    if (!digits) return null;
    return (await this.query(`${this.config.fields.id} = '${digits}'`, 1))[0] ?? null;
  }
}

let source: CityRequestSource | null | undefined;
export function cityRequests(): CityRequestSource | null {
  if (source === undefined) {
    const config = (city as { openRequests?: ArcGis311Config }).openRequests;
    source = config?.provider === "arcgis-311" ? new ArcGis311(config) : null;
  }
  return source;
}
