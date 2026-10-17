import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityPack } from '../src/cities';
import { involves, MemoryTickets, TrelloTickets } from '../src/lib/tickets';
import { formatDesc, parseDesc } from '../src/lib/tickets/trello';

const memory = () => new MemoryTickets(cityPack().knownIssues, () => '2026-10-17');

test('known issues are seeded as CD-1001 onwards, and "open" leaves out fixed ones', async () => {
  const tickets = memory();
  assert.deepEqual((await tickets.list()).map(t => t.reference), ['CD-1001', 'CD-1002', 'CD-1003', 'CD-1004', 'CD-1005']);
  assert.equal((await tickets.list({ open: true })).length, 4);
  assert.equal((await tickets.list({ department: 'parks', open: true })).length, 1);
});

test('a new ticket gets the next reference and can be found however the caller says it', async () => {
  const tickets = memory();
  const t = await tickets.create({ department: 'transportation', title: 'Pothole', issue: 'Deep pothole', location: '200th Ave and 3rd St', reporter: { name: 'Dana', phone: '+1 (425) 555-0123' } });
  assert.equal(t.reference, 'CD-1006');
  assert.equal(t.status, 'reported');
  for (const spoken of ['CD-1006', 'cd 1006', 'C D 1 0 0 6', '1006']) assert.equal((await tickets.get(spoken))?.title, 'Pothole', spoken);
  assert.equal(await tickets.get('CD-9999'), null);
  assert.ok(involves(t, '4255550123'));
  assert.ok(!involves(t, '4255550199'));
});

test('following a ticket adds the caller to it', async () => {
  const tickets = memory();
  await tickets.follow('CD-1001', { name: 'Sam', phone: '+14255550111' });
  const t = (await tickets.get('CD-1001'))!;
  assert.deepEqual(t.followers, [{ name: 'Sam', phone: '+14255550111' }]);
  assert.ok(involves(t, '425-555-0111'));
});

test('a Trello card description round-trips the ticket fields', () => {
  const fields = { department: 'parks', location: 'Downtown Park', reportedOn: '2026-10-16', reporter: { name: 'Dana Lee', phone: '+14255550123' }, followers: [{ name: 'Sam', phone: '+1425' }, { name: 'Ari' }], issue: 'Broken swing.\n\nTaped off.' };
  assert.deepEqual(parseDesc(formatDesc(fields)), fields);
  assert.deepEqual(parseDesc(formatDesc({ ...fields, reporter: {}, followers: [] })).followers, []);
});

test('the Trello adapter maps lists to statuses, comments to updates, and idShort to references', async () => {
  const requests: { method: string; url: URL }[] = [];
  const board = {
    lists: [{ id: 'L1', name: 'Reported' }, { id: 'L2', name: 'In progress' }, { id: 'L3', name: 'Scheduled' }, { id: 'L4', name: 'Fixed' }],
    cards: [{ id: 'C1', name: 'Streetlight out', idList: 'L2', idShort: 2, shortUrl: 'https://trello.com/c/x', desc: formatDesc({ department: 'transportation', location: 'Bellevue Way', reportedOn: '2026-10-15', reporter: {}, followers: [], issue: 'Dark block.' }) }],
    actions: [{ date: '2026-10-16T10:00:00Z', data: { text: 'Part ordered.', card: { id: 'C1' } } }, { date: '2026-10-15T10:00:00Z', data: { text: 'Assigned.', card: { id: 'C1' } } }],
  };
  const http = (async (url: URL, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', url });
    const json = url.pathname.endsWith('/cards') && init?.method === 'POST' ? { id: 'C2', idShort: 7, shortUrl: 'https://trello.com/c/y' } : init?.method === 'GET' ? board : {};
    return new Response(JSON.stringify(json));
  }) as typeof fetch;
  const trello = new TrelloTickets('k', 't', 'B1', http);

  const t = (await trello.get('C D 1 0 0 2'))!;
  assert.equal(t.status, 'in-progress');
  assert.deepEqual(t.updates.map(u => u.text), ['Assigned.', 'Part ordered.']);
  assert.equal(t.location, 'Bellevue Way');

  const created = await trello.create({ department: 'parks', title: 'Swing', issue: 'Broken', location: 'Downtown Park', reporter: { name: 'Dana', phone: '+14255550123' } });
  assert.equal(created.reference, 'CD-1007');
  const post = requests.find(r => r.method === 'POST')!;
  assert.equal(post.url.searchParams.get('idList'), 'L1');
  assert.match(post.url.searchParams.get('desc')!, /Reporter: Dana \(\+14255550123\)/);
  assert.equal(post.url.searchParams.get('key'), 'k');

  await trello.follow('CD-1002', { name: 'Sam', phone: '+14255550111' });
  assert.match(requests.find(r => r.method === 'PUT')!.url.searchParams.get('desc')!, /Followers: Sam \(\+14255550111\)/);
  assert.ok(requests.some(r => r.method === 'POST' && r.url.pathname.endsWith('/actions/comments')));
});
