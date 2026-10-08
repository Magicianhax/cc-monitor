#!/usr/bin/env node
// Claude Code hook → claude-city: post the hook payload from stdin to the local server.
//
//   node forward.mjs          posts to /hook   (every hook event)
//   node forward.mjs status   posts to /status and echoes stdin back, for use as a status-line tee
//
// It never fails. As a plugin hook it runs async, so Claude never waits for it, and it can afford a
// few seconds for a server that is still starting. As a status-line tee it is synchronous and gives
// up after one second. Node only: no shell, no curl, so it runs the same on every OS.
import { portFrom } from './port.mjs';

const status = process.argv[2] === 'status';
const port = portFrom(process.env);
const patience = status ? 1000 : 3000;
const hardStop = setTimeout(() => process.exit(0), patience + 1500);   // stdin that never closes still ends the hook

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', async () => {
  const body = Buffer.concat(chunks);
  if (status) process.stdout.write(body);
  if (body.length) {
    try {
      await fetch(`http://127.0.0.1:${port}/${status ? 'status' : 'hook'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(patience),
      });
    } catch { /* server not running: nothing to report to */ }
  }
  clearTimeout(hardStop);
  process.exit(0);
});
