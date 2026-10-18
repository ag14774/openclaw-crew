# OpenClaw Crew

![A lead robot directing small worker robots around a coral claw](assets/logo.png)

A small, personal-use OpenClaw plugin for one lead agent and its workers. The lead talks with you in the project chat, keeps requests, questions and messages on a SQLite board, and works on each task in a private session where it launches coding workers. The [repository](https://github.com/ag14774/openclaw-crew) is MIT licensed.

## Start here

- **[Getting started](getting-started.md):** install the plugin and configure the lead and worker agents.
- **[Workflow](workflow.md):** request work, answer questions and review results.
- **[Board reference](board-reference.md):** all seven tool operations, settings and enforced rules.
- **[Design and boundaries](design.md):** what the board owns and what depends on the trusted host.
- **[Operations](operations.md):** inspect health, stalled work and delivery failures.
- **[Documentation](documentation.md):** build and preview this site locally.

## A board, not another planning framework

Each task is one piece of work you asked for. It is open while it is the lead's turn and waiting while the lead waits for your answer. A mechanical scan wakes the lead in the task's session when something changed or a check-in is due. The lead interprets the request, chooses the approach, briefs the workers and reviews the result.

Private sessions keep task work separate from user-facing chats. They are **not a security sandbox**. Use this plugin with cooperative agents on a trusted OpenClaw host, and keep tool permissions and worker isolation in host configuration.

These pages describe the repository's current behavior, not a claim that every live channel or failure scenario has been qualified. See the repository's [testing guide](https://github.com/ag14774/openclaw-crew/blob/main/TESTING.md) for evidence boundaries.
