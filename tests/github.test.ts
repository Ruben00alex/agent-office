import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, MergeWatch } from '../src/server/github.js';
import type { GhPull } from '../src/shared/protocol.js';

const pull = (number: number, state: string): GhPull => ({
  number, title: `PR ${number}`, state, isDraft: false, url: '', author: '', labels: [], reviewDecision: '',
  headRefName: `b${number}`, baseRefName: 'main', createdAt: '', updatedAt: '', additions: 0, deletions: 0,
  checks: 'none', body: '', closes: [],
});
const numbers = (ps: GhPull[]) => ps.map((p) => p.number);

for (const linksFail of [false, true]) test(`PR board loads with CLI-supported fields when link enrichment ${linksFail ? 'fails' : 'succeeds'}`, async () => {
  const github = new GitHub('.', () => {}, () => {});
  (github as any).run = async (args: string[]) => {
    if (args[0] === 'issue') return JSON.stringify(args.includes('open') ? [28, 29].map(number => ({ number, state: 'OPEN', title: `Issue ${number}` })) : []);
    if (args[0] === 'pr') {
      assert.ok(!args[args.indexOf('--json') + 1].split(',').includes('closingIssuesReferences'), 'gh pr list rejects this field');
      const state = args[args.indexOf('--state') + 1];
      return JSON.stringify(state === 'open' ? [pull(1, 'OPEN')] : [{ ...pull(2, 'MERGED'), body: 'Closes other/project#29\nFixes #28' }]);
    }
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'team/office' });
    if (linksFail) throw new Error('GraphQL unavailable');
    assert.ok(args.includes('graphql'));
    return JSON.stringify({ data: { repository: { p2: { closingIssuesReferences: { nodes: [
      { number: 28, repository: { nameWithOwner: 'team/office' } },
      { number: 29, repository: { nameWithOwner: 'other/project' } },
    ] } } } } });
  };
  await github.refresh();
  assert.equal(github.pulls.error, undefined);
  assert.equal(github.pulls.loading, false);
  assert.deepEqual(numbers(github.pulls.items), [1, 2]);
  assert.deepEqual(github.pulls.items[1].closes, linksFail ? [] : [28]);
  assert.equal(github.issues.items.find(i => i.number === 28)?.doneBy, linksFail ? undefined : 'PR #2 merged');
  assert.equal(github.issues.items.find(i => i.number === 29)?.doneBy, undefined, 'another repository’s reference cannot complete this issue');
});

test('a pull request that was open at the last look and is merged now rings once', () => {
  const w = new MergeWatch();
  assert.deepEqual(numbers(w.look([pull(1, 'OPEN'), pull(2, 'MERGED'), pull(3, 'OPEN')])), [], 'nothing rings on the first look');
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED'), pull(3, 'CLOSED')])), [1]);
  assert.deepEqual(numbers(w.look([pull(1, 'MERGED'), pull(2, 'MERGED')])), []);
});

test('a merge from the PR window rings right away, and not again when GitHub catches up', () => {
  const w = new MergeWatch();
  w.look([pull(5, 'OPEN'), pull(6, 'OPEN')]);
  assert.equal(w.ring(5), true);
  assert.equal(w.ring(5), false);
  // A look that started before the merge still says open; the next one says merged.
  assert.deepEqual(numbers(w.look([pull(5, 'OPEN'), pull(6, 'OPEN')])), []);
  assert.deepEqual(numbers(w.look([pull(5, 'MERGED'), pull(6, 'MERGED')])), [6]);
});
