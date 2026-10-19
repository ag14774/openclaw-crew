import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, LEAD_DM, LEAD_GROUP, MINUTE, ref } from './support/harness.ts';
import { taskSessionKey } from '../src/topology.ts';
import { companionMethodAllowed, companionScopes } from '../src/bridge-methods.ts';
import { Store } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = (h, id) => taskSessionKey(h.runtime.store.task(id));
async function project(
  h,
  name = 'Quote Desk',
  chat = { session: LEAD_GROUP, target: 'telegram:-200' },
) {
  await h.userMessage(chat.session, chat.target);
  const created = await h.call(chat.session, { operation: 'create_project', name });
  h.endTurn(chat.session);
  return created.project;
}
const addTask = (h, title, extra = {}) =>
  h.call(LEAD_DM, { operation: 'add_task', project: 'quote-desk', title, ...extra });

test('a request is worked in its task session and the user hears the result', async () => {
  const h = await harness();
  const id = await project(h);
  assert.equal(id, 'quote-desk');
  assert.match(
    (await h.call(LEAD_DM, { operation: 'list' })).projects[0].chat,
    /telegram chat telegram:-200/,
  );

  // The user asks for work in the project chat; the lead records it.
  await h.userMessage(LEAD_GROUP, 'telegram:-200');
  const { task } = await h.call(LEAD_GROUP, {
    operation: 'add_task',
    title: 'Add CSV export',
    body: 'Quotes can be exported as CSV.',
  });
  h.endTurn(LEAD_GROUP);

  // The scan wakes the lead at once in the task's private session.
  const tKey = key(h, task);
  assert.deepEqual((await h.tick()).woken, [task]);
  const run = h.native.runs.at(-1);
  assert.deepEqual([run.agentId, run.sessionKey, run.deliver], ['lead', tKey, false]);
  assert.match(run.message, /^PROJECT TASK task-\d+-[0-9a-z]+\nNew task\./);
  const card = await h.hooks.before_prompt_build({}, { agentId: 'lead', sessionKey: tKey });
  assert.match(card.prependContext, /Task #\d+: Add CSV export\nStatus: open, your turn\./);
  assert.match(card.prependContext, /sol-low = openai\/gpt-5\.6-sol/);
  assert.ok(card.prependSystemContext.startsWith(`Session ${tKey}.\nIn project work`));
  assert.match(card.prependSystemContext, /private task session/);

  // A running session is not woken again.
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);

  // A worker spawned with a profile id gets the profile and is recorded on the task.
  const spawned = await h.spawn(tKey, { agentId: 'opencode', model: 'sol-low', task: 'Implement' });
  assert.deepEqual(
    [spawned.params.model, spawned.params.thinking, spawned.params.runtime],
    ['openai/gpt-5.6-sol', 'low', 'acp'],
  );
  assert.deepEqual(
    h.runtime.store.task(task).workers.map((w) => w.key),
    [spawned.childSessionKey],
  );

  // Closing needs a message for the user, and the worker must have finished.
  const close = (extra) =>
    h.call(tKey, { operation: 'update_task', status: 'done', note: 'Merged PR #7', ...extra });
  assert.match((await close()).error, /Closing a task needs message/);
  assert.match((await close({ message: 'CSV export is live.' })).error, /1 running worker/);
  h.advance(3 * MINUTE);
  h.native.session(spawned.childSessionKey).hasActiveRun = false;
  const done = await close({ message: 'CSV export is live.' });
  assert.deepEqual([done.status, done.message.state], ['done', 'sent']);
  const sent = h.native.sent.at(-1);
  assert.deepEqual(
    [sent.conversationRef, sent.message, sent.agentId],
    [ref('b'), 'CSV export is live.', 'lead'],
  );

  // Private replies never reach a chat; the closed task's session is kept for a week.
  assert.equal(h.hooks.message_sending({}, { sessionKey: tKey }).cancel, true);
  h.endAllRuns();
  await h.tick();
  assert.deepEqual(h.native.cleaned, []);
  h.advance(7 * 24 * 60 * MINUTE);
  await h.tick();
  assert.deepEqual(h.native.cleaned, [tKey]);

  // A late native turn that recreates it is refused, and the next scan removes it again.
  h.native.session(tKey);
  assert.equal(h.hooks.before_agent_run({}, { sessionKey: tKey }).outcome, 'block');
  await h.tick();
  assert.deepEqual(h.native.cleaned, [tKey, tKey]);
});

