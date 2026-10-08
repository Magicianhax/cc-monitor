import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, costUsd } from '../lib/cost.mjs';

test('exact and suffix match', () => {
  assert.equal(priceFor('claude-fable-5-1').input, 10);
  assert.equal(priceFor('claude-fable-5-1[1m]').input, 10);
});
test('prefix match picks longest key', () => {
  assert.equal(priceFor('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceFor('claude-fable-5-1-preview').cacheRead, 0.25);
});
test('unknown → null', () => {
  assert.equal(priceFor('gpt-9'), null);
  assert.equal(costUsd('gpt-9', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
});
test('costUsd arithmetic', () => {
  const c = costUsd('claude-opus-5', { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 400_000 });
  // 5 + 2.5 + 1.0 + 2.5
  assert.equal(Number(c.toFixed(6)), 11);
});
