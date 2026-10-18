# Getting started

## Prerequisites

- OpenClaw **2026.10.4**, the version pinned by this repository.
- Node.js with `node:sqlite`: **`>=24.16.0 <25 || >=26.1.0`**. Repository CI uses **26.8.1**.
- Two distinct configured OpenClaw agents: the lead and the worker.
- A working user-message channel and an owner direct chat with the lead for fallback delivery.

Python is needed only to [build the documentation](documentation.md), not to run the plugin.

## Install

Install a pinned release from ClawHub; the [releases](https://github.com/ag14774/openclaw-crew/releases) list the versions:

```bash
openclaw plugins install clawhub:openclaw-crew@<version> --accept-capabilities
```

The command installs the plugin into OpenClaw and accepts its plugin capabilities. It changes the host installation; run it only on the host where you intend to use the plugin. To run a local checkout instead, build it (`npm ci`, `npm run build`) and link it with `openclaw plugins install --link . --force --accept-capabilities`.

## Configure the plugin

Add this entry to your OpenClaw configuration. All paths, agent IDs, chat destinations and model names below are placeholders; substitute your own configured values. The model must be available to your worker runtime.

```json
{
  "plugins": {
    "entries": {
      "crew": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true,
          "allowPromptInjection": true
        },
        "config": {
          "statePath": "/absolute/path/to/board.sqlite",
          "leadAgentId": "lead",
          "ownerChat": {
            "channel": "telegram",
            "accountId": "default",
            "to": "telegram:REPLACE_WITH_OWNER_CHAT_ID"
          },
          "worker": {
            "agentId": "worker",
            "runtime": "acp",
            "limit": 2,
            "profiles": [
              {
                "id": "routine",
                "model": "provider/available-model",
                "thinking": "low",
                "description": "Routine implementation work."
              }
            ]
          }
        }
      }
    }
  }
}
```

Use a dedicated **new database file** or an existing **schema 1 board** at the absolute `statePath`. The store's schema-version check does not prove a database belongs to this plugin: never use an unrelated database. `:memory:` is ephemeral and unsuitable for durable work.

Grant `project_board` to the lead in its OpenClaw tool permissions. The bundled skills, [crew-lead](https://github.com/ag14774/openclaw-crew/blob/main/skills/crew-lead/SKILL.md) and [code-review](https://github.com/ag14774/openclaw-crew/blob/main/skills/code-review/SKILL.md), load for OpenClaw agents with the plugin; add them to any per-agent skill allowlist. Also make the code-review skill available to workers, which review and fix each change with it: link the installed copy into a skill folder the worker loads, for example `ln -s ~/.openclaw/extensions/crew/skills/code-review ~/.agents/skills/code-review`, which follows plugin upgrades, or install it with `npx skills add ag14774/openclaw-crew --skill code-review -g`. Without it, the lead copies the review rules into every review brief. Configure the worker's ACP runtime in OpenClaw when using `acp`; `subagent` is also supported. The plugin does not configure the agents, providers or channel for you.

The entry's `enabled` and hook permissions are host settings. The separate `config.enabled: false` stops automatic scans and wakes but leaves the board tool available. Optional cadence, turn timeout and concurrency settings are in the [configuration reference](board-reference.md#configuration); the authoritative schema is [openclaw.plugin.json](https://github.com/ag14774/openclaw-crew/blob/main/openclaw.plugin.json).

## Load and check

Once host configuration is ready, restart the Gateway:

```bash
openclaw gateway restart
```

This interrupts host activity. A linked checkout loads `dist/` at startup; after source changes, rebuild and restart to load the new code.

Confirm the lead can use `project_board` and inspect [board health](operations.md#inspect-health) for errors. In the intended project chat, ask the lead to create a project and record its context. Then follow the [normal workflow](workflow.md). A successful build or install alone does not establish that the worker runtime and real channel delivery work.
