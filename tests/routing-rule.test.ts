import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cityPack } from '../src/cities';
import { nextStep, runAgent } from '../src/lib/agent';
import { eventsBetween, parseEventsFeed } from '../src/lib/city-events';
import type { Chat, ChatRequest, ChatResult } from '../src/lib/llm';
import { MemoryTickets } from '../src/lib/tickets';

const MONDAY_10AM = new Date('2026-10-19T17:00:00Z'), SATURDAY = new Date('2026-10-17T17:00:00Z'), VETERANS_DAY = new Date('2026-11-11T18:00:00Z');

test('route or ticket is a business-hours rule: open means transfer, closed (incl. holidays) means ticket', () => {
  assert.equal(nextStep(MONDAY_10AM).step, 'transfer');
  assert.equal(nextStep(SATURDAY).step, 'ticket');
  assert.match(nextStep(SATURDAY).why, /until on Monday at 8 AM/);
  assert.equal(nextStep(VETERANS_DAY).step, 'ticket');
});

async function toolResult(now: Date, name: string, args: object) {
  const requests: ChatRequest[] = [];
  const chat: Chat = async request => {
    if (!request.tools) return { content: 'no', toolCalls: [] };
    requests.push(structuredClone({ ...request, signal: undefined }));
    return (requests.length === 1 ? { content: null, toolCalls: [{ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'ok', toolCalls: [] }) as ChatResult;
  };
  const tickets = new MemoryTickets(cityPack().knownIssues);
  await runAgent([{ role: 'user', text: 'hi' }], { now, tickets, chat, cityRequests: null, events: null });
  return { result: JSON.parse(requests[1].messages.at(-1)!.content as string), tickets: await tickets.list() };
}
const ticket = { department: 'transportation', title: 'Pothole', issue: 'Hole', location: '200th Ave', name: 'Dana', phone: '+14255550123' };

test('the tools enforce the rule: no ticket while open, no transfer while closed', async () => {
  const open = await toolResult(MONDAY_10AM, 'create_ticket', ticket);
  assert.equal(open.result.created, false);
  assert.match(open.result.reason, /transfer/);
  assert.equal(open.tickets.length, 5);
  const transfer = await toolResult(MONDAY_10AM, 'transfer_call', { department: 'transportation' });
  assert.deepEqual([transfer.result.transferred, transfer.result.phone], [true, '425-452-6856']);
  const closed = await toolResult(SATURDAY, 'transfer_call', { department: 'transportation' });
  assert.equal(closed.result.transferred, false);
  assert.equal((await toolResult(SATURDAY, 'create_ticket', ticket)).result.created, true);
});

test("the city's events feed is parsed into dated events, and filtered by date", () => {
  const events = parseEventsFeed(readFileSync('tests/fixtures/bellevue-events.xml', 'utf8'));
  const council = events.find(e => e.title === 'City Council Regular Meeting')!;
  assert.equal(council.time, '6:00 PM - 10:00 PM');
  assert.match(council.place, /450 110th Ave NE/);
  assert.ok(!council.details.startsWith('Description'));
  assert.ok(events.some(e => /Muertos/.test(e.title)));
  assert.deepEqual(eventsBetween(events, SATURDAY, 3).map(e => e.date), [council.date].filter(d => d <= '2026-10-20'));
});
