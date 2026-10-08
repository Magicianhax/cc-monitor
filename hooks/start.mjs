#!/usr/bin/env node
// SessionStart hook: start the claude-city server if nothing answers on its port, and tell the user
// where to find it.
//
// The server always binds loopback here. Putting every session on the network has to be something
// the human types (`node server.mjs --host 0.0.0.0`), never a side effect of a hook or of an
// environment variable some other tool set.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portFrom } from './port.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = portFrom(process.env);
const url = `http://127.0.0.1:${port}`;
// Plugin installs get a data folder that survives updates; a git checkout logs beside the code.
const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(ROOT, '.tmp');

async function answering() {
  try {
    await fetch(`${url}/api/sessions`, { signal: AbortSignal.timeout(400) });
    return true;            // any HTTP answer means the port is taken, ours or not
  } catch {
    return false;
  }
}

function say(message) {
  // JSON with only systemMessage is shown to the user and never added to Claude's context.
  process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
}

try {
  if (!(await answering())) {
    mkdirSync(dataDir, { recursive: true });
    const log = openSync(join(dataDir, 'server.log'), 'a');
    const child = spawn(process.execPath, [join(ROOT, 'server.mjs'), '--port', String(port)], {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, CLAUDE_CITY_HOST: '127.0.0.1', CC_MONITOR_HOST: '127.0.0.1' },
    });
    writeFileSync(join(dataDir, 'server.pid'), String(child.pid));
    child.unref();
    for (let i = 0; i < 10 && !(await answering()); i++) await new Promise((r) => setTimeout(r, 150));
    say(`claude-city: your sessions are live at ${url}`);
  }
} catch {
  /* never block or fail a session start */
}
process.exit(0);
