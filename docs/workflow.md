# Normal workflow

## Request, work, review

1. **Start in the project chat.** Ask the lead to create a project. Its context holds lasting facts, repository locations and your direction. Creation binds the current user-message chat when available.
2. **Request a piece of work.** The lead records a task with a clear title and body: one task per separate feature or unrelated ask. Discussion alone is not a request to implement.
3. **Let the lead work.** The board wakes the lead in the task's private session at once. It settles a short design and keeps the steps in the task's plan, shown at the top of the task card. One owner worker builds the change and opens the PR, a separate review worker reviews it with the `code-review` skill, a worker on the same branch fixes what holds up, and the lead merges once CI passes. A change too large for one worker becomes several tasks: a foundation first, then parts that merge on their own.
4. **Answer questions on that task.** When the lead needs you, it sets the task to waiting and asks in the chat. Your answer is recorded on the task, which puts it back to the lead; no separate task is needed for the question.
5. **Review and finish.** The lead checks each requested point against the result, closes the task and tells you what changed or what remains incomplete.

These are the bundled skill's working practices. The board mechanically requires a note on every status change and a message when asking you or closing a task, but it does not inspect the quality of a review, run CI or verify a merge.

## Progress and waiting

The lead uses `notify` for useful progress updates. Notes hold status and evidence; project context holds durable facts, not a running log. One task represents one requested piece of work, not every message or supervision step.

The scan runs every **60 seconds** by default. It wakes the lead in the session of a task that is new, was changed from another session (for example your answer noted in the chat), or has a due check-in, normally **60 minutes**, without interrupting a session reported as mid-turn. A private reply ends the turn; saying what will happen next does not continue execution. Worker completions and the exit of a background command waiting for CI or another event wake the lead as soon as something happens; `check_in_minutes` (10 minutes or more) is the fallback.

Tasks **waiting** on you get no automatic wake-ups. When a task has been woken three times without its session acting, or could not be woken, the board tells you it is stuck and stops its automatic wakes; the task session acting resets the count, and a change from another session wakes it once more. Check [operations](operations.md) if work goes quiet.

## Chats and models

Ask the lead to move the project to the current chat when needed; `update_project` with `use_this_chat: true` binds only the chat of the user message that started that turn. Delivery fallback never moves that binding.

Select `/model` and `/think` in the project chat for the task sessions. The plugin reads those settings at each wake; otherwise agent defaults apply. A settings-copy error is logged and execution proceeds. Worker models come from configured worker profiles, separately from the chat's choice.

## Pause or cancel

- **Pause the project:** stops automatic wakes and new worker spawns, but existing workers continue.
- **Resume:** wakes each open task to look again.
- **Cancel a task:** closes it with a note and aborts its recorded workers, clearing queued follow-ups.
- **Archive the project:** requires all tasks to be closed or cancelled.

Closed-task sessions remain for seven days and are then removed once idle. The persistent board is separate from those sessions. See the [board reference](board-reference.md#enforcement) for exact lifecycle checks.
