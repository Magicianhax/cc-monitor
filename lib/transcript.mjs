import { redact } from './redact.mjs';

const SUMMARY_KEYS = ['command', 'file_path', 'pattern', 'description', 'query', 'url', 'skill', 'path', 'prompt'];

export function contextFromPath(filePath, claudeDir) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(claudeDir) + '/projects/';
  const p = norm(filePath);
  if (!p.startsWith(root) || !p.endsWith('.jsonl')) return null;
  const parts = p.slice(root.length).split('/');           // [slug, ...rest]
  if (parts.length === 2) {
    return { sessionId: parts[1].slice(0, -6), agentId: 'main', source: 'main', workflowId: null };
  }
  if (parts.length >= 4 && parts[2] === 'subagents') {
    const base = parts[parts.length - 1];
    const m = /^agent-(.+)\.jsonl$/.exec(base);
    if (!m) return null;
    const wf = parts[3] === 'workflows' && parts.length >= 6 ? parts[4] : null;
    return { sessionId: parts[1], agentId: m[1], source: wf ? 'workflow' : 'subagent', workflowId: wf };
  }
  return null;
}

export function summarizeToolInput(name, input) {
  try {
    if (!input || typeof input !== 'object') return '';
    // Redaction happens before the 80-character trim, so a mask can never be cut in half and a
    // secret can never survive by sitting across the boundary.
    for (const k of SUMMARY_KEYS) {
      if (typeof input[k] === 'string' && input[k].trim()) return redact(input[k].trim().replace(/\s+/g, ' ')).slice(0, 80);
    }
    return redact(JSON.stringify(input)).slice(0, 80);
  } catch { return ''; }
}

export function parseLine(line, ctx) {
  if (!line || !line.trim()) return null;
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r !== 'object' || !r.message) return null;
  const sessionId = r.sessionId || r.session_id || ctx.sessionId;
  const agentId = r.agentId || ctx.agentId;
  const ts = r.timestamp ? Date.parse(r.timestamp) || Date.now() : Date.now();
  const msg = r.message;
  const content = Array.isArray(msg.content) ? msg.content : null;

  if (r.type === 'assistant') {
    const u = msg.usage || {};
    const ev = {
      kind: 'usage', sessionId, agentId, ts,
      model: msg.model || null, effort: r.effort ?? null, requestId: r.requestId ?? null,
      gitBranch: r.gitBranch ?? null, cwd: r.cwd ?? null, version: r.version ?? null,
      tokens: {
        input: u.input_tokens | 0, output: u.output_tokens | 0,
        cacheRead: u.cache_read_input_tokens | 0, cacheWrite: u.cache_creation_input_tokens | 0,
        thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) | 0,
      },
      toolUses: [],
    };
    for (const c of content || []) {
      if (c && c.type === 'tool_use') {
        ev.toolUses.push({ kind: 'tool_use', sessionId, agentId, ts, toolUseId: c.id, name: c.name, summary: summarizeToolInput(c.name, c.input) });
      }
    }
    return ev;
  }
  if (r.type === 'user') {
    if (content) {
      const tr = content.find((c) => c && c.type === 'tool_result');
      if (tr) {
        const ok = r.toolUseResult && typeof r.toolUseResult.success === 'boolean' ? r.toolUseResult.success : !tr.is_error;
        return { kind: 'tool_result', sessionId, agentId, ts, toolUseId: tr.tool_use_id, ok };
      }
      const txt = content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      // Mask here, not in the store: `/api/session/:id/replay` rebuilds from the JSONL and never
      // touches the store, so masking downstream would still ship raw secrets to every browser.
      if (txt) return { kind: 'prompt', sessionId, agentId, ts, text: redact(txt).slice(0, 2000) };
      return null;
    }
    if (typeof msg.content === 'string') return { kind: 'prompt', sessionId, agentId, ts, text: redact(msg.content).slice(0, 2000) };
  }
  return null;
}
