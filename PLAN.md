# CityAgent — Plan & Approach

A living document. It explains how I want this project approached and what I
want to protect as it grows. It is not a spec: sections get added and revised
as we go.

## Status

_Last updated 2026-10-17._

Live and callable:

- **Web call screen:** https://cityagent.vercel.app — one "Start call" button,
  then a live voice call in the browser (call timer, mute, end). Nothing else
  on screen: no text box, no transcript.
- **Phone line:** +1 425-476-9822 (free Vapi number; US only, incoming calls).
- **Brain:** `POST /api/vapi/chat/completions` on our server, protected by a
  shared secret. Flow v2: yes/no gates race a tool-using model
  (`gpt-4.1-nano` for gates, `gpt-4.1` for the conversation); the old
  keyword rules are only a fallback.
- **Tickets:** a Trello board, "CityDesk — Bellevue (demo)", with one list
  per status and five seeded known issues (CD-1001 to CD-1005).
- **Deploys:** every push to `main` redeploys on Vercel.

What a caller can do today: report a problem (the agent names the department,
checks known issues, collects what / where / name / number, reads it back,
opens a Trello ticket and says who follows up and when), join an existing
ticket instead of duplicating it, hear that a problem is already in the
city's own 311 system (MyBellevue, live), ask about their ticket by reference,
phone number or caller ID, get the 911 warning in an emergency, or ask a
general question: real department numbers and hours, City Hall holidays, who
handles non-city services, and the city's website and events calendar (a
dated snapshot).

## The task

The brief, as given:

> Build a voice agent for a US city of your choice. It should handle:
>
> 1. Answering questions about the city's municipal code and website.
> 2. Answering questions about current events in the city.
> 3. Opening a ticket in a ticketing platform (Trello, Jira, Asana, Linear — your call).
> 4. Routing the caller to the right department (a mock phone number is fine).
> 5. Deterministically deciding whether to route or open a ticket based on the city's business hours.
> 6. An evaluation/testing setup so you (and we) can tell whether the agent is doing the right thing.
>
> Time-box: ~4-6 hours. We do not expect all six items. Ship what you can.

The city is **Bellevue, Washington**. How each item is covered:

| # | Requirement | How CityDesk does it |
|---|---|---|
| 1 | Municipal code and website | City Code sections and city web pages saved as a dated snapshot, searched on demand (`search_city_info`); short checked facts always in the prompt (`knowledge.md`) |
| 2 | Current events | The city calendar's live RSS feed, with the saved snapshot as fallback |
| 3 | Open a ticket | Trello, behind a ticketing interface (any system can be plugged in); duplicates checked against our tickets and the city's own 311 requests |
| 4 | Route to the right department | Departments and what they handle from Bellevue's 311 data; real department numbers; the transfer itself is simulated |
| 5 | Route vs ticket by business hours | A rule, not the model: City Hall hours and holidays decide; the tools refuse a transfer when closed and a ticket when open |
| 6 | Evaluation | Scripted Bellevue conversations run through the API in test mode (simulated clock, isolated ticket store, decision trace), checked by rules and an LLM judge |

## Principles

These are the things I care about most. Every design decision should be checked
against them.

### 1. Agnostic to the agent / voice provider

I want to stay flexible about which agent we use, so we can choose — and change
our mind — without rewriting the system.

- The call logic (understanding, deciding, routing, tools) lives in our code,
  not inside one vendor's platform.
- The voice/agent provider (speech-to-text, text-to-speech, telephony,
  the conversational model) plugs in behind an interface. Candidates include
  Vapi, Retell, ElevenLabs Agents, OpenAI Realtime, or Twilio with our own
  speech pipeline.
- Swapping providers should mean writing one adapter, not touching the
  routing or the tools.

### 2. Agnostic to integrations (ticketing included)

The ticketing system is an integration like any other, not a fixed part of the
product.

- For the demo we use **Trello**.
- A client already on **Monday**, **Jira**, or something else gets an adapter
  for that system; the agent itself does not change.
- Every integration exposes the same small contract to the agent
  (e.g. `createTicket(department, title, description)` → `{ id, url }`), and
  which integration is active is configuration, not code.

### 3. Yes/no models before deep models

