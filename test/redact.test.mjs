// Every credential-shaped string below is invented for this file and matches nothing real.
// secret-guard:allow
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, MASK } from '../lib/redact.mjs';
import { parsePs } from '../lib/procs-posix.mjs';
import { parsePwshJson } from '../lib/procs.mjs';
import { summarizeToolInput } from '../lib/transcript.mjs';
import { Store } from '../lib/store.mjs';

test('redact masks a password inside a connection string', () => {
  assert.equal(redact('psql postgres://u:p@host:5432/db'), `psql postgres://u:${MASK}@host:5432/db`);
  assert.equal(redact('mongodb+srv://admin:hunter2@cluster0.example.net'), `mongodb+srv://admin:${MASK}@cluster0.example.net`);
  // A URL with no credentials keeps its shape, colon and all.
  assert.equal(redact('curl http://127.0.0.1:4888/api/sessions'), 'curl http://127.0.0.1:4888/api/sessions');
});

test('redact masks the value after a secret-ish key, in any spelling', () => {
  assert.equal(redact('node x.js --api-key=abc123'), `node x.js --api-key=${MASK}`);
  assert.equal(redact('export OPENAI_API_KEY=not-a-real-one'), `export OPENAI_API_KEY=${MASK}`);
  assert.equal(redact('-H "authorization: Bearer aaaa.bbbb.cccc"'), `-H "authorization: ${MASK}"`);
  assert.equal(redact('password : hunter2'), `password : ${MASK}`);
  assert.equal(redact('{"token":"abc"}'), `{"token":"${MASK}"}`);
  assert.equal(redact('PGPASSWORD=s3cr3t psql'), `PGPASSWORD=${MASK} psql`);
});

test('redact masks a long opaque run wherever it appears', () => {
  assert.equal(redact('0123456789abcdef0123456789abcdef01234567'), MASK);
  assert.equal(redact('sig da39a3ee5e6b4b0d3255bfef95601890afd80709 ok'), `sig ${MASK} ok`);
  assert.equal(redact('https://api.example.com/v1/AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJ/x'), `https://api.example.com/v1/${MASK}/x`);
});

test('redact leaves ordinary text, paths and commands alone', () => {
  const plain = [
    'ls -la /f/Tools',
    '/home/alex/.local/bin/node server.mjs --host 0.0.0.0',
    'C:/Users/alex/AppData/Local/Temp/claude/cc-monitor/lib/store.mjs',
    'Edit public/game/city-scene.mjs',
    'rotate the ssh key next week',
    'npm run verify',
  ];
  for (const s of plain) assert.equal(redact(s), s, s);
});

test('redact is total: never throws, always a string', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '42');
  assert.equal(redact(''), '');
});

test('the process listers redact before the store ever sees a command line', () => {
  const posix = parsePs('  42     1 Mon Sep 15 09:12:03 2026 node /usr/bin/node send.js --api-key=abc123');
  assert.equal(posix[0].cmd, `/usr/bin/node send.js --api-key=${MASK}`);

  const win = parsePwshJson(JSON.stringify([
    { ProcessId: 42, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node send.js --token=abc123', CreationDate: null },
  ]));
  assert.equal(win[0].cmd, `node send.js --token=${MASK}`);
  assert.equal(win[0].name, 'node.exe');
});

test('tool summaries are redacted before the 80-character trim', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'curl -H "authorization: Bearer aaaa.bbbb.cccc" https://api.example.com' }),
    `curl -H "authorization: ${MASK}" https://api.example.com`);
  // The mask lands inside the first 80 characters even when the secret straddled the old boundary.
  const long = summarizeToolInput('Bash', { command: `echo ${'a'.repeat(70)} --password=hunter2` });
  assert.ok(!long.includes('hunter2'), long);
  assert.equal(summarizeToolInput('Read', { file_path: 'public/game/city-scene.mjs' }), 'public/game/city-scene.mjs');
});

test('identifiers that are opaque but not secret stay readable', () => {
  // A session id is how a person recognises their own session in the panel; masking it would make
  // the tool useless for the case it exists for.
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.equal(redact(uuid), uuid);
  assert.equal(redact(`claude -r ${uuid}`), `claude -r ${uuid}`);
  assert.equal(redact(uuid.toUpperCase()), uuid.toUpperCase());
  assert.equal(redact('req_011CQ7dVJ8pKmN4xY'), 'req_011CQ7dVJ8pKmN4xY');
  assert.equal(redact('aimpl-task-15c-b6daa53c3d4e'), 'aimpl-task-15c-b6daa53c3d4e');

  // 40 characters with no break is still a digest, and still goes.
  assert.equal(redact('da39a3ee5e6b4b0d3255bfef95601890afd80709'), MASK);
  assert.equal(redact('0123456789abcdef0123456789abcdef01234567'), MASK);
  // A UUID with something appended is no longer a UUID.
  assert.equal(redact(`${uuid}0123456789`), MASK);
});

test('prompts are redacted on both store paths', () => {
  const store = new Store();
  // The transcript path: a prompt parsed out of a JSONL file.
  store.applyEvent({ kind: 'prompt', sessionId: 's1', agentId: 'main', ts: 1, text: 'deploy with --api-key=abc123 please' });
  // The hook path: UserPromptSubmit carrying the prompt inline.
  store.applyHook({ session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: 'psql postgres://u:hunter2@db/app' });
  const texts = store.session('s1').prompts.map((p) => p.text);
  assert.deepEqual(texts, [`deploy with --api-key=${MASK} please`, `psql postgres://u:${MASK}@db/app`]);
});
