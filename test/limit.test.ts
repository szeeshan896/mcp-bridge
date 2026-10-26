import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ConcurrencyLimit } from '../src/limit.js';

test('never runs more than the configured number at once', async () => {
  const limit = new ConcurrencyLimit(2);
  let running = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 8 }, () =>
      limit.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(30);
        running -= 1;
      }),
    ),
  );

  assert.equal(peak, 2);
  assert.equal(running, 0);
});

test('a thrown task still frees its slot', async () => {
  const limit = new ConcurrencyLimit(1);

  await assert.rejects(() => limit.run(async () => { throw new Error('boom'); }));

  // if the slot leaked, this would never resolve
  assert.equal(await limit.run(async () => 'after'), 'after');
});

test('runs everything, in order, rather than dropping the queue', async () => {
  const limit = new ConcurrencyLimit(1);
  const done: number[] = [];

  await Promise.all([1, 2, 3, 4].map((n) => limit.run(async () => { done.push(n); })));

  assert.deepEqual(done, [1, 2, 3, 4]);
});

test('rejects a nonsensical limit', () => {
  assert.throws(() => new ConcurrencyLimit(0), /at least 1/);
});
