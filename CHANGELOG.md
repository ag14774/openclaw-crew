# Changelog

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
