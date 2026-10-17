import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officesNow } from '../src/lib/routing';
import { forSpeech } from '../src/lib/speech';

test('phone numbers are read digit by digit, in their groups', () => {
  assert.equal(forSpeech('Call 425-452-6800 today.'), 'Call 4 2 5, 4 5 2, 6 8 0 0 today.');
  assert.equal(forSpeech('Police non-emergency: (425) 577-5656'), 'Police non-emergency: 4 2 5, 5 7 7, 5 6 5 6');
  assert.equal(forSpeech('USCIS: 1-800-375-5283'), 'USCIS: 1, 8 0 0, 3 7 5, 5 2 8 3');
});

test("addresses don't run numbers together, and abbreviations are spoken in full", () => {
  assert.equal(forSpeech('City Hall, 450 110th Ave NE.'), 'City Hall, 450, 110th Avenue Northeast.');
  assert.equal(forSpeech('NE 8th St at 112th Ave NE'), 'Northeast 8th Street at 112th Avenue Northeast');
  assert.equal(forSpeech('From 10 AM to 3:30 PM on October 17, reference C D 1 0 0 6.'), 'From 10 AM to 3:30 PM on October 17, reference C D 1 0 0 6.');
});

test('walk-in offices say whether they are open right now', () => {
  const saturdayNoon = new Date('2026-10-17T19:00:00Z'), mondayNine = new Date('2026-10-19T16:00:00Z'), veteransDay = new Date('2026-11-11T19:00:00Z');
  assert.deepEqual(officesNow(saturdayNoon), [
    "City Hall's Service First desk (425-452-6800) is closed now; it opens on Monday at 8 AM.",
    'Mini City Hall (425-452-2800) is open now, until 6 PM.',
  ]);
  assert.match(officesNow(mondayNine)[0], /is open now, until 4 PM/);
  assert.match(officesNow(mondayNine)[1], /closed now; it opens today at 10 AM/);
  assert.match(officesNow(veteransDay)[0], /closed now; it opens tomorrow at 8 AM/);
});
