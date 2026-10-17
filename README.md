# CityDesk — Threefold AI Developer Task (starter)

A **prototype**, not a finished municipal AI receptionist, built with Next.js and TypeScript. Designed for rapid iteration and architectural discussion.

## What's included

- Voice-only call screen: one button starts a live browser call with the CityDesk assistant (Vapi web SDK); the same assistant answers a real phone number
- Deterministic department selection and business-hour routing with Pacific timezone
- Human-readable decisions and optional mock/Trello ticket creation
- City source links, without inventing municipal laws or current events
- Unit tests covering routing, weekends, boundaries, and information requests
- Simulated clock and interactive call scenario examples

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000. Run `npm test`, `npm run typecheck`, and `npm run build` before deploying.

Live: https://cityagent.vercel.app (call screen) and +1 425-476-9822 (phone). See `PLAN.md` for the approach and current status.

## Configuration

Copy `.env.example` to `.env.local`. On Vercel the same variables live in Project Settings → Environment Variables; the `NEXT_PUBLIC_` ones are read at build time, so redeploy after changing them.

| Variable | Purpose |
|---|---|
| `VAPI_LLM_SECRET` | Shared secret Vapi sends with every turn; the brain endpoint rejects requests without it |
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | Browser-safe Vapi key for the call screen |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | The Vapi assistant the call button dials |
| `OPENAI_API_KEY` | Model provider key; without it, replies fall back to the rule-based routing |
| `LLM_GATE_MODEL`, `LLM_AGENT_MODEL` | Optional model overrides (defaults `gpt-4.1-nano` for yes/no gates, `gpt-4.1` for the conversation; rate limits are per model, so keep them different) |
| `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID` | Optional; Trello as the ticketing system. `npm run setup:trello` creates the board and prints the ID. Without all three, tickets live in memory and are **not persistent** |
| `LLM_BASE_URL`, `LLM_API_KEY` | Optional; any OpenAI-compatible provider instead of OpenAI directly (e.g. Vercel AI Gateway, with models named `openai/gpt-4.1`) |
| `CITY` | Optional; which city pack in `src/cities` to use (default `bellevue`) |

No real transfers occur yet.

## Vapi setup

- **Assistant model:** provider `custom-llm`, URL `https://<host>/api/vapi`. Vapi appends `/chat/completions` itself.
- **Credential:** a `custom-llm` credential whose API key equals `VAPI_LLM_SECRET`; Vapi sends it as `Authorization: Bearer`.
- **Phone number:** a free Vapi number assigned to the assistant.

## Architecture

- `src/cities/<id>/`: a city pack — `city.json` (departments, hours, urgent line), `knowledge.md` (what callers can be told), `known-issues.json` (seed tickets)
- `src/lib/city.ts`: the active city's config
- `src/lib/routing.ts`: explicit routing and schedule rules (open now, next opening)
- `src/lib/tickets/`: the ticketing contract (`types.ts`) and its integrations: in-memory and Trello
- `src/lib/llm.ts`: the only file that knows the model provider
- `src/lib/gates.ts`: yes/no gates — one-token answers with a confidence, run before the deep model
- `src/lib/agent.ts`: the deep model — system prompt, tools (known issues, ticket lookup/creation/follow, transfer), tool loop
- `src/lib/brain.ts`: one caller turn — gates and deep model race; a confident gate wins, the rule-based reply is the fallback
- `src/app/api/vapi/chat/completions/route.ts`: the endpoint Vapi calls every turn (OpenAI-compatible, streamed, secret-protected)
- `src/lib/reply.ts`: the rule-based fallback reply
- `src/app/api/agent/route.ts`: the starter's original JSON API
- `src/app/page.tsx`: voice-only call screen (start, mute, end)
- `tests/routing.test.ts`: decision unit tests

## Known limitations / next iterations

1. Replace browser Web Speech with real conversational voice agent (Vapi or direct realtime API) and real transfer capability.
2. Ingest trusted municipal pages and live events with source attribution and staleness handling; current answers only link to authoritative websites.
3. Verify individual departments' real hours, holiday schedules, and phone numbers before activating phone routing. Phone numbers here are explicitly **mock**.
4. Add caller consent, PII minimization, secure tool authentication and persistence/idempotency for real ticket requests.
5. Add an LLM/NLU layer to interpret complex/ambiguous requests, while keeping deterministic backend policy.
6. Add end-to-end conversational evaluations and instrumented logs.

## Safety / honesty

This is not affiliated with the City of Bellevue. The routing calendar is a **demo policy** and must not be represented as the real city's hours. No claims of live event data, verified laws, production-ready call transfers or real tickets should be made without integrations.
