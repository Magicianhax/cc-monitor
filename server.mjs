import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { Store } from './lib/store.mjs';
import { startIngest, transcriptFiles } from './lib/ingest.mjs';
import { contextFromPath, parseLine } from './lib/transcript.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const BODY_LIMIT = 2 * 1024 * 1024;
// Phaser builds its textures and its audio decoder through blob: URLs, and the page's own inline
// module and import map are inline scripts, so 'unsafe-inline' stays until they move to files. Every
// remote origin is pinned: the two CDNs the page actually loads, and nothing else.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function makeToken() { return randomBytes(16).toString('hex'); }

// Constant-time, and length-safe: timingSafeEqual throws on a length mismatch, which would itself
// be an oracle if it escaped as a 500.
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

const strip = (h) => String(h ?? '').replace(/^\[|\]$/g, '').toLowerCase();
const isIpLiteral = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

export function isLoopbackAddr(addr) {
  const a = strip(addr);
  return a === '::1' || a === '::ffff:127.0.0.1' || /^127\./.test(a);
}

// DNS rebinding turns "only bound to loopback" into "readable by any web page": the attacker's
// domain resolves to 127.0.0.1 a second after their script loads, and the browser treats the result
// as same-origin. The defence is the Host header, which still says `evil.com`. A bare IP literal is
// accepted whatever it is, because rebinding needs a *name* — and with `--host 0.0.0.0` the phone
// legitimately arrives as the machine's own LAN address, which the server cannot know in advance.
export function hostAllowed(hostHeader, { host, port } = {}) {
  if (!hostHeader) return true;              // HTTP/1.0 and raw sockets: no header, no rebinding
  let u;
  try { u = new URL(`http://${hostHeader}`); } catch { return false; }
  if (!u.hostname || (u.port && port && Number(u.port) !== Number(port))) return false;
  const h = strip(u.hostname);
  if (h === 'localhost' || h === '::1' || isIpLiteral(h)) return true;
  return host ? h === strip(host) : false;
}