test('asking the user sends the question, and the answer noted in the chat wakes the task', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Pricing page');
  await h.tick();
  const tKey = key(h, task);

  const ask = (extra) =>
    h.call(tKey, {
      operation: 'update_task',
      status: 'waiting',
      note: 'Asked about billing period',
      ...extra,
    });
  assert.match((await ask()).error, /Asking the user needs message/);
  const asked = await ask({ message: 'Should the pricing page show monthly or yearly prices?' });
  assert.equal(asked.status, 'waiting');
  assert.equal(h.native.sent.at(-1).conversationRef, ref('b'));
  h.endAllRuns();

  // Nothing is woken while the task waits on the user.
  h.advance(2 * 60 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);

  // A message that was not delivered, and a later note, do not hide the question.
  h.native.sendStatus = () => 'throw';
  await h.call(tKey, { operation: 'notify', message: 'Undelivered reminder' });
  h.native.sendStatus = () => 'sent';
  await h.call(tKey, { operation: 'update_task', note: 'Remind on Monday' });
  h.endAllRuns();

  // In the project chat the lead sees the project and the waiting question.
  const context = (await h.userMessage(LEAD_GROUP, 'telegram:-200')).prependContext;
  assert.match(context, /also used as the project chat for "Quote Desk"/);
  assert.match(
    context,
    /Waiting on the user: Quote Desk task #\d+ "Pricing page" — last message they received \([^)]+\): Should the pricing page show monthly or yearly prices\? — latest note \([^)]+\): Remind on Monday/,
  );
  assert.doesNotMatch(context, /Undelivered reminder|billing period/);

  const answered = await h.call(LEAD_GROUP, {
    operation: 'update_task',
    task,
    status: 'open',
    note: 'User: yearly, with a monthly toggle.',
  });
  assert.equal(answered.status, 'open');
  h.endTurn(LEAD_GROUP);
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(
    h.native.runs.at(-1).message,
    /Changed outside this session\. Latest note: User: yearly/,
  );
});

test('in the project chat the reply is the message; elsewhere a message is required', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Logo');
  await h.userMessage(LEAD_GROUP, 'telegram:-200');
  const cancelled = await h.call(LEAD_GROUP, {
    operation: 'update_task',
    task,
    status: 'cancelled',
    note: 'User dropped it',
  });
  assert.equal(cancelled.status, 'cancelled');
  const asked = await h.call(LEAD_GROUP, { operation: 'add_task', title: 'Colour' });
  const question = await h.call(LEAD_GROUP, {
    operation: 'update_task',
    task: asked.task,
    status: 'waiting',
    note: 'Asked the user',
    message: 'Which colour?',
  });
  assert.equal(question.message.state, 'not sent');
  const notified = await h.call(LEAD_GROUP, { operation: 'notify', message: 'FYI' });
  assert.equal(notified.message.state, 'not sent');
  assert.equal(h.native.sent.length, 0);
  // With no board message, the chat context labels the note as internal.
  h.endTurn(LEAD_GROUP);
  const context = await h.userMessage(LEAD_GROUP, 'telegram:-200');
  assert.match(context.prependContext, /"Colour" — latest note \([^)]+\): Asked/);

  const other = await addTask(h, 'Font');
  await h.userMessage(LEAD_DM, 'telegram:100');
  const fromDm = await h.call(LEAD_DM, {
    operation: 'update_task',
    task: other.task,
    status: 'cancelled',
    note: 'Dropped',
  });
  assert.match(fromDm.error, /needs message/);
});

test('a status change needs a note and is decided on the latest state', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Summary header');
  const tKey = key(h, task);
  assert.match(
    (await h.call(tKey, { operation: 'update_task', status: 'waiting', message: 'Header text?' }))
      .error,
    /Changing the status needs a note/,
  );
  // The task session reads the task; meanwhile the chat records the user's direction.
  await h.hooks.before_prompt_build({}, { agentId: 'lead', sessionKey: tKey });
  await h.userMessage(LEAD_GROUP, 'telegram:-200');
  await h.call(LEAD_GROUP, { operation: 'update_task', task, note: 'User: "Copied Summary"' });
  const close = () =>
    h.call(tKey, { operation: 'update_task', status: 'done', note: 'Done', message: 'Done.' });
  assert.match(
    (await close()).error,
    /changed since you read it \(latest note: User: "Copied Summary"\)/,
  );
  await h.call(tKey, { operation: 'show' });
  assert.equal((await close()).status, 'done');
});

