# pi-threads protocol reference

Load this when changing persistence, spawn/resume, or parent/child session behavior.

## Session roles

| Role | Detection | On `session_start` |
|------|-----------|-------------------|
| Parent | No `thread_meta` in session | Single `listThreadSessions` scan → `resume` (unless reload/fork) + picker refresh |
| Child | `thread_meta` entry present | Start `child-message-poller`; no `ThreadManager.resume` |

Child session header includes `parentSession` path (Pi lineage) plus `thread_meta.parent_id` for protocol tree.

## Dual-write channels

### Durable (`appendEntry` / `appendCustomEntry`)

Entry types in `THREAD_ENTRY_TYPES`:

- `thread_meta` — identity, parent_id, task, agent_type
- `thread_spawned` — spawn record
- `thread_completed` — terminal status (completed, error, aborted, closed)

Used for session tree reconstruction and completion state.

### Transcript (`sendMessage`)

Types in `THREAD_TRANSCRIPT_TYPES`:

- `thread_spawned`, `thread_send`, `thread_wait`, `thread_interrupted`, `thread_closed`

Inline activity in parent session UI.

### Per-operation matrix

| Operation | Durable | Transcript |
|-----------|---------|------------|
| spawn | yes | yes |
| send | yes (`thread_send` custom) | yes |
| wait | no | yes |
| interrupt | yes (`thread_completed` aborted) | yes |
| close | yes (`thread_completed` closed) | yes |

Facade: `thread-events.ts` (`recordSpawn`, `recordSend`, `recordWait`, `recordInterrupt`, `recordClose`).

## Inter-agent messages

`send_to_thread` wraps content in `[From author to recipient]: ...` (`INTER_AGENT_MESSAGE_PATTERN`). Child poller injects as user message.

## Session index

`getThreadSessionIndex(cwd)` — cached `Map<threadId, ThreadSessionInfo>`. Invalidated on full `listThreadSessions` scan; upserted on spawn/complete. Used by wait/send/close lookups.

## Error model

`ThreadToolError` codes: `THREAD_NOT_FOUND`, `THREAD_NOT_RUNNING`, `THREAD_STILL_RUNNING`, `THREAD_NOT_COMPLETED`, `SESSION_CREATE_FAILED`, `TIMEOUT`, `ABORTED`, `UNKNOWN`.

Wait **timeout** → partial result (`timedOut: true`), not throw. Wait **abort** → throw `ABORTED`.