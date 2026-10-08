#!/bin/sh
# Tee the status-line JSON to cc-monitor, then pass it through unchanged.
PORT="${CC_MONITOR_PORT:-4888}"
IN=$(cat)
printf '%s' "$IN" | curl -s --connect-timeout 0.3 -m 1 -o /dev/null -X POST -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:${PORT}/status" 2>/dev/null || true
printf '%s' "$IN"
exit 0
