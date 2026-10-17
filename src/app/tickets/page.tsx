import type { Metadata } from "next";
import { departmentName } from "@/lib/city";
import { STATUS_LABEL, STATUSES, ticketSystem, type Ticket } from "@/lib/tickets";
import { AutoRefresh } from "./auto-refresh";

// A read-only view of the ticketing system for reviewers: tickets appear here a few seconds after a call opens them.
// Caller names and phone numbers are never shown.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "CityDesk | Tickets", description: "Tickets opened by the CityDesk voice agent, live from the ticketing system." };

const number = (t: Ticket) => Number(t.reference.replace(/\D/g, ""));
const date = (iso: string) => (iso ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T12:00:00Z`)) : "");

export default async function Tickets() {
  let tickets: Ticket[] = [], failed = false;
  try { tickets = (await ticketSystem().list()).sort((a, b) => number(b) - number(a)); } catch { failed = true; }
  const updated = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date());

  return <main className="tickets">
    <AutoRefresh seconds={20}/>
    <header>
      <h1>CityDesk tickets</h1>
      <p>Live from the ticketing system ({ticketSystem().provider === "trello" ? "Trello" : "demo store"}) · refreshes every 20 seconds · last updated {updated} Pacific. Caller names and phone numbers are hidden. CD-1001 to CD-1005 are seeded sample issues.</p>
    </header>
    {failed ? <p className="empty">The ticketing system couldn&apos;t be reached. Try again in a moment.</p> :
      <section className="board">
        {STATUSES.map(status => {
          const list = tickets.filter(t => t.status === status);
          return <div className="column" key={status}>
            <h2>{STATUS_LABEL[status]} <span>{list.length}</span></h2>
            {list.length ? list.map(t => <article key={t.reference}>
              <div className="ref">{t.reference}<span>{date(t.reportedOn)}</span></div>
              <h3>{t.title}</h3>
              <p className="where">{t.location || "No location given"}</p>
              <p className="dept">{departmentName(t.department)}</p>
              {t.updates.length > 0 && <p className="update">{t.updates[t.updates.length - 1].text}</p>}
              {t.followers.length > 0 && <p className="follow">{t.followers.length} more {t.followers.length === 1 ? "caller is" : "callers are"} following</p>}
            </article>) : <p className="empty">None</p>}
          </div>;
        })}
      </section>}
  </main>;
}
