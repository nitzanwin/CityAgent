# CityDesk — for reviewers

CityDesk is a voice agent for the City of **Bellevue, Washington**. It answers
questions about the city's code, website and events, opens tickets, and routes
callers to the right department — deciding between routing and a ticket by the
city's business hours, as a rule rather than a model's judgement.

This page is the short tour. [`PLAN.md`](PLAN.md) is the full working document:
principles, decisions, research, and what every test call changed.

## Try it

| | |
|---|---|
| **Call** | **+1 (425) 476-9822** (US number) |
| **Or in the browser** | https://cityagent.vercel.app — press Start call (any country; needs a microphone) |
| **Watch tickets appear** | https://cityagent.vercel.app/tickets — live from Trello, refreshes every 20 s; caller names and numbers are hidden |

Business hours are City Hall's (weekdays 8 AM–4 PM **Pacific**, closed on city
holidays), so what you hear depends on when you call: during hours the agent
transfers you (simulated), outside them it opens a ticket.

Things to try:

| Brief | Say | Expect |
|---|---|---|
| 1 · Code | "Can I set off fireworks in my backyard?" · "How long can I leave my car parked on my street?" | Illegal in Bellevue, $1,000 fine · no more than 24 hours in one place (BCC 11.23.020) |
| 1 · Website | "My garbage wasn't picked up." · "I need to renew my green card." | Republic Services and their number · not a city service: USCIS and its number |
| 2 · Events | "What's happening in the city this week?" · "When's the next City Council meeting?" | Read live from the city's calendar, with dates, times and places |
| 3 · Ticket | "There's a pothole on 148th Avenue NE at NE 20th Street." (outside hours) | Names Transportation, checks it isn't already known, takes your name and number, reads it back, gives a reference ("C D" and four digits) and says who follows up and when — then it appears on the tickets page |
| 3 · Known issue | "There's a pothole on NE 8th Street at 112th Avenue NE." | Already reported (CD-1001), repair scheduled; offers to add you instead of opening a duplicate |
| 3 · Status | Call again from the same phone: "Any news on my report?" | Found by caller ID, with its status |
| 4 · Routing | During hours: "There's an abandoned shopping cart on my street." | Community Development, transferred (simulated) with their real number |
| 5 · Hours rule | The same report during and outside hours | Transfer when open, ticket when closed — never the other way round |
| Safety | "There's smoke pouring out of my neighbor's house!" | Hang up and call 911, immediately |

## What's built

| # | Requirement | How |
|---|---|---|
| 1 | Municipal code and website | 37 city pages and city-code pages saved as Markdown and searched on demand; short checked facts always in the prompt |
| 2 | Current events | The city calendar's RSS feed, read live (1-hour cache), with the saved snapshot as fallback |
| 3 | Tickets | Trello, behind a ticketing interface; duplicates checked against our tickets **and** the city's own open 311 requests (MyBellevue, live); look-up by reference, caller ID or a number the caller gives |
| 4 | Routing | Bellevue's real departments and what each handles, taken from the city's 311 data; real department numbers; the transfer itself is simulated |
| 5 | Hours rule | Deterministic: City Hall hours and holidays decide, and the tools enforce it — no ticket while open, no transfer while closed |
| 6 | Evaluation | 44 scripted Bellevue calls run through the real API and scored automatically (below) |

## Architecture

```
 caller ── phone or browser ──► Vapi: telephony, speech-to-text, end-of-turn detection, text-to-speech
                                   │  every turn: the whole conversation (OpenAI chat format)
                                   ▼
 Next.js on Vercel ── POST /api/vapi/chat/completions ── secret-checked, streamed reply
   │
   ├─ yes/no gates  (gpt-4.1-nano, one token + confidence): emergency? goodbye?
   │      run in parallel with the agent; a confident gate answers alone and cancels the agent
   │
   └─ agent  (gpt-4.1; gpt-4.1-mini if rate-limited) with tools:
        find_known_issue ─► our tickets + city's open 311 requests ─► one yes/no per candidate
        create_ticket · follow_ticket · lookup_ticket ─► ticketing interface ─► Trello
        transfer_call ─► allowed only when the hours rule says "transfer"
        upcoming_events ─► city calendar RSS (live)
        search_city_info ─► city pages snapshot (BM25 search over Markdown in the repo)
   │
   └─ speech formatting (phone numbers in digit groups, addresses), never a URL read aloud
```

### Stack

| Layer | Choice | Why |
|---|---|---|
| Voice | Vapi — phone number, browser SDK, "custom LLM" mode | Fastest way to real calls; our server does all the thinking, so the voice provider is swappable |
| App and hosting | Next.js 15 + TypeScript on Vercel | One deploy for the call screen, the brain endpoint and the tickets page; every push to `main` deploys |
| Models | OpenAI, through one file (`src/lib/llm.ts`) | Small model for yes/no checks, stronger one for the conversation, a fallback for rate limits; any OpenAI-compatible provider by config |
| Tickets | Trello behind `TicketSystem` | The agent never knows which system it is; Jira or Monday would be another adapter |
| City data | MyBellevue 311 (ArcGIS, live), city calendar (RSS, live), bellevuewa.gov (scraped) | Real, checkable answers |

