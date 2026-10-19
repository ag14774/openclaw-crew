# Worker skills

Skills for the workers that build and review changes. OpenClaw does not load this folder; [install it](../README.md#skills) into a skill folder only the workers read.

| Skill                                                | For                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `engineering-principles`                             | Loaded first: which of the skills below to apply in each situation.       |
| `code-review`                                        | Reviewing a change, and acting on review findings.                        |
| `interrogate`                                        | Adversarial review of a change by reviewer subagents on different models. |
| `tdd`                                                | A failing regression test before a bug fix, when the test path is cheap.  |
| `typescript-best-practices`                          | Editing TypeScript.                                                       |
| `principle-attack-the-premise`                       | Testing the shared premise after two failed fixes.                        |
| `principle-boundary-discipline`                      | Validation and error handling at system boundaries only.                  |
| `principle-fix-root-causes`                          | Debugging: fixing the first place the system went wrong.                  |
| `principle-foundational-thinking`                    | Choosing data structures before writing logic.                            |
| `principle-laziness-protocol`                        | The smallest diff, and one place for each decision.                       |
| `principle-make-operations-idempotent`               | Operations that converge when rerun after a crash or retry.               |
| `principle-migrate-callers-then-delete-legacy-apis`  | Replacing an internal API without a compatibility layer.                  |
| `principle-minimize-reader-load`                     | Fewer layers and less hidden state for the reader.                        |
| `principle-model-the-domain`                         | Encoding the domain in data structures instead of branches.               |
| `principle-outcome-oriented-execution`               | Planned rewrites that converge on the target design.                      |
| `principle-prove-it-works`                           | Checking the real result before reporting done.                           |
| `principle-redesign-from-first-principles`           | Integrating a new requirement as if it had been there from the start.     |
| `principle-separate-before-serializing-shared-state` | Removing shared mutable state before serializing access to it.            |
| `principle-sequence-verifiable-units`                | Multi-step work in small units that are each checked.                     |
| `principle-subtract-before-you-add`                  | Removing complexity before building.                                      |
| `principle-test-behavior-not-implementation`         | Tests that assert what users of the code can observe.                     |
| `principle-type-system-discipline`                   | Types that make illegal states unrepresentable.                           |

`engineering-principles` and `code-review` are this project's own. The principle skills, `tdd`, `typescript-best-practices` and `interrogate` come from [pstack](https://github.com/cursor/plugins/tree/0b8e952/pstack) by poteto (`cursor/plugins`, folder `pstack`, commit `0b8e952`), under the MIT licence in [LICENSE-pstack](LICENSE-pstack). Local changes: the `disable-model-invocation` line is removed so the agent can load each skill itself, and `interrogate` uses the reviewer subagents available to the worker.
