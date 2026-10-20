<p align="center">
  <img src="https://raw.githubusercontent.com/ag14774/openclaw-crew/main/docs/assets/logo.png" width="600" alt="A lead robot directing small worker robots around a coral claw" />
</p>

<h1 align="center">OpenClaw Crew</h1>

<p align="center">One lead agent, its workers, and a small board that keeps the work moving.</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/OpenClaw-2026.10.4-ef6b57" alt="OpenClaw compatibility: 2026.10.4" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D24.16.0%20%3C25%20%7C%7C%20%3E%3D26.1.0-43853d" alt="Node.js requirement: >=24.16.0 <25 or >=26.1.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-6b7280" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="https://ageorgiou.com/openclaw-crew/">Documentation</a> · <a href="#quick-setup">Setup</a> · <a href="#skills">Skills</a> · <a href="#everyday-workflow">Usage</a> · <a href="#safety-and-limitations">Safety</a> · <a href="https://ageorgiou.com/openclaw-crew/board-reference/">Board reference</a> · <a href="#development">Development</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

A small, personal-use OpenClaw plugin for one lead agent and its workers. The lead talks with you in the project chat and gets the work done through coding workers. A SQLite board keeps projects, tasks, notes and messages to you; each task has a private session where the lead works on it and launches workers.

## Quick setup

