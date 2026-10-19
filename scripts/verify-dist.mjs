import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import plugin from '../dist/index.js';
import { Store } from '../dist/store.js';

const tools = [],
  methods = [],
  services = [],
  hooks = [];
plugin.register({
  pluginConfig: {
    statePath: ':memory:',
    enabled: false,
    leadAgentId: 'lead',
    ownerChat: { channel: 'test', accountId: 'default', to: 'test:owner' },
    worker: { agentId: 'worker', profiles: [{ id: 'routine', model: 'provider/worker' }] },
  },
  logger: { warn() {} },
  registerTool(_factory, options) {
    tools.push(options.name);
  },
  registerGatewayMethod(name) {
    methods.push(name);
  },
  registerService(service) {
    services.push(service.id);
  },
  on(name) {
    hooks.push(name);
  },
});
assert.deepEqual(tools, ['project_board']);
assert.deepEqual(methods, ['crew.board.call', 'crew.board.tick', 'crew.board.health']);
assert.deepEqual(services, ['crew-board']);
assert(hooks.includes('before_tool_call') && hooks.includes('before_prompt_build'));
const store = new Store(':memory:');
assert.equal(store.get('PRAGMA user_version').user_version, 1);
store.close();
const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url)));
assert.deepEqual(manifest.skills, ['./skills']);
assert.deepEqual(manifest.contracts.tools, ['project_board']);
const skill = readFileSync(new URL('../skills/crew-lead/SKILL.md', import.meta.url), 'utf8');
assert.match(skill, /^name: crew-lead$/m);
const root = new URL('..', import.meta.url);
const packed = Object.values(
  JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  ),
)[0].files.map((file) => file.path);
const skillFiles = (dir) =>
  readdirSync(new URL(dir, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${dir}/${entry.name}/SKILL.md`);
assert.deepEqual(skillFiles('skills'), ['skills/crew-lead/SKILL.md']);
for (const file of [
  ...skillFiles('skills'),
  ...skillFiles('worker-skills'),
  'worker-skills/LICENSE-pstack',
])
  assert(packed.includes(file), `${file} is not packed`);
console.log('Compiled distribution verified');
