import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { readStringParam } from 'openclaw/plugin-sdk/param-readers';
import { normalizeAgentIdStrict } from 'openclaw/plugin-sdk/routing';
import {
  isLead,
  isPrivateSession,
  parseTaskSession,
  taskScope,
  taskSessionKey,
  topology,
} from './topology.js';

const MINUTE = 60 * 1000;
const CHECK_IN_MINUTES = 60;
const STALL_WAKES = 3;
const WAKE_RETRY_MINUTES = 5;
const WAKE_GRACE_MS = MINUTE;
const WORKER_GRACE_MS = 2 * MINUTE;
const STALE_RUN_MS = 6 * 60 * MINUTE;
const SOURCE_FRESH_MS = 10 * MINUTE;
const ROUTE_CACHE_MS = 24 * 60 * MINUTE;
const KEEP_CLOSED_MS = 7 * 24 * 60 * MINUTE;
const ADAPT_WAIT_MS = 2 * MINUTE;
const ADAPT_RETRY_MS = 10 * 1000;
const ADAPT_CHAT_CHARS = 40000;
const ADAPT_INSTRUCTIONS = `You are about to send a message in a project chat. It was written without seeing this conversation. Rewrite it as the message you send now.
- Keep every fact, decision, number, link, question and limitation in it. Add no new facts, and do not say you have done anything it does not say.
- Add only as much background as the user needs to recognise what it is about. If they asked recently and the conversation has not moved on, give it directly. If time has passed or the conversation moved on, say briefly what they asked for and why.
- If something recent in the conversation clearly relates to it, you may point that out or offer to look into it.
- A question must stay answerable as written. Explain any term the user has not used themselves.
- If the message already fits, return it unchanged.
Reply with the message text only.`;
const PREFERRED_ATTEMPTS = 3;
const FALLBACK_ATTEMPTS = 10;
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
// An open task is the lead's turn; a waiting task waits on the user.
const STATUSES = ['open', 'waiting', 'done', 'cancelled'];
const isClosed = (status) => status === 'done' || status === 'cancelled';
const STATUS_LINE = {
  open: 'open, your turn',
  waiting: 'waiting on the user',
  done: 'done',
  cancelled: 'cancelled',
};

