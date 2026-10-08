# PRODUCT

## What it is

cc-monitor is a local web page that turns every running Claude Code session on your machine into a living pixel-art city. Sessions are houses; agents and subagents are citizens who walk to the Library, Forge, Server hall, Radio tower or Town hall depending on the tool they are using; background shells drive around as cars; guard blocks send a guard running. A persistent side panel narrates the same state as text: sessions, what each agent is doing now, tokens, cost, context window, and a live activity feed. Data comes from Claude Code hooks and the transcript files under `~/.claude`; nothing leaves the machine.

## Who it is for

- Primary user: a developer running several Claude Code sessions at once who wants to glance at a second monitor (or a phone on the same network) and see what every agent is doing and what it costs.
- Secondary: anyone who wants to show non-developers what agentic coding looks like.

## Job to be done

When I have two or more Claude Code sessions working, I want to see at a glance which agent is doing what, how fast tokens are burning and where a guard blocked something, so I can intervene early and stop paying for runaway loops.

## What it is not

- Not a hosted service, not telemetry, no accounts. Local only; opt-in LAN binding for phones.
- Not a control surface in v1: no killing processes, no sending prompts (v2 candidates).
- Not a cost report tool like ccusage; it is live and visual, with only a rough cost estimate.

## Success signals

- A person who has never seen the page can say which agent is doing what within 10 seconds, without clicking.
- Hook overhead per tool call under 150 ms when the server is up, under 500 ms when it is down.
- Works unchanged on Windows, macOS and Linux with Node ≥ 20; the page is usable from a phone browser on the LAN.
- Zero crashes of the server on malformed transcript or hook input over a full day of use.

## Constraints

- Chains / networks: none.
- Money: none moved. An OpenAI API key (`OPENAI_API_KEY` in `../.env.local`) is used only by `tools/gen-art.mjs` to generate art; never at runtime.
- Regulatory / distribution: none; later a Claude Code plugin from a git URL.

## Competitive wedge

Existing tools (ccusage, usage monitors) are tables of tokens. Nothing fuses hooks, transcripts and the process tree into a live, spatial picture that a human reads faster than a log. The city is the wedge; the panel keeps it honest.

## Open product questions

- LAN binding default: off (localhost only) unless `--host` is passed. Confirm before the plugin release.
- Whether "fight" should exist beyond the guard mechanic (decided: no violence, guard only).
