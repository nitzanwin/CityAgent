import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyFor, type ChatMessage } from '../src/lib/reply';
import type { TicketInput } from '../src/lib/tickets';

const OPEN = new Date('2026-10-19T17:00:00Z'); // Monday, 10 AM Pacific
const CLOSED = new Date('2026-10-18T17:00:00Z'); // Sunday
const URL_LIKE = /https?:|www\.|\.(gov|com|org|codes)\b/i;
const ISSUE = 'There is a pothole on my street';
const system: ChatMessage = { role: 'system', content: 'You are CityDesk.' };
const user = (content: unknown): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

async function afterOffer(answer: string, ticket: (input: TicketInput) => Promise<{ id: string; provider: 'mock' }>) {
  const offer = await replyFor([system, user(ISSUE)], CLOSED);
  return replyFor([system, user(ISSUE), assistant(offer), user(answer)], CLOSED, ticket);
}

test('closed office offers a ticket and asks yes or no', async () => {
  const reply = await replyFor([system, user(ISSUE)], CLOSED);
  assert.match(reply, /open a service ticket/);
  assert.match(reply, /yes or no/);
});

test('yes after the offer creates a ticket for the original issue', async () => {
  const calls: TicketInput[] = [];
  const reply = await afterOffer('Yes please', async input => { calls.push(input); return { id: 'demo-abc123', provider: 'mock' }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].department, 'transportation');
  assert.equal(calls[0].description, ISSUE);
  assert.match(reply, /reference ends in A B C 1 2 3/);
});

test('no after the offer closes politely without a ticket', async () => {
  let called = false;
  const reply = await afterOffer('No, thank you', async () => { called = true; return { id: 'x', provider: 'mock' }; });
  assert.equal(called, false);
  assert.match(reply, /won't open a ticket/);
});

test('a failed ticket is not reported as filed', async () => {
  const reply = await afterOffer('yes', async () => { throw new Error('Trello down'); });
  assert.match(reply, /nothing was filed/);
});

test('during office hours the caller hears which department they would reach', async () => {
  assert.match(await replyFor([user('Report a pothole')], OPEN), /transfer you to Transportation/);
});

test('replies never read a URL aloud', async () => {
  for (const said of ['Are there any city events?', 'What is the noise ordinance?', 'Where can I find information about permits?', 'Report a pothole', 'I need a human'])
    for (const now of [OPEN, CLOSED]) assert.doesNotMatch(await replyFor([user(said)], now), URL_LIKE);
});

test('missing or empty caller message asks them to repeat', async () => {
  const cases: ChatMessage[][] = [[], [system], [user('   ')], [user(null)], [assistant('Hello')]];
  for (const messages of cases) assert.match(await replyFor(messages, OPEN), /didn't catch that/);
});

test('array content parts are read as text', async () => {
  assert.match(await replyFor([user([{ type: 'text', text: 'Report a pothole' }])], OPEN), /Transportation/);
});
