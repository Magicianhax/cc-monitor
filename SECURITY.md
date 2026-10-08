# Security

claude-city reads data that can be sensitive: your prompts, file paths, shell commands and process
command lines. It is built to keep that data on your machine and away from anything else running in
your browser.

## What it protects against

- **Other devices on your network.** The server binds `127.0.0.1` by default. Binding anything else
  needs an explicit `--host`, and then every route requires a one-time token printed at startup.
- **Web pages you visit.** Every route checks the `Host` and `Origin` headers, which blocks DNS
  rebinding and cross-site posts. `/hook` and `/status` accept only `application/json`, so a browser
  has to send a CORS preflight, which the server never approves.
- **Secrets in commands and prompts.** `lib/redact.mjs` masks key, token and password values, the
  password in connection strings, and long opaque strings before anything is stored or sent to the
  page. Redaction is best-effort pattern matching, so a secret in an unusual format can still slip
  through.
- **Malformed input.** Transcripts and hook payloads are treated as untrusted. Parsers never throw,
  session ids are validated before any filesystem access, and the static file route is confined to
  `public/`.

## Known gaps

- Neither the static file route nor the transcript reader resolves symlinks with `realpath`. A
  symlink planted inside `~/.claude` or `public/` by a program already running as you would be
  followed.
- Phaser is pinned by SHA-384 through the import map's `integrity` field. A browser that doesn't
  support import-map integrity ignores the field, so in that browser Phaser is pinned by version and
  origin only. Vendoring it into `public/vendor/` would close the gap.
- The Content-Security-Policy allows `'unsafe-inline'` scripts, because the page uses an inline
  import map and module script.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Don't open a public issue for a security problem.
