// Everything the city displays comes from somewhere hostile to privacy: a process's argv, a Bash
// command, a tool input. Any of those can carry a key. This masks the obvious shapes before the
// value reaches the store, which is the last point where it is still in one place; after that it is
// in a snapshot, an SSE frame, a replay and every connected browser.
export const MASK = '\u2022\u2022\u2022';

// scheme://user:password@host — the password, not the user, and not a bare host:port.
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s/@]+)@/gi;

// A key-ish name, then `=` or `:`, then its value. The name may carry a prefix (`PGPASSWORD`,
// `--api-key`, `OPENAI_API_KEY`), so the boundary is hand-rolled rather than `\b`. The name and the
// separator are kept; only the value goes. A `bearer <value>` is taken whole, since the token is the
// word after it.
const SECRET_ASSIGN = new RegExp(
  '(?<![A-Za-z0-9_])'
  + '([A-Za-z0-9_.-]*(?:token|api[_-]?key|key|secret|passwd|password|pwd|authorization|auth|bearer))'
  + '(?![A-Za-z0-9_])'
  + '(["\']?\\s*[:=]\\s*)'
  + '("[^"\\n]*"|\'[^\'\\n]*\'|bearer\\s+[^\\s"\']+|[^\\s"\'&;,]+)',
  'gi',
);

// A long opaque run: hex digests, base64url blobs, `ghp_…`, `sk-…`. Deliberately NOT the security
// review's literal `[A-Za-z0-9+/_-]{32,}`, which includes `/` and so eats any absolute path longer
// than 32 characters — and absolute paths are most of what this tool exists to show. Runs are
// therefore measured between path separators instead, which still catches a secret sitting in a URL
// path or a query string.
//
// 40, not 32, because the city is full of identifiers that are opaque but not secret: a session id,
// a request id, a run id. A hex digest and an API key are 40 or longer; a UUID is 36 and now stays
// readable, which is what makes a session recognisable in the panel.
const LONG_RUN = /[A-Za-z0-9+_=-]{40,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redact(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (!s) return '';
  try {
    s = s.replace(URL_CREDS, (_m, head) => `${head}:${MASK}@`);
    s = s.replace(SECRET_ASSIGN, (_m, name, sep, val) => {
      const q = val[0] === '"' || val[0] === "'" ? val[0] : '';
      return `${name}${sep}${q}${MASK}${q}`;
    });
    // The UUID guard is belt and braces: at 36 characters a UUID is already under the run
    // threshold. It keeps that true if the threshold is ever lowered again.
    s = s.replace(LONG_RUN, (run) => (UUID.test(run) ? run : MASK));
    return s;
  } catch { return s; }   // a pathological input must never take down an ingest tick
}
