import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueJobs } from '../src/server/maintenance-issue-jobs.js';

const input = { title: 't', body: 'b', queue: true, writer: 'auto', attachments: [] };
const settle = () => new Promise(r => setTimeout(r, 5));

test('issue drafting runs as a server job that survives its caller, and failed drafts stay recoverable', async () => {
  let fail = true;
  const jobs = new IssueJobs(async () => { if (fail) throw new Error('model down'); return { number: 7, url: 'u', title: 't' }; });
  const job = jobs.start(input, 'me');
  assert.equal(job.status, 'drafting');
  await settle();
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'model down');
  assert.equal(job.body, 'b');
  fail = false;
  jobs.retry(job.id);
  assert.equal(job.status, 'drafting');
  await settle();
  assert.equal(job.status, 'done');
  assert.equal(job.issue?.number, 7);
  assert.throws(() => jobs.retry(job.id), /Only a failed/);
  jobs.dismiss(job.id);
  assert.equal(jobs.list().length, 0);
});
