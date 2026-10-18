# Changelog

## 2026.10.11 - 2026-10-18

- The coordination skill (protocol 11.20) has review workers load the `code-review` skill themselves instead of the manager copying it into each brief, gives the fix worker any review comments already on the PR, and has the review and fix workers use the change's own worktree one at a time instead of a separate one.

## 2026.10.10 - 2026-10-18

- The managers' system context starts with the session key, so each session's prompt starts differently. Providers that route prompt caching by the start of the prompt (OpenAI through OpenRouter, which gets no per-session cache key from OpenClaw) then keep each session on its own cache instead of spreading sessions that share an opening across machines.
- The coordination skill (protocol 11.19) says how to split a change too large for one worker: a foundation task first, then parallel tasks that each merge on their own, each with one owner.

## 2026.10.9 - 2026-10-18

- `check_in_minutes` accepts 10 to 10080 (was 1 to 10080). Check-ins are the fallback wake-up; worker completions and command exits still wake the holder at once.
- A new task wakes its holder at once, including a task the product manager keeps for itself (before, only tasks for the other manager did).
- Workers started from any task session count towards the worker limit and see the worker profiles on the task card (before, only the engineering manager's did).
- The coordination skill (protocol 11.18) asks managers to let events wake them instead of polling: worker completions and command exits already do, and for anything else (CI, a PR, a server) a native condition watcher runs its check without a model call and starts a turn only when the result changes. A full worker limit is waited out with a 10-minute check-in. Engineering gives each change to one owner worker, which builds all of it in one branch, instead of splitting it between workers and merging their branches; managers no longer read diffs or run tests themselves but decide from a separate review worker's verdict, the PR's size and CI; worker briefs ask workers to load the `engineering-principles` skill. When the project context says so, the product manager runs a project's engineering itself. The code-review skill uses `interrogate` for a second model's view when it is available.

## 2026.10.8 - 2026-10-16

- Requires OpenClaw 2026.10.4 (was 2026.9.8). The native checks pass against it. It fixes preflight compaction, which ignored the model fallback chain while the primary auth profile was cooling down and refused every turn of a long session.

## 2026.10.7 - 2026-10-16

- A holder who does not act on its wake-ups is reported to the user even while the other manager keeps writing to the task. Before, anyone's note reset the count, a task with an outstanding change was never reported, and a wake that failed to dispatch did not count, so a manager whose session could not run went unreported for hours. Now the holder's own update (or a new holder, a new worker or resuming the project) resets the count; every wake for someone else's change counts, scheduled check-ins count when no worker is running, and failed dispatches count. After a report, someone else's change gets the holder one more wake before it is reported again.
- Task cards show the project context and the task description in full (both are limited to 8,000 characters when written). They were cut at 3,000 and 4,000 characters, which hid the user's later directions at the end of a long context.
- The coordination skill asks both managers to find and fix what blocks them within their authority before bringing it to the user, with the cause; to check that the other manager's session actually ran before writing to it again; to check facts before stating them; and to write each note once, on the task it concerns. Engineering has a worker describe any image it is given before working from it, and starts servers that must outlive OpenClaw's 30-minute background limit with `timeoutSeconds: 0`.
- The documentation header links to the repository beside search.
- The documentation's native version selector offers main and genuine release snapshots starting at v2026.10.6. Pages builds retain all release documentation from that baseline, with existing current-page URLs redirecting to main.

## 2026.10.6 - 2026-10-11

- The coordination skill asks both managers to know who each piece of work is for, keep anything meant for someone else (developer notes, evidence, test controls, reviewer-only caveats) out of the work while keeping limitations the person needs, and check the result the way that person will use it. Engineering reviews code with the code-review skill and CI, and designs, images and copy by looking at each one at full size, without tests or review rounds unless the user asks.

## 2026.10.5 - 2026-10-11

- The coordination skill asks engineering to judge what is at stake by what code is for and how long it will live, giving a temporary stage only what it needs and asking when unsure, and not to build in limits, policies or safeguards a request doesn't need.
- The coordination skill asks for repository docs that say how things work and how to work on them, each thing once, with test results in the PR description, and that drop what deferred or dropped work left behind unless the user wants a plan kept.

## 2026.10.4 - 2026-10-10

- The coordination skill asks managers to request a worker's result and how it was checked, not proof of which tools it called.
- The release workflow uploads to ClawHub without waiting for ClawHub's security review, which once took longer than the 30-minute wait and failed a release that ClawHub later published. The upgrade procedure installs a version once ClawHub lists it.

## 2026.10.3 - 2026-10-10

- Chat rewrites work: the model call runs within the manager's turn that sent the message. In 2026.10.2 it ran in the board service's own context, which OpenClaw refuses once the service's start has finished ("Gateway is draining"), so every message went out as written. While the chat is busy or changes during the rewrite, that turn now waits and rewrites again, for up to two minutes. Messages the scan sends on its own (stall notices, retries) go out as written.
- In a project chat, a task waiting on the user is shown with the last message the user received for it (one with a delivery receipt) and any newer note, marked internal, instead of only the latest note. The note had made the product manager take his own question for a leaked internal note and ask it again.

## 2026.10.2 - 2026-10-09

- Messages to the project chat are rewritten for the conversation before they are sent. Messages are written in private task sessions that cannot see the chat, so a result arriving days later, or between other replies, could read as out of context. Before the first send, one tool-free model call as the product manager sees the chat since the request, the task and the message as written, together with his identity, character and notes about the user. It keeps the facts and adds only as much background as the user needs. Deliveries run one at a time, and while the chat is mid-reply, or changes during the rewrite, a message is rewritten again shortly, for up to two minutes. If the rewrite fails, the message goes out as written. The optional `rewriteModel` setting picks a different model for it (the entry then needs `subagent.allowModelOverride`); by default it uses the product manager's own model.
- `notify` from the project chat sends nothing, as `update_task` already did: the reply is the message.

## 2026.10.1 - 2026-10-09

- Coordination skill (protocol 11.16): product describes what the user needs, why, and what they would check, adding context but not requirements the user did not ask for, and keeps the bar in proportion to the request. Engineering asks for a design second opinion only for decisions that would be expensive to change later, not for self-contained changes that are easy to replace.
- Board backups work with a board of any schema version: the backup script checks that the file is a board and intact, and copies everything else as it is. Any version of the script can back up the board before an upgrade.

## 2026.10.0 - 2026-10-08

First public release. Earlier development versions were used only on the author's own host; their history is in git.

- A shared SQLite project board (schema 19) for a product manager agent and an engineering manager agent: projects with a chat and free-text context, tasks with a holder (whose turn it is), a working plan and notes, and messages to the user.
- Wake-ups: a scan wakes the holder of a changed task, or of a task whose check-in is due, in that task's private session. A holder woken three times without changing anything is reported to the user once.
- Delivery: messages go to the project chat with retries under one native operation identity, fall back to the owner DM, carry attached files, and are added to the chat's session as the product manager's reply.
- Workers: engineering launches configured worker profiles from task sessions; the board records them, applies the profile, enforces `worker.limit` and stops a cancelled task's workers.
- Bundled skills: `project-coordination` (how both managers run projects: splitting requests, design, plans, parallel steps, merging on current main, plain notes) and `code-review` (the repository's rules first, findings rated by likelihood and cost where the code runs, smallest fixes, size, a short report with a verdict).
- `scripts/board-backup.mjs` for consistent private board snapshots and staged verification.
- Releases are published from version tags as GitHub releases and on ClawHub: `openclaw plugins install clawhub:openclaw-jarvis-gilfoyle@<version>`.