test('private task sessions follow the model chosen in the project chat', async () => {
  const h = await harness();
  await project(h);
  const chat = h.native.session(LEAD_GROUP);
  Object.assign(chat, {
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    modelOverrideSource: 'user',
    thinkingLevel: 'high',
  });
  const one = await addTask(h, 'Totals');
  await h.tick();
  const k1 = key(h, one.task);
  assert.deepEqual(h.native.patches.slice(-2), [
    { key: k1, agentId: 'lead', model: 'openai/gpt-5.6-sol' },
    { key: k1, agentId: 'lead', thinkingLevel: 'high' },
  ]);

  // Without a choice in the chat a session goes back to the agent's defaults.
  Object.assign(chat, { modelOverrideSource: null, thinkingLevel: undefined });
  const two = await addTask(h, 'Tax');
  await h.tick();
  const k2 = key(h, two.task);
  assert.deepEqual(h.native.patches.slice(-2), [
    { key: k2, agentId: 'lead', model: null },
    { key: k2, agentId: 'lead', thinkingLevel: null },
  ]);

  // A message in the project chat records the session OpenClaw routed it to; a message in
  // another chat (the DM) does not.
  const moved = 'agent:lead:telegram:group:-200:reset-scope';
  h.native.session(moved);
  await h.userMessage(moved, 'telegram:-200');
  await h.userMessage(LEAD_DM, 'telegram:100');
  assert.equal(h.runtime.store.project('quote-desk').route.sessionKey, moved);

  // The companion lets sessions.patch touch only the model settings of private sessions.
  assert(companionMethodAllowed('sessions.patch', { key: k1, agentId: 'lead', model: null }));
  assert(
    !companionMethodAllowed('sessions.patch', { key: LEAD_GROUP, agentId: 'lead', model: null }),
  );
  assert(!companionMethodAllowed('sessions.patch', { key: k1, agentId: 'lead', label: 'x' }));
  assert(
    !companionMethodAllowed('sessions.patch', {
      key: k1,
      agentId: 'lead',
      model: null,
      thinkingLevel: null,
    }),
  );
  // A model is never sent with admin scope, which would make it the configured default.
  assert(!companionScopes('sessions.patch', { key: k1, model: 'x' }).includes('operator.admin'));
  assert(
    companionScopes('sessions.patch', { key: k1, thinkingLevel: 'high' }).includes(
      'operator.admin',
    ),
  );
});

test('task sessions stay in their project, and closed tasks change only by reopening', async () => {
  const h = await harness();
  await project(h, 'Alpha');
  await project(h, 'Beta', { session: LEAD_DM, target: 'telegram:100' });
  const a = await h.call(LEAD_DM, { operation: 'add_task', project: 'alpha', title: 'A1' });
  const b = await h.call(LEAD_DM, { operation: 'add_task', project: 'beta', title: 'B1' });
  const aKey = key(h, a.task);
  assert.match(
    (await h.call(aKey, { operation: 'update_task', task: b.task, note: 'x' })).error,
    /only on its own project/,
  );
  assert.match(
    (await h.call(aKey, { operation: 'show', project: 'beta' })).error,
    /only on its own project/,
  );
  assert.deepEqual(
    (await h.call(aKey, { operation: 'list' })).projects.map((p) => p.id),
    ['alpha'],
  );
  assert.match(
    (await h.call(aKey, { operation: 'create_project', name: 'Gamma' })).error,
    /not from a task session/,
  );
  assert.equal(h.tool('opencode', 'agent:opencode:x'), null);

  await h.call(LEAD_DM, {
    operation: 'update_task',
    task: a.task,
    status: 'cancelled',
    note: 'No',
    message: 'Dropped A1',
  });
  assert.match(
    (await h.call(aKey, { operation: 'update_task', note: 'more' })).error,
    /is cancelled; reopen/,
  );
  h.endAllRuns();
  const reopened = await h.call(LEAD_DM, {
    operation: 'update_task',
    task: a.task,
    status: 'open',
    note: 'Back on',
  });
  assert.equal(reopened.status, 'open');
  assert(h.runtime.store.task(a.task).poked);
});

test('a task session that does nothing is reported once, and a change from the chat wakes it once more', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Stuck');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await h.tick()).woken, [task]);
    h.endAllRuns();
    h.advance(61 * MINUTE);
  }
  assert.deepEqual((await h.tick()).stalled, [task]);
  assert.match(
    h.native.sent.at(-1).message,
    /task #\d+ "Stuck" is stuck: its wake-ups went unanswered/,
  );
  h.advance(3 * 60 * MINUTE);
  assert.deepEqual(await h.tick().then((s) => [s.woken, s.stalled]), [[], []]);
  assert.equal(h.native.sent.length, 1);
  await h.call(LEAD_DM, { operation: 'update_task', task, note: 'Any news?' });
  assert.deepEqual((await h.tick()).woken, [task]);
  h.endAllRuns();
  h.advance(61 * MINUTE);
  assert.deepEqual((await h.tick()).stalled, [task]);
  assert.equal(h.native.sent.length, 2);
});

test('notes from other sessions do not hide a task session that never acts', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Unanswered');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual((await h.tick()).woken, [task]);
    h.endAllRuns();
    h.advance(5 * MINUTE);
    await h.call(LEAD_DM, { operation: 'update_task', task, note: `Ping ${i}` });
  }
  assert.deepEqual((await h.tick()).stalled, [task]);
  // The task session's own action answers its wakes.
  await h.call(key(h, task), { operation: 'update_task', note: 'Back on it' });
  assert.equal(h.runtime.store.task(task).idle_wakes, 0);
});

