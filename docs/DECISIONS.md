# Decisions

Append-only. Never edit or delete an entry; supersede it with a new one.

Format:

```
## ADR-NNNN <title> (YYYY-MM-DD)
**Status:** proposed | accepted | superseded by ADR-NNNN
**Context:** what forced the decision, in two sentences
**Decision:** what was chosen
**Consequences:** what becomes easier, what becomes harder, what must now be true
```

---

## ADR-0001 Adopt this template (2026-09-17)
**Status:** accepted
**Context:** Project bootstrapped from `~/.claude/templates/project` during `/ship`.
**Decision:** `PRODUCT.md`, `DESIGN.md`, `docs/ARCHITECTURE.md` and this log are the durable context; `tasks/todo.md` is the working plan.
**Consequences:** `/ship` reads these first; missing files are bootstrapped, not invented.

## ADR-0002 Hooks plus transcript tailing as the data source (2026-09-16)
**Status:** accepted
**Context:** Claude Code exposes hooks (timing, lifecycle) and writes JSONL transcripts with per-message token usage; OpenTelemetry export exists but gives no agent tree.
**Decision:** POST hook payloads to a local server via curl; tail `~/.claude/projects/**/*.jsonl`, `sessions/*.json`, `teams/*/config.json`, `hooks/guard.log`; poll the OS process table for shells.
**Consequences:** Zero hosting, works offline; parser must tolerate version drift in record shapes; hooks must never block Claude.

## ADR-0003 Dependency-free backend (2026-09-16)
**Status:** accepted
**Context:** The server is tiny and must install anywhere with plain Node.
**Decision:** `lib/` and `server.mjs` use only `node:*` modules; tests use `node:test`.
**Consequences:** No supply-chain surface for the runtime; file watching relies on `fs.watch` (robust enough with a poll fallback in the tailer).

## ADR-0004 Superseded scene attempts (2026-09-16 → 2026-09-17)
**Status:** superseded by ADR-0005
**Context:** A three.js toon scene and then a hand-rolled Canvas-2D isometric town were built; the human rejected the first as tiny and text-less and the second's per-session plots as "tiny farms".
**Decision:** Both abandoned (history on branch `wip/canvas-town` and commit e14768e).
**Consequences:** The scene is one shared living city, not per-session plots; every citizen and building carries readable text.

## ADR-0005 Phaser 3 + easystar.js + Tiled for the city (2026-09-17)
**Status:** accepted
**Context:** The human asked to use strong OSS instead of hand-rolling, and the city needs tilemaps, sprite animation, camera and pathfinding.
**Decision:** Phaser 3 (isometric tilemap from a Tiled JSON map), easystar.js for A*, loaded from jsdelivr via importmap (no bundler). Runtime dev dependency `pngjs` only for the art pipeline.
**Consequences:** Far less custom rendering code; the map is editable in Tiled; page depends on a CDN at load (pinned versions; offline fallback is a later concern).

## ADR-0006 Generated art is shipped, not just reference (2026-09-17)
**Status:** accepted
**Context:** gpt-image-2.5 produced consistent isometric building, prop, character and vehicle sheets on a magenta key background.
**Decision:** Ship the sheets after chroma-key and atlas packing by `tools/prep-art.mjs`; raw sheets are committed; characters are tinted per model family at load.
**Consequences:** Much better look than ASCII sprites; regenerate with `tools/gen-art.mjs <name>`; licence is the OpenAI output terms (fine for a personal tool; revisit before public release).

## ADR-0007 Cross-platform from v1 (2026-09-17)
**Status:** accepted
**Context:** The human: "we are making something iOS, Linux, Windows, everyone can use".
**Decision:** Per-OS process listing (`pwsh` on Windows, `ps` on macOS/Linux); POSIX sh hooks; opt-in `--host` flag to bind the LAN for phone viewing; touch-friendly page (Phaser pointer/pinch, bottom-sheet panel under 640 px).
**Consequences:** A macOS/Linux test run is needed before calling it done; iOS means Safari on the LAN, not a native app.

## ADR-0008 Rename to claude-city and ship as a Claude Code plugin (2026-10-08)
**Status:** accepted
**Context:** The human asked for an installable Claude Code plugin and a new name, and chose "claude-city". Claude Code reserves plugin names that start with `claude-`, and a plugin cannot set a status line.
**Decision:** The product, repo and marketplace are `claude-city`; the plugin ID is `cc-city`, installed as `cc-city@claude-city`. Hooks are Node scripts (`hooks/forward.mjs`, `hooks/start.mjs`) run in exec form, async except the SessionStart starter, replacing the `sh` + `curl` scripts. The context bar is estimated from each turn's usage divided by the model's window (`lib/prices.json`), with the status-line tee still available for the exact figure. `CLAUDE_CITY_*` environment variables replace `CC_MONITOR_*`, which still work.
**Consequences:** Two-command install on every OS with no Git Bash requirement, and hooks never add latency. The first events of the very first session after boot can be lost while the server reads `~/.claude`. A plugin update takes effect after the server restarts.
