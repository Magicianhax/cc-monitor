# Install

cc-monitor runs on Windows, macOS and Linux. Same code, same hooks, same page.

## Requirements

- **Node ≥ 20** (`node -v`). No `npm install` is needed to run it; the one dependency is a dev tool for regenerating art.
- **curl** on the PATH. Present by default on Windows 10+, macOS and every mainstream Linux.
- **A POSIX shell** to run the hooks: Git Bash on Windows (it ships with Git for Windows), `/bin/sh` everywhere else.
- Claude Code, obviously, writing to `~/.claude`.

## 1. Run it once by hand

```sh
cd /path/to/cc-monitor
node server.mjs
```

Open <http://127.0.0.1:4888>. An empty city means the server is up but no session has reported yet; it fills in as soon as a Claude Code session with the hooks installed starts a turn.

Stop it with Ctrl+C.

## 2. Wire the hooks into `~/.claude/settings.json`

Every hook is the same one-line script, so the block below is identical on all three systems apart from
the path. Merge it into the `hooks` object of `~/.claude/settings.json`, keeping any entries you
already have: add to each list rather than replacing it, and create the lists that are missing.

Replace `/abs/path/to/cc-monitor` with the folder you cloned into, written the way your OS section
below shows.

```json
{
  "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/ensure-server.sh", "timeout": 5 }, { "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "SessionEnd":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "PreToolUse":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "SubagentStart":    [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "SubagentStop":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "PreCompact":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }],
  "Notification":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh /abs/path/to/cc-monitor/hooks/hook.sh", "timeout": 2 }] }]
}
```

The hooks never block and never fail: each is a `curl` with a 1-second cap that swallows its own
errors, so a stopped server costs a session nothing but the timeout.

### Windows

Use **forward slashes and a drive letter**, which is what Git Bash understands:

```
sh C:/code/cc-monitor/hooks/hook.sh
```

Backslashes have to be escaped inside JSON and are easy to get wrong, so avoid them. If `sh` is not
found, add Git's `usr/bin` to your PATH or spell the shell out in full:
`"C:/Program Files/Git/bin/sh.exe" C:/code/cc-monitor/hooks/hook.sh`.

Process listing uses `pwsh` (PowerShell 7). Without it the city still works; the cars, which are the
child processes of each session, simply never appear.

### macOS

```
sh /Users/you/code/cc-monitor/hooks/hook.sh
```

Process listing uses `ps`, which is part of the system. If you installed Node with `nvm`, a hook
launched from the macOS UI may not see it on its PATH; set `CC_MONITOR_NODE` to the absolute path of
your `node` binary, for example in `~/.claude/settings.json` under `env`.

### Linux

```
sh /home/you/code/cc-monitor/hooks/hook.sh
```

Process listing uses `ps` from procps. The same `CC_MONITOR_NODE` note as macOS applies to `nvm` and
to distro-less-standard Node installs.

## 3. Status line (optional)

The status line carries the model, the cost and the context percentage, which nothing else reports.
Tee it through cc-monitor and pass it on unchanged. If you already have a status line command, put
this in front of it:

```
sh /abs/path/to/cc-monitor/hooks/status-tee.sh | bash ~/.claude/statusline-command.sh
```

With no status line of your own, `sh /abs/path/to/cc-monitor/hooks/status-tee.sh` alone works: it
prints its input back out.

## 4. Start a new session

The next Claude Code session starts the server through `SessionStart` and appears in the city within
a few seconds. Nothing leaves the machine: the page, the server and your transcripts stay local.

## Watching from your phone

By default the server binds `127.0.0.1` and only this machine can reach it. To watch the city from a
phone on the same Wi-Fi:

```sh
node server.mjs --host 0.0.0.0
```

It prints a warning when it does this, and the warning is the point: **anyone on that network who has
the link can read your prompts, file paths, tool calls and costs.** Use it on your own network, not a
cafe's.

Off loopback the server also prints a one-time token in the URL:

```
[cc-monitor] http://127.0.0.1:4888/?token=3f9a…  watching /home/you/.claude
```

That token is required once. The first request with it sets an HttpOnly, SameSite=Strict cookie, and
the phone stays signed in from then on. Without it every route answers 401. A loopback bind has no
token: on your own machine it would only be a password for reading your own screen.

Then find the machine's LAN address and open `http://<that-address>:4888/?token=<the token>` on the
phone:

| OS | Find the address | First-time firewall |
|---|---|---|
| Windows | `ipconfig` → IPv4 Address | Windows Defender prompts on first bind; allow Node on **Private** networks only |
| macOS | `ipconfig getifaddr en0` | macOS prompts to accept incoming connections; allow |
| Linux | `hostname -I` | `sudo ufw allow from 192.168.0.0/16 to any port 4888` if ufw is on |

The page is touch-friendly: drag to pan, pinch to zoom, and under 640 px wide the panel becomes a
bottom sheet.

Tunnelling instead of binding the LAN works too, and keeps the server on loopback. Forward the **same
port on both sides**, because the server checks the port in the `Host` header and a mismatch answers
403:

```sh
ssh -L 4888:localhost:4888 you@the-machine   # then open http://localhost:4888
```

The `SessionStart` hook always starts the server on loopback and deliberately ignores
`CC_MONITOR_HOST`, so publishing your sessions to the network is always something you type, never
something an environment variable does quietly on your behalf. Run the command above by hand when
you want the phone to see it.

## Options

| Flag | Environment variable | Default | Meaning |
|---|---|---|---|
| `--host <addr>` | `CC_MONITOR_HOST` | `127.0.0.1` | Address to bind. `0.0.0.0` exposes it to the LAN, behind a token. Ignored by the `SessionStart` hook, which always binds loopback |
| `--port <n>` | `CC_MONITOR_PORT` | `4888` | Port for the page and the hooks |
| `--claude-dir <path>` | `CC_MONITOR_CLAUDE_DIR` | `~/.claude` | Where transcripts and the session registry live |
| | `CC_MONITOR_NODE` | `node` | Node binary `ensure-server.sh` starts, for when it is not on the hook's PATH |

Flags beat environment variables. The hooks read `CC_MONITOR_PORT` too, so change the port in one
place and everything follows.

## Troubleshooting

- **The city is empty.** Check the server is up: `curl -s http://127.0.0.1:4888/api/sessions`. Then
  check a hook fires: run `sh /abs/path/to/cc-monitor/hooks/hook.sh` with a JSON payload on stdin; it
  should exit 0 silently.
- **`port 4888 in use (another cc-monitor?)`.** One is already running. That is the normal case and
  the reason `ensure-server.sh` probes before starting.
- **No cars in the city.** Process listing failed. On Windows that means `pwsh` is missing; elsewhere
  `ps`. Everything else keeps working.
- **`401 token required`.** The server is bound off loopback. Open the `?token=…` URL it printed at
  startup once; the cookie carries it after that. Restarting the server issues a new token.
- **`403 forbidden host or origin`.** The request arrived under a host name the server does not
  answer to. Use the machine's IP address, `localhost`, or whatever you passed to `--host`. This is
  the DNS-rebinding guard, and it is the one thing that stops a web page you visit from reading the
  dashboard behind your back. The port is compared as well as the name, so a tunnel or a proxy has to
  keep the port the same: `ssh -L 4888:localhost:4888`, not `-L 9999:localhost:4888`.
- **The server log.** `ensure-server.sh` appends to `.tmp/server.log` inside the repo.

## Uninstall

Remove the entries you added to `~/.claude/settings.json`, stop the server, delete the folder.
Nothing else was written outside the repo.
