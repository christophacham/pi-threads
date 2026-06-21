---
name: pi-threads
description: Install, configure, and develop the pi-threads Pi extension for persistent subagent threads. Use when spawning/waiting/sending to subagent threads, debugging thread sessions, extending thread tools, fork_turns context copy, dual-write persistence, parent vs child session roles, or working in this repo. Do not use for generic Pi extension tutorials unrelated to threads/subagents.
---

# pi-threads

Guide for using and hacking on **pi-threads**: a Pi extension that runs isolated child `pi` subprocesses as persistent subagent threads.

## When to read what

| Task | Start here |
|------|------------|
| Install or load extension | [Install](#install) |
| Agent/tool usage patterns | [Tools workflow](#tools-workflow) |
| Session switching in TUI | [Navigation](#navigation) |
| Change extension code | [Development](#development) |
| Dual-write / protocol details | `references/protocol.md` |

## Install

**Recommended (package):**

```bash
pi install git:github.com/christophacham/pi-threads
# local checkout:
pi install /path/to/pi-threads
pi install -l ./pi-threads
```

**Project-local dev:** symlink repo root — never copy files into `.pi/extensions/pi-threads/` (stale copies miss fixes and re-register removed shortcuts).

```bash
mkdir -p .pi/extensions
ln -sfn ../.. .pi/extensions/pi-threads   # from repo root
```

Trust the project, then `/reload` or restart Pi.

**One-off:** `pi --extension /path/to/pi-threads/index.ts`

## Architecture (30-second model)

- **Parent session** — main agent. Owns `ThreadManager`, six tools, `/threads` picker. On `session_start`, resumes incomplete subprocesses unless `event.reason` is `reload` or `fork`.
- **Child session** — thread subprocess. Detected by `thread_meta` in session file. Runs `child-message-poller` to receive `send_to_thread` messages.
- **Source of truth** — repo root (`index.ts`, `thread-manager.ts`, …). Extension is flat at repo root, not nested `pi-threads/pi-threads/`.

## Tools workflow

Typical orchestrator pattern:

1. **`spawn_thread`** — `task`, `thread_name`, `agent_type`; optional `model`, `tools`, `cwd`, `fork_turns`
2. **`wait_thread`** — `thread_ids`, optional `timeout_ms`. On timeout returns **partial** `{ threads, timedOut: true }` (not an error). Aborts via `AbortSignal` throw `ABORTED`.
3. **`send_to_thread`** — inject follow-up while running
4. **`list_threads`** — filter by status; `status: "all"` includes closed
5. **`interrupt_thread`** / **`close_thread`** — stop running vs archive completed

### `fork_turns` (parent context into child)

| Value | Effect |
|-------|--------|
| `"none"` | Fresh child context (default) |
| `"all"` | Replay entire active parent branch |
| positive int | Last N parent turns |

### Flags

- `--pi-threads-poll-ms` (default `2000`) — child session poll interval for inter-agent delivery

Child subprocesses: `--no-extensions` plus parent's `-e` flags, loading only pi-threads.

## Navigation

Commands (no default keyboard shortcuts — avoids `alt+left`/`alt+right` tree-nav collision):

- `/threads` — session picker
- `/threads-prev` / `/threads-next` — cycle sessions

Bind custom shortcuts via `/keybindings` if desired.

## Development

```bash
npm install
npm test          # vitest — must pass before commit
npm run typecheck
```

### Layout

| Module | Role |
|--------|------|
| `index.ts` | Extension entry; parent vs child routing |
| `thread-manager.ts` | Spawn/wait/send/interrupt/close/resume |
| `thread-subprocess-runner.ts` | Child process lifecycle |
| `thread-events.ts` | Dual-write facade (spawn/send/wait/interrupt/close) |
| `persistence.ts` | Session scan, index, durable writes |
| `contracts.ts` | Shared tool TypeBox schemas + result types |
| `tools/*.ts` | Thin tool wrappers via `runTool` |
| `thread-tool-error.ts` | Typed `ThreadToolError` codes |

### Public exports (only these from package)

`default`, `shouldRespawnThreadsOnSessionStart`, `contracts`, `types` — see `index.ts`. Do not re-export internals.

### Issue tracking

Use **beads** (`bd` CLI), not markdown TODOs. Workflow: `bd ready` → claim → implement → `npm test && npm run typecheck` → `bd close` → `git push`.

### Common gotchas

- **Stale `.pi/extensions` copy** — symlink to repo root; copied trees cause shortcut conflicts and missing fixes.
- **Dual-write** — spawn/send write durable + transcript; wait/interrupt/close are transcript-only (durable completion on interrupt/close). See `references/protocol.md`.
- **`session_start` reasons** — `reload`/`fork` must not respawn subprocesses (`shouldRespawnThreadsOnSessionStart`).
- **Wait timeout** — partial success with `timedOut: true`; still-running threads stay in active map for `send_to_thread`.
- **Tests** — shared fixtures in `test/fixtures/session.ts`; run full suite after thread-manager changes.

## Validation

Before claiming work done on this repo:

```bash
npm test && npm run typecheck
```

For extension load issues: `/reload` after symlink/install change; confirm no `alt+left`/`alt+right` shortcut conflict warnings.

## Output format (when reporting pi-threads work)

```markdown
## Summary
<what changed or how to use>

## Validation
- npm test: N passed
- npm run typecheck: clean

## Notes
<install/reload steps if relevant>
```