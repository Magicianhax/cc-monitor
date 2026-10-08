import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

test('the plugin and marketplace manifests agree, and the plugin name is not reserved', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  const pkg = json('package.json');
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case');
  assert.ok(!/^(claude|anthropic)-/.test(plugin.name), 'Claude Code reserves claude- and anthropic- plugin names');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  assert.equal(plugin.version, pkg.version, 'bump plugin.json and package.json together');
});

test('every plugin hook runs node on a script that exists, and only the starter blocks', () => {
  const { hooks } = json('hooks/hooks.json');
  const seen = new Set();
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const h of group.hooks) {
        assert.equal(h.type, 'command', event);
        assert.equal(h.command, 'node', `${event}: exec form, so no shell is needed on Windows`);
        const script = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}', ROOT);
        assert.ok(existsSync(script), `${event}: ${h.args[0]} is missing`);
        seen.add(h.args[0].split('/').pop());
        if (!h.args[0].endsWith('start.mjs')) assert.equal(h.async, true, `${event}: forwarding must never block a turn`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['forward.mjs', 'start.mjs']);
  for (const event of ['SessionStart', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'UserPromptSubmit']) {
    assert.ok(hooks[event], `${event} is wired`);
  }
});
