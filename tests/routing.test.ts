import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isOfficeOpen, nextOpening, selectDepartment, spokenWhen } from '../src/lib/routing';

test('routes potholes to public works', () => assert.equal(selectDepartment('A pothole on my street').id, 'public-works'));
test('unrecognized issue goes to general services', () => assert.equal(selectDepartment('I need a human').id, 'general'));
test('weekday business hours are open', () => assert.equal(isOfficeOpen(new Date('2026-10-19T17:00:00Z')), true));
test('weekday closing boundary is closed', () => assert.equal(isOfficeOpen(new Date('2026-10-19T23:00:00Z')), false));
test('weekend is closed', () => assert.equal(isOfficeOpen(new Date('2026-10-18T17:00:00Z')), false));
test('holiday override closes office', () => assert.equal(isOfficeOpen(new Date('2026-10-19T17:00:00Z'),new Set(['2026-10-19'])), false));
test('during hours gives transfer', () => assert.equal(decide('Report a pothole',new Date('2026-10-19T17:00:00Z')).action,'transfer'));
test('outside hours gives ticket', () => assert.equal(decide('Report a pothole',new Date('2026-10-18T17:00:00Z')).action,'ticket'));
test('regulation question points to source', () => assert.equal(decide('What is the noise ordinance?',new Date()).action,'answer'));
test('event question points to calendar', () => assert.equal(decide('Are there any city events?',new Date()).action,'answer'));

test('next opening after a Saturday morning is Monday at 8 AM', () => {
  const saturday = new Date('2026-10-17T17:00:00Z');
  assert.equal(nextOpening(saturday)?.toISOString(), '2026-10-19T15:00:00.000Z');
  assert.equal(spokenWhen(nextOpening(saturday)!, saturday), 'on Monday at 8 AM');
});
test('next opening is spoken as today or tomorrow when it is', () => {
  const mondayEarly = new Date('2026-10-19T14:00:00Z'), sunday = new Date('2026-10-18T17:00:00Z');
  assert.equal(spokenWhen(nextOpening(mondayEarly)!, mondayEarly), 'today at 8 AM');
  assert.equal(spokenWhen(nextOpening(sunday)!, sunday), 'tomorrow at 8 AM');
});
