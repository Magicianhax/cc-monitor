# Install

claude-city runs on Windows, macOS and Linux: same code, same hooks, same page. The only requirement
is **Node ≥ 20** on your PATH (`node -v`). There is nothing to `npm install`.

## As a Claude Code plugin (recommended)

In Claude Code:

```
/plugin marketplace add https://github.com/Magicianhax/claude-city.git
/plugin install cc-city@claude-city
```

Or from a terminal:

```sh
claude plugin marketplace add https://github.com/Magicianhax/claude-city.git
claude plugin install cc-city@claude-city
```

Then start a new Claude Code session, or run `/reload-plugins` in the current one. The first session
starts the server and tells you where it is: <http://127.0.0.1:4888>. Every session after that reports
into the same server.

The plugin is called `cc-city` because Claude Code reserves plugin names that start with `claude-`.
The short form `/plugin marketplace add Magicianhax/claude-city` also works, but it clones over SSH,
so it needs an SSH key registered with GitHub. The HTTPS URL above works for everyone.

What the plugin adds:

- **A `SessionStart` hook** that starts the server on `127.0.0.1` if nothing answers on its port. It
  runs once per session start and returns in well under a second when the server is already up.
- **One forwarding hook per event** (`PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`,
  `UserPromptSubmit`, `Stop`, and so on) that posts the event to the server. These hooks run
  **async**, so they never add a millisecond to a turn, and they ignore a stopped server.

The hooks are Node scripts and need no shell, so they work on Windows without Git Bash.

**Update:** `claude plugin update cc-city@claude-city`, then restart the server (stop it, and the next
session starts the new version). Third-party marketplaces don't auto-update unless you turn it on in
`/plugin` under **Marketplaces**.

**Uninstall:** `claude plugin uninstall cc-city@claude-city`, then stop the server.

### Context-window bars

The context bar on each house is estimated from the session's transcript: everything the model read
on its latest turn, divided by that model's context window. That is close to what Claude Code shows,
but not exact. For the exact figure, route your status line through the forwarder, which passes its
input through unchanged:

```
node /abs/path/to/claude-city/hooks/forward.mjs status | <your current status line command>
```

Use a git clone for the path (see below), because the plugin's own folder changes with every update.
With no status line of your own, `node /abs/path/to/claude-city/hooks/forward.mjs status` on its own
works too.

## From a clone, without the plugin

```sh
git clone https://github.com/Magicianhax/claude-city.git
cd claude-city
node server.mjs
```

Open <http://127.0.0.1:4888>. Running sessions appear within a few seconds, because the server reads
the transcripts under `~/.claude` directly. For exact timings, subagent lifecycles and guard events,
add the hooks to `~/.claude/settings.json`. Merge these into its `hooks` object, adding to existing
lists rather than replacing them:

```json
{
  "SessionStart":       [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/start.mjs", "timeout": 10 },
                                      { "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "Stop":               [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "PreCompact":         [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }],
  "Notification":       [{ "hooks": [{ "type": "command", "command": "node /abs/path/to/claude-city/hooks/forward.mjs", "async": true }] }]
}
```

On Windows write the path with forward slashes and a drive letter, for example
`node C:/code/claude-city/hooks/forward.mjs`. If you use the plugin as well, leave these out: every
event would be sent twice.

## Watching from your phone

By default the server binds `127.0.0.1`, so only this machine can reach it. To watch from a phone on
the same Wi-Fi, stop the running server and start one by hand:

```sh
node server.mjs --host 0.0.0.0
```

It prints a warning, and the warning is the point: **anyone on that network with the link can read
your prompts, file paths, tool calls and costs.** Use it on your own network, not a cafe's.

Off loopback the server also prints a one-time token in the URL:

```
[claude-city] http://127.0.0.1:4888/?token=3f9a…  watching /home/you/.claude
```

Open `http://<this machine's LAN address>:4888/?token=<the token>` on the phone. The token is needed
once; after that an HttpOnly, SameSite=Strict cookie keeps the phone signed in. Every route answers
401 without it.

| OS | Find the address | First-time firewall |
|---|---|---|
| Windows | `ipconfig` → IPv4 Address | Allow Node on **Private** networks only when Windows Defender asks |
| macOS | `ipconfig getifaddr en0` | Allow incoming connections when macOS asks |
| Linux | `hostname -I` | `sudo ufw allow from 192.168.0.0/16 to any port 4888` if ufw is on |

An SSH tunnel works too and keeps the server on loopback. Forward the **same port on both sides**,
because the server checks the port in the `Host` header:

```sh
ssh -L 4888:localhost:4888 you@the-machine   # then open http://localhost:4888
```

The `SessionStart` hook always starts the server on loopback and ignores `CLAUDE_CITY_HOST`, so
sharing your sessions on the network is always something you type.

## Options

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| `--host <addr>` | `CLAUDE_CITY_HOST` | `127.0.0.1` | Address to bind. `0.0.0.0` exposes it to the LAN, behind a token. The `SessionStart` hook always binds loopback |
| `--port <n>` | `CLAUDE_CITY_PORT` | `4888` | Port for the page and the hooks |
| `--claude-dir <path>` | `CLAUDE_CITY_CLAUDE_DIR` | `~/.claude` | Where transcripts and the session registry live |

Flags beat environment variables. The hooks read `CLAUDE_CITY_PORT` too, so you can change the port
in one place, for example under `env` in `~/.claude/settings.json`. The pre-rename names
(`CC_MONITOR_PORT` and so on) still work.

## Troubleshooting

- **`Permission denied (publickey)` when adding the marketplace.** You used the `owner/repo` short
  form, which clones over SSH. Use the HTTPS URL instead.
- **The city is empty.** Check that the server is up: `curl -s http://127.0.0.1:4888/api/sessions`.
  Then start a new Claude Code session. With the plugin, `/plugin` should list `cc-city` as enabled.
- **`port 4888 in use (another claude-city?)`.** One is already running. That is normal, and the
  reason the `SessionStart` hook checks before starting one.
- **No cars in the city.** Process listing failed. On Windows that means `pwsh` (PowerShell 7) is
  missing; elsewhere, `ps`. Everything else keeps working.
- **`401 token required`.** The server is bound off loopback. Open the `?token=…` URL it printed at
  startup once. Restarting the server issues a new token.
- **`403 forbidden host or origin`.** The request arrived under a host name the server doesn't answer
  to. Use the machine's IP address, `localhost`, or what you passed to `--host`, and keep the port the
  same through any tunnel or proxy. This check is what stops a web page you visit from reading the
  dashboard.
- **Server log.** With the plugin: `server.log` in the plugin's data folder,
  `~/.claude/plugins/data/<plugin id>/`. From a clone: `.tmp/server.log` in the repo.