test('check_in_minutes schedules the next wake, and running workers do not count as idle', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'CI');
  await h.tick();
  const tKey = key(h, task);
  await h.spawn(tKey, { agentId: 'opencode', model: 'astra', task: 'Build' });
  await h.call(tKey, { operation: 'update_task', note: 'Waiting for CI', check_in_minutes: 10 });
  h.endAllRuns();
  h.advance(9 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(h.native.runs.at(-1).message, /workers are still running/);
  for (let i = 0; i < 5; i++) {
    h.endAllRuns();
    h.advance(61 * MINUTE);
    assert.deepEqual((await h.tick()).stalled, []);
  }
  // A wake for a change from another session counts even while workers run.
  const before = h.runtime.store.task(task).idle_wakes;
  await h.call(LEAD_DM, { operation: 'update_task', task, note: 'Status?' });
  h.endAllRuns();
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.equal(h.runtime.store.task(task).idle_wakes, before + 1);
});

test('the plan is kept on the task, shown on its card, and replaced or cleared as a whole', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Full UI');
  const tKey = key(h, task);
  const plan = '[~] 1 Layout — worker A → PR #1\n[ ] 2 Forms — after 1';
  assert(!(await h.call(tKey, { operation: 'update_task', plan })).error);
  const card = await h.hooks.before_prompt_build({}, { agentId: 'lead', sessionKey: tKey });
  assert.match(
    card.prependContext,
    /Plan:\n\[~\] 1 Layout — worker A → PR #1\n\[ \] 2 Forms — after 1/,
  );
  assert.equal((await h.call(LEAD_DM, { operation: 'show', task })).task.plan, plan);
  // Other updates keep it; a new plan replaces it; an empty one clears it.
  await h.call(tKey, { operation: 'update_task', note: 'Layout merged' });
  assert.equal(h.runtime.store.task(task).plan, plan);
  await h.call(tKey, { operation: 'update_task', plan: '[x] 1 Layout\n[~] 2 Forms' });
  assert.equal(h.runtime.store.task(task).plan, '[x] 1 Layout\n[~] 2 Forms');
  await h.call(tKey, { operation: 'update_task', plan: '' });
  assert.equal((await h.call(LEAD_DM, { operation: 'show', task })).task.plan, undefined);
});

test('the card shows the project context and the description in full', async () => {
  const h = await harness();
  await project(h);
  const long = (end) => `${'x'.repeat(7980)} ${end}`;
  await h.call(LEAD_DM, {
    operation: 'update_project',
    project: 'quote-desk',
    context: long('CONTEXT-END'),
  });
  const { task } = await addTask(h, 'Long', { body: long('BODY-END') });
  const card = await h.hooks.before_prompt_build({}, { agentId: 'lead', sessionKey: key(h, task) });
  assert.match(card.prependContext, /CONTEXT-END/);
  assert.match(card.prependContext, /BODY-END/);
});

test('cancelling stops the task’s workers', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Big');
  await h.tick();
  const w = await h.spawn(key(h, task), { agentId: 'opencode', model: 'sol-low', task: 'x' });
  await h.call(LEAD_DM, {
    operation: 'update_task',
    task,
    status: 'cancelled',
    note: 'Stop',
    message: 'Stopped.',
  });
  assert.deepEqual(h.native.aborted, [w.childSessionKey]);
});

test('worker spawns need a profile, respect the limit, and are refused when paused', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'One');
  await h.tick();
  const k = key(h, task);
  assert.match(
    (await h.spawn(k, { agentId: 'opencode', model: 'gpt-9', task: 'x' })).blocked,
    /profile id: sol-low, astra/,
  );
  await h.spawn(k, { agentId: 'opencode', model: 'sol-low', task: 'x' });
  await h.spawn(k, { agentId: 'opencode', model: 'sol-low', task: 'y' });
  assert.match(
    (await h.spawn(k, { agentId: 'opencode', model: 'sol-low', task: 'z' })).blocked,
    /2 workers are already running/,
  );
  // Spawning some other agent (research) is not the worker pool and is allowed.
  assert.ok((await h.spawn(k, { agentId: 'researcher', task: 'look' })).childSessionKey);
  await h.call(LEAD_DM, { operation: 'update_project', project: 'quote-desk', state: 'paused' });
  assert.match((await h.spawn(k, { agentId: 'researcher', task: 'look' })).blocked, /paused/);
  // sessions_send only reaches the task's own workers; the message tool is refused.
  const guard = (toolName, params) =>
    h.hooks.before_tool_call({ toolName, params }, { agentId: 'lead', sessionKey: k });
  assert.equal((await guard('sessions_send', { sessionKey: LEAD_DM })).block, true);
  assert.equal((await guard('message', {})).block, true);
});

test('paused projects are not woken; resuming wakes their open tasks', async () => {
  const h = await harness();
  await project(h);
  const { task } = await addTask(h, 'Later');
  await h.call(LEAD_DM, { operation: 'update_project', project: 'quote-desk', state: 'paused' });
  h.advance(3 * 60 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);
  await h.call(LEAD_DM, { operation: 'update_project', project: 'quote-desk', state: 'active' });
  assert.deepEqual((await h.tick()).woken, [task]);
  assert.match(
    (
      await h.call(LEAD_DM, {
        operation: 'update_project',
        project: 'quote-desk',
        state: 'archived',
      })
    ).error,
    /Close or cancel/,
  );
});

