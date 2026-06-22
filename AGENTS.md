# AGENTS.md

Guide for AI agents working in **pi-threads** — a Pi extension that runs persistent subagent threads as isolated child `pi` subprocesses.

## Quick facts

- **Stack:** TypeScript ESM, Vitest, TypeBox. No build step — Pi loads `index.ts` directly.
- **Source of truth:** repo root (flat layout). Never edit a copied `.pi/extensions/pi-threads/` tree.
- **Validation gate:** `npm test && npm run typecheck` (matches CI).
- **Issues:** beads (`bd` CLI), not markdown TODOs.

## Setup

```bash
npm install
mkdir -p .pi/extensions && ln -sfn ../.. .pi/extensions/pi-threads   # from repo root
```

Trust the project in Pi, then `/reload`. One-off: `pi --extension /path/to/pi-threads/index.ts`.

## Architecture

| Role | Detection | Behavior |
|------|-----------|----------|
| **Parent** | No `thread_meta` in session | Owns `ThreadManager`, six tools, `/threads` picker; resumes incomplete subprocesses on `session_start` |
| **Child** | `thread_meta` present | Runs `child-message-poller` for inter-agent delivery; no tools |

**Spawn flow:** create child session → `writeThreadMeta` → optional `forkParentContextIntoChild` → bootstrap assistant message → start child `pi` subprocess → `ThreadEvents.recordSpawn`.

**Orchestrator pattern:** `spawn_thread` → `wait_thread` (optional `send_to_thread`) → `close_thread` or `interrupt_thread`.

**Public exports** (only these from `index.ts`): `default`, `shouldRespawnThreadsOnSessionStart`, `contracts`, `types`.

## Module map

| File | Role |
|------|------|
| `index.ts` | Extension entry; parent vs child routing |
| `thread-manager.ts` | Spawn/wait/send/interrupt/close/resume |
| `thread-subprocess-runner.ts` | Child process lifecycle |
| `thread-events.ts` | Dual-write facade (spawn/send/wait/interrupt/close) |
| `persistence.ts` | Session scan, index, durable writes |
| `context-fork.ts` | Parent branch replay (`fork_turns`) |
| `child-message-poller.ts` | Child-side inter-agent delivery |
| `contracts.ts` | TypeBox schemas — single source of truth for tool params |
| `tools/*.ts` | Thin wrappers via `runTool()` in `tools/common.ts` |
| `thread-picker.ts` | `/threads` navigation; `alt+,` / `alt+.` shortcuts |
| `tool-render.ts`, `renderers.ts`, `status-feed.ts` | TUI rendering |

## Conventions

- Imports use `.ts` extensions; `strict` + `verbatimModuleSyntax`.
- Tool names: `snake_case`. Functions: `camelCase`. Protocol: `THREAD_*` / `Thread*`.
- Schemas in `contracts.ts` → manager methods take matching `Static<>` types.
- Errors: manager throws `ThreadToolError`; tools return `{ isError: true, details: { error } }` via `runTool()`.
- Tests: colocated `*.test.ts`; shared fixtures in `test/fixtures/session.ts`.

## Where to change what

| Task | Files |
|------|-------|
| Tool params/results | `contracts.ts` → `thread-manager.ts` → `tools/<name>.ts` → `tool-render.ts` → tests |
| Spawn/resume behavior | `thread-manager.ts`, `context-fork.ts`, `thread-subprocess*.ts` |
| Persistence/protocol | `persistence.ts`, `thread-events.ts`, `types.ts` |
| Inter-agent delivery | `child-message-poller.ts`, `persistence.ts` |
| Session navigation/UI | `thread-picker.ts`, `renderers.ts`, `status-feed.ts` |
| Extension hooks | `index.ts` |

## Gotchas

- **Symlink, don't copy** `.pi/extensions` — stale copies miss fixes and re-register removed shortcuts.
- **`session_start` reasons** — `reload`/`fork` must not respawn subprocesses (`shouldRespawnThreadsOnSessionStart`).
- **`wait_thread` timeout** — partial success (`timedOut: true`), not an error; running threads stay in active map.
- **`close_thread` vs `interrupt_thread`** — close only works on `completed`; running threads need interrupt first.
- **`send_to_thread`** — requires thread in `ThreadManager.threads` (in-memory), not just on disk.
- **Dual-write** — spawn/send: durable + transcript; wait: transcript only; interrupt/close: `thread_completed` on child. See protocol doc.
- **Shortcuts** — use `pi.registerShortcut`, not `keybindings.json`; never `alt+left`/`alt+right` (Pi tree nav conflict).
- **Child subprocess** — `--no-extensions` then parent's `-e` flags + only pi-threads re-added.
- **Session index cache** — invalidate via `invalidateThreadSessionScanCache` after mutations.

## Tools reference

| Tool | Notes |
|------|-------|
| `spawn_thread` | `task`, `thread_name`, `agent_type`; optional `model`, `tools`, `cwd`, `fork_turns` |
| `wait_thread` | `thread_ids`, optional `timeout_ms`; `AbortSignal` → `ABORTED` |
| `send_to_thread` | Inject follow-up while running |
| `list_threads` | Default hides `closed`; `status: "all"` shows all |
| `interrupt_thread` | SIGTERM → SIGKILL |
| `close_thread` | Archive completed thread |

### `fork_turns`

| Value | Effect |
|-------|--------|
| `"none"` | Fresh child context (default) |
| `"all"` | Replay entire active parent branch |
| positive int | Last N parent turns |

## Deeper reading

- `README.md` — install, tools, flags, navigation
- `skills/pi-threads/SKILL.md` — agent workflows and validation template
- `skills/pi-threads/references/protocol.md` — dual-write matrix, session roles, error model