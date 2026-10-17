import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityPack } from '../src/cities';
import { runAgent, type Turn } from '../src/lib/agent';
import { ArcGis311, type CityRequestSource } from '../src/lib/city-requests';
import type { Chat, ChatRequest, ChatResult } from '../src/lib/llm';
import { MemoryTickets } from '../src/lib/tickets';

const config = cityPack().config.openRequests as ConstructorParameters<typeof ArcGis311>[0];
const feature = (attributes: object) => ({ attributes: { ID: '18808602', RequestType: 'Pothole', Status: 'submitted', Address: '108th Ave NE & NE 39th St, Bellevue, WA 98004, USA', Department: 'Transportation', DateCreated: Date.UTC(2026, 9, 17, 16), ...attributes } });

test("the city's 311 layer is read into requests with our departments and statuses", async () => {
  const urls: URL[] = [];
  const http = (async (url: URL) => {
    urls.push(url);
    return new Response(JSON.stringify({ features: [feature({}), feature({ ID: '13454736', RequestType: 'Traffic Concerns ', Status: 'in progress', Address: '268 102nd Ave NE,Bellevue, WA 98004', Department: 'Police Department' })] }));
  }) as typeof fetch;
  const source = new ArcGis311(config, http);
  const [pothole, traffic] = await source.open();
  assert.deepEqual(pothole, { system: 'MyBellevue', reference: 'MyBellevue 18808602', title: 'Pothole', department: 'transportation', location: '108th Ave NE & NE 39th St', status: 'reported', reportedOn: '2026-10-17' });
  assert.equal(traffic.status, 'in-progress');
  assert.equal(traffic.department, 'police');
  assert.equal(traffic.location, '268 102nd Ave NE');
  assert.match(urls[0].searchParams.get('where')!, /^Status IN \('submitted','received','in progress'\)$/);
  await source.open();
  assert.equal(urls.length, 1, 'open requests are cached');
  await source.get('MyBellevue 18808602');
  assert.equal(urls[1].searchParams.get('where'), "ID = '18808602'");
});

const SATURDAY = new Date('2026-10-17T17:00:00Z');
const turns: Turn[] = [{ role: 'user', text: "There's a pothole at 108th Avenue and NE 39th Street." }];
const city: CityRequestSource = {
  name: 'MyBellevue',
  open: async () => [{ system: 'MyBellevue', reference: 'MyBellevue 18808602', title: 'Pothole', department: 'transportation', location: '108th Ave NE & NE 39th St', status: 'reported', reportedOn: '2026-10-17' }],
  get: async id => (id === '18808602' ? (await city.open())[0] : null),
};
const call = (name: string, args: object): ChatResult => ({ content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function model(first: ChatResult, sameProblem: (prompt: string) => boolean) {
  const requests: ChatRequest[] = [];
  const chat: Chat = async request => {
    if (!request.tools) { const yes = sameProblem(String(request.messages[1].content)); return { content: yes ? 'yes' : 'no', toolCalls: [], top: [{ token: 'yes', logprob: Math.log(yes ? 0.95 : 0.05) }, { token: 'no', logprob: Math.log(yes ? 0.05 : 0.95) }] }; }
    requests.push(structuredClone({ ...request, signal: undefined }));
    return requests.length === 1 ? first : { content: 'done', toolCalls: [] };
  };
  return { chat, result: () => JSON.parse(requests[1].messages.at(-1)!.content as string) };
}

test("a problem already in the city's 311 system is reported as known, and can't be followed", async () => {
  const { chat, result } = model(call('find_known_issue', { department: 'transportation', issue: 'Pothole', location: '108th Ave and NE 39th St' }), p => p.includes('Existing report: Pothole'));
  await runAgent(turns, { now: SATURDAY, tickets: new MemoryTickets(cityPack().knownIssues), cityRequests: city, chat });
  const r = result();
  assert.equal(r.known, true);
  assert.equal(r.source, 'city');
  assert.equal(r.request.reportedOn, '2026-10-17');
  assert.equal(r.request.department, 'Transportation');
  assert.match(r.note, /can't add the caller/);
});

test('a city 311 request number is looked up in the city system', async () => {
  const { chat, result } = model(call('lookup_ticket', { reference: '18808602' }), () => false);
  await runAgent(turns, { now: SATURDAY, tickets: new MemoryTickets(cityPack().knownIssues), cityRequests: city, chat });
  assert.equal(result().request.reference, 'MyBellevue 18808602');
});

test('if the city system is down, known-issue checks still use our own tickets', async () => {
  const down: CityRequestSource = { name: 'MyBellevue', open: async () => { throw new Error('timeout'); }, get: async () => null };
  const { chat, result } = model(call('find_known_issue', { department: 'transportation', issue: 'Pothole', location: 'NE 8th St at 112th Ave NE' }), p => p.includes('Large pothole'));
  await runAgent(turns, { now: SATURDAY, tickets: new MemoryTickets(cityPack().knownIssues), cityRequests: down, chat });
  assert.equal(result().ticket.reference, 'CD-1001');
});