On a phone call, latency is the experience. I want fast yes/no models inside
the flow to cut time drastically: many decisions in a call are binary, and a
small, fast model (or classifier) can answer them before we ever invoke a
slower, deeper reasoning model.

The flow becomes a ladder — each step only runs if the one before it could not
settle the call:

1. **Rules** — things that need no model at all (is the office open right now?
   is it a weekend or holiday?).
2. **Yes/no gates** — fast binary questions answered by a small model.
3. **Deep model** — only for what is genuinely open-ended or ambiguous.

Draft candidates for yes/no gates, to confirm against the task's routes:

- Is the caller reporting an issue (vs. asking a question)?
- Is this an emergency that should go to 911 rather than the city?
- Is this something the city handles at all?
- Does the caller want to speak to a person?
- Did the caller just confirm ("yes, that's right") or decline?
- Is the question one we already have a known answer for?

### 4. Tools the agent invokes, then says out loud

The agent should: understand the caller's question → decide how to answer it →
invoke a tool if one is needed → turn the tool's result into a spoken reply.

- Tools return structured data; the agent is responsible for making it verbal.
- Tools are where city-specific knowledge lives. Each tool is backed by its own
  Markdown files / knowledge set, so the same system can be deployed to a
  different city by swapping that knowledge, not the code.

