# CityAgent — Plan & Approach

A living document. It explains how I want this project approached and what I
want to protect as it grows. It is not a spec: sections get added and revised
as we go.

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

**Decision: a hosted voice platform (Vapi or Retell) for the voice, our own
server for the thinking.**

The voice platform handles the phone number, speech-to-text, text-to-speech,
detecting when the caller has finished speaking, and interruptions. On every
turn it sends what the caller said to our server (its "custom LLM" option) and
speaks whatever text we send back. Everything that decides the answer runs on
our server.

### How a call flows

```
VAPI / RETELL   phone line → speech-to-text → detects the end of the caller's turn
                     │ what the caller said
                     ▼
OUR SERVER      rules              (no model)
                → yes/no gates     (small fast model)
                → deep model       (only if still open)
                → tools            (city knowledge, ticketing)
                     │ reply text, streamed
                     ▼
VAPI / RETELL   text-to-speech → phone line
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

### Recommended setup (to confirm)

- **Vapi** for the voice, with a phone number from Vapi.
- **Vercel** for our server: it imports the GitHub repo, redeploys on every
  push to `main`, supports streaming, and runs Next.js with no extra setup.
- **How the tester reaches it:** they call the phone number, or press a "Call"
  button on the deployed page (Vapi's web SDK). The button matters if the
  tester is outside the US, where calling a US number costs them.

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

1. Deploy the starter as it is to Vercel and confirm it loads at a public URL.
2. Add the brain endpoint (OpenAI-compatible, streamed), first backed by the
   existing rule-based routing only — no model yet.
3. Create the Vapi assistant pointing at that endpoint, attach a phone number,
   and make a real call.
4. Then layer on the yes/no gates, the deep model, the tools and Trello.

A real call working end to end early means everything after it is
improvement, not risk.

## Where the starter code stands

| Area | Starter today | Where this plan takes it |
|---|---|---|
| Voice | Browser Web Speech only (`src/app/page.tsx`) | Real phone calls through Vapi or Retell, with our server as the brain |
| Ticketing | Trello or mock, hard-wired in `src/lib/tickets.ts` | Integration interface; Trello is one adapter |
| Understanding | Keyword matching + regex (`src/lib/routing.ts`) | Rules → yes/no gates → deep model |
| City knowledge | Bellevue hard-coded in `src/lib/city.ts` | Per-city pack of config + Markdown |
| Tools | None; the API route decides and answers directly | Agent-invoked tools with verbal replies |

## Open questions

- Vapi or Retell for the demo? (Hosting leans Vapi — see Deployment.)
- Hosting: Vercel, or another host that meets the needs under Deployment?
- Will the tester call from inside the US, or do we need the browser call button?
- Which yes/no gates map to the task's known routes? (Needs the task brief.)
- What latency budget do we hold a caller to before the first word back?
- _More as we go._
