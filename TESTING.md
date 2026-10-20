# Testing

## Behavioral Suite

`npm test` rebuilds `dist/` (via `pretest`) and runs `test/*.test.ts` against `src/` with Node's test runner and `tsx`. `node --import tsx --test test/*.test.ts` runs the same suite without rebuilding.

`test/support/harness.ts` registers the real plugin with a fake native gateway and drives it only through the real `project_board` tool and hooks: `message_received`, `before_prompt_build`, `before_tool_call`, `after_tool_call`, `agent_end`, `before_agent_run` and `message_sending`. The fake gateway provides conversations, sessions, sends, agent runs, aborts and session cleanup, on a controllable clock. It rejects any other native method. No test contacts a gateway, a channel or a repository. The rpc-bridge child process is not exercised.

`test/board.test.ts` covers, one behavior per test:

- a request worked in its task session, from the user's message to the result they hear;
- a question to the user, and their answer noted in the chat waking the task;
- when a message is required, and that the project chat is not told twice;
- status changes needing a note and being decided on the latest notes;
- project isolation of task sessions, and closed tasks changing only by reopening;
- stall reporting and check-ins;
- workers: profiles, the limit, cancellation and the done guard;
- the task plan: shown on the card, kept by other updates, replaced and cleared;
- status cards: posted once a plan exists, edited only when their text changes and a last time on close, none for a project without its own chat, a lost post retried without a second post, and a card whose message is gone given up after ten tries;
- the project context in the system prompt of its task sessions and its chat, unchanged across turns, and context over 40,000 characters refused rather than cut;
- pause and resume;
- the limit on task sessions running at once;
- delivery fallback and retry identity;
- rewriting a project chat message for its conversation: what the model call receives, the long-chat trim, waiting within the turn for a busy or changing chat, sending as written when the rewrite fails, and no rewrite for the scan's own deliveries;
- `use_this_chat` turn binding;
- non-interference with the lead's personal work and other agents;
- the board file surviving a restart, a schema 1 board opened as schema 2 with its tasks intact, and refusal of a database with another schema;
- one shared board when OpenClaw registers the plugin more than once in a process;
- task sessions following the project chat's model choice, the chat's session refreshed only from that chat, and the companion's limits on `sessions.patch` (one setting per call, the model never with admin scope);
- closed task sessions recreated by late native turns being removed again.

The fakes follow OpenClaw 2026.10.4 as found in its distribution:

- `hasActiveRun` is the live-turn signal;
- `sessions_spawn` results carry `details.childSessionKey`;
- `conversations.send` receipts are `sent`, `queued`, `suppressed` or `unknown`, and `queued` means durably queued;
- a repeated `operationId` does not send twice, and a repeated `message.action` idempotency key replays the first result (OpenClaw keeps those for five minutes).

`test/admission.test.ts` drives the real `before_tool_call` and `after_tool_call` hooks with fake native sessions: simultaneous launches at the last free slot, parallel launches in one turn while there is room, refused and failed launches not holding a slot, a launch whose completion never arrives counting for 16 minutes, which running workers count, a worker target written in another case, and waiting out a full limit with ordinary check-ins.

`test/reliability.test.ts` drives the runtime directly with fake native calls that assert no SQLite transaction spans an await: changes made while a completion checks the workers, stopping a cancelled task's workers until they are confirmed stopped (and then no more checks), failed and timed-out wakes, actions made during a wake dispatch, attachments retried in the chat that received the text, simultaneous deliveries of one message, and refusal of a foreign database file.

These are mocked behavior tests, not live worker or hard-limit evidence.

## Native Integration

`npm run test:native` (`CREW_NATIVE_TEST=1`) also checks that every native method the companion calls, the message edit used for status cards (`message.action` with the board's own origin, and the bundled Telegram channel's `edit`), the transcript writer and the tool-free model call used for chat rewrites exist in the pinned OpenClaw build. It reads the installed package only; the Discord channel is a separate package, so its `edit` is not checked there.

Not covered by automated tests: live model behavior (including the quality of chat rewrites), code-mode tool dispatch through the hooks, real channel delivery, and session cleanup against a real gateway. These need a live, explicitly authorized run.

## Build And Package

`npm run check` builds `dist/`, syntax-checks it and runs `scripts/verify-dist.mjs` against the compiled registration and store. `npm run pack:check` inspects the package boundary.

## Recovery Utility

`npm run test:recovery` runs `test/recovery.test.ts` on disposable private temporary
fixtures only, without rebuilding. It is also included in `npm test`. The suite
uses the existing Store solely to make fixtures; the operator utility has no
runtime imports or dependency on OpenClaw. It covers committed, uncheckpointed WAL
data, exclusion of an uncommitted write, separate staged verification and hashes,
private permissions, no source checkpoint/journal change, existing destinations
and aliases, concurrent destination refusal, malformed/schema-zero/foreign sources,
a board of another schema version, foreign-key violations, invalid CLI arguments, missing sources and refusal to
stage a WAL database. Tests remove their fixtures and never contact a gateway,
launch a worker or read real board/session data.

`scripts/board-backup.mjs` is the only operator script included in the package.
`backup` and `stage` create a new private directory with a database and report;
`verify` opens the explicitly supplied file read-only. See
[recovery](https://ageorgiou.com/openclaw-crew/recovery/) for prerequisites, read-only WAL coordination caveats
and the separately authorized boundary before any live replacement. This is local
SQLite restore-readability evidence, not a live/off-host/full-host recovery test.

## Formatting

`npm run format` applies Prettier. `npm run format:check` is enforced in CI.
