// The port the hooks talk to: CLAUDE_CITY_PORT, then the pre-rename CC_MONITOR_PORT, then 4888.
export const DEFAULT_PORT = 4888;

export function portFrom(env) {
  for (const key of ['CLAUDE_CITY_PORT', 'CC_MONITOR_PORT']) {
    const raw = env[key];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
  }
  return DEFAULT_PORT;
}
