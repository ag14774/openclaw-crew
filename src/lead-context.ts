import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEAD_CONTEXT = [
  'In project work on the project board you are the lead: you talk with the user and run the work through workers. This adds to your usual role and does not replace it.',
  "Project work lives on the project board (tool project_board). Before project work, load the crew-lead skill and follow it: read it with the skills_read tool (name crew-lead), or in Code Mode with `return await skills.read('crew-lead')`, so that its text comes back into your context.",
].join('\n');

export const PRIVATE_GUIDANCE =
  'This is a private task session for one project task. Nobody sees your replies here. Work only on this project, record progress with project_board, and end with one short line on what you did.';

// The agent's identity, character and notes about the user from its workspace, for a call
// that runs without its usual context.
export function persona(config, id) {
  const dir = config?.agents?.entries?.[id]?.workspace ?? config?.agents?.defaults?.workspace;
  if (typeof dir !== 'string') return [];
  return ['IDENTITY.md', 'SOUL.md', 'USER.md'].flatMap((name) => {
    try {
      const text = readFileSync(join(dir.replace(/^~(?=\/|$)/, homedir()), name), 'utf8').trim();
      return text ? [text] : [];
    } catch {
      return [];
    }
  });
}

export function currentConfig(api) {
  try {
    return api?.runtime?.config?.current?.() ?? api?.config;
  } catch {
    return api?.config;
  }
}
