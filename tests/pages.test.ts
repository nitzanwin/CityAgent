import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/lib/agent';
import { parsePage, searchChunks } from '../src/cities/pages';
import type { Chat, ChatRequest } from '../src/lib/llm';
import { MemoryTickets } from '../src/lib/tickets';

const page = (title: string, topic: string, body: string) => `---\ntitle: ${title}\nsource: https://bellevuewa.gov/${topic}\nfetched: 2026-10-17\ntopic: ${topic}\n---\n${body}`;
const garbage = page('Garbage and Recycling', 'utilities', '# Garbage and Recycling\n\n## Missed pickup\n\nIf your garbage, recycling or yard debris was missed, call Republic Services by 5 PM on the next business day.\n\n## Holiday schedule\n\nPickup is delayed by one day during holiday weeks, for every household in the city.');
const events = page('Events', 'events', '# Upcoming events\n\n## Saturday\n\nPumpkin Walk at Crossroads Park, 10 AM to 1 PM, free for families with costume parade.');

test('pages are split into sections that keep their source and date', () => {
  const chunks = parsePage(garbage);
  assert.deepEqual(chunks.map(c => c.heading), ['Missed pickup', 'Holiday schedule']);
  assert.equal(chunks[0].fetched, '2026-10-17');
  assert.equal(chunks[0].source, 'https://bellevuewa.gov/utilities');
});

test('search finds the most relevant section, with headings counting extra', () => {
  const chunks = [...parsePage(garbage), ...parsePage(events)];
  assert.equal(searchChunks('my garbage pickup was missed', chunks)[0].heading, 'Missed pickup');
  assert.equal(searchChunks('events this weekend', chunks)[0].title, 'Events');
  assert.deepEqual(searchChunks('the and of', chunks), []);
});

test('the agent can search the website snapshot, and results say how old they are', async () => {
  const requests: ChatRequest[] = [];
  const chat: Chat = async request => {
    if (!request.tools) return { content: 'no', toolCalls: [] };
    requests.push(structuredClone({ ...request, signal: undefined }));
    return requests.length === 1
      ? { content: null, toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search_city_info', arguments: JSON.stringify({ query: 'garbage pickup missed' }) } }] }
      : { content: 'Call Republic Services by 5 PM the next business day.', toolCalls: [] };
  };
  await runAgent([{ role: 'user', text: 'My garbage was not picked up' }], { now: new Date('2026-10-17T17:00:00Z'), tickets: new MemoryTickets([]), cityRequests: null, pages: parsePage(garbage), chat });
  const result = JSON.parse(requests[1].messages.at(-1)!.content as string);
  assert.equal(result.found, true);
  assert.equal(result.results[0].asOf, '2026-10-17');
  assert.match(result.results[0].text, /Republic Services/);
});

test('a long table is split into pieces that each keep the table header', () => {
  const rows = Array.from({ length: 60 }, (_, i) => `| 2026-11-${String(i % 28 + 1).padStart(2, '0')} | 6 PM | Event number ${i} with a long descriptive name | City Hall, 450 110th Ave NE |`);
  const chunks = parsePage(page('City Events', 'events', `# City Events\n\n| Date | Time | Event | Where |\n|---|---|---|---|\n${rows.join('\n')}`));
  assert.ok(chunks.length > 2);
  for (const c of chunks) assert.match(c.text, /^\| Date \| Time \| Event \| Where \|\n\|---/);
  assert.match(chunks.at(-1)!.text, /Event number 59/);
});

test("Bellevue's scraped pages answer the questions callers ask", async () => {
  const { cityPages } = await import('../src/cities/pages');
  const pages = cityPages('bellevue');
  assert.ok(pages.length > 50, `expected the scraped pages to be present, got ${pages.length} sections`);
  // The agent gets the top three results, so that's what has to contain the answer.
  const top3 = (q: string) => searchChunks(q, pages).map(c => c.text).join(' ');
  assert.match(top3('missed garbage pickup'), /Republic Services|425-452-4762/);
  assert.equal(searchChunks('upcoming events', pages)[0].topic, 'events');
  assert.match(top3('construction noise hours'), /7 a\.m\. to 8 p\.m\./);
  assert.match(top3('water main break flooding emergency'), /425-452-7840/);
});
