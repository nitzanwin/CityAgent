import { city, departments, holidays as cityHolidays, type Department, type DepartmentId } from "./city";

export function localTimeParts(date: Date, timeZone = city.timezone) {
  const pieces = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => pieces.find(part => part.type === type)?.value ?? "";
  return { weekday: get("weekday"), hour: Number(get("hour")) };
}

export function isOfficeOpen(date: Date, holidays: ReadonlySet<string> = cityHolidays): boolean {
  const { weekday, hour } = localTimeParts(date);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: city.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  if (holidays.has(localDate)) return false;
  return !["Sat", "Sun"].includes(weekday) && hour >= city.weekdayOpenHour && hour < city.weekdayCloseHour;
}

export function selectDepartment(message: string): Department {
  const words = message.toLowerCase();
  const candidates = departments.filter(d => d.id !== "general").map(department => ({department, score: department.keywords.filter(k => new RegExp(`\\b${k}s?\\b`, "i").test(words)).length}));
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score ? candidates[0].department : departments.find(d => d.id === "general")!;
}

export type Decision =
  | { action: "answer"; department: DepartmentId; response: string; source?: string }
  | { action: "transfer"; department: DepartmentId; phone: string; response: string }
  | { action: "ticket"; department: DepartmentId; response: string; title: string };

export function decide(message: string, now: Date, holidays: ReadonlySet<string> = cityHolidays): Decision {
  const input = message.trim();
  const dept = selectDepartment(input);
  if (/\b(events?|festival|concert|what'?s on|happening|calendar)\b/i.test(input)) {
    return { action: "answer", department: dept.id, source: city.sources[2].url, response: "For current Bellevue events, please check the official city calendar. This demo does not ingest live event listings yet." };
  }
  if (/\b(law|legal|municipal code|ordinance|regulation|rule|allowed)\b/i.test(input)) {
    return { action: "answer", department: dept.id, source: city.sources[1].url, response: "The official Bellevue Municipal Code is the best source for that question. I cannot verify a specific ordinance yet; please check the linked source." };
  }
  if (/\b(website|where can i|how do i|information|hours)\b/i.test(input)) {
    return { action: "answer", department: dept.id, source: city.sources[0].url, response: "The official city website has more information. I can also help route a service request to the right department." };
  }
  if (isOfficeOpen(now, holidays)) {
    return { action: "transfer", department: dept.id, phone: dept.phone, response: `During demo business hours I would transfer this call to ${dept.name}. This number is a mock destination; no call is placed.` };
  }
  return { action: "ticket", department: dept.id, title: input.slice(0, 80), response: `${dept.name} is closed under the demo schedule. I can create a service ticket instead.` };
}

// When offices next open, searched hour by hour up to 8 days ahead (hours are whole-hour, demo policy).
export function nextOpening(now: Date, holidays: ReadonlySet<string> = cityHolidays): Date | null {
  const hour = 3_600_000, start = Math.floor(now.getTime() / hour) * hour;
  for (let h = 1; h <= 24 * 8; h++) if (isOfficeOpen(new Date(start + h * hour), holidays)) return new Date(start + h * hour);
  return null;
}

// "today at 8 AM", "tomorrow at 8 AM", "on Monday at 8 AM" — in the city's timezone.
export function spokenWhen(date: Date, now: Date): string {
  const fmt = (d: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: city.timezone, ...options }).format(d);
  const dayOf = (d: Date) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });
  const day = dayOf(date) === dayOf(now) ? "today" : dayOf(date) === dayOf(new Date(now.getTime() + 86_400_000)) ? "tomorrow" : `on ${fmt(date, { weekday: "long" })}`;
  return `${day} at ${fmt(date, { hour: "numeric", minute: "2-digit" }).replace(":00", "")}`;
}

// Walk-in offices (city pack "inPerson"): which are open right now, and until when or when they next open.
type Office = { name: string; phone: string; days: number[]; open: number; close: number; closedOnHolidays?: boolean };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourText = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
export function officesNow(now: Date, holidays: ReadonlySet<string> = cityHolidays): string[] {
  const offices = (city as { inPerson?: Office[] }).inPerson ?? [];
  const isOpen = (o: Office, at: Date) => {
    const { weekday, hour } = localTimeParts(at);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: city.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
    return o.days.includes(WEEKDAYS.indexOf(weekday)) && hour >= o.open && hour < o.close && !(o.closedOnHolidays && holidays.has(day));
  };
  return offices.map(o => {
    if (isOpen(o, now)) return `${o.name} (${o.phone}) is open now, until ${hourText(o.close)}.`;
    const start = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
    for (let h = 1; h <= 24 * 8; h++) {
      const at = new Date(start + h * 3_600_000);
      if (isOpen(o, at)) return `${o.name} (${o.phone}) is closed now; it opens ${spokenWhen(at, now)}.`;
    }
    return `${o.name} (${o.phone}) is closed now.`;
  });
}
