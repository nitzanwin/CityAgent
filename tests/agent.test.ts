import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityPack } from '../src/cities';
import { runAgent, Superseded, type Turn } from '../src/lib/agent';
import { think } from '../src/lib/brain';
import type { Chat, ChatRequest, ChatResult } from '../src/lib/llm';
import { MemoryTickets } from '../src/lib/tickets';

const SATURDAY = new Date('2026-10-17T17:00:00Z'); // 10 AM Pacific, offices closed
const tickets = () => new MemoryTickets(cityPack().knownIssues, () => '2026-10-17');
const answer = (pYes: number): ChatResult => ({ content: pYes > 0.5 ? 'yes' : 'no', toolCalls: [], top: [{ token: 'yes', logprob: Math.log(pYes) }, { token: 'no', logprob: Math.log(1 - pYes) }] });
const toolCall = (name: string, args: object, content: string | null = 'Let me check that.'): ChatResult =>
  ({ content, toolCalls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

// A fake model: yes/no calls (no tools) answer from `gate`; agent calls (with tools) play `script` in order.
function fakeModel(script: ChatResult[], gate: (prompt: string) => number = () => 0.02) {
  const agentRequests: ChatRequest[] = [];
  const chat: Chat = async request => {
    if (!request.tools) return answer(gate(String(request.messages[1].content)));
    agentRequests.push(structuredClone({ ...request, signal: undefined }));
    return script[agentRequests.length - 1] ?? { content: 'Anything else?', toolCalls: [] };
  };
  return { chat, agentRequests };
}
const toolResults = (r: ChatRequest) => r.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const turns: Turn[] = [{ role: 'assistant', text: 'Welcome to Bellevue CityDesk.' }, { role: 'user', text: 'There is a big pothole on NE 8th Street at 112th.' }];

test('a known problem is matched by yes/no checks and reported back instead of a duplicate', async () => {
  const { chat, agentRequests } = fakeModel(
    [toolCall('find_known_issue', { issue: 'Big pothole', location: 'NE 8th St at 112th' }), { content: "That's already reported and scheduled for Tuesday.", toolCalls: [] }],
    prompt => (prompt.includes('Existing ticket: Large pothole') ? 0.97 : 0.03),
  );
  const said: string[] = [];
  const reply = await runAgent(turns, { now: SATURDAY, tickets: tickets(), chat, say: t => said.push(t) });
  assert.equal(reply, "That's already reported and scheduled for Tuesday.");
  assert.deepEqual(said, ['Let me check that.']);
  const [result] = toolResults(agentRequests[1]);
  assert.equal(result.known, true);
  assert.equal(result.ticket.reference, 'CD-1001');
  assert.equal(result.ticket.spokenReference, 'C D 1 0 0 1');
  assert.equal(result.ticket.status, 'Scheduled');
});

test('creating a ticket says who follows up, when they reopen, and how they will reach the caller', async () => {
  const store = tickets();
  const { chat, agentRequests } = fakeModel([toolCall('create_ticket', { department: 'public-works', title: 'Pothole', issue: 'Hole in the road', location: '200th Ave and 3rd St', name: 'Dana', phone: '+14255550123' }, null)]);
  await runAgent(turns, { now: SATURDAY, tickets: store, chat });
  const [result] = toolResults(agentRequests[1]);
  assert.equal(result.ticket.reference, 'CD-1006');
  assert.equal(result.followUp, 'Public Works will review it when they reopen on Monday at 8 AM.');
  assert.match(result.contact, /contact Dana at \+14255550123/);
  assert.equal((await store.get('CD-1006'))!.reporter.name, 'Dana');
});

test('a caller asking about their ticket is found by caller ID', async () => {
  const store = tickets();
  await store.create({ department: 'parks', title: 'Swing', issue: 'Broken', location: 'Downtown Park', reporter: { name: 'Dana', phone: '+14255550123' } });
  const { chat, agentRequests } = fakeModel([toolCall('lookup_ticket', { reference: '' })]);
  await runAgent(turns, { now: SATURDAY, tickets: store, chat, callerNumber: '+1 425 555 0123' });
  const [result] = toolResults(agentRequests[1]);
  assert.equal(result.found, true);
  assert.equal(result.tickets[0].reference, 'CD-1006');
  const { chat: webChat, agentRequests: web } = fakeModel([toolCall('lookup_ticket', { reference: '' })]);
  await runAgent(turns, { now: SATURDAY, tickets: store, chat: webChat });
  assert.match(toolResults(web[1])[0].reason, /no caller ID/);
});

test('tools never run once a gate has answered the turn', async () => {
  const store = tickets();
  const { chat } = fakeModel([toolCall('create_ticket', { department: 'general', title: 'x', issue: 'x', location: 'x', name: 'x', phone: 'x' })]);
  await assert.rejects(runAgent(turns, { now: SATURDAY, tickets: store, chat, proceed: Promise.resolve(false) }), Superseded);
  assert.equal((await store.list()).length, 5);
});

test('an emergency is answered by the gate, and the deep model is cancelled before it acts', async () => {
  process.env.OPENAI_API_KEY ||= 'test';
  const store = tickets();
  const { chat } = fakeModel([toolCall('create_ticket', { department: 'general', title: 'x', issue: 'x', location: 'x', name: 'x', phone: 'x' })], p => (p.includes('immediate danger') ? 0.98 : 0.02));
  const reply = await think([{ role: 'user', content: "There's smoke pouring out of my neighbour's house!" }], { now: SATURDAY, chat, tickets: store });
  assert.match(reply, /call 9 1 1/);
  await new Promise(r => setTimeout(r, 10));
  assert.equal((await store.list()).length, 5);
});

test('if the model fails, the rule-based reply keeps the call going', async () => {
  process.env.OPENAI_API_KEY ||= 'test';
  const chat: Chat = async () => { throw new Error('Model provider returned 429'); };
  const reply = await think([{ role: 'user', content: 'There is a pothole on my street' }], { now: SATURDAY, chat, tickets: tickets() });
  assert.match(reply, /Public Works/);
});
