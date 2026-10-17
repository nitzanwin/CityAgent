import { readFileSync } from "node:fs";
import path from "node:path";
import { activeCityId, type CityId } from ".";

// Read at request time from src/cities/<id>/knowledge.md (traced into the deployment by next.config.ts).
const cache = new Map<CityId, string>();
export function cityKnowledge(id: CityId = activeCityId()): string {
  if (!cache.has(id)) {
    try { cache.set(id, readFileSync(path.join(process.cwd(), "src/cities", id, "knowledge.md"), "utf8")); }
    catch { cache.set(id, ""); }
  }
  return cache.get(id)!;
}
