---
name: engineering-principles
description: 'Load before writing, changing, testing or reviewing code. Says which principle skill to apply in each situation so the change stays small, simple and verified.'
---

# Engineering principles

Write the least code that does what was asked, and leave the code simpler than you found it. Load the skill named for each situation and follow it:

- Before writing code: `principle-laziness-protocol`, `principle-subtract-before-you-add` and `principle-foundational-thinking`.
- Adding a requirement to an existing design: `principle-redesign-from-first-principles`.
- Code with state, many branches or repeated shape assumptions: `principle-model-the-domain`; validation and error handling: `principle-boundary-discipline`; TypeScript: `typescript-best-practices`.
- Debugging: `principle-fix-root-causes`, and `principle-attack-the-premise` after two failed fixes. With a cheap local test path: `tdd`.
- Writing, changing or keeping a test: `principle-test-behavior-not-implementation`.
- Before reporting done: `principle-prove-it-works`.
- When asked to review a change or to act on review findings: `code-review`.

Guard only against states that can actually happen. Delete what your change makes unused, including its tests. Your assignment and the repository's `AGENTS.md` take precedence over these skills.
