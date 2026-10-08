import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tailer } from '../lib/tail.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'cc-tail-'));

test('fromStart reads existing lines, then appended lines, buffers partials', async () => {
  const f = join(dir, 'a.jsonl');
  writeFileSync(f, 'one\ntwo\n');
  const t = new Tailer({ pollMs: 50 });
  const got = [];
  t.on('line', (p, l) => got.push(l));
  t.add(f, { fromStart: true });
  await wait(120);
  assert.deepEqual(got, ['one', 'two']);
  appendFileSync(f, 'thr');
  await wait(120);
  assert.deepEqual(got, ['one', 'two']);
  appendFileSync(f, 'ee\nfour\n');
  await wait(120);
  assert.deepEqual(got, ['one', 'two', 'three', 'four']);
  t.close();
});

test('default starts at EOF; truncation resets', async () => {
  const f = join(dir, 'b.jsonl');
  writeFileSync(f, 'old\n');
  const t = new Tailer({ pollMs: 50 });
  const got = [];
  t.on('line', (p, l) => got.push(l));
  t.add(f);
  await wait(120);
  assert.deepEqual(got, []);
  appendFileSync(f, 'new\n');
  await wait(120);
  assert.deepEqual(got, ['new']);
  truncateSync(f, 0);
  appendFileSync(f, 'x\n');
  await wait(120);
  assert.deepEqual(got, ['new', 'x']);
  t.close();
});

test('missing file emits error once and does not throw', async () => {
  const t = new Tailer({ pollMs: 50 });
  const errs = [];
  t.on('error', (p, e) => errs.push(e.code));
  t.add(join(dir, 'nope.jsonl'), { fromStart: true });
  await wait(120);
  assert.equal(errs[0], 'ENOENT');
  t.close();
});

test('missing file with no error listener never throws', async () => {
  const t = new Tailer({ pollMs: 50 });
  try {
    assert.equal(t.listenerCount('error'), 0);
    assert.doesNotThrow(() => t.add(join(dir, 'nope2.jsonl'), { fromStart: true }));
    // Survive at least two poll ticks: an unguarded emit here is an uncaught
    // exception from the timer, which would kill the process, not just this test.
    await wait(140);
    assert.equal(t.listenerCount('error'), 0);
  } finally {
    t.close();
  }
});

test('multi-byte character split across reads is not corrupted', async () => {
  const f = join(dir, 'c.jsonl');
  writeFileSync(f, '');
  const t = new Tailer({ pollMs: 50 });
  const got = [];
  t.on('line', (p, l) => got.push(l));
  try {
    t.add(f, { fromStart: true });
    const euro = Buffer.from('€', 'utf8'); // 3 bytes: e2 82 ac
    assert.equal(euro.length, 3);
    appendFileSync(f, euro.subarray(0, 1));
    await wait(120);
    assert.deepEqual(got, []);
    appendFileSync(f, Buffer.concat([euro.subarray(1), Buffer.from('\n')]));
    await wait(120);
    assert.deepEqual(got, ['€']);
  } finally {
    t.close();
  }
});

test('truncation resets the decoder, not just the offset', async () => {
  const f = join(dir, 'd.jsonl');
  writeFileSync(f, '');
  const t = new Tailer({ pollMs: 50 });
  const got = [];
  t.on('line', (p, l) => got.push(l));
  try {
    t.add(f, { fromStart: true });
    // Pad so the post-truncation file is strictly smaller than the stale offset,
    // then leave a dangling first byte of '€' held in the decoder.
    appendFileSync(f, 'aaaaaaaaaa\n');
    appendFileSync(f, Buffer.from('€', 'utf8').subarray(0, 1));
    await wait(120);
    assert.deepEqual(got, ['aaaaaaaaaa']);
    truncateSync(f, 0);
    appendFileSync(f, 'clean\n');
    await wait(120);
    // A decoder carried across the truncation would prefix a replacement char.
    assert.deepEqual(got, ['aaaaaaaaaa', 'clean']);
  } finally {
    t.close();
  }
});

test('a huge backlog is read in slices, so the event loop stays responsive and order is kept', async () => {
  const f = join(dir, 'big.jsonl');
  const line = 'x'.repeat(200);
  const total = 60000; // ~12 MB
  writeFileSync(f, Array.from({ length: total }, (_, i) => `${i} ${line}`).join('\n') + '\n');
  const t = new Tailer({ pollMs: 50, chunkBytes: 64 * 1024, sliceMs: 5 });
  try {
    let seen = 0;
    let inOrder = true;
    t.on('line', (p, l) => { if (Number(l.slice(0, l.indexOf(' '))) !== seen) inOrder = false; seen += 1; });
    t.add(f, { fromStart: true });
    // A timer due in 10 ms must not wait for the whole file.
    const lag = await new Promise((resolve) => { const s = Date.now(); setTimeout(() => resolve(Date.now() - s), 10); });
    assert.ok(lag < 150, `timer delayed ${lag} ms by the backlog`);
    assert.ok(seen < total, 'the backlog was not read in one go');
    const deadline = Date.now() + 10000;
    while (seen < total && Date.now() < deadline) await wait(20);
    assert.equal(seen, total);
    assert.ok(inOrder, 'lines arrive in file order');
  } finally { t.close(); }
});
