import { execFile } from 'node:child_process';
import { parsePs, runPs } from './procs-posix.mjs';
import { redact } from './redact.mjs';

const PWSH_CMD = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress';

export function runPwsh() {
  return new Promise((resolve, reject) => {
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-Command', PWSH_CMD], { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function parseDate(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = /\/Date\((\d+)\)\//.exec(v);
    if (m) return Number(m[1]);
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function parsePwshJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  if (!data) return [];
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter((r) => r && Number.isInteger(r.ProcessId)).map((r) => ({
    // A full argv is the most reliable place on the machine to find a key on the command line, and
    // every one of these ends up in a browser, so it is masked here rather than at the edge.
    pid: r.ProcessId, ppid: r.ParentProcessId | 0, name: r.Name || '', cmd: redact(r.CommandLine || ''), startedAt: parseDate(r.CreationDate),
  }));
}

export function descendants(all, rootPids) {
  const children = new Map();
  for (const p of all) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const out = new Map();
  for (const root of rootPids) {
    const acc = [];
    const stack = [root];
    const seen = new Set([root]); // a stale ppid after pid reuse can point back at the root
    while (stack.length) {
      const pid = stack.shift();
      for (const c of children.get(pid) || []) {
        if (seen.has(c.pid)) continue;
        seen.add(c.pid); acc.push(c); stack.push(c.pid);
      }
    }
    out.set(root, acc);
  }
  return out;
}

// Windows lists processes through pwsh, everything else through ps. The runner and the parser are
// picked together, so a test that hands over ps text also has to say which platform it is pretending
// to be; otherwise the suite would parse its own fixtures differently depending on the host OS.
export function procsFor(platform = process.platform) {
  return platform === 'win32' ? { run: runPwsh, parse: parsePwshJson } : { run: runPs, parse: parsePs };
}

// Accepts either listProcesses(run) / listProcesses(run, { platform }) or listProcesses({ run, platform }).
function normalize(runOrOpts, opts) {
  return typeof runOrOpts === 'function' ? { ...opts, run: runOrOpts } : { ...(runOrOpts || {}) };
}

export async function listProcesses(runOrOpts, opts) {
  const o = normalize(runOrOpts, opts);
  const { run, parse } = procsFor(o.platform);
  try { return parse(await (o.run || run)()); } catch { return []; }
}

export function startProcPoller({ rootPidsFn, onResult, run, platform, intervalMs = 3000, slowMs = 2000, backoffMs = 10000 }) {
  let stopped = false;
  let timer = null;
  const tick = async () => {
    if (stopped) return;
    const t0 = Date.now();
    let roots = [];
    try { roots = rootPidsFn() || []; } catch { roots = []; }
    const all = roots.length ? await listProcesses({ run, platform }) : [];
    if (stopped) return;
    try { onResult(descendants(all, roots)); } catch { /* consumer errors never stop the poller */ }
    const next = Date.now() - t0 > slowMs ? backoffMs : intervalMs;
    timer = setTimeout(tick, next);
    if (timer.unref) timer.unref();
  };
  tick();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
