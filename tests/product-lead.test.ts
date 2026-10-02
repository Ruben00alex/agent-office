import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKER_ROLES, isWorkerRole } from '../src/shared/protocol.js';
import { PROMPTS, PROMPT_GROUPS, fillPrompt } from '../src/shared/prompts.js';
import { officePrompt } from '../src/server/prompts.js';

test('the Product Lead has an editable brief that talks and brainstorms, reads the repo and files issues only on request, without coding', () => {
  assert.ok(isWorkerRole('product-lead') && !isWorkerRole('nobody'));
  assert.equal(WORKER_ROLES['product-lead'].name, 'Product Lead');
  const def = PROMPTS['role.productLead'];
  assert.ok(def && PROMPT_GROUPS[def.group]);
  const brief = officePrompt(undefined, 'role.productLead');
  assert.equal(brief, fillPrompt(def.text, {}));
  assert.match(brief, /gh issue create/);
  assert.match(brief, /README\.md, docs\//);
  assert.match(brief, /thinking partner/);
  assert.match(brief, /only when the person asks/);
  assert.match(brief, /You don't write code/);
  assert.match(brief, /office-workers/);
});
