import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANION_METHODS } from '../src/bridge-methods.ts';

// Compatibility lane: every native method the companion calls exists in the pinned build.
test(
  'companion methods exist in the pinned OpenClaw build',
  { skip: process.env.CREW_NATIVE_TEST !== '1' && 'set CREW_NATIVE_TEST=1' },
  () => {
    const dist = dirname(fileURLToPath(import.meta.resolve('openclaw')));
    const names = new Set();
    for (const file of readdirSync(dist).filter((n) =>
      /^(method-scopes|core-method-policy)-.*\.m?js$/.test(n),
    ))
      for (const match of readFileSync(join(dist, file), 'utf8').matchAll(/"([a-z][\w.-]*)"/g))
        names.add(match[1]);
    for (const method of COMPANION_METHODS) assert(names.has(method), `${method} missing`);
  },
);

test(
  'the message edit used for status cards exists in the pinned OpenClaw build',
  { skip: process.env.CREW_NATIVE_TEST !== '1' && 'set CREW_NATIVE_TEST=1' },
  () => {
    const dist = dirname(fileURLToPath(import.meta.resolve('openclaw')));
    const code = readdirSync(dist)
      .filter((n) => /^(src|action-runtime)-.*\.mjs$/.test(n))
      .map((n) => readFileSync(join(dist, n), 'utf8'))
      .join('\n');
    // message.action takes the board's own origin, and the bundled Telegram channel edits.
    assert.match(
      code,
      /MessageActionParamsSchema = closedObject\(\{[\s\S]*?conversationReadOrigin: Type\.Optional\(Type\.Literal\("direct-operator"\)\)/,
    );
    assert.match(code, /\bedit: "editMessage"/);
  },
);

test(
  'the transcript writer the board uses exists in the pinned OpenClaw build',
  { skip: process.env.CREW_NATIVE_TEST !== '1' && 'set CREW_NATIVE_TEST=1' },
  async () => {
    const sdk = await import('openclaw/plugin-sdk/session-transcript-runtime');
    assert.equal(typeof sdk.appendSessionTranscriptMessageByIdentity, 'function');
    assert.equal(typeof sdk.publishSessionTranscriptUpdateByIdentity, 'function');
  },
);

test(
  'the tool-free model call used for chat rewrites exists in the pinned OpenClaw build',
  { skip: process.env.CREW_NATIVE_TEST !== '1' && 'set CREW_NATIVE_TEST=1' },
  () => {
    const dist = dirname(fileURLToPath(import.meta.resolve('openclaw')));
    const declared = readdirSync(dist).some(
      (name) =>
        name.endsWith('.d.ts') &&
        readFileSync(join(dist, name), 'utf8').includes(
          'complete: (params: SubagentCompleteParams)',
        ),
    );
    assert(declared, 'api.runtime.subagent.complete missing');
  },
);