export function originAllowed(origin, hostHeader) {
  if (!origin || origin === 'null') return true;   // same-origin GETs send no Origin at all
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return strip(u.host) === strip(hostHeader);
}

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;   // past the limit: keep the stream flowing but throw the bytes away
      size += c.length;
      // Rejecting is immediate so the handler can answer 413 straight away, but the socket is
      // neither destroyed nor paused. Cutting an upload short mid-flight makes the peer observe an
      // ECONNRESET instead of the status, so the rest is drained and discarded; memory stays
      // bounded because nothing past the limit is ever buffered.
      if (size > BODY_LIMIT) { over = true; chunks.length = 0; reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function replayEvents(claudeDir, sessionId) {
  const events = [];
  for (const f of transcriptFiles(claudeDir, sessionId)) {
    const ctx = contextFromPath(f, claudeDir);
    if (!ctx) continue;
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const ev = parseLine(line, ctx);
      if (!ev) continue;
      if (ctx.workflowId) ev.workflowId = ctx.workflowId;
      events.push(ev);
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

export function createApp({ store, claudeDir, publicDir, host, token = null }) {
  const clients = new Set();
  // Every write to a client goes through here so the slow-client rule holds on both paths. The ping
  // needs it most: against an idle store no delta ever arrives, so a ping that skipped the
  // backpressure check would let a stalled client buffer indefinitely and never be dropped.
  const broadcast = (frame) => {
    for (const res of clients) {
      if (res.writableLength > 1e6) { res.destroy(); clients.delete(res); continue; }
      res.write(frame);
    }
  };
  // Every delta carries the two session-wide fields the page would otherwise only learn at connect
  // time: the parse-error count, which spec §5 asks to stay visible, and the store's wall clock,
  // which the city uses to expire its idle window.
  store.on('change', (delta) => {
    const frame = { ...delta, parseErrors: store.parseErrors, now: Date.now() };
    broadcast(`event: delta\ndata: ${JSON.stringify(frame)}\n\n`);
  });
  const ping = setInterval(() => broadcast(': ping\n\n'), 15000);
  if (ping.unref) ping.unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const extra = {};
    const send = (code, body, type = 'application/json') => {
      const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
      if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
      res.writeHead(code, headers);
      res.end(body);
    };
    try {
      // A local write endpoint is a write endpoint: the checks come before the routes, not inside
      // them, so a new route cannot be added without them.
      const hostHeader = req.headers.host;
      if (!hostAllowed(hostHeader, { host, port: req.socket.localPort }) || !originAllowed(req.headers.origin, hostHeader)) {
        return send(403, '{"error":"forbidden host or origin"}');
      }
      const localPost = (url.pathname === '/hook' || url.pathname === '/status') && isLoopbackAddr(req.socket.remoteAddress);
      if (token && !localPost) {
        const q = url.searchParams.get('token');
        if (q && safeEqual(q, token)) {
          // First load off the printed link. The cookie carries it from here so the token stops
          // appearing in the address bar, in history, and in any Referer the page sends out.
          extra['set-cookie'] = `cc_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
        } else if (!safeEqual(cookieValue(req.headers.cookie, 'cc_token'), token)) {
          return send(401, '{"error":"token required: open the URL cc-monitor printed at startup"}');
        }
      }
      if (req.method === 'POST' && (url.pathname === '/hook' || url.pathname === '/status')) {
        // text/plain is a CORS-simple content type, so without this any page on the internet could
        // POST a fabricated hook and script the city. application/json is not simple; it is
        // preflighted, and the preflight never passes the Origin check above.
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
          return send(415, '{"error":"content-type must be application/json"}');
        }
        let body;
        try { body = await readBody(req); } catch { return send(413, '{"error":"body too large"}'); }
        try {
          const j = JSON.parse(body);
          if (url.pathname === '/hook') store.applyHook(j); else store.applyStatus(j);
        } catch (e) { store.parseErrors += 1; console.error('[server] bad body on', url.pathname, e.message); }
        return send(204, '');
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'keep-alive', ...extra });
        res.write(`event: snapshot\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') return send(200, JSON.stringify(store.snapshot()));
      const m = /^\/api\/session\/([^/]+)\/replay$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        let sid;
        // Same malformed-escape guard as the static route below: `[^/]+` matches `%zz`, which no
        // session id can ever decode to, so it is an unknown session and not a server fault.
        try { sid = decodeURIComponent(m[1]); }
        catch { return send(404, '{"error":"unknown session"}'); }
        // `[^/]+` also matches `%2F..`, which decodes to a separator and would reach join() as a
        // traversal. A session id is a file name, so it is checked against one before any fs call.
        if (!SESSION_ID.test(sid)) return send(404, '{"error":"unknown session"}');
        if (!transcriptFiles(claudeDir, sid).length) return send(404, '{"error":"unknown session"}');
        return send(200, JSON.stringify({ sessionId: sid, events: replayEvents(claudeDir, sid) }));
      }
      if (req.method === 'GET') {
        let rel;
        // A malformed escape (%zz) throws out of decodeURIComponent; that is a bad request for a
        // static file, not a server fault, so it answers 404 like any other unservable path.
        try { rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)); }
        catch { return send(404, 'not found', 'text/plain'); }
        const ext = extname(rel);
        const root = resolve(publicDir);
        const full = resolve(root, normalize(rel));
        // The separator matters: a bare startsWith(root) also accepts a sibling directory whose
        // name merely begins with root, so `/..%2Fpublic-secrets%2Fkeys.json` would escape.
        if (!MIME[ext] || !full.startsWith(root + sep) || !existsSync(full) || !statSync(full).isFile()) return send(404, 'not found', 'text/plain');
        return send(200, readFileSync(full), MIME[ext]);
      }
      return send(404, 'not found', 'text/plain');
    } catch (e) {
      console.error('[server]', e);
      if (!res.headersSent) send(500, 'error', 'text/plain');
    }
  });
  server.on('close', () => { clearInterval(ping); for (const c of clients) c.destroy(); });
  return server;
}

