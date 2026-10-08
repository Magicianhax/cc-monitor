import { readFileSync } from 'node:fs';
const TABLE = JSON.parse(readFileSync(new URL('./prices.json', import.meta.url), 'utf8'));
const KEYS = Object.keys(TABLE).filter((k) => !k.startsWith('_')).sort((a, b) => b.length - a.length);

export function priceFor(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const id = modelId.replace(/\[.*?\]$/, '').trim();
  if (TABLE[id]) return TABLE[id];
  const k = KEYS.find((key) => id.startsWith(key));
  return k ? TABLE[k] : null;
}

export function costUsd(modelId, t) {
  const p = priceFor(modelId);
  if (!p || !t) return null;
  const n = (x) => Number(x) || 0;
  return (n(t.input) * p.input + n(t.output) * p.output + n(t.cacheRead) * p.cacheRead + n(t.cacheWrite) * p.cacheWrite) / 1e6;
}

/** The model's context window in tokens, or null for a model the table does not know. */
export function contextWindowFor(modelId) {
  const p = priceFor(modelId);
  return p && Number(p.context) > 0 ? Number(p.context) : null;
}

/**
 * How full the context window is, as a whole percentage, from one assistant turn's usage.
 *
 * Everything the model read on that turn (fresh input plus cache reads and writes) is the context
 * it was carrying. Null when the model's window is unknown.
 */
export function contextPercent(modelId, tokens) {
  const window = contextWindowFor(modelId);
  if (!window || !tokens) return null;
  const n = (x) => Number(x) || 0;
  const used = n(tokens.input) + n(tokens.cacheRead) + n(tokens.cacheWrite);
  return Math.min(100, Math.round((100 * used) / window));
}
