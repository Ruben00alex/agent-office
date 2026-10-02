import test from 'node:test';
import assert from 'node:assert/strict';
import { appServerPlanLimits } from '../src/server/codex-limits.js';

test('the Codex app server rate-limit answer becomes plan windows', () => {
  const answer = { rateLimits: { planType: 'plus',
    primary: { usedPercent: 49, windowDurationMins: 300, resetsAt: 1790965315 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791053618 } } };
  assert.deepEqual(appServerPlanLimits(answer, 5), { plan: 'plus', at: 5, windows: [
    { label: '5h session', pct: 49, resetsAt: 1790965315000 },
    { label: 'Week', pct: 100, resetsAt: 1791053618000 },
  ] });
  assert.equal(appServerPlanLimits({ rateLimits: null }, 5), undefined);
  assert.equal(appServerPlanLimits({ rateLimits: { primary: { usedPercent: 'x' } } }, 5), undefined);
});
