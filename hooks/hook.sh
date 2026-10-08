#!/bin/sh
# Claude Code hook → cc-monitor. Never fails, never blocks (>1 s).
PORT="${CC_MONITOR_PORT:-4888}"
curl -s --connect-timeout 0.3 -m 1 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:${PORT}/hook" 2>/dev/null || true
exit 0
