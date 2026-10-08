import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { redact } from './redact.mjs';

// One listing for macOS and Linux. `-a`/`x` widen it to every user's processes, `args=` goes last so
// the untruncated command line runs to the end of the line, and every `=` suppresses its header.
const PS_ARGS = ['-axo', 'pid=,ppid=,lstart=,comm=,args='];

export function runPs() {
  return new Promise((resolve, reject) => {
    execFile('ps', PS_ARGS, { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// pid, ppid, then lstart's five fields ("Tue Sep  1 08:04:59 2026"), then comm and args as one blob.
const LINE = /^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S[\s\S]*)$/;
const MAX_SPLIT_CANDIDATES = 64;

// comm and args are not separated by anything a split can see: procps pads comm to a fixed width,
// and macOS prints comm as the full executable path, which may itself contain spaces
// ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"). What is reliable is that args
// begins with argv[0], which for those same processes repeats comm verbatim. So the first prefix
// that the text immediately repeats is comm. Shortest match wins: a longer one can only be an
// accidental repeat further inside argv (`sh sh -c sh sh -c x` would otherwise yield "sh sh -c").
// With no repeat, comm has no spaces in practice and the first whitespace run is the boundary.
function splitCommArgs(rest) {
  const runs = [];
  let i = 0;
  while (i < rest.length && runs.length < MAX_SPLIT_CANDIDATES) {
    if (!/\s/.test(rest[i])) { i++; continue; }
    const start = i;
    while (i < rest.length && /\s/.test(rest[i])) i++;
    runs.push([start, i]);
  }
  const limit = (rest.length - 1) / 2;   // comm has to fit in the line twice over
  for (const [start, end] of runs) {
    if (start > limit) break;
    const comm = rest.slice(0, start);
    const after = rest.slice(end);
    if (after === comm || (after.startsWith(comm) && /\s/.test(after[comm.length]))) return { comm, args: after };
  }
  const first = runs[0];
  return first ? { comm: rest.slice(0, first[0]), args: rest.slice(first[1]) } : { comm: rest, args: '' };
}

export function parsePs(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) continue;   // headers, ps's own error output, anything that is not a process row
    const t = Date.parse(m[3]);
    const { comm, args } = splitCommArgs(m[4]);
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: posix.basename(comm),
      cmd: redact(args || comm),   // argv reaches every browser; mask keys before the store sees them
      startedAt: Number.isNaN(t) ? null : t,
    });
  }
  return out;
}
