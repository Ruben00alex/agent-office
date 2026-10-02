import test from 'node:test';
import assert from 'node:assert/strict';
import { DESK_BY_ID, PRODUCT_DESK, STATION_AGENT } from '../src/shared/layout.js';
import { PROMPTS, PROMPT_GROUPS, fillPrompt } from '../src/shared/prompts.js';
import { officePrompt } from '../src/server/prompts.js';
import { stationBrief } from '../src/server/stations.js';
import { transcriptMessage } from '../src/server/maintenance-chat.js';

test('the Product Lead is a kiosk that is always there, not a desk to hire', () => {
  const seat = DESK_BY_ID.get(PRODUCT_DESK);
  assert.equal(seat?.station, 'product');
  assert.equal(STATION_AGENT.product.name, 'Product Lead');
});

test('its editable brief makes it a thinking partner that reads the repo, files issues only on request and does not code', () => {
  const def = PROMPTS['station.product'];
  assert.ok(def && PROMPT_GROUPS[def.group]);
  const brief = officePrompt(undefined, 'station.product');
  assert.equal(brief, fillPrompt(def.text, {}));
  assert.equal(stationBrief('product'), brief);
  assert.match(brief, /thinking partner/);
  assert.match(brief, /think out loud, brainstorm/);
  assert.match(brief, /README\.md, docs\//);
  assert.match(brief, /only an optional extra, when the person asks/);
  assert.match(brief, /gh issue create/);
  assert.match(brief, /You don't write code/);
  assert.doesNotMatch(brief, /task queue|office-queue/);
});

test('the chat shows only the first message typed to it, not its brief', () => {
  const first = { type: 'user', message: { role: 'user', content: `${stationBrief('product')}\n\nWhat if desks could be booked?` } };
  assert.equal(transcriptMessage(first)?.content, 'What if desks could be booked?');
});