// Reuse the native reader's alias precedence and target canonicalization.
const spawnAgentId = (params) => {
  const target = readStringParam(params ?? {}, 'agentId');
  if (!target) return undefined;
  const normalized = normalizeAgentIdStrict(target);
  return normalized.ok ? normalized.value : undefined;
};

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
function text(value, max, name) {
  assert(typeof value === 'string', `${name} must be text`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  assert(normalized, `${name} must not be empty`);
  assert(normalized.length <= max, `${name} must be at most ${max} characters`);
  assert(!CONTROL.test(normalized), `${name} must not contain control characters`);
  return normalized;
}
const line = (value, max, name) =>
  text(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, max, name);
const optional = (value, max, name) =>
  value === undefined || value === null || value === '' ? undefined : text(value, max, name);
// Files sent with a message: existing absolute paths, read again at each delivery attempt.
const MAX_FILES = 4;
const MAX_FILE_MB = 8;
const attachments = (value) => {
  if (value === undefined || value === null) return [];
  assert(
    Array.isArray(value) && value.length <= MAX_FILES,
    `attachments is a list of at most ${MAX_FILES} file paths`,
  );
  return value.map((path) => {
    assert(typeof path === 'string' && isAbsolute(path), 'Each attachment is an absolute path');
    let stat;
    try {
      stat = statSync(path);
    } catch {
      assert.fail(`Attachment not found: ${path}`);
    }
    assert(stat.isFile(), `Attachment is not a file: ${path}`);
    assert(stat.size <= MAX_FILE_MB * 1024 * 1024, `Attachment is over ${MAX_FILE_MB} MB: ${path}`);
    return path;
  });
};
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'project';

const conversation = (value) => {
  assert(
    value && /^conv_[a-f0-9]{30,64}$/.test(value.conversationRef ?? ''),
    'Native conversation reference required',
  );
  return {
    conversationRef: value.conversationRef,
    channel: String(value.channel ?? ''),
    accountId: String(value.accountId ?? 'default'),
    target: String(value.target ?? ''),
    kind: String(value.kind ?? ''),
    ...(value.threadId ? { threadId: String(value.threadId) } : {}),
  };
};
// The text a chat receives: the owner DM gets the project name first.
const sentText = (row, project, toOwner) => (toOwner ? `[${project.name}] ${row.text}` : row.text);
const chatLabel = (route) =>
  route
    ? `${route.channel} ${route.kind === 'direct' ? 'DM' : 'chat'} ${route.target}`
    : 'the owner DM (no project chat bound yet)';

// A native session row is working when its own turn is live (not a stale leftover) or,
// for workers, when descendants still run.
const rowLive = (row, now) =>
  row?.hasActiveRun === true && !(now - Number(row.updatedAt) > STALE_RUN_MS);
const rowBusy = (row, now) => rowLive(row, now) || row?.hasActiveSubagentRun === true;

export class BoardRuntime {
  constructor(
    store,
    rpc,
    {
      ownerChat = null,
      now = () => Date.now(),
      log = () => {},
      turnTimeoutSeconds = 1800,
      maxTaskSessions = 2,
      appendTranscript = async () => {
        throw new Error('Transcript append unavailable');
      },
      publishTranscript = async () => {},
      adapt = null,
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = {},
  ) {
    this.store = store;
    this.rpc = rpc;
    this.ownerChat = ownerChat;
    this.now = now;
    this.log = log;
    this.turnTimeoutSeconds = turnTimeoutSeconds;
    this.maxTaskSessions = maxTaskSessions;
    this.appendTranscript = appendTranscript;
    this.publishTranscript = publishTranscript;
    this.adapt = adapt; // ({system, message}) -> text, as the lead; null when unavailable
    this.sleep = sleep;
    this.sending = Promise.resolve(); // deliveries run one at a time
    this.sources = new Map(); // session -> newest inbound chat {route, at, used}
    this.turns = new Map(); // session -> the inbound chat of the running turn
    this.captures = new Map(); // session -> route resolution still in progress
    this.routeCache = new Map();
    this.wakes = new Map(); // session -> dispatch time (until the run shows up as live)
    this.deliveries = new Map(); // outbox id -> the whole in-flight attempt, including fallback
    this.seen = new Map(); // "session|task" -> newest note id read or written in this turn
    this.ownerRouteCache = null;
    this.stopped = false;
    this.health = { lastScan: null, lastError: null };
  }

  // ---- Who is calling, from where ----------------------------------------------------

  caller(ctx = {}) {
    const agentId = ctx.agentId ?? /^agent:([^:]+):/.exec(ctx.sessionKey ?? '')?.[1];
    assert(isLead(agentId), 'Only the lead uses the project board');
    const scope = parseTaskSession(ctx.sessionKey);
    let task = null;
    if (scope) {
      task = this.store.task(scope.taskId);
      assert(task.created === scope.created, 'This private session belongs to a removed task');
    } else assert(!isPrivateSession(ctx.sessionKey), 'This private session has no task');
    return {
      task,
      session: ctx.sessionKey ?? '',
      source: task ? null : (this.turns.get(ctx.sessionKey) ?? null),
    };
  }
  scopeProject(caller, id) {
    if (caller.task) {
      assert(
        id === undefined || id === caller.task.project,
        'A task session works only on its own project',
      );
      return this.store.project(caller.task.project);
    }
    if (id !== undefined) return this.store.project(id);
    const live = this.store.projects().filter((project) => project.state !== 'archived');
    const here = caller.source?.route
      ? live.filter(
          (project) => project.route?.conversationRef === caller.source.route.conversationRef,
        )
      : [];
    const candidates = here.length ? here : live;
    assert(
      candidates.length === 1,
      `Pass project: ${live.map((project) => `${project.id} (${project.name})`).join(', ') || 'no projects yet'}`,
    );
    return candidates[0];
  }
  scopeTask(caller, id) {
    if (id === undefined && caller.task) return this.store.task(caller.task.id);
    assert(id !== undefined, 'Pass task (the task number)');
    const task = this.store.task(id);
    assert(
      !caller.task || task.project === caller.task.project,
      'A task session works only on its own project',
    );
    return task;
  }
  // Whether the caller is talking in the chat where this project's messages go (its
  // project chat, or the owner DM for a project without one).
  inProjectChat(caller, project) {
    const here = caller.source?.route?.conversationRef;
    const there = project.route?.conversationRef ?? this.ownerRouteCache?.route?.conversationRef;
    return Boolean(here && there && here === there);
  }

  // ---- Operations --------------------------------------------------------------------

  async operation(operation, input = {}, ctx = {}) {
    const caller = this.caller(ctx);
    const handlers = {
      list: () => this.list(caller, input),
      show: () => this.show(caller, input),
      create_project: () => this.createProject(caller, input),
      update_project: () => this.updateProject(caller, input),
      add_task: () => this.addTask(caller, input),
      update_task: () => this.updateTask(caller, input),
      notify: () => this.notify(caller, input),
    };
    assert(handlers[operation], `Unknown operation ${operation}`);
    return handlers[operation]();
  }

  taskView(task, detail = false) {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.stalled ? { stalled: when(task.stalled) } : {}),
      updated: when(task.updated),
      ...(detail
        ? {
            project: task.project,
            body: task.body,
            ...(task.plan ? { plan: task.plan } : {}),
            workers: task.workers.map((worker) => worker.key),
            ...(task.check_at && task.status === 'open'
              ? { nextCheckIn: when(task.check_at) }
              : {}),
          }
        : {}),
    };
  }
  projectView(project) {
    const open = this.store.all(
      "SELECT * FROM tasks WHERE project=? AND status IN ('open','waiting') ORDER BY id",
      project.id,
    );
    const closed = this.store.all(
      "SELECT * FROM tasks WHERE project=? AND status IN ('done','cancelled') ORDER BY updated DESC LIMIT 3",
      project.id,
    );
    const failed = this.store.all(
      "SELECT id,task,text,error FROM outbox WHERE project=? AND state='failed' ORDER BY id DESC LIMIT 3",
      project.id,
    );
    return {
      id: project.id,
      name: project.name,
      state: project.state,
      chat: chatLabel(project.route),
      open: open.map((row) => this.taskView({ ...row, workers: [] })),
      recentlyClosed: closed.map((row) => ({ id: row.id, title: row.title, status: row.status })),
      ...(failed.length
        ? {
            undeliveredMessages: failed.map((row) => ({
              id: row.id,
              task: row.task,
              text: clip(row.text, 200),
              error: row.error,
            })),
          }
        : {}),
    };
  }
  list(caller, input) {
    const projects =
      input.project !== undefined || caller.task
        ? [this.scopeProject(caller, input.project)]
        : this.store.projects().filter((project) => project.state !== 'archived');
    return { projects: projects.map((project) => this.projectView(project)) };
  }
  show(caller, input) {
    if (input.task !== undefined || (caller.task && input.project === undefined)) {
      const task = this.scopeTask(caller, input.task);
      this.markSeen(caller.session, task.id);
      return {
        task: this.taskView(task, true),
        notes: this.store.notes(task.id).map((note) => ({
          at: when(note.created),
          text: note.text,
        })),
      };
    }
    const project = this.scopeProject(caller, input.project);
    return { project: { ...this.projectView(project), context: project.context } };
  }
  createProject(caller, input) {
    const name = line(input.name, 120, 'name');
    const context = optional(input.context, 8000, 'context') ?? '';
    const base = slug(name);
    let id = base;
    for (let n = 2; this.store.get('SELECT 1 FROM projects WHERE id=?', id); n++)
      id = `${base}-${n}`;
    const route = caller.source?.route
      ? { ...caller.source.route, sessionKey: caller.session }
      : null;
    const now = this.now();
    this.store.run(
      'INSERT INTO projects(id,name,context,route,created,updated) VALUES(?,?,?,?,?,?)',
      id,
      name,
      context,
      route ? JSON.stringify(route) : null,
      now,
      now,
    );
    return { project: id, name, chat: chatLabel(route) };
  }
  updateProject(caller, input) {
    const project = this.scopeProject(caller, input.project);
    assert(
      ['name', 'context', 'state', 'use_this_chat'].some((key) => input[key] !== undefined),
      'Pass name, context, state or use_this_chat',
    );
    const now = this.now();
    const changes = {};
    if (input.name !== undefined) changes.name = line(input.name, 120, 'name');
    if (input.context !== undefined) changes.context = String(input.context).trim().slice(0, 8000);
    if (input.use_this_chat) {
      const route = caller.source?.route;
      assert(
        route,
        'use_this_chat needs a current user message in a chat the plugin can reply to (not a private task session)',
      );
      changes.route = JSON.stringify({ ...route, sessionKey: caller.session });
    }
    if (input.state !== undefined) {
      assert(
        ['active', 'paused', 'archived'].includes(input.state),
        'state is active, paused or archived',
      );
      if (input.state === 'archived')
        assert(
          !this.store.get(
            "SELECT 1 FROM tasks WHERE project=? AND status IN ('open','waiting')",
            project.id,
          ),
          'Close or cancel the open tasks before archiving the project',
        );
      changes.state = input.state;
    }
    this.store.tx(() => {
      for (const [key, value] of Object.entries(changes))
        this.store.run(`UPDATE projects SET ${key}=?,updated=? WHERE id=?`, value, now, project.id);
      // Resuming a project wakes each open task to look again.
      if (changes.state === 'active' && project.state !== 'active')
        this.store.run(
          "UPDATE tasks SET poked=1,idle_wakes=0,stalled=NULL WHERE project=? AND status='open'",
          project.id,
        );
    });
    const updated = this.store.project(project.id);
    this.requestTick();
    return {
      project: updated.id,
      name: updated.name,
      state: updated.state,
      chat: chatLabel(updated.route),
    };
  }
  // A new task is the lead's turn and wakes its task session at once.
  addTask(caller, input) {
    const project = this.scopeProject(caller, input.project);
    assert(project.state !== 'archived', 'The project is archived');
    const title = line(input.title, 200, 'title');
    const body = optional(input.body, 8000, 'body') ?? '';
    const now = this.now();
    const id = Number(
      this.store.run(
        'INSERT INTO tasks(project,title,body,poked,check_at,created,updated) VALUES(?,?,?,1,?,?,?)',
        project.id,
        title,
        body,
        now + CHECK_IN_MINUTES * MINUTE,
        now,
        now,
      ).lastInsertRowid,
    );
    this.markSeen(caller.session, id);
    this.requestTick();
    return { task: id, project: project.id, status: 'open' };
  }
  async updateTask(caller, input) {
    const task = this.scopeTask(caller, input.task);
    const lastNote = this.latestNote(task.id);
    const project = this.store.project(task.project);
    const note = optional(input.note, 4000, 'note');
    const message = optional(input.message, 4000, 'message');
    const files = attachments(input.attachments);
    assert(!files.length || message !== undefined, 'attachments are sent with a message');
    // The task's working plan: free text, replaced as a whole; an empty plan clears it.
    const plan =
      input.plan === undefined || input.plan === null
        ? undefined
        : (optional(input.plan, 4000, 'plan') ?? '');
    const status = input.status;
    assert(
      [note, message, status, input.check_in_minutes, plan].some((value) => value !== undefined),
      'Pass note, status, message, check_in_minutes or plan',
    );
    assert(
      status === undefined || STATUSES.includes(status),
      'status is open, waiting, done or cancelled',
    );
    if (isClosed(task.status)) {
      assert(status === 'open', `Task #${task.id} is ${task.status}; reopen it with status open`);
      assert(project.state !== 'archived', 'The project is archived');
    }
    const changing = status !== undefined && status !== task.status;
    if (changing) {
      assert(note, 'Changing the status needs a note: the result, the question or the reason');
      // Decisions are made on the latest state: another session may have changed the
      // task since this one read it in this turn.
      const seen = this.seen.get(`${caller.session}|${task.id}`);
      assert(
        seen === undefined || seen >= (lastNote?.id ?? 0),
        `Task #${task.id} changed since you read it${lastNote ? ` (latest note: ${clip(lastNote.text, 300)})` : ''}; read it with show, then decide again`,
      );
    }
    // Required messages travel with the change that requires them. In the project chat
    // the reply is the message; sending it too would say it twice.
    const inChat = this.inProjectChat(caller, project);
    if (changing && (status === 'waiting' || isClosed(status)) && !message && !inChat)
      assert.fail(
        `${status === 'waiting' ? 'Asking the user' : 'Closing a task'} needs message: the text the user receives in ${chatLabel(project.route)}`,
      );
    let checkIn;
    if (input.check_in_minutes !== undefined) {
      checkIn = Number(input.check_in_minutes);
      assert(
        Number.isInteger(checkIn) && checkIn >= 10 && checkIn <= 10080,
        'check_in_minutes is 10 to 10080',
      );
    }
    if (changing && status === 'done') {
      const live = await this.liveWorkers(task);
      assert(
        !live.length,
        `Task #${task.id} still has ${live.length} running worker(s); wait for them to finish or cancel the task`,
      );
      // The task may have changed, or gained a worker, while the workers were checked.
      assert(
        this.taskUnchanged(task, lastNote?.id ?? 0) &&
          this.store.task(task.id).workers.length === task.workers.length,
        `Task #${task.id} changed while its workers were checked; read it with show, then decide again`,
      );
    }
    const now = this.now();
    const next = status ?? task.status;
    // A change from any other session (the project chat, another task) wakes the task's
    // own session. Only that session acting, or a new status, answers the wakes it was
    // sent; another session's change to a stalled task gets it one more wake before the
    // stall is reported again.
    const own = caller.task?.id === task.id;
    const outbox = this.store.tx(() => {
      if (note) this.store.note(task.id, note);
      this.store.run(
        `UPDATE tasks SET status=?,plan=COALESCE(?,plan),poked=?,check_at=?,
           idle_wakes=CASE WHEN ? THEN 0 WHEN stalled IS NOT NULL THEN ? ELSE idle_wakes END,stalled=NULL,cleaned=CASE WHEN ? THEN NULL ELSE cleaned END,updated=? WHERE id=?`,
        next,
        plan ?? null,
        own ? 0 : 1,
        next === 'cancelled'
          ? now + WAKE_RETRY_MINUTES * MINUTE
          : next === 'done'
            ? null
            : now + (checkIn ?? CHECK_IN_MINUTES) * MINUTE,
        own || changing ? 1 : 0,
        STALL_WAKES - 1,
        isClosed(task.status) ? 1 : 0,
        now,
        task.id,
      );
      return message && !inChat ? this.store.enqueue(project.id, task.id, message, files) : null;
    });
    this.markSeen(caller.session, task.id);
    if (changing && status === 'cancelled') await this.abortWorkers(this.store.task(task.id));
    const delivery = outbox ? await this.deliver(outbox, true) : undefined;
    this.requestTick();
    return {
      task: task.id,
      status: next,
      ...(delivery ? { message: delivery } : {}),
      ...(message && inChat
        ? {
            message: {
              state: 'not sent',
              reason: `you are in the project chat; say it in your reply${files.length ? ' with the files attached' : ''}`,
            },
          }
        : {}),
    };
  }
  async notify(caller, input) {
    const project = this.scopeProject(caller, input.project);
    const message = text(input.message ?? input.text, 4000, 'message');
    const files = attachments(input.attachments);
    let taskId = null;
    if (input.task !== undefined || caller.task) {
      const task = this.scopeTask(caller, input.task);
      assert(task.project === project.id, 'That task belongs to another project');
      taskId = task.id;
    }
    if (this.inProjectChat(caller, project))
      return {
        message: { state: 'not sent', reason: 'you are in the project chat; say it in your reply' },
      };
    const id = this.store.enqueue(project.id, taskId, message, files);
    return { notification: id, ...(await this.deliver(id, true)) };
  }

  // ---- Delivery ----------------------------------------------------------------------

  async ownerRoute() {
    if (this.ownerRouteCache && this.now() - this.ownerRouteCache.at < ROUTE_CACHE_MS)
      return this.ownerRouteCache.route;
    const owner = this.ownerChat;
    assert(owner, 'No ownerChat is configured');
    const result = await this.rpc('conversations.list', {
      agentId: topology().leadAgentId,
      query: owner.to,
      channel: owner.channel,
      limit: 100,
    });
    const matches = (result?.conversations ?? []).filter(
      (route) =>
        route.channel === owner.channel &&
        route.accountId === owner.accountId &&
        route.target === owner.to &&
        route.kind === 'direct' &&
        String(route.threadId ?? '') === String(owner.threadId ?? ''),
    );
    assert.equal(matches.length, 1, 'The owner DM is unavailable or ambiguous');
    this.ownerRouteCache = { route: conversation(matches[0]), at: this.now() };
    return this.ownerRouteCache.route;
  }
  // One delivery at a time, including its fallback, so a rewrite sees the messages sent
  // before it. `rewrite` is set for messages sent from the lead's turn.
  deliver(id, rewrite = false) {
    if (this.deliveries.has(id)) return this.deliveries.get(id);
    const pending = this.sending
      .then(() => this.deliverAttempt(id, rewrite))
      .finally(() => this.deliveries.delete(id));
    this.sending = pending.catch(() => {});
    this.deliveries.set(id, pending);
    return pending;
  }
  // Before its first send to the project chat, the lead rewrites a message for the
  // conversation it lands in, given that chat since the task's request, the task and the
  // message as written. The model call runs within the lead's turn that sent the message,
  // because OpenClaw admits new work only from running work; the scan's own deliveries go
  // out as written. While the chat is mid-reply, or changed during the rewrite, it waits and
  // tries again, for at most ADAPT_WAIT_MS. Any failure sends the message as written.
  async adaptToChat(row, project, route) {
    const waitedOut = () => this.now() - row.created >= ADAPT_WAIT_MS;
    try {
      for (;;) {
        const session = await this.chatSession(route);
        if (!session) return;
        if (rowLive(session, this.now()) && !waitedOut()) {
          await this.sleep(ADAPT_RETRY_MS);
          continue;
        }
        const history = await this.rpc('chat.history', {
          sessionKey: session.key,
          agentId: topology().leadAgentId,
          limit: 1000,
        });
        const task = row.task ? this.store.task(row.task) : null;
        const message = [
          `The project chat, oldest first (times UTC):\n${this.chatSince(history?.messages ?? [], task?.created) || '(no messages yet)'}`,
          ...(task ? [this.taskLines(task, project).join('\n')] : []),
          `The message to send:\n${row.text}`,
        ].join('\n\n');
        const adapted = text(
          await this.adapt({ system: ADAPT_INSTRUCTIONS, message }),
          4000,
          'message',
        );
        const after = await this.chatSession(route);
        if (
          (rowLive(after, this.now()) || after?.updatedAt !== session.updatedAt) &&
          !waitedOut()
        ) {
          await this.sleep(ADAPT_RETRY_MS);
          continue;
        }
        this.store.run('UPDATE outbox SET text=? WHERE id=?', adapted, row.id);
        row.text = adapted;
        return;
      }
    } catch (error) {
      this.log(`Project message ${row.id} sent as written: ${error?.message ?? error}`);
    }
  }
  // The chat's user and assistant text from the user's last message before `since` (the
  // request) to now. When that is long, the request and the newest messages are kept.
  chatSince(messages, since) {
    const chat = messages.flatMap((m) => {
      const said = (
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? [])
              .filter((b) => b?.type === 'text')
              .map((b) => b.text)
              .join('\n')
      ).trim();
      return ['user', 'assistant'].includes(m.role) && said
        ? [
            {
              user: m.role === 'user',
              at: Number(m.timestamp),
              text: `[${when(Number(m.timestamp))}] ${m.role === 'user' ? 'User' : 'You'}: ${clip(said, 4000)}`,
            },
          ]
        : [];
    });
    const start = since === undefined ? -1 : chat.findLastIndex((m) => m.user && m.at <= since);
    const head = start >= 0 ? [chat[start].text] : [];
    const rest = chat.slice(start + 1);
    let room = ADAPT_CHAT_CHARS - (head[0]?.length ?? 0);
    let first = rest.length;
    while (first > 0 && rest[first - 1].text.length <= room) room -= rest[--first].text.length;
    return [
      ...head,
      ...(first ? [`[${first} earlier messages left out]`] : []),
      ...rest.slice(first).map((m) => m.text),
    ].join('\n');
  }
  // One attempt for one outbox row. "sent" and "queued" hand the message to OpenClaw's own
  // durable delivery; the same operation id never sends twice. The project chat is tried
  // first, then the owner DM (prefixed with the project name); the route is never rebound.
  // Once the text is accepted the message is delivered and never falls back: attached
  // files follow as native message sends to the same chat, each with its own idempotency
  // key, and failed files are retried there. A delivered message is then added to the
  // session of the chat it reached.
  async deliverAttempt(id, rewrite = false) {
    const row = this.store.get('SELECT * FROM outbox WHERE id=?', id);
    if (!row || row.state !== 'pending') return row ? { state: row.state } : undefined;
    const project = this.store.project(row.project);
    const toOwner = row.fallback === 1 || !project.route;
    const operation = `crew-${row.id}-${toOwner ? 'owner' : 'project'}`;
    let receipt = row.receipt ? JSON.parse(row.receipt) : null;
    let status = receipt?.status;
    let error, route;
    try {
      route = toOwner ? await this.ownerRoute() : project.route;
      if (rewrite && !receipt && !toOwner && !row.attempts && this.adapt)
        await this.adaptToChat(row, project, route);
      if (!receipt) {
        const sent = await this.rpc('conversations.send', {
          agentId: topology().leadAgentId,
          operationId: operation,
          conversationRef: route.conversationRef,
          message: sentText(row, project, toOwner),
        });
        status = sent?.status;
        if (status === 'sent' || status === 'queued') {
          receipt = sent;
          this.store.run('UPDATE outbox SET receipt=? WHERE id=?', JSON.stringify(sent), row.id);
        }
      }
      if (receipt)
        for (const [index, path] of JSON.parse(row.files).entries())
          await this.rpc('message.action', {
            channel: route.channel,
            action: 'send',
            accountId: route.accountId,
            agentId: topology().leadAgentId,
            params: {
              to: route.target,
              ...(route.threadId ? { threadId: route.threadId } : {}),
              buffer: readFileSync(path).toString('base64'),
              filename: basename(path),
            },
            idempotencyKey: `${operation}-file-${index + 1}`,
          });
    } catch (failure) {
      error = String(failure?.message ?? failure)
        .split('\n')[0]
        .slice(0, 300);
    }
    const to = toOwner ? 'owner DM' : chatLabel(project.route);
    const attempts = row.attempts + 1;
    if (receipt && (!error || attempts >= FALLBACK_ATTEMPTS)) {
      this.store.run(
        "UPDATE outbox SET state='handed',error=?,attempts=? WHERE id=?",
        error ? `Attachments not delivered: ${error}` : null,
        attempts,
        row.id,
      );
      if (error) this.log(`Project message ${row.id} attachments not delivered: ${error}`);
      await this.record(row.id);
      return {
        state: status,
        to,
        ...(error ? { error: `Attachments not delivered: ${error}` } : {}),
      };
    }
    if (receipt) {
      this.store.run(
        'UPDATE outbox SET attempts=?,error=?,next_at=? WHERE id=?',
        attempts,
        error,
        this.now() + Math.min(2 ** attempts, 60) * MINUTE,
        row.id,
      );
      return { state: status, to, error: `Attachments not delivered yet, retrying: ${error}` };
    }
    error ??=
      status === 'suppressed'
        ? 'The chat rejected the message'
        : `Delivery ${status ?? 'unconfirmed'}`;
    if (!toOwner && (status === 'suppressed' || attempts >= PREFERRED_ATTEMPTS)) {
      this.store.run(
        'UPDATE outbox SET fallback=1,attempts=0,next_at=?,error=? WHERE id=?',
        this.now(),
        error,
        row.id,
      );
      return this.deliverAttempt(row.id);
    }
    const failed = status === 'suppressed' || attempts >= FALLBACK_ATTEMPTS;
    this.store.run(
      'UPDATE outbox SET state=?,attempts=?,error=?,next_at=? WHERE id=?',
      failed ? 'failed' : 'pending',
      attempts,
      error,
      this.now() + Math.min(2 ** attempts, 60) * MINUTE,
      row.id,
    );
    if (failed) this.log(`Project message ${row.id} could not be delivered: ${error}`);
    return { state: failed ? 'failed' : 'retrying', error };
  }

  // The lead's session for a chat, when exactly one matches.
  async chatSession(route) {
    const sessions = (
      await this.sessionRows(topology().leadAgentId, route.target.replace(/^[^:]+:/, ''))
    ).filter(
      ({ deliveryContext: to }) =>
        to?.channel === route.channel &&
        to.to === route.target &&
        (to.accountId ?? 'default') === route.accountId &&
        String(to.threadId ?? '') === String(route.threadId ?? ''),
    );
    return sessions.length === 1 ? sessions[0] : null;
  }
  // A delivered message becomes the lead's own reply in its session for the chat
  // it reached (the project chat or the owner DM), as text plus a MEDIA line per file, so
  // that chat's history and what the model reads next turn match the chat. It waits while
  // that session runs a turn; the scan retries for a day. Failures never affect delivery.
  async record(id) {
    const row = this.store.get('SELECT * FROM outbox WHERE id=?', id);
    if (row.recorded) return;
    const project = this.store.project(row.project);
    const toOwner = row.fallback === 1 || !project.route;
    try {
      const route = toOwner ? await this.ownerRoute() : project.route;
      const agentId = topology().leadAgentId;
      const session = await this.chatSession(route);
      if (!session?.sessionId || rowLive(session, this.now())) return;
      const files = JSON.parse(row.files).map((path) => `MEDIA:${path}`);
      const text = [sentText(row, project, toOwner), ...(files.length ? ['', ...files] : [])];
      // OpenClaw's own transcript writer. Its SDK subpath is JavaScript-only and labelled
      // private-local ("Private-local after July 2026" in docs/plugins/sdk-subpaths.md), so a
      // host update may change or remove it: before raising the pinned OpenClaw version, check
      // that appendSessionTranscriptMessageByIdentity still appends a model-visible assistant
      // message (only provider "openclaw" with model "gateway-injected" or "delivery-mirror" is
      // display-only) and run the native test lane, which checks the export.
      const result = await this.appendTranscript({
        agentId,
        sessionKey: session.key,
        sessionId: session.sessionId,
        idempotencyLookup: 'scan-assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: text.join('\n') }],
          api: 'crew',
          provider: 'crew',
          model: 'project-board',
          usage: ZERO_USAGE,
          stopReason: 'stop',
          timestamp: row.created,
          idempotencyKey: `crew-${row.id}-chat`,
        },
      });
      this.store.run('UPDATE outbox SET recorded=1 WHERE id=?', row.id);
      if (result?.messageId)
        await this.publishTranscript({
          agentId,
          sessionKey: session.key,
          sessionId: session.sessionId,
          update: { messageId: result.messageId },
        });
    } catch (error) {
      this.log(
        `Project message ${row.id} not added to the chat session: ${error?.message ?? error}`,
      );
    }
  }

  // ---- Native session facts ----------------------------------------------------------

  async sessionRows(agentId, search, extra = {}) {
    const result = await this.rpc('sessions.list', { agentId, search, limit: 200, ...extra });
    assert(Array.isArray(result?.sessions), 'Session list unavailable');
    return result.sessions;
  }
  async liveWorkers(task) {
    const live = [];
    for (const worker of task.workers) {
      if (this.now() - worker.at < WORKER_GRACE_MS) {
        live.push(worker.key);
        continue;
      }
      const agentId = /^agent:([^:]+):/.exec(worker.key)?.[1];
      const rows = await this.sessionRows(agentId, worker.key);
      if (
        rowBusy(
          rows.find((row) => row.key === worker.key),
          this.now(),
        )
      )
        live.push(worker.key);
    }
    return live;
  }
  // Workers launched from task sessions that are running now,
  // whatever their task's status, plus ones recorded too recently for the list to show.
  async runningBoardWorkers() {
    const { workerAgentId } = topology();
    const running = new Set();
    for (let offset = 0; ;) {
      const result = await this.rpc('sessions.list', {
        agentId: workerAgentId,
        limit: 200,
        offset,
      });
      assert(Array.isArray(result?.sessions), 'Worker session list unavailable');
      for (const session of result.sessions)
        if (rowLive(session, this.now()) && parseTaskSession(session.spawnedBy))
          running.add(session.key);
      if (!result.hasMore || !(result.nextOffset > offset)) break;
      offset = result.nextOffset;
    }
    for (const row of this.store.all("SELECT workers FROM tasks WHERE workers<>'[]'"))
      for (const worker of JSON.parse(row.workers))
        if (
          worker.key.startsWith(`agent:${workerAgentId}:`) &&
          this.now() - worker.at < WORKER_GRACE_MS
        )
          running.add(worker.key);
    return running.size;
  }
  // Stops a cancelled task's workers. Returns true once each is confirmed stopped: its
  // session is idle or gone after the spawn grace. Unconfirmed stops are retried by the scan.
  async abortWorkers(task) {
    let stopped = true;
    for (const worker of task.workers) {
      const key = worker.key;
      let session;
      try {
        session = (await this.sessionRows(/^agent:([^:]+):/.exec(key)?.[1], key)).find(
          (row) => row.key === key,
        );
      } catch (error) {
        stopped = false;
        this.log(
          `Worker ${key} stop unconfirmed: ${String(error?.message ?? error).slice(0, 200)}`,
        );
        continue;
      }
      if (this.now() - worker.at >= WORKER_GRACE_MS && !rowBusy(session, this.now())) continue;
      stopped = false;
      if (this.store.task(task.id).status !== 'cancelled') return false;
      // clearQueued also drops follow-ups already queued for the worker.
      await this.rpc('sessions.abort', { key, clearQueued: true }).catch((error) =>
        this.log(`Could not stop worker ${key}: ${String(error?.message ?? error).slice(0, 200)}`),
      );
    }
    if (stopped)
      this.store.run("UPDATE tasks SET check_at=NULL WHERE id=? AND status='cancelled'", task.id);
    return stopped;
  }
  recordWorker(sessionKey, childSessionKey) {
    const scope = parseTaskSession(sessionKey);
    if (!scope || typeof childSessionKey !== 'string' || !childSessionKey.startsWith('agent:'))
      return;
    const task = this.store.task(scope.taskId);
    if (task.workers.some((worker) => worker.key === childSessionKey)) return;
    // A worker that appears after its task was cancelled is stopped by the next scan.
    this.store.run(
      "UPDATE tasks SET workers=?,idle_wakes=0,check_at=CASE WHEN status='cancelled' THEN ? ELSE check_at END WHERE id=?",
      JSON.stringify([...task.workers, { key: childSessionKey, at: this.now() }]),
      this.now(),
      task.id,
    );
    if (task.status === 'cancelled') this.requestTick();
  }

  // ---- Hook support (private sessions and project chats only) -----------------------

  // Remembers the chat of the lead's newest inbound message (resolved to a native
  // conversation the lead can send to).
  captureInbound(sessionKey, agentId, raw) {
    if (!sessionKey || isPrivateSession(sessionKey) || !isLead(agentId)) return;
    const at = this.now();
    const pending = this.resolveRoute(agentId, raw)
      .catch(() => null)
      .then((route) => {
        this.sources.set(sessionKey, { route, at, used: false });
        if (route) this.followChatSession(sessionKey, route);
      });
    this.captures.set(sessionKey, pending);
    return pending.finally(() => {
      if (this.captures.get(sessionKey) === pending) this.captures.delete(sessionKey);
    });
  }
  // The session OpenClaw routed a message in a project's own chat to is that chat's
  // session; a project records it again when it changed (reset scope, deleted session).
  // Messages in any other chat leave the project untouched.
  followChatSession(sessionKey, route) {
    try {
      for (const project of this.store.projects())
        if (
          project.route?.conversationRef === route.conversationRef &&
          project.route.sessionKey !== sessionKey
        )
          this.store.run(
            'UPDATE projects SET route=? WHERE id=?',
            JSON.stringify({ ...project.route, sessionKey }),
            project.id,
          );
    } catch (error) {
      this.log(
        `Project chat session not recorded: ${String(error?.message ?? error).slice(0, 200)}`,
      );
    }
  }
  async resolveRoute(agentId, raw) {
    const clean = (value) => {
      let v = String(value ?? '');
      if (v.startsWith(`${raw.channel}:`)) v = v.slice(raw.channel.length + 1);
      if (raw.channel === 'discord') v = v.replace(/^(channel|user):/, '');
      return v.replace(/:topic:.+$/, '');
    };
    const target = clean(raw.conversationId);
    const cacheKey = `${agentId}|${raw.channel}|${raw.accountId}|${target}|${raw.threadId ?? ''}`;
    const cached = this.routeCache.get(cacheKey);
    if (cached && this.now() - cached.at < ROUTE_CACHE_MS) return cached.route;
    const result = await this.rpc('conversations.list', { agentId, query: target, limit: 100 });
    const matches = (result?.conversations ?? []).filter(
      (c) =>
        c.channel === raw.channel &&
        c.accountId === raw.accountId &&
        clean(c.target) === target &&
        String(c.threadId ?? '') === String(raw.threadId ?? ''),
    );
    const route = matches.length === 1 ? conversation(matches[0]) : null;
    if (route) this.routeCache.set(cacheKey, { route, at: this.now() });
    return route;
  }
  // The running turn keeps the chat of the message that started it, even if a newer
  // message arrives meanwhile. Turns without a new message (cron, heartbeat) get none.
  async beginTurn(sessionKey) {
    const pending = this.captures.get(sessionKey);
    if (pending)
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 5000).unref?.())]);
    const source = this.sources.get(sessionKey);
    if (source && !source.used && this.now() - source.at < SOURCE_FRESH_MS) {
      source.used = true;
      this.turns.set(sessionKey, source);
    } else this.turns.delete(sessionKey);
  }
  latestNote(taskId) {
    return this.store.notes(taskId, 1)[0];
  }
  // Whether anyone acted on the task since it was read. The scan's own bookkeeping
  // (woken, check_at, idle_wakes, poked) does not count.
  taskUnchanged(task, lastNote) {
    const current = this.store.task(task.id);
    return (
      ['status', 'updated'].every((field) => current[field] === task[field]) &&
      (this.latestNote(task.id)?.id ?? 0) === lastNote
    );
  }
  markSeen(sessionKey, taskId) {
    this.seen.set(`${sessionKey}|${taskId}`, this.latestNote(taskId)?.id ?? 0);
  }
  endTurn(sessionKey) {
    this.turns.delete(sessionKey);
    this.wakes.delete(sessionKey);
    for (const key of this.seen.keys()) if (key.startsWith(`${sessionKey}|`)) this.seen.delete(key);
  }
  // Project context for a chat that a project uses: which project, its context, and any
  // task waiting on the user. Nothing for other chats.
  chatContext(sessionKey) {
    const route = this.turns.get(sessionKey)?.route;
    if (!route) return null;
    const owner = this.ownerRouteCache?.route?.conversationRef === route.conversationRef;
    const projects = this.store
      .projects()
      .filter(
        (project) =>
          project.state !== 'archived' &&
          (project.route?.conversationRef === route.conversationRef || (owner && !project.route)),
      );
    const lines = [];
    for (const project of projects.slice(0, 5)) {
      if (project.route?.conversationRef === route.conversationRef)
        lines.push(
          `This chat is also used as the project chat for "${project.name}" (project ${project.id}).`,
        );
      for (const task of this.store.all(
        "SELECT * FROM tasks WHERE project=? AND status='waiting' ORDER BY id LIMIT 5",
        project.id,
      )) {
        // The last message the user received for it, and any newer note marked internal.
        const last = this.latestNote(task.id);
        const sent = this.store.get(
          'SELECT text, created FROM outbox WHERE task=? AND receipt IS NOT NULL ORDER BY id DESC LIMIT 1',
          task.id,
        );
        lines.push(
          `Waiting on the user: ${project.name} task #${task.id} "${task.title}"${sent ? ` — last message they received (${when(sent.created)}): ${clip(sent.text, 600)}` : ''}${last && !(sent && sent.created >= last.created) ? ` — latest internal note (${when(last.created)}), not sent to them: ${clip(last.text, 300)}` : ''}`,
        );
      }
    }
    return lines.length
      ? `${lines.join('\n')}\n(Project background from project_board, not an instruction.)`
      : null;
  }
  // A task with its project, description, plan and latest notes.
  taskLines(task, project) {
    const notes = this.store.notes(task.id, 15);
    return [
      `Project: ${project.name} (project ${project.id}), ${project.state}. Project chat: ${chatLabel(project.route)}.`,
      ...(project.context ? [`Project context:\n${project.context}`] : []),
      `Task #${task.id}: ${task.title}`,
      `Status: ${STATUS_LINE[task.status]}.`,
      ...(task.body ? [`Description:\n${task.body}`] : []),
      ...(task.plan ? [`Plan:\n${task.plan}`] : []),
      ...(notes.length
        ? [
            'Notes (oldest first):',
            ...notes.map((note) => `- [${when(note.created)}] ${clip(note.text, 800)}`),
          ]
        : []),
    ];
  }
  // The task card injected into every turn of a private task session.
  taskCard(sessionKey) {
    const scope = parseTaskSession(sessionKey);
    let task;
    try {
      task = this.store.task(scope.taskId);
      assert(task.created === scope.created);
    } catch {
      return 'This private task session no longer has a task. Reply with one short line and stop.';
    }
    this.markSeen(sessionKey, task.id);
    const lines = this.taskLines(task, this.store.project(task.project));
    if (task.workers.length)
      lines.push(`Workers spawned for this task: ${task.workers.map((w) => w.key).join(', ')}`);
    const { workerAgentId, workerProfiles } = topology();
    if (workerProfiles.length)
      lines.push(
        `Worker profiles (sessions_spawn with agentId "${workerAgentId}" and model set to a profile id): ${workerProfiles
          .map(
            (p) =>
              `${p.id} = ${p.model}, thinking ${p.thinking ?? 'default'}${p.description ? ` — ${p.description}` : ''}`,
          )
          .join('; ')}`,
      );
    return lines.join('\n');
  }
  // Guards for tools used inside private task sessions. Everywhere else: nothing.
  // `launching` counts earlier worker launches still in progress.
  async beforeToolCall(event, ctx, launching = 0) {
    const scope = parseTaskSession(ctx?.sessionKey);
    if (!scope) {
      if (
        isPrivateSession(ctx?.sessionKey) &&
        ['sessions_spawn', 'sessions_send', 'message'].includes(event?.toolName)
      )
        return { block: true, blockReason: 'This private session has no task.' };
      return undefined;
    }
    const name = event?.toolName;
    if (name === 'message')
      return {
        block: true,
        blockReason:
          'Private task session: the user is reached through project_board (a message on update_task, or notify).',
      };
    if (name !== 'sessions_spawn' && name !== 'sessions_send') return undefined;
    let task, project;
    try {
      task = this.store.task(scope.taskId);
      assert(task.created === scope.created);
      project = this.store.project(task.project);
    } catch {
      return { block: true, blockReason: 'This private session has no task.' };
    }
    if (isClosed(task.status))
      return { block: true, blockReason: `Task #${task.id} is ${task.status}.` };
    const params = event.params ?? {};
    if (name === 'sessions_send') {
      if (task.workers.some((worker) => worker.key === params.sessionKey)) return undefined;
      return {
        block: true,
        blockReason:
          'From a task session, sessions_send may only reach this task’s own workers (by sessionKey).',
      };
    }
    if (project.state !== 'active')
      return {
        block: true,
        blockReason: `Project ${project.name} is ${project.state}; no new workers.`,
      };
    const { workerAgentId, workerProfiles, workerRuntime, workerLimit } = topology();
    if (spawnAgentId(params) !== workerAgentId || !workerProfiles.length) return undefined;
    const profile =
      workerProfiles.find((p) => p.id === params.model) ??
      workerProfiles.find(
        (p) =>
          p.model === params.model && (p.thinking ?? undefined) === (params.thinking ?? undefined),
      );
    if (!profile)
      return {
        block: true,
        blockReason: `Set model to a worker profile id: ${workerProfiles.map((p) => p.id).join(', ')}.`,
      };
    const running = (await this.runningBoardWorkers()) + launching;
    if (running >= workerLimit)
      return {
        block: true,
        blockReason: `${running} workers are already running or starting (limit ${workerLimit}); wait for one to finish.`,
      };
    return {
      params: {
        ...params,
        agentId: workerAgentId,
        model: profile.model,
        ...(profile.thinking ? { thinking: profile.thinking } : {}),
        runtime: workerRuntime,
      },
    };
  }
  // Runs in private sessions whose task is closed or gone are refused.
  allowRun(sessionKey) {
    if (!isPrivateSession(sessionKey)) return true;
    const scope = parseTaskSession(sessionKey);
    const task =
      scope && this.store.get('SELECT status,created FROM tasks WHERE id=?', scope.taskId);
    if (!task || task.created !== scope.created) return false;
    if (!isClosed(task.status)) return true;
    // A late native turn recreated a closed task's session; the next scan removes it again.
    this.store.run('UPDATE tasks SET cleaned=NULL WHERE id=?', scope.taskId);
    this.requestTick();
    return false;
  }

  // ---- The scan ----------------------------------------------------------------------

  requestTick() {
    if (this.stopped || this.tickRequested) return;
    this.tickRequested = true;
    setTimeout(() => {
      this.tickRequested = false;
      this.tick().catch((error) => this.log(`Project scan failed: ${error?.message ?? error}`));
    }, 2000).unref?.();
  }
  async tick() {
    if (this.stopped || this.ticking) return { skipped: true };
    this.ticking = true;
    const summary = { delivered: 0, woken: [], stalled: [], cleaned: 0 };
    this.scanProblem = null;
    try {
      if (!this.ownerRouteCache && this.ownerChat)
        await this.ownerRoute().catch((error) =>
          this.log(`Owner DM unresolved: ${error?.message ?? error}`),
        );
      for (const row of this.store.all(
        "SELECT id FROM outbox WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 20",
        this.now(),
      )) {
        const result = await this.deliver(row.id);
        if (result?.state === 'sent' || result?.state === 'queued') summary.delivered++;
      }
      for (const row of this.store.all(
        "SELECT id FROM outbox WHERE state='handed' AND recorded=0 AND created>=? ORDER BY id LIMIT 20",
        this.now() - 24 * 60 * MINUTE,
      ))
        await this.record(row.id);
      // A cancelled task's check_at is the next try at stopping its workers; abortWorkers
      // clears it once all are stopped. Ten oldest first, each moved on before the try,
      // so failures cannot starve later rows.
      for (const row of this.store.all(
        "SELECT id FROM tasks WHERE status='cancelled' AND workers<>'[]' AND check_at<=? ORDER BY check_at,id LIMIT 10",
        this.now(),
      )) {
        this.store.run(
          'UPDATE tasks SET check_at=? WHERE id=?',
          this.now() + WAKE_RETRY_MINUTES * MINUTE,
          row.id,
        );
        await this.abortWorkers(this.store.task(row.id));
      }
      await this.wakeDue(summary);
      summary.cleaned = await this.cleanupClosed();
      this.health.lastScan = this.now();
      this.health.lastError = this.scanProblem?.slice(0, 300) ?? null;
    } catch (error) {
      this.health.lastError = String(error?.message ?? error).slice(0, 300);
      throw error;
    } finally {
      this.ticking = false;
    }
    return summary;
  }
  async wakeDue(summary) {
    const now = this.now();
    const due = this.store.all(
      `SELECT t.* FROM tasks t JOIN projects p ON p.id=t.project
       WHERE t.status='open' AND p.state='active' AND t.stalled IS NULL AND (t.poked=1 OR t.check_at<=?)
       ORDER BY t.updated`,
      now,
    );
    const notes = new Map(due.map((task) => [task.id, this.latestNote(task.id)?.id ?? 0]));
    for (const [session, at] of this.wakes)
      if (now - at >= WAKE_GRACE_MS) this.wakes.delete(session);
    if (!due.length) return;
    // One list shows which task sessions are mid-turn.
    let live;
    try {
      live = new Set(
        (await this.sessionRows(topology().leadAgentId, `${topology().sessionNamespace}:task-`))
          .filter((row) => rowLive(row, now))
          .map((row) => row.key),
      );
    } catch (error) {
      const problem = `Cannot see the task sessions: ${error?.message ?? error}`;
      this.scanProblem ??= problem;
      this.log(problem);
      return;
    }
    for (const row of due) {
      const task = { ...row, workers: JSON.parse(row.workers) };
      const lastNote = notes.get(task.id);
      const key = taskSessionKey(task);
      if (this.wakes.has(key) || live.has(key)) continue;
      const running = live.size + [...this.wakes.keys()].filter((k) => !live.has(k)).length;
      if (running >= this.maxTaskSessions) continue;
      const poked = task.poked === 1;
      let workers = 0;
      try {
        workers = (await this.liveWorkers(task)).length;
      } catch {
        workers = task.workers.length;
      }
      if (!this.taskUnchanged(task, lastNote)) continue;
      if (task.idle_wakes >= STALL_WAKES) {
        await this.reportStall(task);
        summary.stalled.push(task.id);
        continue;
      }
      if (await this.wake(task, key, poked, workers, lastNote)) {
        live.add(key);
        summary.woken.push(task.id);
      }
    }
  }
  // A private task session runs on the model and thinking level the user chose in the
  // project chat, or on the agent's defaults when the chat has none. Fails open.
  async followChatModel(task, key) {
    const { leadAgentId } = topology();
    const chatKey = this.store.project(task.project).route?.sessionKey;
    try {
      const row = chatKey
        ? (await this.sessionRows(leadAgentId, chatKey)).find(
            (candidate) => candidate.key === chatKey,
          )
        : null;
      const chosen = row?.modelOverrideSource === 'user' && row.model;
      // Two calls: the companion sends the model with write scope only, so the choice
      // never becomes a configured default; the thinking level needs admin scope.
      const target = { key, agentId: leadAgentId };
      await this.rpc('sessions.patch', {
        ...target,
        model: chosen
          ? row.modelProvider
            ? `${row.modelProvider}/${row.model}`
            : row.model
          : null,
      });
      await this.rpc('sessions.patch', { ...target, thinkingLevel: row?.thinkingLevel ?? null });
    } catch (error) {
      this.log(
        `Task #${task.id} runs on default settings: ${String(error?.message ?? error).slice(0, 200)}`,
      );
    }
  }
  async wake(task, key, poked, workers, lastNote) {
    const now = this.now();
    const agentId = topology().leadAgentId;
    this.wakes.set(key, now);
    const last = this.latestNote(task.id);
    const reason = poked
      ? last
        ? `Changed outside this session. Latest note: ${clip(last.text, 500)}`
        : 'New task.'
      : workers
        ? 'Scheduled check-in; workers are still running.'
        : 'Scheduled check-in.';
    try {
      await this.rpc('sessions.create', {
        key,
        agentId,
        label: clip(`Task #${task.id}: ${task.title}`, 80),
      }).catch(() => undefined);
      await this.followChatModel(task, key);
      try {
        await this.rpc('agent', {
          agentId,
          sessionKey: key,
          deliver: false,
          idempotencyKey: randomUUID(),
          timeout: this.turnTimeoutSeconds,
          message: `PROJECT TASK ${taskScope(task)}\n${reason}\nThe task card is in your context. Act with project_board; this reply is private. End with one short line on what you did.`,
        });
      } catch (error) {
        // A timed-out request may still have started the turn.
        const started = await this.sessionRows(agentId, key)
          .then((rows) =>
            rowLive(
              rows.find((row) => row.key === key),
              this.now(),
            ),
          )
          .catch(() => false);
        if (!started) throw error;
      }
    } catch (error) {
      // A wake that did not happen is tried again later and counts as unanswered, so a task
      // session that cannot be reached is reported like one that does not act. A change
      // made meanwhile keeps its own wake.
      this.wakes.delete(key);
      this.store.run('UPDATE tasks SET idle_wakes=idle_wakes+1 WHERE id=?', task.id);
      if (this.taskUnchanged(task, lastNote))
        this.store.run(
          'UPDATE tasks SET poked=0,check_at=? WHERE id=?',
          now + WAKE_RETRY_MINUTES * MINUTE,
          task.id,
        );
      const problem = `Could not wake task #${task.id}: ${String(error?.message ?? error).slice(0, 200)}`;
      this.log(problem);
      this.scanProblem ??= problem;
      return false;
    }
    // A change made during the dispatch keeps its own wake and check-in.
    if (this.taskUnchanged(task, lastNote))
      this.store.run(
        'UPDATE tasks SET check_at=?,idle_wakes=idle_wakes+?,poked=0 WHERE id=?',
        now + CHECK_IN_MINUTES * MINUTE,
        poked || !workers ? 1 : 0,
        task.id,
      );
    return true;
  }
  async reportStall(task) {
    const project = this.store.project(task.project);
    const last = this.latestNote(task.id);
    const message = `${project.name}: task #${task.id} "${task.title}" is stuck: its wake-ups went unanswered or could not be delivered.${last ? ` Latest note: ${clip(last.text, 500)}` : ''}`;
    const id = this.store.tx(() => {
      this.store.run('UPDATE tasks SET stalled=? WHERE id=?', this.now(), task.id);
      return this.store.enqueue(project.id, task.id, message);
    });
    await this.deliver(id);
  }
  // Private sessions of closed tasks are kept for a week so the work can be reviewed,
  // then deleted once nothing runs in them.
  async cleanupClosed() {
    let cleaned = 0;
    const { leadAgentId: agentId, sessionNamespace } = topology();
    for (const row of this.store.all(
      "SELECT * FROM tasks WHERE status IN ('done','cancelled') AND cleaned IS NULL AND updated<=? ORDER BY updated LIMIT 10",
      this.now() - KEEP_CLOSED_MS,
    )) {
      const sessionKey = taskSessionKey(row);
      try {
        const session = (await this.sessionRows(agentId, sessionKey, { archived: 'all' })).find(
          (candidate) => candidate.key === sessionKey,
        );
        if (session && rowBusy(session, this.now())) continue;
        // A task reopened meanwhile keeps its session.
        if (session && isClosed(this.store.task(row.id).status))
          await this.rpc('crew.session.cleanup', { agentId, sessionNamespace, sessionKey });
        cleaned += Number(
          this.store.run(
            "UPDATE tasks SET cleaned=? WHERE id=? AND status IN ('done','cancelled')",
            this.now(),
            row.id,
          ).changes,
        );
      } catch (error) {
        this.log(
          `Cleanup of ${sessionKey} deferred: ${String(error?.message ?? error).slice(0, 200)}`,
        );
      }
    }
    return cleaned;
  }
  healthReport() {
    const count = (sql) => this.store.get(sql).n;
    return {
      ...this.health,
      projects: count("SELECT COUNT(*) n FROM projects WHERE state<>'archived'"),
      openTasks: count("SELECT COUNT(*) n FROM tasks WHERE status IN ('open','waiting')"),
      stalledTasks: count(
        "SELECT COUNT(*) n FROM tasks WHERE status='open' AND stalled IS NOT NULL",
      ),
      pendingMessages: count("SELECT COUNT(*) n FROM outbox WHERE state='pending'"),
      failedMessages: count("SELECT COUNT(*) n FROM outbox WHERE state='failed'"),
    };
  }
}
