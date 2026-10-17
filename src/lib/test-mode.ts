import { cityPack } from "../cities";
import { eventsBetween, type CityEvent, type CityEventSource } from "./city-events";
import type { CityRequest, CityRequestSource } from "./city-requests";
import { MemoryTickets, type TicketSystem } from "./tickets";

// Test mode, for the evals: a request with the shared secret and an `x-cityagent-test: <conversation id>` header
// gets a simulated clock (`x-cityagent-now`), a ticket store of its own and a fixed copy of the city's 311 data,
// so runs are repeatable, never touch the real ticketing board, and don't depend on what's open in the city today.

// The test caller, who already has one ticket (CD-1006) — for "what's the status of my report?" by caller ID.
export const TEST_CALLER = { name: "Dana Levi", phone: "+14255550123" };

// Real MyBellevue requests from 2026-10-17, frozen.
const FIXTURE_REQUESTS: CityRequest[] = [
  { system: "MyBellevue", reference: "MyBellevue 18808602", title: "Pothole", department: "transportation", location: "108th Ave NE & NE 39th St", status: "reported", reportedOn: "2026-10-17" },
  { system: "MyBellevue", reference: "MyBellevue 18808420", title: "Improperly Parked Scooter or Bicycle", department: "transportation", location: "13620 SE Eastgate Way", status: "reported", reportedOn: "2026-10-17" },
  { system: "MyBellevue", reference: "MyBellevue 13454736", title: "Traffic Concerns", department: "police", location: "268 102nd Ave NE", status: "in-progress", reportedOn: "2025-11-03" },
];
export const fixtureCityRequests: CityRequestSource = {
  name: "MyBellevue",
  open: async () => FIXTURE_REQUESTS.filter(r => r.status !== "fixed"),
  get: async id => FIXTURE_REQUESTS.find(r => r.reference.endsWith(` ${id.replace(/\D/g, "")}`)) ?? null,
};

// The city calendar as it was on 2026-10-17, frozen.
const FIXTURE_EVENTS: CityEvent[] = [
  { date: "2026-10-17", time: "10:00 AM - 3:30 PM", title: "Residential Permitting Expo", place: "City Hall, 450 110th Avenue NE", details: "Planning on a home remodel or addition? Learn about the permitting process, talk with permit staff and get your questions answered.", contact: "DS_Experience@bellevuewa.gov", canceled: false },
  { date: "2026-10-20", time: "6:00 PM - 10:00 PM", title: "City Council Regular Meeting", place: "Bellevue City Hall, 450 110th Ave NE, Council Chambers", details: "City Council meetings are held the first four Tuesdays of the month.", canceled: false },
  { date: "2026-10-21", time: "6:00 PM - 8:30 PM", title: "Parks & Community Services Board Meeting", place: "Bellevue City Hall, room 1E-113, and online", details: "Regular meeting of the Parks & Community Services Board.", canceled: false },
  { date: "2026-10-24", time: "", title: "Tree Giveaway", place: "Bannerwood Sports Park, 1790 Richards Rd", details: "Sustainable Bellevue's sixth tree giveaway.", canceled: false },
  { date: "2026-10-24", time: "12:00 PM - 4:00 PM", title: "Eastside Día de los Muertos Celebration", place: "Crossroads Community Center", details: "Celebrate Día de los Muertos with music, dance and ofrendas.", canceled: false },
  { date: "2026-10-27", time: "6:00 PM - 10:00 PM", title: "City Council Regular Meeting", place: "Bellevue City Hall, 450 110th Ave NE, Council Chambers", details: "City Council meetings are held the first four Tuesdays of the month.", canceled: false },
  { date: "2026-11-11", time: "All day", title: "City Hall closed for Veterans Day", place: "Bellevue City Hall", details: "", canceled: false },
  { date: "2026-11-26", time: "All day", title: "City Hall closed for Thanksgiving", place: "Bellevue City Hall", details: "", canceled: false },
];
export const fixtureEvents: CityEventSource = { name: "city calendar", upcoming: async (from, days) => eventsBetween(FIXTURE_EVENTS, from, days) };

const stores = new Map<string, Promise<TicketSystem>>();
export function testTickets(conversation: string): Promise<TicketSystem> {
  if (!stores.has(conversation)) {
    if (stores.size >= 200) stores.delete(stores.keys().next().value!);
    stores.set(conversation, (async () => {
      const store = new MemoryTickets(cityPack().knownIssues, () => "2026-10-16");
      await store.create({ department: "transportation", title: "Hole in the road", issue: "Big hole in the road, could damage cars.", location: "200th Ave NE and NE 3rd St", reporter: TEST_CALLER });
      return store;
    })());
  }
  return stores.get(conversation)!;
}

export function testClock(header: string | null): Date | null {
  if (!header) return null;
  const date = new Date(header);
  return Number.isNaN(date.getTime()) ? null : date;
}