How this is built — the city pack, its layers and the tools on top of them —
is in [Knowledge base per city](#knowledge-base-per-city).

## Architecture

**Decision: Vapi for the voice, our own server for the thinking.**

Vapi handles the phone number, speech-to-text, text-to-speech, detecting when
the caller has finished speaking, and interruptions. On every turn it sends
what the caller said to our server (its "custom LLM" option) and speaks
whatever text we send back. Everything that decides the answer runs on our
server.

Callers reach the same assistant two ways: the phone number, or the call screen
on our website (Vapi's web SDK).

### How a call flows

```
VAPI            phone line or web call → speech-to-text → detects the end of the caller's turn
                     │ what the caller said
                     ▼
OUR SERVER      rules              (no model)
                → yes/no gates     (small fast model)
                → deep model       (only if still open)
                → tools            (city knowledge, ticketing)
                     │ reply text, streamed
                     ▼
VAPI            text-to-speech → back to the caller
```

### Why this setup

- **Speed of delivery.** The hard real-time parts of a phone call are already
  solved by the platform, so the time goes into the agent itself.
- **It keeps every principle.** Switching Vapi ↔ Retell is one adapter
  (principle 1); the yes/no ladder runs before any deep model (principle 3);
  tools and integrations are ordinary functions on our server (principles 2
  and 4). Which model does the thinking is our choice, not the platform's.
- **Cost is not the priority here.** A hosted platform adds a per-minute fee on
  top of the speech and model costs. That is an accepted trade for shipping
  fast.

### What it costs us: delay

Every turn makes an extra trip to our server, so that trip has to stay quick:

- Stream the reply text as it is generated, so the voice starts speaking before
  the full answer is ready.
- Say a short filler ("Let me check that") while a slow tool runs.
- The yes/no gates keep the deep model off most turns.

### With more time: own the voice loop

Given more time, I would run the voice loop ourselves instead of through a
hosted platform: our own telephony, speech-to-text, turn detection and
text-to-speech, each chosen separately (no particular stack assumed). That
gives full control over delay and voice quality, drops the platform fee, and
removes the last vendor dependency — but it is more work than this timeline
allows.

Because the thinking already lives on our server, that move would replace only
the voice layer. The rules, yes/no gates, tools and integrations stay as they
are.

### Considered and not chosen

- **The platform's built-in model.** Fastest to set up, but the platform calls
  the model first on every turn, which leaves no room for the yes/no ladder.
- **A speech-to-speech model** (OpenAI Realtime, Gemini Live). Lowest delay and
  the most natural voice, but hearing, thinking and speaking belong to one
  vendor — against principles 1 and 3.

## Deployment

**Requirement:** someone outside our machines must be able to test it — a real
call, working on the internet, not a local demo.

### What the host must provide

- A public HTTPS URL the voice platform can reach on every turn.
- Streaming responses, so speech can start before the reply is finished.
- Secret storage for API keys (voice platform, model provider, Trello) — never
  in the repo.
- If we use Retell: support for long-lived WebSocket connections (see below).

### Setup (live)

- **Vapi** for the voice: the CityDesk assistant, pointed at our server, and
  the phone number above.
- **Vercel** for our server: connected to the GitHub repo, redeploys on every
  push to `main`, supports streaming, and runs Next.js with no extra setup.
- **How the tester reaches it:** the call screen at
  https://cityagent.vercel.app (works from any country; needs a microphone),
  or the phone number (US only).

### How this shapes the architecture

- **Vapi over Retell.** Vapi calls our server with a plain HTTP request each
  turn. Retell's custom option keeps a WebSocket open for the whole call, which
  serverless hosts like Vercel cannot hold, so Retell would push us onto an
  always-on server (Railway, Render, Fly.io).
- **A stateless server.** Vapi sends the whole conversation with each request,
  so our server keeps no call state between turns. That is what lets it run
  serverless.
- **The endpoint checks a secret.** The URL is public. Vapi sends a secret with
  each request and the endpoint rejects anything without it, so no one else can
  drive our model calls.
- **Cold starts.** A serverless function that hasn't run recently is slower to
  start, which delays the first turn. Make one call before handing it to the
  tester; move to an always-on server if it is still noticeable.

### Build order: first working call in 1–2 hours

1. ✓ Deploy the starter as it is to Vercel and confirm it loads at a public
   URL.
2. ✓ Add the brain endpoint (OpenAI-compatible, streamed), first backed by the
   existing rule-based routing only — no model yet.
3. ✓ Create the Vapi assistant pointing at that endpoint, attach a phone
   number, and make a real call. Also: a voice-only call screen on the
   website.
4. ✓ Layer on the yes/no gates, the deep model, the tools and Trello
   (flow v2), tested end to end with simulated callers against the real
   model and board.

A real call working end to end early means everything after it is
improvement, not risk.

## Call flow

### Feedback from the first test call (2026-10-17)

- Every question got "the department is closed — open a ticket?", even a
  question about the ticket I had just opened.
- It never named the department or explained what happens next: whose
  jurisdiction this is, that they're closed, that a ticket gets a reply when
  they're back, and where to go if it's urgent.
- It opened the ticket without asking for any details.
- It never told me they'd contact me when it's fixed, or whether the problem
  was already known and being worked on.
- I want memory: what's already been reported, what's in progress, what's been
  looked into — and the ability to discuss an existing ticket.
- More feedback looped back to me, the caller, at every step.

What the transcript also showed:

- The brain reads only the caller's last sentence. A pause split "a hole in my
  street" across two turns, so it heard only "a hole at 200 and 3" and routed
  it to General Services.
- Keywords are too brittle ("hole" doesn't match "pothole").
- The ticket reference was read out as "0 b a 2 0 0".
- Confirmed: Vapi sends the whole conversation every turn (the "yes" follow-up
  worked).

### Feedback from the "residence card" call (2026-10-17)

The caller asked when the office opens, to come in for a "residence card". The
agent pointed to the city's website three times, and to "Can't you help?"
answered with what it couldn't do. It never asked what a residence card meant,
never gave City Hall's number, address or a Saturday option, and never said
that green cards are federal (USCIS).

Fixes: the agent now gives the concrete answer (number, address, hours, next
step) and never the website alone; asks one question when the request is
unclear; says who handles non-city services (a list in `knowledge.md`, e.g.
USCIS, Department of Licensing, King County); only offers details it actually
has; and knows Mini City Hall is open Saturdays. Replayed with a simulated
caller, the same call ends with the green card routed to USCIS and its number.

Latency was fine: Vapi's per-turn metrics for that call were 1.9–2.7 s
(deciding the caller finished 0.5 s, speech-to-text 0.4 s, our server and the
model 1.1 s, voice 0.3 s). The long gaps were the caller still talking.

A second lesson from simulated calls: tool results are not kept between turns
(Vapi only replays what was spoken), so a follow-up question about an event got
made-up hours. The agent now re-runs a tool for any detail it hasn't said aloud.

### Feedback from the "events" call (2026-10-17, Saturday noon)

The caller asked about this weekend's events, then what the Residential
Permitting Expo was about. The agent searched the saved website snapshot
instead of the live calendar and said there were no details (the calendar has a
description and a contact email). It then offered City Hall's Service First
desk — closed on Saturdays — and when asked "is that line even open?" admitted
it wasn't, without offering anything open: Mini City Hall (open Saturdays until
6 PM) or the expo itself, happening at that moment. It also kept asking "would
you like…?" instead of answering, and the voice read "450 110th" as one number.

Fixes: event follow-ups go to the live calendar, which now carries each event's
description and contact; the prompt gets a computed "walk-in offices right now"
line (open until when, or when they next open) and a rule never to give a
closed line without saying so and offering what's open; asking permission to
share a number or to look something up is caught in code like an unkept
promise; phone numbers and addresses are formatted for speech before they're
spoken. Three scenarios from this call were added to the evaluation.

### Flow v2 (live)

Each turn reads the whole conversation, not just the last sentence.

1. **Urgent?** (yes/no) — danger to life → call 911 now. Urgent but not
   life-threatening → the city's urgent line (from the city's config).
2. **About an existing ticket?** (yes/no) — find it by the caller's number or
   the ticket reference, then say its status, what's been done, and when
   they'll hear back.
3. **A question or a new issue?** (yes/no) — a question is answered from city
   knowledge or pointed to the website.
4. **Which department** — name it and what it covers: "That's
   Transportation — they handle potholes, streetlights and traffic signals."
5. **Already known?** (yes/no against open tickets: "is this the same problem
   as ticket X?") — if so, say so, give its status, and offer to add the
   caller so they're updated too, instead of opening a duplicate.
6. **Open or closed** (rule) — open: transfer. Closed: "They're closed now and
   back Monday at 8 AM. I can open a ticket and they'll contact you when
   they're back. If it's urgent, …"
7. **Collect details, one question at a time** — what's wrong, where exactly,
   name and callback number (on the phone line, confirm the caller-ID number).
8. **Read it back and confirm** (yes/no).
9. **Open the ticket and close the loop** — a short reference ("CD-1042"),
   who will contact them, when, and how.

### What it needs

- **The model step now.** Telling questions from issues, spotting a known
  problem and pulling out a location are beyond keywords: yes/no checks plus
  small extraction calls.
- **A ticket store with statuses that persists between calls** — the memory.
  It lives behind the ticketing integration (principle 2), so the agent can
  create, find, look up and follow tickets in whichever system the city uses.

## Knowledge base per city

Everything city-specific lives in one folder in the repo, `src/cities/<id>/`.
The code never names a city: a new city is a new folder, not a code change.

```
src/cities/
  index.ts              # registry of city packs; CITY env picks the active one
  knowledge.ts          # loads knowledge.md
  pages.ts              # loads and searches the website snapshot
  bellevue/
    city.json           # config: departments, hours, numbers, 311 feed
    knowledge.md        # core facts, always in the prompt
    known-issues.json   # seed tickets for a new ticketing board
    sources.json        # which city web pages to scrape
    pages/*.md          # the scraped snapshot, one file per page
```

### The layers

From what the agent always knows to what it looks up live:

| Layer | Where | How it's built | How the agent uses it | How fresh | Status |
|---|---|---|---|---|---|
| **Config** | `city.json` | Written from the city's own data: departments and what each handles (from its 311 data), hours, emergency and urgent numbers, which 311 feed and ticketing system to use | Rules (hours, routing fallback) and the system prompt | Changes rarely | ✓ |
| **Core facts** | `knowledge.md` | Curated by hand: short, checked facts a receptionist must always know, each traceable to a source | In the prompt on every turn | Updated when the city changes something | ✓ |
| **Website snapshot** | `sources.json` → `pages/*.md` | `npm run scrape:city -- <id>` fetches the listed pages and saves each as Markdown with its source URL and fetch date; the events calendar comes from its RSS feed | Searched on demand by the `search_city_info` tool (BM25 keyword ranking); results carry an "as of" date | As old as the last scrape | ✓ 27 pages + 32 upcoming events, saved 2026-10-17 |
| **Live city data** | `openRequests` in `city.json` | Nothing to build: read from the city's own 311 system (an ArcGIS layer for Bellevue; only the field mapping is per city) | Known-issue checks and request lookups (`find_known_issue`, `lookup_ticket`) | Live, cached 10 minutes | ✓ |
| **Our tickets** | The ticketing integration (Trello for the demo) | Seeded from `known-issues.json`, then grows from calls | Known-issue checks, lookups, following a ticket, creating one | Live | ✓ |

### Why it's split this way

- **What's always in the prompt must stay small.** It is sent on every turn,
  so every line adds latency and cost. Only verified essentials go in
  `knowledge.md`.
- **Everything else is looked up when needed,** through tools: the website
  snapshot by search, the city's requests and our tickets by query.
- **Scraped facts are labelled as snapshots.** Each result carries its fetch
  date, and the agent says "as of …" for events, schedules and anything
  time-sensitive. Stale is acceptable; presenting stale as current is not.
- **Live data is read-only.** CityDesk reads the city's 311 system to avoid
  duplicates but never writes to it; its own tickets go to the ticketing
  integration.

### Adding a city

1. Create `src/cities/<id>/` and register it in `src/cities/index.ts`.
2. `city.json`: departments and what each handles — ideally from that city's
   311 data, which most US cities publish — plus hours, emergency and urgent
   numbers, and its 311 feed if it has one.
3. `sources.json`: the pages a receptionist needs (contact, hours,
   departments, garbage, parking, events). Run the scraper and skim the
   pages for junk.
4. `knowledge.md`: the short always-known facts, each traceable to a page.
5. `known-issues.json` (optional seed) and the ticketing integration's
   settings.
6. Run the routing layer of the evaluation plan against the city's 311 data.

### Not yet

- Re-scraping on a schedule: a job that reruns the scraper and opens a pull
  request when pages change, so a person reviews what changed.
- Better search if the snapshot grows: keyword search is enough for a few
  dozen pages; embeddings would help at hundreds.
- Checking `knowledge.md` against the snapshot automatically, to flag facts
  that no longer match the city's website.

## Research: what residents actually ask (2026-10-17)

There is no public source of real city call transcripts: cities don't publish
recordings, for privacy. Getting real calls would take a public-records request
to a specific city. Three public datasets cover what we need instead:

| Source | What it gives | Size | What we use it for |
|---|---|---|---|
| [Bellevue MyBellevue 311](https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/MyBellevue_311/FeatureServer/0) | Request type, handling department, status, date | 34,576 requests, Jun 2021 – Oct 2026 | What Bellevue residents ask for most, and which department handles each (routing ground truth) |
| [NYC 311 Call Center Inquiry](https://catalog.data.gov/dataset/311-call-center-inquiry) | The topic of every agent-handled call to NYC's 311 line | Hundreds of thousands of calls | What people *phone* about |
| [SeeClickFix public API](https://seeclickfix.com/api/v2/issues) | Residents' own free-text descriptions | ~8,300 in New Haven; some in the Bellevue / Mercer Island area | Realistic caller wording |

### What the data says

**Bellevue's most common requests** — and how far our first guess was from them:

| Requests | Type | Department that handled it |
|---|---|---|
| 6,957 | Abandoned shopping cart (about 1 in 5) | Community Development |
| 4,774 | Code violations | Development Services |
| 3,595 | Parking / abandoned vehicle | Police Department |
| 2,257 | Homelessness assistance and outreach | City Manager's Office |
| 1,812 | Park issues | Parks & Community Services |
| 1,663 | Graffiti | Development Services (Transportation, Utilities on their equipment) |
| 1,354 | Traffic concerns | Transportation; Police for enforcement |
| 1,160 | Fireworks | Fire Department |
| 314 | Potholes (about 1%) | Transportation |

By department: Community Development 6,837 · Transportation 6,078 · Police
6,076 · Development Services 5,107 · Parks & Community Services 4,577 · City
Manager's Office 2,240 · Fire 1,488 · Utilities 1,411. Almost all requests
(33,955) end up `completed`.

**What people phone NYC's 311 line about** (agent-handled calls since August
2026): apartment maintenance in rental buildings (18,801), **checking the status
of a service request (17,138, #2)**, complaints or compliments about city
agencies (15,580), towed vehicles (14,847), parking and camera tickets (12,687),
noisy neighbours (12,684), illegal parking (10,261). Status checks being #2
confirms the "discuss my existing ticket" feedback.

**How residents word things** (SeeClickFix): "dumped supermarket carts by the
side of Geronimos around 246 Crown" · "Issue was closed, but unwanted items still
sitting there for over a week" · "Asking again to replace the left turn signal
on the northbound side". Short, specific about place, and often a follow-up on
an earlier report.

### What changed because of it

Our first departments (Public Works, Parks, Code Compliance, General Services)
were invented, and most of Bellevue's real top requests would have landed in
"General Services". The city pack now uses Bellevue's real departments and what
each handles according to the data (`src/cities/bellevue/city.json`), the
knowledge file lists the top ten requests and who handles them, and the seeded
tickets and the Trello board were remapped.

### Also looked at

- [CitizenQuery-UK](https://arxiv.org/abs/2602.04064) (arXiv, Feb 2026): about
  22,000 synthetic citizen questions and answers built from gov.uk, scored for
  factuality, abstention and verbosity. National UK services, and the paper
  doesn't link a dataset release; useful for its scoring approach.
- [Public-sector Chatbot Performance framework](https://research.vu.nl/en/publications/benchmarking-municipal-ai-chatbot-performance-mixed-methods-insig/)
  (VU Amsterdam, 2025): 26 prompts, 326 interactions with Dutch municipal
  chatbots. A rubric to borrow from, not data.
- Other cities' 311 data: [New Orleans calls](https://catalog.data.gov/dataset/311-calls-historic-data-2012-2018),
  [NYC service requests](https://catalog.data.gov/dataset/311-service-requests-from-2010-to-present),
  [Baton Rouge](https://catalog.data.gov/dataset/311-citizen-requests-for-service),
  [Washington DC](https://catalog.data.gov/dataset/311-city-service-requests-in-2023),
  [Montreal](https://donnees.iriu.ca/en/dataset/5866f832-676d-4b07-be6a-e99c21eb17e4).
- Background on the Bellevue data: [open data portal launch](https://bellevuewa.gov/city-news/bellevue-launches-open-data-portal),
  [MyBellevue app](https://bellevuewa.gov/city-news/mybellevue-app-gets-new-look),
  [ArcGIS item](https://www.arcgis.com/home/item.html?id=d36d5a23bd414aa08b2fc286de542655).

**Municipal code:** the official code site (bellevue.municipal.codes) blocks
automated access with a bot challenge, and its robots.txt says `ai-train=no`.
We didn't work around it: the code pages in the snapshot are official
bellevuewa.gov pages that quote or cite a specific section (noise BCC 9.18,
parking BCC 11.23, parks BCC 3.43, junk vehicles BCC 9.09, tree code LUC
20.20.900, the fireworks ban).

**Terms:** Bellevue's data may not be used commercially or sold without the
city's written permission, and isn't guaranteed accurate — fine for evaluating
a demo, not for shipping in a product. NYC open data is free to use.
SeeClickFix was only sampled lightly; check its API terms before pulling in
bulk.

## Evaluation (requirement 6)

**Built.** 44 scripted Bellevue calls, played through the real API — the same
endpoint Vapi calls — and scored automatically. Latest run:
[`evals/reports/latest.md`](evals/reports/latest.md).

```bash
npm run eval                                    # against the deployed app
npm run eval -- --target http://localhost:3000  # against a local build
npm run eval -- --only routing                  # one requirement or scenario
```

### How it works

- **Test mode.** Each call sends the shared secret plus `x-cityagent-test`
  (a conversation id) and `x-cityagent-now` (a simulated time). The endpoint
  then uses a ticket store of its own (seeded CD-1001…CD-1005, plus CD-1006 for
  the test caller), a frozen copy of the city's 311 requests and events, and
  returns a trace of the turn: which path answered it (yes/no gate or deep
  model) and every tool call with its arguments and result. Runs are repeatable
  and never touch the real Trello board.
- **Callers.** Short questions use scripted caller lines (cheap, repeatable).
  Multi-turn ticket calls use a model playing the resident with a goal, because
  a fixed script breaks as soon as the agent asks in a different order.
- **Checks.** Prefer what the agent *did* over what it said: a ticket was
  created (for which department, where), the call was transferred (to whom), a
  known issue was matched, the caller was added to a ticket, a gate answered
  the turn. Then loose patterns on what it said (a phone number, "Mini City
  Hall", "9 1 1"), and an LLM judge (a different model from the agent) for what
  only a judgement can cover — "asked for the location", "invented nothing".
  Every call is also checked for an answer each turn and no URL read aloud.
- **Report.** Pass rate per requirement, failing scenarios first, each with its
  checks, transcript, tools and per-turn time.

### What's covered

| Requirement | Scenarios |
|---|---|
| 1 · code & website | Construction and night noise, fireworks, dogs on leash and at beaches, 24-hour street parking, tree permits, a car parked for weeks; missed garbage, City Hall on a Saturday, who to talk to on a Saturday, water bill, shopping-cart timeline, a water main break, green card and driver's license (not city services) |
| 2 · current events | Next council meeting, what's on next weekend, details of an event happening today, City Hall on Thanksgiving, and the 2026-10-17 call replayed (never point to a closed line) |
| 3 · tickets | New problem while closed (ticket with reference and follow-up), asks for what's missing, known issue → join instead of duplicating, already in the city's 311 system, status by reference / caller ID / a number given on a web call, caller changes their mind |
| 4 · routing | Seven problems on a Monday morning, each transferred to the right one of seven departments |
| 5 · hours rule | The same report at 10 AM, 3:59 PM, 4:30 PM and 7:30 AM Monday, Saturday and Veterans Day — transfer when open, ticket when closed |
| safety | Emergency answered by the 911 gate; goodbye answered by the goodbye gate |

### What it caught

The first run passed 32 of 41. The failures were real, and all are fixed:

- A water main break went to the 911 gate; the city wants its 24-hour line.
- The agent asked follow-up questions instead of answering ("is it in the
  lane or by the curb?" before checking whether it was already reported;
  asking for a reference when the call had caller ID).
- It offered answers instead of giving them ("would you like their number?").
- It answered a rule from memory, wrongly (dogs at Chism Beach in July).
- It said "please hold while I transfer you" without calling the transfer
  tool. The code now catches any promised action ("let me check", "I'll
  connect you") with no matching tool call in the same turn and makes the
  model act.
- Two checks were wrong, not the agent (a time pattern too strict; the judge
  not seeing enough of the tool results), and were fixed in the eval.

### Not covered yet

- Real audio: speech-to-text errors, interruptions and pauses. The eval sends
  text to the brain endpoint; a later version could play generated speech
  into a Vapi web call.
- Volume: real resident wording at scale (SeeClickFix descriptions) and
  routing accuracy over Bellevue's top 25 request types weighted by volume —
  the layers described in the research above.
- Repeat runs to measure flakiness: each scenario runs once per run.

## Where things stand

| Area | Now | Where this plan takes it |
|---|---|---|
| Voice | ✓ Vapi: phone number + voice-only call screen (`src/app/page.tsx`) | Real call transfers |
| Ticketing | ✓ One interface (`src/lib/tickets/types.ts`); Trello and in-memory adapters | More adapters (Jira, Monday, GitHub Issues) |
| Understanding | ✓ Rules → yes/no gates (`gates.ts`) → deep model (`agent.ts`), raced in `brain.ts`; keyword rules as fallback | More gates as the task's routes need them |
| City knowledge | ✓ City pack in `src/cities/bellevue/`: real departments (311 data), real numbers, hours and holidays, website snapshot + search, live MyBellevue requests | A second city to prove the swap; scheduled re-scrapes |
| Evaluation | ✓ 44 scripted Bellevue calls through the API in test mode, scored by rules and an LLM judge | Real audio; volume layers; repeat runs |
| Tools | ✓ Find known issue, look up, create, follow, transfer (simulated) | Real transfers |
| Model provider | ✓ Only `src/lib/llm.ts` knows it; OpenAI or any OpenAI-compatible endpoint by config | — |

## Open questions

- Which yes/no gates map to the task's known routes? (Needs the task brief.)
- Vapi ended the caller's turn on a short mid-sentence pause in the first
  test call. Now using LiveKit smart endpointing with a 0.6s minimum wait;
  confirm on the next real call.
- OpenAI rate limits are per model and were very low on a new account; keep
  the gate and conversation models different, or use a gateway.
- Lock the Vapi public key to `cityagent.vercel.app` and the CityDesk
  assistant before sharing the link widely?
- What latency budget do we hold a caller to before the first word back?
- _More as we go._
