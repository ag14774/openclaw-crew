# Board reference

[Documentation home](index.md) · [Repository README](https://github.com/ag14774/openclaw-crew/blob/main/README.md)

Detailed behavior of the `project_board` tool and its private task sessions. The bundled [crew-lead skill](https://github.com/ag14774/openclaw-crew/blob/main/skills/crew-lead/SKILL.md) describes the lead's judgment and working procedure; the rules below describe checks the plugin can enforce from callers, board rows and native calls.

## Board records

- **Projects:** name, free-text context (the lead's record of the project's current state, up to 40,000 characters), the chat for messages, and state (`active`, `paused`, `archived`).
- **Tasks:** title, body, a free-text plan, a status card in the project chat and a status: `open` (the lead's turn), `waiting` (on the user), `done` or `cancelled`.
- **Notes:** an append-only log per task. Every status change carries one.
- **Outbox:** messages to the user, optionally with files, delivered with native idempotency, retries and an owner-DM fallback.

## Tool operations

The lead uses one tool, `project_board`, with an `operation` and its fields. `project` is implied in a task session or project chat; `task` is implied in a task session.

| Operation        | What it does                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `list`           | Projects with open tasks, recently closed tasks and undelivered messages. Archived projects are omitted unless selected explicitly. |
| `show`           | One task with its notes, or one project with its context.                                                                           |
| `create_project` | Takes `name` and optional `context`; uses the chat of the current user message when available.                                      |
| `update_project` | `name`, `context`, `state` or `use_this_chat`.                                                                                      |
| `add_task`       | `title` and optional `body`. A new task is open and wakes its task session at once.                                                 |
| `update_task`    | `note`, `status`, `message` with optional `attachments`, `check_in_minutes`, `plan`.                                                |
| `notify`         | `message` to the user in the project chat, with optional `attachments`.                                                             |

`check_in_minutes` accepts 10–10080; an update without it schedules the next check-in for 60 minutes. `attachments` travel with a message, not on their own. `plan` is the task's working plan, free text up to 4,000 characters that the board never interprets. Each `plan` replaces the previous one, an empty one clears it, and it is shown on the task card, by `show` and on the task's status card.

## Scheduling and model choice

A mechanical scan (every 60 seconds by default) wakes the lead in the private session of an open task in an active project when the task is new, when it was changed from any other session (the project chat, another task session, an operator call), or when its check-in is due. It never wakes a waiting task and avoids interrupting a session reported as mid-turn. At most `maxTaskSessions` task sessions run at once.

OpenClaw's completion notice continues the task session when a worker ends, including one stopped by a restart; the check-in is the fallback. Failed dispatches are retried five minutes later. An ambiguous dispatch is checked against native session liveness before retry. Each wake the task session does not act on counts: wakes for a change from another session, scheduled check-ins while no worker runs, and failed dispatches. The task session's own update, a status change, a new worker or resuming the project resets the count. After three, the scan reports the stall to the user once and stops automatic wakes for that task; a change from another session then wakes it once more before the stall is reported again.

Task sessions follow the model and thinking level selected in the project chat (`/model`, `/think`), read at every wake. Without a selection they use the lead's defaults. If copying the settings fails, the plugin logs it and proceeds. The source chat session is the one OpenClaw routed the binding message to; each later user message in that chat refreshes it if changed. Messages in other chats never change it. `/new` and `/reset` keep the session and choice.

## Enforcement

### Tasks and lifecycle

- Every status change needs a note. Setting a task to `waiting` or closing it (`done`, `cancelled`) also needs a `message` in the same call, queued in the same transaction as the change. In the project's own chat, the lead's reply is the message; `update_task` does not send it a second time, and files must be attached to that reply.
- A status change is refused if a newer note arrived since the calling session last read the task in this turn; reread with `show` and decide again. Completing a task checks its workers first; if the task changed or gained a worker meanwhile, the completion is refused and must be decided again.
- Closed tasks are read-only until reopened with `status: open` and a note.
- A private task session sees and changes only its own project.
- A task cannot be marked `done` while its workers run. Cancelling stops workers and clears their queued follow-ups. Until every worker is confirmed stopped (its session idle or gone after a two-minute spawn grace), the scan tries again every five minutes, ten tasks at a time; a worker recorded after the cancellation is stopped by the next scan.
- Pausing stops automatic wakes and new worker spawns, not existing workers. Resuming wakes each open task. Archiving requires all tasks to be closed or cancelled.
- Runs in closed-task private sessions are refused. The sessions are kept for seven days for review, then deleted once idle; reopening within that period continues in the old session.

### Worker and messaging guards

- Workers spawned with `sessions_spawn` from a task session are recorded on that task.
- For the configured worker agent, use `model: "<profile id>"`. The plugin applies the profile's model, thinking level and configured runtime. A matching model/thinking pair is also accepted. The target `agentId` is read with OpenClaw's own parameter reader and normalization, so any spelling the native tool accepts gets the same profile and limit.
- `worker.limit` covers the workers launched from task sessions. It counts those running now (by native parent, whatever the task's status), workers recorded in the last two minutes that the native list may not show yet, and earlier launches still starting. A launch counts as starting from its permission until its `after_tool_call`; one whose completion never arrives stops counting after 16 minutes. Parallel launches in one turn go ahead while there is room. When the running workers cannot be counted the launch is refused with a retry instruction. Launches from the lead's other sessions and workers' own descendants do not count. The starting launches are held in the gateway process, so this is a coordination limit, not a hard cap across restarts or processes.
- Spawns are refused for closed tasks and non-active projects. Profile and concurrency checks apply to the configured worker agent, not spawns targeting another agent.
- From task sessions, `sessions_send` may reach only that task's own workers by session key; the `message` tool is refused. Private task-session replies never intentionally go into user chats; board messages are the user-facing path.
- `use_this_chat` binds only the chat of the user message that started the current turn, never an arbitrary supplied destination.

### Delivery and chat history

- Messages go only to the project chat, or the configured owner DM when there is no bound chat, the project chat rejects them or it keeps failing. Owner-DM messages are prefixed with the project name. Delivery never rebinds the project's chat.
- Before its first send to the project chat, a message sent from the lead's turn is rewritten for the conversation it lands in. One tool-free model call as the lead, with no session, receives the project context with its instructions, the chat (from the user's message that led to the task, keeping the newest messages when it is long), the task's card, the message as written, and the lead's `IDENTITY.md`, `SOUL.md` and `USER.md`. It keeps the facts and adds only the background the user needs. The call runs within that turn, because OpenClaw accepts new work only from running work. Deliveries run one at a time. While the chat's session is mid-reply, or changes during the rewrite, the turn waits and rewrites again, for up to two minutes. The sent text replaces the stored one; a failed rewrite sends the message as written. Messages the scan sends (stall notices, retries) and owner-DM fallbacks are not rewritten.
- `notify` from the project chat itself sends nothing: the reply is the message.
- A task with a plan in a project with its own chat has a status card there: one message with `#<id> <title>`, its status (working on it, waiting for you, done, cancelled) and the plan as written, up to 2,000 characters. The scan posts it without a notification and edits it whenever that text changes, until it shows the task closed. Projects whose messages go to the owner DM get no card. A failed post or edit is retried, backing off up to an hour, the post with the same idempotency key; after ten failures in a row the card is left as it is. Cards are not rewritten or added to the chat's session.
- Native idempotency keys keep retries from intentionally sending duplicates. Delivery has finite retries and can become failed; `list` and health expose undelivered messages and failures.
- Attachments are up to four existing files (absolute paths, 8 MB each). They follow the text as native message sends to the same chat, each with a stable idempotency key, and are read again on every attempt. Once the text is accepted the message is delivered and never falls back; failed files are retried in that chat, and if they keep failing the message stays delivered with the error recorded. Files must remain available until delivery finishes.
- A delivered message is added as the lead's own reply to the session for the chat it reached (project chat or owner DM): the text as sent, then one `MEDIA:` line per file. OpenClaw's transcript writer uses a stable idempotency key so the Control UI history and later model context reflect the delivered message.
- Transcript append waits while that destination session runs a turn and is retried by the scan for a day. An append failure is logged and never affects delivery.

### Scope and failure behavior

Outside the board tool and private task-session guards, the plugin only adds context to the lead's prompts. Every session's system prompt starts with the session key and a short note that project work adds to the lead's usual role. The project context goes at the end of the system prompt in the project's task sessions and in its chat's session; it stays the same from turn to turn until the context changes, so providers can cache it. Each turn in a task session also gets the task card: the task, its plan and latest notes, its workers and the worker profiles. Each turn started by a user message in a project chat gets which project the chat belongs to and the tasks waiting on the user, each with the last message the user received for it and any newer note. Other agents and the lead's personal-assistant work are otherwise unaffected.

Hook errors are logged and ignored, except that a worker launch from a task session is refused while the running workers cannot be counted. The board is not a security sandbox or a substitute for host tool permissions. An unavailable board is reported by the tool and health; scans log failures. The shared runtime and companion are replaced on plugin reload, or after the companion has not answered for five minutes, and scans try again using the persistent board, keeping the launches still starting.

## Configuration

Required configuration is shown in [getting started](getting-started.md#configure-the-plugin); the authoritative shape is [openclaw.plugin.json](https://github.com/ag14774/openclaw-crew/blob/main/openclaw.plugin.json).

| Setting                         | Default / constraint                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `statePath`                     | Required absolute path to a new file or a board; schema 1 is upgraded to 2 on open. `:memory:` is accepted for ephemeral use.    |
| `leadAgentId`, `worker.agentId` | Required, different OpenClaw agent IDs.                                                                                          |
| `ownerChat`                     | Required `channel`, `accountId`, `to`; optional `threadId`. The owner's direct chat with the lead, used for fallback.            |
| `worker.profiles`               | Required, 1–8 profiles with `id` and `model`; optional `thinking` and `description`.                                             |
| `worker.runtime`                | `acp`; also accepts `subagent`.                                                                                                  |
| `worker.limit`                  | 2; range 1–20; workers launched directly from task sessions.                                                                     |
| `sessionNamespace`              | `crew`. Task sessions are `agent:<lead>:<namespace>:task-<id>-<created>`.                                                        |
| `scanMs`                        | 60000; range 10000–600000.                                                                                                       |
| `turnTimeoutSeconds`            | 1800; range 60–14400, for each private task-session turn.                                                                        |
| `maxTaskSessions`               | 2; range 1–10. Task sessions running at once.                                                                                    |
| `rewriteModel`                  | The lead's model. A `provider/model` for rewriting project chat messages; needs the entry's `subagent.allowModelOverride: true`. |
| `enabled`                       | Omitted means enabled; `false` stops automatic scans/wakes. This config flag does not remove the board tool.                     |

The entry's `enabled` switch and hook permissions are OpenClaw settings, separate from the plugin's `config.enabled`. The lead needs `project_board` permission; its other tools and the worker runtime remain host configuration.

SQLite uses WAL, full synchronous writes and foreign keys. New parent directories use mode `0700`, and the database file is set to `0600`. The store accepts an empty schema-zero database, schema 2, or schema 1, which it upgrades to 2 by adding the status-card column in one transaction; nonempty schema-zero files and other versions are refused before board DDL, chmod or journal changes. The version is not a comprehensive database-identity check, so always use a dedicated board file, never an unrelated database. See [backup and staged recovery](recovery.md) for the standalone operator utility and its separate verification boundary.

## Operator methods

| Gateway method      | Parameters / access                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `crew.board.call`   | `{operation, input, sessionKey?}`; runs as the lead, by default from an operator session. Requires `operator.admin`.                          |
| `crew.board.tick`   | Runs a scan. Requires `operator.admin`.                                                                                                       |
| `crew.board.health` | Reports enabled/registry state, scan health and counts of projects, open/stalled tasks and pending/failed messages. Requires `operator.read`. |

See [TESTING.md](https://github.com/ag14774/openclaw-crew/blob/main/TESTING.md) for checks and live-integration limitations, and the [changelog](https://github.com/ag14774/openclaw-crew/blob/main/CHANGELOG.md) for schema changes.