const FLAGS = { '--host': 'host', '--port': 'port', '--claude-dir': 'claudeDir' };

const DEFAULT_PORT = 4888;
// 0 is legal and means "any free port", so this cannot be a truthiness check.
const portOrNull = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;   // undefined = present but junk
};

// Flags beat the environment, the environment beats the defaults, and anything unrecognised or
// unusable is ignored with a warning: a monitor that refuses to start is worse than one on the
// default port. Both port paths validate identically, because the environment one is the one people
// hand-edit in ~/.claude/settings.json, and an out-of-range port makes server.listen throw a
// *synchronous* RangeError that no 'error' listener ever sees.
export function parseArgs(argv = [], env = process.env, warn = (m) => console.error(m)) {
  const out = {
    host: env.CC_MONITOR_HOST || '127.0.0.1',
    port: DEFAULT_PORT,
    claudeDir: env.CC_MONITOR_CLAUDE_DIR || join(homedir(), '.claude'),
  };
  const envPort = portOrNull(env.CC_MONITOR_PORT);
  if (envPort === undefined) warn(`[cc-monitor] CC_MONITOR_PORT=${env.CC_MONITOR_PORT} is not a port between 0 and 65535; using ${DEFAULT_PORT}`);
  else if (envPort !== null) out.port = envPort;
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const key = FLAGS[name];
    if (!key) continue;
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') continue;
    if (key === 'port') {
      const n = portOrNull(value);
      if (n === undefined) warn(`[cc-monitor] --port ${value} is not a port between 0 and 65535; using ${out.port}`);
      else if (n !== null) out.port = n;
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

export function isLoopbackHost(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d/.test(h);
}

function main() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const { host, port, claudeDir } = parseArgs(process.argv.slice(2), process.env);
  const store = new Store();
  const ingest = startIngest({ store, claudeDir });
  // A loopback bind is already limited to people who can run code on this machine, and a token there
  // would only be a password the user has to paste to read their own screen. Off loopback it is the
  // only thing between a session transcript and everyone on the Wi-Fi.
  const token = isLoopbackHost(host) ? null : makeToken();
  const server = createApp({ store, claudeDir, publicDir: join(here, 'public'), host, token });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`[cc-monitor] port ${port} in use (another cc-monitor?)`); process.exit(1); }
    throw e;
  });
  // A wildcard bind is the address the socket listens on, not one you can type into a browser, so
  // the printed URL falls back to loopback and the phone gets its own line in INSTALL.md.
  const bare = host.replace(/^\[|\]$/g, '');
  const shown = bare === '0.0.0.0' || bare === '::' ? '127.0.0.1' : (bare.includes(':') ? `[${bare}]` : bare);
  const query = token ? `/?token=${token}` : '';
  try {
    server.listen(port, host, () => {
      console.log(`[cc-monitor] http://${shown}:${port}${query}  watching ${claudeDir}`);
      if (token) {
        console.log(`[cc-monitor] WARNING: bound to ${host}, so the dashboard is reachable from the whole network and anyone on it can read your prompts, file paths and tool calls.`);
        console.log('[cc-monitor] Open the link above on the phone; the token is required once and then kept in a cookie. Substitute this machine\'s LAN address for the host.');
      }
    });
  } catch (e) {
    // listen() validates its arguments synchronously, so a bad host or port throws here and never
    // reaches the 'error' handler above. A stack trace would be a worse answer than a sentence.
    console.error(`[cc-monitor] cannot listen on ${host}:${port}: ${e.message}`);
    process.exit(1);
  }
  // close() alone waits for every open connection to end, and an SSE stream never ends, so
  // Ctrl+C with the dashboard open would hang instead of exiting. The connections have to go first.
  const shutdown = () => { ingest.stop(); server.close(() => process.exit(0)); server.closeAllConnections?.(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
