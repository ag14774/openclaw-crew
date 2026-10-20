# Changelog

## 2026.10.17 - 2026-10-20

Board schema 2. Stop the gateway, back up the board as [upgrading](https://ageorgiou.com/openclaw-crew/operations/#upgrade) says, then run these statements on it once before starting the new version, which refuses a schema 1 board:

```sql
BEGIN; ALTER TABLE tasks ADD COLUMN card TEXT; PRAGMA user_version=2; COMMIT;
```

Without the `sqlite3` shell, Node runs them: `node -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec('BEGIN; ALTER TABLE tasks ADD COLUMN card TEXT; PRAGMA user_version=2; COMMIT;')" <statePath>`. Older versions refuse a schema 2 board, so going back means restoring the backup.

- Status cards: a task with a plan in a project with its own chat gets one message there showing `#<id> <title>`, its status (working on it, waiting for you, done, cancelled) and the plan as written. The scan posts it without a notification and edits it whenever that text changes, until it shows the task closed, with no model call. A failed post or edit is retried, the post under the same idempotency key; after ten failures in a row the card is left as it is and the log says so. Projects whose messages go to the owner DM get no card. Cards are not rewritten or added to the chat's session.
- `crew-lead` protocol 1.3: the plan is the user's status card, so the lead writes it for the user (plain steps, PR links, no internal terms) and keeps it current; routine step changes need no `notify`.
- The rewrite of a project chat message receives the project context again, after the rewrite instructions in the call's system text.

## 2026.10.16 - 2026-10-20

No board schema change.

- The project context is at the end of the system prompt in the project's task sessions and in its chat's session, where providers cache it, and is no longer in the task card. The task card is added to each turn's message, which OpenClaw keeps in the session's history, so every wake-up used to store another copy of the context; the project chat did not show the context at all. The rewrite of a project chat message no longer receives the context.
- Project context can be up to 40,000 characters. `update_project` refuses longer context with an error asking to condense it, as `create_project` does, instead of cutting off the end. Tool results can be up to 192 KB, so `show` returns a full context.
- `crew-lead` protocol 1.2: the context is the project's current state, rewritten rather than appended to, and keeps what the lead needs; what workers need about the repository goes in the repository. When a task is closed or cancelled the lead removes its worktrees and branches and tidies the project's checkouts, so leftovers are cleared at the next close.

## 2026.10.15 - 2026-10-20

No board schema change.

- Worker kit: the principle skills no longer mention pstack skills that the kit does not ship.

## 2026.10.14 - 2026-10-19

No board schema change.

- Worker kit: `worker-skills/` ships the skills workers build and review with: `engineering-principles`, `code-review` (moved from `skills/`), `interrogate`, `tdd`, `typescript-best-practices` and the 17 `principle-*` skills from pstack. OpenClaw does not load it; link its folders into a skill folder only the workers read (see the README's Skills section). `interrogate` uses whichever `reviewer-` subagents the worker has, and one model's view when there are none.
- `crew-lead` protocol 1.1: it carries the project rules a lead's own `AGENTS.md` used to hold (the decisions the user keeps, taking requests in the user's words, finding a named project before calling it unknown, no claims without board or native evidence, replacing generic coding-agent routing skills) and a default checkout layout under `~/projects/<project-id>/`. Review briefs no longer copy `code-review` into the brief.
- The injected lead context says how to read `crew-lead` into context: `skills_read` or, in Code Mode, `skills.read('crew-lead')`.

## 2026.10.13 - 2026-10-18

First release of `openclaw-crew` (plugin id `crew`), board schema 1.

- A SQLite project board for one lead agent and its workers: projects with a chat and free-text context, and tasks that are open (the lead's turn), waiting (on the user), done or cancelled, each with a working plan and notes.
- Wake-ups: a 60-second scan with no model calls wakes the lead in a task's private session when the task is new, was changed from another session, or has a check-in due, without interrupting a live turn. A task woken three times without its session acting, or that cannot be woken, is reported to the user once. At most `maxTaskSessions` task sessions run at once.
- Messages: asking the user or closing a task carries a message to the project chat, rewritten for the conversation before the first send, with retries under one native identity, an owner-DM fallback, attached files, and the delivered text added to the chat's session. In the project chat, the lead's reply is the message.
- Workers: the lead launches configured worker profiles from task sessions with `sessions_spawn`; the board records them on the task, applies the profile, enforces `worker.limit`, refuses `done` while they run and stops a cancelled task's workers.
- Bundled skills: `crew-lead` (protocol 1.0: how the lead talks with the user and runs each change through an owner worker, a review worker and a fix worker, merging on green CI) and `code-review`.
- Closed task sessions are removed once idle, seven days after the task closed.
- `scripts/board-backup.mjs` for consistent private board snapshots and staged verification.
- Releases are published from version tags as GitHub releases and on ClawHub: `openclaw plugins install clawhub:openclaw-crew@<version>`.
