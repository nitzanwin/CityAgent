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

## Trello (optional)

Copy `.env.example` to `.env.local` and supply Trello API key, token, and destination list ID. Without all three settings, **ticket creation is mock-only**. No real transfers occur in this starter.

## Architecture

- `src/lib/city.ts`: department data and city configuration
- `src/lib/routing.ts`: explicit routing and schedule decision engine
- `src/lib/tickets.ts`: ticket integration boundary
- `src/app/api/agent/route.ts`: validated API and ticket orchestration
- `src/app/api/vapi/chat/completions/route.ts`: the brain Vapi calls every turn (OpenAI-compatible, secret-protected)
- `src/lib/reply.ts`: turns routing decisions into spoken replies, including the yes/no ticket follow-up
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
