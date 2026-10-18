import assert from 'node:assert/strict';

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const NAMESPACE = /^[a-z][a-z0-9_-]{0,31}$/;
const PROFILE_ID = /^[a-z][a-z0-9_-]{0,31}$/;

// The lead and its workers. Configured once at registration; everything else asks here.
let current = Object.freeze({
  leadAgentId: 'lead',
  workerAgentId: 'worker',
  workerRuntime: 'acp',
  workerLimit: 2,
  sessionNamespace: 'crew',
  workerProfiles: Object.freeze([]),
});

export function configureTopology(input = {}) {
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
  };
  for (const key of ['leadAgentId', 'workerAgentId'])
    assert(AGENT_ID.test(next[key]), `Invalid ${key}`);
  assert(next.leadAgentId !== next.workerAgentId, 'The lead and worker agent IDs must differ');
  assert(NAMESPACE.test(next.sessionNamespace), 'Invalid sessionNamespace');
  assert(
    ['acp', 'subagent'].includes(next.workerRuntime),
    'worker.runtime must be acp or subagent',
  );
  assert(
    Number.isSafeInteger(next.workerLimit) && next.workerLimit >= 1 && next.workerLimit <= 20,
    'worker.limit must be 1 to 20',
  );
  assert(Array.isArray(next.workerProfiles), 'worker.profiles must be a list');
  next.workerProfiles = Object.freeze(
    next.workerProfiles.map((profile) => {
      assert(PROFILE_ID.test(profile?.id ?? ''), 'Invalid worker profile id');
      assert(typeof profile.model === 'string' && profile.model, 'Worker profile needs a model');
      return Object.freeze({ ...profile });
    }),
  );
  current = Object.freeze(next);
  return current;
}

export const topology = () => current;
export const isLead = (id) => id === current.leadAgentId;

// Private task sessions: agent:<lead>:<namespace>:task-<id>-<created base36>. The creation
// time makes a key unique to one registry row, even if a registry is ever recreated.
export const taskScope = (task) => `task-${task.id}-${Number(task.created).toString(36)}`;
export const taskSessionKey = (task) =>
  `agent:${current.leadAgentId}:${current.sessionNamespace}:${taskScope(task)}`;
export function parseTaskSession(key) {
  const match = /^agent:([^:]+):([^:]+):task-(\d+)-([0-9a-z]+)$/.exec(String(key ?? ''));
  if (!match || !isLead(match[1]) || match[2] !== current.sessionNamespace) return null;
  return { taskId: Number(match[3]), created: parseInt(match[4], 36) };
}
// Any session in the plugin's namespace (including stale ones whose task is gone).
export const isPrivateSession = (key) =>
  isLead(/^agent:([^:]+):/.exec(String(key ?? ''))?.[1]) &&
  String(key).split(':')[2] === current.sessionNamespace;
