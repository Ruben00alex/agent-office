import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueJobs } from '../src/server/maintenance-issue-jobs.js';

const input = { title: 't', body: 'b', queue: true, writer: 'auto', attachments: [] };
const settle = () => new Promise(r => setTimeout(r, 5));

test('background drafting survives its caller, is retryable, and never saves before confirmation', async () => {
  let fail = true;
  const saved: { title: string; body: string }[] = [];
  const jobs = new IssueJobs(async () => { if (fail) throw new Error('model down'); return { title: 'generated', body: 'generated body' }; }, async (_job, draft) => { saved.push(draft); return { number: 7, url: 'u', title: draft.title }; });
  const job = jobs.start(input, 'me');
  assert.equal(job.status, 'drafting');
  assert.throws(() => jobs.dismiss(job.id), /Wait/);
  await assert.rejects(jobs.confirm(job.id, 't', 'b'), /not ready/);
  await settle();
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'model down');
  assert.equal(job.body, 'b');
  fail = false;
  jobs.retry(job.id);
  await settle();
  assert.equal(job.status, 'ready');
  assert.deepEqual(saved, []);
  assert.throws(() => jobs.retry(job.id), /Only a failed/);
  await assert.rejects(jobs.confirm(job.id, '', 'body'), /Use a title/);
  await jobs.confirm(job.id, ' Edited title ', 'Edited body');
  assert.equal(job.status, 'done');
  assert.deepEqual(saved, [{ title: 'Edited title', body: 'Edited body' }]);
  assert.equal(job.issue?.number, 7);
  await assert.rejects(jobs.confirm(job.id, 'again', 'body'), /not ready/);
  jobs.dismiss(job.id);
  assert.equal(jobs.list().length, 0);
});

test('save failures preserve reviewed edits, and simultaneous or repeated saves are rejected', async () => {
  let fail = true;
  let release: () => void = () => {};
  const jobs = new IssueJobs(async () => ({ title: 'draft', body: 'body' }), async (job, draft) => {
    assert.equal(job.number, 16);
    if (fail) throw new Error('GitHub unavailable');
    await new Promise<void>(resolve => { release = resolve; });
    return { number: job.number!, url: 'u', title: draft.title };
  });
  const job = jobs.start({ ...input, number: 16, instructions: 'Change title' }, 'me');
  await settle();
  await assert.rejects(jobs.confirm(job.id, 'edited', 'edited body'), /GitHub unavailable/);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.draft, { title: 'edited', body: 'edited body' });
  assert.throws(() => jobs.retry(job.id), /Only a failed/);
  fail = false;
  const saving = jobs.confirm(job.id, 'edited again', 'body');
  assert.equal(job.status, 'saving');
  assert.throws(() => jobs.dismiss(job.id), /Wait/);
  await assert.rejects(jobs.confirm(job.id, 'double', 'body'), /not ready/);
  release(); await saving;
  assert.equal(job.status, 'done');
  assert.equal(job.issue?.number, 16);
});
