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
