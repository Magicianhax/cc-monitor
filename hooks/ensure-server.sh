#!/bin/sh
# SessionStart hook: start cc-monitor if nothing answers on the port.
# POSIX sh, so the same file runs under Git Bash on Windows, macOS and Linux.
PORT="${CC_MONITOR_PORT:-4888}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${CC_MONITOR_NODE:-node}"           # set CC_MONITOR_NODE if node is not on the hook's PATH
command -v curl >/dev/null 2>&1 || exit 0

probe() { curl -s --connect-timeout 0.3 -m 1 -o /dev/null "http://$1:${PORT}/api/sessions" 2>/dev/null; }

probe 127.0.0.1 && exit 0

# A server started by hand may be bound to one specific address and not to loopback, in which case
# the probe above says "nothing there" and this hook would start a second one beside it.
H=$(printf '%s' "${CC_MONITOR_HOST:-}" | tr -d '[]')
if [ -n "$H" ] && [ "$H" != "0.0.0.0" ] && [ "$H" != "::" ] && [ "$H" != "::1" ] && [ "$H" != "localhost" ] &&
   ! printf '%s' "$H" | grep -q '^127\.'; then
  case "$H" in *:*) T="[$H]" ;; *) T="$H" ;; esac
  probe "$T" && exit 0
fi

command -v "$NODE" >/dev/null 2>&1 || exit 0
mkdir -p "$ROOT/.tmp"
# The hook always binds loopback and deliberately ignores CC_MONITOR_HOST. Publishing every session
# on the network has to be something the human types (`node server.mjs --host 0.0.0.0`), not a side
# effect of an environment variable that some other tool set in ~/.claude/settings.json.
cd "$ROOT" && CC_MONITOR_HOST=127.0.0.1 nohup "$NODE" server.mjs >> .tmp/server.log 2>&1 &
exit 0
