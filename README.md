# pi-threads

Persistent subagent threads for [Pi](https://github.com/earendil-works/pi): spawn isolated child `pi` sessions, send follow-ups, wait for results, and switch between main and thread sessions.

## Installation

**Pi package (recommended):**

```bash
pi install git:github.com/christophacham/pi-threads
```

For a local checkout:

```bash
pi install /path/to/pi-threads
# or project-local:
pi install -l ./pi-threads
```

**Project extension directory:** copy or symlink this repo into `.pi/extensions/pi-threads/` (Pi discovers `.pi/extensions/*/index.ts` after the project is trusted).

**One-off load:**

```bash
pi --extension /path/to/pi-threads/index.ts
```

Restart Pi (or use `/reload` if the extension is in an auto-discovered location).

## Tools

| Tool | Purpose |
|------|---------|
| `spawn_thread` | Start a persistent subagent in an isolated `pi` subprocess. Returns `thread_id` and `thread_name`. |
| `wait_thread` | Block until one or more threads finish; streams per-thread status via `onUpdate`. |
| `send_to_thread` | Inject a message into a running thread (inter-agent communication envelope). |
| `list_threads` | List thread sessions with status, task, and usage. Closed threads are hidden unless `status: "all"`. |
| `interrupt_thread` | Force-stop a running thread subprocess and mark it aborted. |
| `close_thread` | Archive a completed thread (`closed` status). Does not kill running threads. |

### `spawn_thread` parameters

- `task` — work for the subagent
- `thread_name` — human-readable label (transcript and envelopes)
- `agent_type` — role label (e.g. `researcher`, `implementer`)
- `model` *(optional)* — model override for the child `pi` process
- `tools` *(optional)* — tool allowlist for the child; `[]` passes `--no-tools`
- `cwd` *(optional)* — working directory (defaults to parent cwd)
- `fork_turns` *(optional)* — parent context to copy into the child (see below)

## `fork_turns`

Controls how much of the parent's active session branch is replayed into the child before its first prompt. Default: `"none"` (fresh context).

| Value | Behavior |
|-------|----------|
| `"none"` | No parent context copied (default). |
| `"all"` | Copy the entire active branch. |
| `N` (positive integer) | Copy the last *N* parent turns (turn boundaries: user messages, bash execution, branch summaries, custom messages). |

Example:

```json
{
  "task": "Implement the auth refactor we discussed.",
  "thread_name": "implementer",
  "agent_type": "implementer",
  "fork_turns": 3
}
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--pi-threads-poll-ms` | `2000` | Poll interval (ms) for delivering inter-agent messages to child thread sessions. |

Child subprocesses load only this extension (`--no-extensions` plus inherited `-e` flags from the parent).

## Session navigation

- `/threads` — picker to switch between main and thread sessions
- `/threads-prev` / `/threads-next` — cycle sessions (no default shortcuts; bind via `/keybindings` if desired)

Status bar shows the current session (main or thread name).

## Development

```bash
npm install
npm test
npm run typecheck
```

`npm test` runs Vitest; `npm run typecheck` runs `tsc --noEmit`.