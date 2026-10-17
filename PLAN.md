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
ticket instead of duplicating it, ask about their ticket by reference or
caller ID, get the 911 warning in an emergency, or ask a general question
answered from the city's knowledge file.

## The task

An automated phone system for a city: a caller rings in, the agent understands
what they need, and either answers, routes them, or opens a ticket. The task
defines a set of known questions and routes.

> _To add: the task brief and its list of known questions / routes._

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

Draft shape of a city "pack":

```
cities/
  bellevue/
    city.json          # departments, hours, phone numbers, active integrations
    knowledge/
      departments.md
      faq.md
      events.md
```

Draft tool list (from what the starter already does): find the right
department, check office hours, answer from city knowledge, transfer the call,
create a ticket.

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

**Terms:** Bellevue's data may not be used commercially or sold without the
city's written permission, and isn't guaranteed accurate — fine for evaluating
a demo, not for shipping in a product. NYC open data is free to use.
SeeClickFix was only sampled lightly; check its API terms before pulling in
bulk.

## Evaluation plan (v1 — not built yet)

**Goal:** measure whether CityDesk handles the calls a real city gets, the way
the call flow says it should, and catch regressions when the prompt or models
change.

Four layers, cheapest first:

1. **Routing coverage** (no conversation). Bellevue's top ~25 request types and
   the department that handled each are the ground truth. One plain caller
   sentence per type ("There's an abandoned shopping cart outside my
   building"); check the department the agent names in its first reply.
   Accuracy is weighted by request volume, so carts count twenty times more than
   potholes. (The keyword fallback already has a unit test for the top seven.)
2. **Real wording, first turn.** About 100 SeeClickFix descriptions, Bellevue
   area first, each labelled with a Bellevue department through its category.
   Each is the caller's first sentence; the reply must name the right
   department and what it covers, ask one question for what's missing (usually
   the exact place), invent nothing, read out no URL, and stay within two
   sentences.
3. **Phone-specific asks.** The NYC info-line topics that apply to any city:
   checking a ticket's status, towed cars, bulky items, noisy neighbours,
   parking tickets, complaints about city staff. Expected: look it up, route
   it, or say honestly that the city's website has it — never make it up.
4. **Full conversations.** The simulated-caller harness already used for
   testing (a model plays the resident with a goal and talks to the real
   endpoint turn by turn), seeded from 1–3 plus the flows from our feedback:
   new issue while closed, known issue (join, don't duplicate), calling back by
   caller ID and by reference, emergency, urgent but not dangerous, a caller who
   changes their mind, a caller who pauses mid-sentence.

Scoring for the full conversations, built from the feedback:

| Check | How it's measured |
|---|---|
| Names the department and what it covers | Judge |
| When closed: says when they reopen, the urgent line, 911 | Judge |
| Collects what / where / name / number, one at a time | Judge + tool arguments |
| Reads back and gets a yes before creating | Order of tool calls in the turn logs |
| Gives the reference, who follows up, and when | Transcript match + judge |
| No duplicate when the issue is already known | Ticket store state |
| The ticket matches what the caller said | Ticket store vs scenario |
| Nothing invented | Judge, with the city knowledge as reference |
| First words within 1.5 s; 95% of turns within 3 s | Turn logs |

**How it runs:**

- Against the in-memory ticket store with fresh seeds per scenario, so runs are
  repeatable and don't fill the Trello board; one smoke run against Trello.
- The judge is a different model from the agent, and logs a reason for every
  check, so a failure can be read rather than guessed at.
- Output: a pass rate per check and the failing transcripts, saved per run so a
  prompt or model change can be compared with the last run.
- Size for v1: ~25 routing cases, ~100 first turns, ~15 phone asks and ~20 full
  conversations — minutes and a few dollars per run.

**Not in v1:** real audio. The harness sends text to the brain endpoint, so
speech-recognition errors, interruptions and pauses aren't covered. A later
version could play generated speech into a Vapi web call.

## Where things stand

| Area | Now | Where this plan takes it |
|---|---|---|
| Voice | ✓ Vapi: phone number + voice-only call screen (`src/app/page.tsx`) | Real call transfers |
| Ticketing | ✓ One interface (`src/lib/tickets/types.ts`); Trello and in-memory adapters | More adapters (Jira, Monday, GitHub Issues) |
| Understanding | ✓ Rules → yes/no gates (`gates.ts`) → deep model (`agent.ts`), raced in `brain.ts`; keyword rules as fallback | More gates as the task's routes need them |
| City knowledge | ✓ City pack in `src/cities/bellevue/` (config, `knowledge.md`, known issues), with Bellevue's real departments from its 311 data | A second city to prove the swap |
| Evaluation | Simulated-caller harness used for manual testing | The v1 eval above |
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
