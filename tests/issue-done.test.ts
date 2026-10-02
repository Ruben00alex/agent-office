import test from 'node:test';
import assert from 'node:assert/strict';
import { referencesIssue } from '../src/server/github.js';

test('referencesIssue spots closing keywords for exactly that issue', () => {
  assert.ok(referencesIssue('Fixes #24', 24));
  assert.ok(referencesIssue('closes: owner/repo#24 and more', 24));
  assert.ok(referencesIssue('Implemented #24', 24));
  assert.ok(!referencesIssue('Fixes #240', 24));
  assert.ok(!referencesIssue('Part of #24', 24));
  assert.ok(!referencesIssue('see #24', 24));
});
