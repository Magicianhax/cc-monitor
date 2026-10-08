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

test('contextPercent estimates how full the window is from one turn, per model window', async () => {
  const { contextPercent, contextWindowFor } = await import('../lib/cost.mjs');
  assert.equal(contextWindowFor('claude-opus-5'), 1_000_000);
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(contextWindowFor('gpt-9'), null);
  // input + cache read + cache write is what the model was carrying on that turn.
  assert.equal(contextPercent('claude-opus-5', { input: 10_000, cacheRead: 400_000, cacheWrite: 40_000, output: 9_999 }), 45);
  assert.equal(contextPercent('claude-haiku-4-5', { input: 0, cacheRead: 150_000, cacheWrite: 0 }), 75);
  assert.equal(contextPercent('claude-haiku-4-5', { input: 0, cacheRead: 900_000, cacheWrite: 0 }), 100);
  assert.equal(contextPercent('gpt-9', { input: 1 }), null);
});