### Storage

There is no database.

| What | Where |
|---|---|
| Tickets | Trello: one list per status, one card per ticket, comments as updates. It's the system of record. |
| City knowledge | Files in the repo, `src/cities/bellevue/`: `city.json` (departments, hours, numbers, data sources), `knowledge.md` (always-known facts), `pages/*.md` (scraped snapshot with source and date). Versioned with the code; `npm run scrape:city -- bellevue` refreshes it. |
| Live city data | Read from the city's systems when needed, cached in memory (311 requests 10 min, calendar 1 h). Read-only. |
| Conversation state | None on our side: Vapi sends the whole conversation every turn, so the server is stateless and runs serverless. |
| Secrets | Vercel environment variables (`.env.local` locally). |

A new city is a new folder under `src/cities/` — departments (ideally from its
311 data), a list of pages to scrape, a few curated facts, and pointers to its
311 feed and ticketing system. No code changes.

## How we built it

1. **Principles first** (in `PLAN.md`): independent of the voice provider and
   of the ticketing system; cheap yes/no models before the expensive one;
   tools backed by per-city knowledge.
2. **A real call within the first hour or two**: the starter deployed to
   Vercel, a brain endpoint for Vapi, a phone number, a voice-only call screen.
3. **Every test call changed something.** The first call got "closed — open a
   ticket?" for every question and no details collected, which led to the
   current call flow. A "residence card" call that only got "check the
   website" led to concrete answers and a list of non-city services (USCIS,
   Department of Licensing). A Saturday events call pointed to a closed line,
   which led to "open right now" awareness and live event details.
4. **Research replaced guesses.** No public city call transcripts exist, so we
   used Bellevue's own 311 data (34,576 requests): its real departments
   replaced invented ones — a fifth of requests are abandoned shopping carts,
   potholes are 1%. NYC's 311 call-center data showed "status of my request"
   is the second most common call, which shaped ticket look-ups.
5. **Evaluation drove the last round.** The first run passed 32 of 41 and every
   failure was real: a water main break sent to 911 instead of the city's
   24-hour line, offering numbers instead of giving them, a rule answered from
   memory (wrongly), and "please hold while I transfer you" without
   transferring — now caught in code for any promised action.

## Evaluation

```bash
npm run eval                                    # 44 scenarios against the deployed app
npm run eval -- --only routing                  # one requirement or scenario
npm run eval -- --target http://localhost:3000  # a local build
npm test                                        # 58 unit tests
```

Each scenario is a call at a fixed simulated time, through the real endpoint in
**test mode**: its own ticket store, a frozen copy of the city's 311 requests
and events, and a trace of every decision. Checks look first at what the agent
*did* (ticket created, for which department; transferred, to whom; known issue
matched; which path answered), then at what it said, then an LLM judge for
what only a judgement covers. Short questions use scripted caller lines;
multi-turn ticket calls use a model playing the resident with a goal.

Latest run: [`evals/reports/latest.md`](evals/reports/latest.md) — per
requirement, with every transcript, tool call and timing. A scenario the model
provider rate-limits is retried once and reported as infrastructure, not
agent behaviour.

## Known limitations

- **Transfers are simulated**: the agent says who it's connecting you to and
  their real number; no call is placed.
- **Municipal code**: the official code site (bellevue.municipal.codes) blocks
  automated access. We didn't work around it; code answers come from official
  bellevuewa.gov pages that quote the sections.
- **The website snapshot is dated** (each answer from it carries its date) and
  refreshes only when re-scraped. Events and 311 requests are live.
- **The evaluation sends text, not audio**: speech-recognition errors,
  interruptions and pauses aren't covered.
- **Voice latency**: replies take about 1.2 s on our side; Vapi's default
  voice and speech-to-text add roughly 1–1.5 s.
- **The phone number is US-only**; the browser call works anywhere.

## Repository map

```
src/app/page.tsx                         voice-only call screen
src/app/tickets/                         read-only tickets page
src/app/api/vapi/chat/completions/       the endpoint Vapi calls (and test mode)
src/lib/brain.ts                         one caller turn: gates race the agent
src/lib/gates.ts                         yes/no gates with confidence
src/lib/agent.ts                         the agent: prompt, tools, hours rule, guards
src/lib/llm.ts                           the only file that knows the model provider
src/lib/tickets/                         ticketing interface + Trello and in-memory adapters
src/lib/city-requests.ts, city-events.ts live city data (311, calendar)
src/cities/bellevue/                     the city pack (config, knowledge, pages)
scripts/scrape-city.ts                   builds the website snapshot
evals/                                   scenarios, runner, latest report
```