test('at most the configured number of task sessions run at once', async () => {
  const h = await harness({ config: { maxTaskSessions: 1 } });
  await project(h);
  const one = await addTask(h, 'One');
  const two = await addTask(h, 'Two');
  assert.deepEqual((await h.tick()).woken, [one.task]);
  h.advance(2 * MINUTE);
  assert.deepEqual((await h.tick()).woken, []);
  h.endAllRuns();
  assert.deepEqual((await h.tick()).woken, [two.task]);
});

test('messages fall back to the owner DM, never rebind, and retry with the same operation', async () => {
  const h = await harness();
  await project(h);
  // The project chat rejects messages: straight to the owner DM, with the project name.
  h.native.sendStatus = (p) => (p.conversationRef === ref('b') ? 'suppressed' : 'sent');
  const notify = (message) =>
    h.call(LEAD_DM, { operation: 'notify', project: 'quote-desk', message });
  assert.equal((await notify('Hello')).state, 'sent');
  assert.deepEqual(
    [h.native.sent.at(-1).conversationRef, h.native.sent.at(-1).message],
    [ref('a'), '[Quote Desk] Hello'],
  );
  assert.equal(h.runtime.store.project('quote-desk').route.conversationRef, ref('b'));

  // Errors retry on the project chat with one operation id, then fall back.
  let tries = 0;
  h.native.sendStatus = (p) => (p.conversationRef === ref('b') ? (tries++, 'throw') : 'queued');
  assert.equal((await notify('Again')).state, 'retrying');
  h.advance(3 * MINUTE);
  await h.tick();
  h.advance(5 * MINUTE);
  await h.tick();
  assert.equal(tries, 3);
  const operations = h.native.calls
    .filter(([m, p]) => m === 'conversations.send' && p.message === 'Again')
    .map(([, p]) => p.operationId);
  assert.equal(new Set(operations.slice(0, 3)).size, 1);
  assert.equal(h.native.sent.at(-1).message, '[Quote Desk] Again');
  assert.equal(h.runtime.store.get("SELECT state FROM outbox WHERE text='Again'").state, 'handed');
});