Use **OpenClaw `2026.10.4`** and Node.js with `node:sqlite`: **`>=24.16.0 <25 || >=26.1.0`** ([CI](https://github.com/ag14774/openclaw-crew/blob/main/.github/workflows/ci.yml) uses `26.8.1`). Install a pinned release from ClawHub; the [releases](https://github.com/ag14774/openclaw-crew/releases) list the versions:

```bash
openclaw plugins install clawhub:openclaw-crew@<version> --accept-capabilities
```

Add a `crew` entry to your OpenClaw configuration. Replace the database path, agent IDs, owner DM and worker model below. The lead and worker agent IDs must differ and both must be configured; the model must be available to your worker.

<details>
<summary>Required configuration example</summary>

```json
{
  "plugins": {
    "entries": {
      "crew": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true, "allowPromptInjection": true },
        "config": {
          "statePath": "/absolute/path/to/board.sqlite",
          "leadAgentId": "main",
          "ownerChat": {
            "channel": "telegram",
            "accountId": "default",
            "to": "telegram:123456789"
          },
          "worker": {
            "agentId": "opencode",
            "runtime": "acp",
            "limit": 2,
            "profiles": [
              {
                "id": "sol-low",
                "model": "openai/gpt-5.6-sol",
                "thinking": "low",
                "description": "Routine work."
              }
            ]
          }
        }
      }
    }
  }
}
```

</details>

- **Permissions:** grant `project_board` to the lead and enable both hook permissions shown above: `allowConversationAccess` and `allowPromptInjection`. Install the [skills](#skills) for the lead and the workers.
- **Workers:** configure the worker's ACP runtime in OpenClaw for `runtime: "acp"`; `"subagent"` is also supported.
- **Storage:** use a dedicated new SQLite file or an existing board at the absolute `statePath`; an older board first needs the upgrade statements in the CHANGELOG. Never use an unrelated database.

Restart the Gateway to load the plugin:

```bash
openclaw gateway restart
```

To upgrade, follow [upgrading](https://ageorgiou.com/openclaw-crew/operations/#upgrade): back up the board, apply any schema step the [changelog](CHANGELOG.md) lists, then install the new version. See the [configuration reference](https://ageorgiou.com/openclaw-crew/board-reference/#configuration) for optional settings and [plugin schema](openclaw.plugin.json) for the authoritative shape.

## Skills

The lead needs no change to its `AGENTS.md`: the plugin tells it to load the bundled [crew-lead](skills/crew-lead/SKILL.md) skill. Add `crew-lead` to any per-agent skill allowlist.

Workers need the [worker kit](worker-skills/README.md), which OpenClaw does not load: `engineering-principles`, which they load first, `code-review`, `interrogate` and the skills these point to. Link each of its folders into a skill folder only the workers read. For OpenCode workers that is `~/.config/opencode/skills`:

```bash
mkdir -p ~/.config/opencode/skills && for s in ~/.openclaw/extensions/crew/worker-skills/*/; do ln -sfn "${s%/}" ~/.config/opencode/skills/; done
```

Do not use `~/.agents/skills`: OpenClaw shows that folder to every agent, the lead included. Re-run the loop after each upgrade, and delete links to skills a release removed with `find ~/.config/opencode/skills -xtype l -delete`. With the `subagent` runtime, link the folders into the `skills/` folder of the worker agent's workspace instead.

`interrogate` gets other models' views of a change from read-only reviewer subagents, one per model; without them, reviews use one model. In OpenCode, define subagents whose names start with `reviewer-`, for example in `~/.config/opencode/opencode.json`:

```json
{
  "agent": {
    "reviewer-a": {
      "description": "Read-only code reviewer",
      "mode": "subagent",
      "model": "provider/model-a",
      "permission": { "edit": "deny" }
    },
    "reviewer-b": {
      "description": "Read-only code reviewer",
      "mode": "subagent",
      "model": "provider/model-b",
      "permission": { "edit": "deny" }
    }
  }
}
```

## Everyday workflow

1. **Start in the project chat.** Ask the lead to create a project and record its context; messages are bound to that chat.
2. **Request work.** The lead adds a task and works on it in the task's private session: it settles a design, has a worker build the change, another review it, and merges once CI passes. A status card in the project chat shows the task's plan and where it stands, edited as the work moves.
3. **Answer and review.** The lead asks you questions in the chat when it needs you, then tells you the result and closes the task.

By default, the board scans every **60 seconds** for changed tasks or due check-ins (normally **60 minutes**). It wakes the lead in the task's session without interrupting an active turn; tasks waiting on you get no automatic wakes. Use `/model` and `/think` in the project chat to choose settings for the task sessions; otherwise agent defaults apply.

The [board reference](https://ageorgiou.com/openclaw-crew/board-reference/) covers all seven `project_board` operations, task statuses, scheduling, delivery and operator methods.

## Safety and limitations

- **Trusted host, not a sandbox.** Private task-session replies are suppressed from user chats. Hook errors are logged and ignored, except that a worker launch from a task session is refused while the running workers cannot be counted. Keep OpenClaw tool permissions and worker isolation in place; keep the board, transcripts and attachment files on a trusted host.
- **Scoped work.** Private task sessions are scoped to their project. The plugin does not constrain other agents or the lead's personal-assistant work.
- **Workers and pauses.** Running workers prevent `done`; cancellation stops them, and the scan retries until each is confirmed stopped. Pausing stops automatic wakes and new workers, but does not stop existing workers. `worker.limit` counts the workers launched from task sessions that are running now, plus launches still starting; a launch whose completion never arrives stops counting after 16 minutes. The count lives in the gateway process, so it is a coordination limit, not a hard cap across restarts. See the [worker guards](https://ageorgiou.com/openclaw-crew/board-reference/#worker-and-messaging-guards).
- **Delivery and retention.** Before they are sent, messages are rewritten for the project chat's current conversation. They retry to the project chat with an owner-DM fallback; once the text is delivered, attachments are retried in the same chat. Delivery can still fail: check board/health output for undelivered messages. Attachment files must remain available until delivery finishes. SQLite survives restarts; closed-task private sessions are kept for seven days, then removed once idle.

See [enforcement and delivery rules](https://ageorgiou.com/openclaw-crew/board-reference/#enforcement) for exact boundaries and [testing limitations](TESTING.md#native-integration) for live models, real channels and real-Gateway cleanup.

For consistent private board snapshots and safe staged verification, see [backup and recovery](https://ageorgiou.com/openclaw-crew/recovery/). The operator utility never replaces the live board.

## Development

```bash
npm ci
npm run format:check
npm run check
npm test
npm run pack:check
openclaw plugins install --link . --force --accept-capabilities   # run a local checkout
```

A linked checkout loads `dist/` at Gateway startup; rebuild and restart after source changes. Releases are cut by pushing a `vX.Y.Z` tag on `main`, as described in [AGENTS.md](AGENTS.md#releases).

[TESTING.md](TESTING.md) explains the checks and their side effects. [CI](https://github.com/ag14774/openclaw-crew/blob/main/.github/workflows/ci.yml) runs the checks above; native integration is optional on manual dispatch. Browse the [source](src/index.ts), [lead skill](skills/crew-lead/SKILL.md) and [changelog](CHANGELOG.md) for implementation details and changes.
