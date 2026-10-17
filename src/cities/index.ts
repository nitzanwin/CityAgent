import bellevue from "./bellevue/city.json";
import bellevueIssues from "./bellevue/known-issues.json";

// A city "pack": config + seed known issues, plus knowledge.md read by ./knowledge (server only).
// A new city is a new folder registered here; nothing else changes.
export type KnownIssue = { title: string; department: string; issue: string; location: string; status: string; reportedOn: string; updates: string[] };
export type CityConfig = typeof bellevue;
const packs = { bellevue: { config: bellevue, knownIssues: bellevueIssues as KnownIssue[] } };

export type CityId = keyof typeof packs;
export const activeCityId = (): CityId => (process.env.CITY && process.env.CITY in packs ? process.env.CITY : "bellevue") as CityId;
export const cityPack = (id: CityId = activeCityId()) => packs[id];