test('files follow their message, and the message joins the session of the chat it reached', async () => {
  const h = await harness();
  await project(h);
  const dir = mkdtempSync(join(tmpdir(), 'crew-files-'));
  const png = join(dir, 'architecture.png');
  writeFileSync(png, 'png-bytes');
  try {
    // Paths are checked when the message is recorded.
    const notify = (attachments) =>
      h.call(LEAD_DM, { operation: 'notify', project: 'quote-desk', message: 'See', attachments });
    assert.match((await notify(['relative.png'])).error, /absolute path/);
    assert.match((await notify([join(dir, 'missing.png')])).error, /not found/);
    assert.match((await notify([dir])).error, /not a file/);
    assert.match((await notify([png, png, png, png, png])).error, /at most 4/);
    const { task } = await addTask(h, 'Architecture');
    const tKey = key(h, task);
    assert.match(
      (await h.call(tKey, { operation: 'update_task', note: 'x', attachments: [png] })).error,
      /sent with a message/,
    );

    // A failed file send retries the whole message with the same identities. Meanwhile
    // the lead is talking in the project chat, so its session is busy.
    const chat = h.native.session(LEAD_GROUP);
    chat.deliveryContext = { channel: 'telegram', to: 'telegram:-200', accountId: 'default' };
    chat.hasActiveRun = true;
    h.native.fail.add('message.action');
    const closed = await h.call(tKey, {
      operation: 'update_task',
      status: 'done',
      note: 'Accepted',
      message: 'Here is the architecture.',
      attachments: [png],
    });
    // The text is delivered; only the file is retried, in the same chat.
    assert.equal(closed.message.state, 'sent');
    assert.match(closed.message.error, /Attachments not delivered yet/);
    h.native.fail.delete('message.action');
    h.advance(3 * MINUTE);
    await h.tick();
    assert.equal(h.native.transcript.length, 0);
    const calls = (method, pick) =>
      new Set(h.native.calls.filter(([m]) => m === method).map(([, p]) => pick(p)));
    assert.equal(calls('conversations.send', (p) => p.operationId).size, 1);
    assert.equal(calls('message.action', (p) => p.idempotencyKey).size, 1);
    const file = h.native.files.at(-1);
    assert.deepEqual(
      [
        file.channel,
        file.params.to,
        file.agentId,
        file.params.filename,
        Buffer.from(file.params.buffer, 'base64').toString(),
      ],
      ['telegram', 'telegram:-200', 'lead', 'architecture.png', 'png-bytes'],
    );
    assert.equal(
      h.runtime.store.get("SELECT state FROM outbox WHERE text='Here is the architecture.'").state,
      'handed',
    );

    // Once the chat's turn ends, the scan adds the message to that session as the lead's
    // own reply, with a MEDIA line for the file; only once.
    chat.hasActiveRun = false;
    await h.tick();
    await h.tick();
    assert.equal(h.native.transcript.length, 1);
    const entry = h.native.transcript[0];
    assert.deepEqual(
      [entry.agentId, entry.sessionKey, entry.sessionId, entry.message.role],
      ['lead', LEAD_GROUP, chat.sessionId, 'assistant'],
    );
    assert.equal(entry.message.content[0].text, `Here is the architecture.\n\nMEDIA:${png}`);
    assert.notEqual(entry.message.provider, 'openclaw');

    // A message that fell back to the owner DM joins the DM's session, as sent there.
    h.native.session(LEAD_DM).deliveryContext = { channel: 'telegram', to: 'telegram:100' };
    h.native.sendStatus = (p) => (p.conversationRef === ref('b') ? 'suppressed' : 'sent');
    await h.call(LEAD_DM, { operation: 'notify', project: 'quote-desk', message: 'DM' });
    assert.deepEqual(
      [h.native.transcript.at(-1).sessionKey, h.native.transcript.at(-1).message.content[0].text],
      [LEAD_DM, '[Quote Desk] DM'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A project bound to the group chat, whose session is the lead's and has a chat history.
async function chatProject(h) {
  await project(h);
  const chat = h.native.session(LEAD_GROUP);
  chat.deliveryContext = { channel: 'telegram', to: 'telegram:-200', accountId: 'default' };
  h.native.history[LEAD_GROUP] = [];
  const say = (role, text) =>
    h.native.history[LEAD_GROUP].push({
      role,
      content: role === 'user' ? text : [{ type: 'text', text }],
      timestamp: h.now(),
    });
  return { chat, say };
}

test('a project chat message is rewritten for the conversation before it is sent', async () => {
  const h = await harness();
  const { say } = await chatProject(h);
  say('user', 'Old chatter');
  h.advance(MINUTE);
  say('user', 'Please add CSV export');
  const { task } = await addTask(h, 'CSV export');
  h.advance(MINUTE);
  say('assistant', 'Recorded.');
  h.native.history[LEAD_GROUP].push({ role: 'toolResult', content: 'x', timestamp: h.now() });
  say('user', 'Also, the logo looks off');
  const calls = [];
  h.runtime.adapt = async (input) => {
    calls.push(input);
    return 'The CSV export you asked for is done.';
  };
  const closed = await h.call(key(h, task), {
    operation: 'update_task',
    status: 'done',
    note: 'Accepted',
    message: 'CSV export is merged.',
  });
  assert.equal(closed.message.state, 'sent');
  assert.equal(h.native.sent.at(-1).message, 'The CSV export you asked for is done.');
  // The rewrite sees the chat from the request on, the task, and the message as written.
  const { system, message } = calls[0];
  assert.match(system, /Keep every fact/);
  assert.doesNotMatch(message, /Old chatter/);
  assert.match(
    message,
    /User: Please add CSV export\n.*You: Recorded\.\n.*User: Also, the logo looks off/,
  );
  assert.match(message, /Task #\d+: CSV export/);
  assert.match(message, /The message to send:\nCSV export is merged\.$/);
  // The chat's session records the text as sent.
  assert.equal(
    h.native.transcript.at(-1).message.content[0].text,
    'The CSV export you asked for is done.',
  );
});

test('a rewrite waits within the turn for a busy or changing chat; failures and scan deliveries go as written', async () => {
  const h = await harness();
  const { chat } = await chatProject(h);
  let calls = 0;
  let slept = 0;
  h.runtime.adapt = async () => `Rewrite ${++calls}`;
  // Waiting happens within the sending turn: here the chat's reply ends during the wait.
  h.runtime.sleep = async (ms) => {
    slept += ms;
    h.advance(ms);
    chat.hasActiveRun = false;
  };
  const notify = () =>
    h.call(LEAD_DM, { operation: 'notify', project: 'quote-desk', message: 'Heads up' });
  chat.hasActiveRun = true;
  assert.equal((await notify()).state, 'sent');
  assert.deepEqual([slept, calls, h.native.sent.at(-1).message], [10000, 1, 'Rewrite 1']);
  // When the chat changes during the rewrite, the message is rewritten again.
  h.runtime.adapt = async () => {
    if (++calls === 2) chat.updatedAt += 1;
    return `Rewrite ${calls}`;
  };
  await notify();
  assert.equal(h.native.sent.at(-1).message, 'Rewrite 3');
  // A chat that stays busy is waited for at most two minutes.
  h.runtime.sleep = async (ms) => {
    slept += ms;
    h.advance(ms);
  };
  slept = 0;
  chat.hasActiveRun = true;
  await notify();
  assert.deepEqual([slept, h.native.sent.at(-1).message], [2 * MINUTE, 'Rewrite 4']);
  chat.hasActiveRun = false;
  // A failed rewrite sends the message as written.
  h.runtime.adapt = async () => {
    calls++;
    throw new Error('model down');
  };
  await notify();
  assert.equal(h.native.sent.at(-1).message, 'Heads up');
  assert.match(h.warnings.at(-1), /sent as written: model down/);
  // Messages the scan sends, and owner-DM fallbacks, are not rewritten.
  h.runtime.adapt = async () => `Rewrite ${++calls}`;
  const before = calls;
  h.runtime.store.enqueue('quote-desk', null, 'From the scan');
  await h.tick();
  h.native.sendStatus = (p) => (p.conversationRef === ref('b') ? 'suppressed' : 'sent');
  await notify();
  assert.equal(calls, before + 1);
  assert.deepEqual(
    h.native.sent.slice(-2).map((p) => p.message),
    ['From the scan', `[Quote Desk] Rewrite ${calls}`],
  );
});

test('the rewrite runs as the lead, with its workspace files and the configured model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-workspace-'));
  writeFileSync(join(dir, 'SOUL.md'), 'Calm and precise.');
  writeFileSync(join(dir, 'USER.md'), 'Explain in plain words.');
  try {
    const calls = [];
    const h = await harness({
      config: { rewriteModel: 'openai/gpt-5.6-terra' },
      workspace: dir,
      complete: async (params) => {
        calls.push(params);
        return { text: 'Rewritten' };
      },
    });
    await chatProject(h);
    await h.call(LEAD_DM, { operation: 'notify', project: 'quote-desk', message: 'Hi' });
    assert.equal(h.native.sent.at(-1).message, 'Rewritten');
    const [{ agentId, model, extraSystemPrompt }] = calls;
    assert.deepEqual([agentId, model], ['lead', 'openai/gpt-5.6-terra']);
    assert.match(
      extraSystemPrompt,
      /Keep every fact[\s\S]*Calm and precise\.\n\nExplain in plain words\.$/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a long chat keeps the request and the newest messages for the rewrite', async () => {
  const h = await harness();
  const at = h.now();
  const messages = [
    { role: 'user', content: 'Before', timestamp: at - 1 },
    { role: 'user', content: 'The request', timestamp: at },
    ...Array.from({ length: 30 }, (_, i) => ({
      role: 'user',
      content: `${i} ${'x'.repeat(2000)}`,
      timestamp: at + i + 1,
    })),
  ];
  const lines = h.runtime.chatSince(messages, at).split('\n');
  assert.match(lines[0], /User: The request$/);
  assert.match(lines[1], /^\[1[0-9] earlier messages left out\]$/);
  assert.match(lines.at(-1), /User: 29 x+$/);
  assert(lines.join('\n').length < 42000);
});

test('use_this_chat binds only the chat of the message that started the turn', async () => {
  const h = await harness();
  await project(h, 'Quote Desk', { session: LEAD_DM, target: 'telegram:100' });
  assert.equal(h.runtime.store.project('quote-desk').route.conversationRef, ref('a'));
  // A turn with no new message (cron, heartbeat) has no chat to bind.
  await h.hooks.before_prompt_build({}, { agentId: 'lead', sessionKey: LEAD_GROUP });
  const bind = (session) => h.call(session, { operation: 'update_project', use_this_chat: true });
  assert.match((await bind(LEAD_GROUP)).error, /needs a current user message/);
  // A new message in the group, then use_this_chat.
  await h.userMessage(LEAD_GROUP, 'telegram:-200');
  await bind(LEAD_GROUP);
  assert.equal(h.runtime.store.project('quote-desk').route.conversationRef, ref('b'));
  // Private sessions have no chat.
  const { task } = await h.call(LEAD_DM, { operation: 'add_task', title: 'x' });
  assert.match((await bind(key(h, task))).error, /needs a current user message/);
});

test('the plugin stays out of personal work and other agents', async () => {
  const h = await harness();
  // The lead spawning or messaging from a personal chat is untouched.
  const lead = { agentId: 'lead', sessionKey: LEAD_DM };
  assert.equal(
    await h.hooks.before_tool_call(
      { toolName: 'sessions_spawn', params: { agentId: 'opencode' } },
      lead,
    ),
    undefined,
  );
  assert.equal(
    await h.hooks.before_tool_call({ toolName: 'message', params: {} }, lead),
    undefined,
  );
  assert.equal(h.hooks.message_sending({}, { sessionKey: LEAD_DM }), undefined);
  assert.equal(h.hooks.before_agent_run({}, { sessionKey: LEAD_DM }), undefined);
  // Other agents get nothing.
  const other = { agentId: 'opencode', sessionKey: 'agent:opencode:x' };
  assert.equal(await h.hooks.before_prompt_build({}, other), undefined);
  assert.equal(
    await h.hooks.before_tool_call({ toolName: 'sessions_spawn', params: {} }, other),
    undefined,
  );
  // A personal chat without projects gets only the session and role lines.
  const personal = await h.userMessage('agent:lead:telegram:direct:999', 'telegram:999');
  assert.equal(personal.prependContext, undefined);
  assert.match(
    personal.prependSystemContext,
    /^Session agent:lead:telegram:direct:999\.\nIn project work .* you are the lead.*adds to your usual role and does not replace it/,
  );
  // It also says how to load the lead skill into context.
  assert.match(
    personal.prependSystemContext,
    /load the crew-lead skill .*skills_read tool \(name crew-lead\).*`return await skills\.read\('crew-lead'\)`, so that its text comes back into your context/,
  );
});

test('the board file persists across restarts and a database of another schema is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-board-'));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  first.run("INSERT INTO projects(id,name,created,updated) VALUES('kept','Kept',1,1)");
  first.close();
  const reopened = new Store(path);
  assert.equal(reopened.project('kept').name, 'Kept');
  reopened.close();

  const foreign = join(dir, 'other.sqlite');
  const other = new DatabaseSync(foreign);
  other.exec('PRAGMA user_version=99');
  other.close();
  assert.throws(() => new Store(foreign), /not a project board \(schema 99, expected 1\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('registrations in one process share the board, so a chat seen by the hooks binds the tool call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-board-'));
  const h = await harness({ config: { statePath: join(dir, 'state.sqlite') } });
  // OpenClaw runs the hooks from its gateway registration and the tool from another one.
  const otherTool = h.registerAgain();
  await h.userMessage(LEAD_DM, 'telegram:100');
  const run = (args) => otherTool({ agentId: 'lead', sessionKey: LEAD_DM }).execute('call', args);
  const created = JSON.parse(
    (await run({ operation: 'create_project', name: 'Quote Desk' })).content[0].text,
  );
  assert.match(created.chat, /telegram DM telegram:100/);
  h.runtime.store.close();
  rmSync(dir, { recursive: true, force: true });
});

const registration = (plugin, statePath, scanMs, services) =>
  plugin.register({
    pluginConfig: {
      statePath,
      leadAgentId: 'lead',
      ownerChat: { channel: 'telegram', accountId: 'default', to: 'telegram:100' },
      scanMs,
    },
    config: {},
    logger: { warn() {} },
    registerTool() {},
    registerGatewayMethod() {},
    registerService: (service) => services.push(service),
    on() {},
  });
const fakeBridge = (name, seen) => ({
  stopped: false,
  failingSince: null,
  request: async (method) => {
    seen.push(`${name}:${method}`);
    return { sessions: [], conversations: [] };
  },
  stop() {
    this.stopped = true;
    seen.push(`${name}:stop`);
  },
});

test('a reload gives the shared board a fresh companion and runtime from the new code', async () => {
  const { default: plugin, testHooks } = await import('../src/index.ts');
  const dir = mkdtempSync(join(tmpdir(), 'crew-reload-'));
  const seen = [];
  const services = [];
  try {
    testHooks.bridge = fakeBridge('old', seen);
    registration(plugin, join(dir, 'state.sqlite'), 3_600_000, services);
    await services[0].start();
    const before = testHooks.runtime;
    assert.ok(before);

    testHooks.bridge = fakeBridge('new', seen);
    registration(plugin, join(dir, 'state.sqlite'), 3_600_000, services);
    seen.length = 0;
    await services[1].start();
    await services[0].stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The new service's first scan goes through the new companion only.
    assert.deepEqual(seen, ['old:stop', 'new:conversations.list']);
    assert.ok(before.stopped);
    assert.notEqual(testHooks.runtime, before);
    await services[1].stop();
  } finally {
    testHooks.bridge = null;
    testHooks.runtime = null;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('health shows a scan that cannot see the task sessions, and clears once it can', async () => {
  const h = await harness();
  await project(h);
  await addTask(h, 'Pricing page');
  h.native.fail.add('sessions.list');
  await h.tick();
  assert.match(h.runtime.healthReport().lastError, /Cannot see the task sessions/);
  h.native.fail.delete('sessions.list');
  await h.tick();
  assert.equal(h.runtime.healthReport().lastError, null);
});

test('a companion that has not answered for five minutes is replaced by a fresh board', async () => {
  const { default: plugin, testHooks } = await import('../src/index.ts');
  const dir = mkdtempSync(join(tmpdir(), 'crew-recover-'));
  const seen = [];
  const services = [];
  let clock = Date.now();
  try {
    const stuck = fakeBridge('stuck', seen);
    testHooks.bridge = stuck;
    testHooks.now = () => clock;
    registration(plugin, join(dir, 'state.sqlite'), 20, services);
    await services[0].start();
    const before = testHooks.runtime;
    stuck.failingSince = clock;
    testHooks.bridge = fakeBridge('fresh', seen);
    clock += 4 * MINUTE;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(!seen.includes('stuck:stop'));
    clock += 2 * MINUTE;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(seen.includes('stuck:stop'));
    assert.ok(seen.includes('fresh:conversations.list'));
    assert.ok(before.stopped);
    assert.notEqual(testHooks.runtime, before);
    await services[0].stop();
  } finally {
    testHooks.bridge = null;
    testHooks.runtime = null;
    testHooks.now = null;
    rmSync(dir, { recursive: true, force: true });
  }
});
