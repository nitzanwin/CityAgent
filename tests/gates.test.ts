import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastPath, parseYesNo, runTurnGates } from '../src/lib/gates';
import type { Chat } from '../src/lib/llm';

const top = (pYes: number) => [{ token: 'yes', logprob: Math.log(pYes) }, { token: 'no', logprob: Math.log(1 - pYes) }];

test('the confidence of a yes/no answer comes from the token probabilities', () => {
  const sure = parseYesNo({ content: 'yes', top: top(0.95) });
  assert.equal(sure.yes, true);
  assert.ok(Math.abs(sure.confidence - 0.95) < 1e-9);
  assert.deepEqual(parseYesNo({ content: 'no', top: top(0.3) }), { yes: false, confidence: parseYesNo({ content: 'no', top: top(0.3) }).confidence });
  assert.equal(parseYesNo({ content: 'Yes', top: undefined }).confidence, 1);
  assert.deepEqual(parseYesNo({ content: 'maybe', top: [{ token: 'maybe', logprob: 0 }] }), { yes: false, confidence: 0 });
});

test('only a confident gate answers the turn by itself', () => {
  assert.match(fastPath([{ id: 'emergency', yes: true, confidence: 0.95 }])!, /call 9 1 1/);
  assert.equal(fastPath([{ id: 'emergency', yes: true, confidence: 0.6 }]), null);
  assert.match(fastPath([{ id: 'goodbye', yes: true, confidence: 0.9 }])!, /goodbye/);
  assert.equal(fastPath([{ id: 'goodbye', yes: false, confidence: 0.99 }]), null);
  assert.equal(fastPath([]), null);
});

test('turn gates run together, and a failing gate is just skipped', async () => {
  const chat: Chat = async ({ messages }) => {
    const question = String(messages[1].content);
    if (question.includes('ending the call')) throw new Error('timeout');
    return { content: 'yes', toolCalls: [], top: top(0.9) };
  };
  assert.deepEqual((await runTurnGates('Caller: fire!', { chat })).map(r => r.id), ['emergency']);
});
