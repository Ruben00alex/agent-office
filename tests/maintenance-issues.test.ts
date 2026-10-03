import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceIssueColumns, maintenanceIssueLane } from '../src/shared/maintenance-issues.js';
import type { GhIssue } from '../src/shared/protocol.js';

test('both Maintenance views classify the same GitHub issues, with closed state taking precedence over queue labels', () => {
  const issue = (number: number, state = 'OPEN', labels: string[] = [], assignees: string[] = []) => ({ number, state, labels: labels.map(name => ({ name })), assignees }) as GhIssue;
  const columns = maintenanceIssueColumns([issue(1), issue(2, 'OPEN', ['maintenance:queued']), issue(3, 'OPEN', [], ['Alex']), issue(4, 'CLOSED', ['maintenance:queued'])]);
  assert.deepEqual(columns.map(c => c.items.map(i => i.number)), [[1], [2], [3], [], [4]]);
});

test('Maintenance\'s own record moves cards on, so finished work never sits in progress just because it was assigned', () => {
  const issue = (number: number, extra: Partial<GhIssue> = {}) => ({ number, state: 'OPEN', labels: [], assignees: ['Alex'], updatedAt: `2026-10-0${number}T00:00:00Z`, ...extra }) as GhIssue;
  assert.equal(maintenanceIssueLane(issue(1), { status: 'running', commits: 0 }), 'progress');
  assert.equal(maintenanceIssueLane(issue(1), { status: 'review', commits: 0 }), 'review', 'an assigned issue whose agent finished needs review');
  assert.equal(maintenanceIssueLane(issue(1), { status: 'done', commits: 2 }), 'review', 'reviewed but still open waits to ship');
  assert.equal(maintenanceIssueLane(issue(1), { status: 'paused', commits: 1 }), 'review', 'interrupted work with commits needs a look');
  assert.equal(maintenanceIssueLane(issue(1), { status: 'paused', commits: 0 }), 'open', 'interrupted work without commits goes back to the backlog');
  assert.equal(maintenanceIssueLane(issue(1, { doneBy: 'PR #3 merged' })), 'review');
  assert.equal(maintenanceIssueLane(issue(1, { work: { status: 'review', commits: 1 } })), 'review', 'the server decorates issues for the wall board');
  assert.equal(maintenanceIssueLane(issue(1)), 'progress', 'assignment still means progress for work outside Maintenance');
  const queued = { labels: [{ name: 'maintenance:queued', color: 'f08c00' }] };
  const [, inQueue, , , closed] = maintenanceIssueColumns([issue(3, queued), issue(2, queued), issue(1, { state: 'CLOSED' }), issue(4, { state: 'CLOSED' })]);
  assert.deepEqual(inQueue.items.map(i => i.number), [2, 3], 'the queue starts oldest first');
  assert.deepEqual(closed.items.map(i => i.number), [4, 1], 'recently closed issues come first');
});
