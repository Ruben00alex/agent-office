// Run against this worktree's isolated Vite preview on port 5199.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [], writes = [], jobs = [];
  let failSave = false;
  const detail = { number: 16, title: 'Existing title', state: 'OPEN', body: 'Existing description', comments: [], viewer: 'alex' };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:5199/', route => route.fulfill({ contentType: 'text/html', body: '<html><link rel="stylesheet" href="/style.css"><body><div id="panel"></div><div id="modal-root"></div><div id="toasts"></div></body></html>' }));
  await page.route('**/api/maintenance/issue-jobs', route => route.fulfill({ json: { jobs } }));
  await page.route('**/api/maintenance/issue?*', route => route.fulfill({ json: detail }));
  await page.route('**/api/maintenance/issue', async route => {
    const input = route.request().postDataJSON(); writes.push(input);
    if (input.save || input.confirm) {
      if (failSave) { failSave = false; return route.fulfill({ status: 400, json: { error: 'GitHub unavailable' } }); }
      detail.title = input.title; detail.body = input.body;
      const job = jobs.find(job => job.id === input.job); if (job) job.status = 'done';
      return route.fulfill({ json: { ok: true } });
    }
    const job = { ...input, id: `job-${jobs.length}`, title: input.title ?? detail.title, body: input.body ?? detail.body, status: 'ready', draft: { title: 'AI title', body: 'AI description' } };
    jobs.push(job); await route.fulfill({ status: 202, json: job });
  });
  await page.goto('http://127.0.0.1:5199/');
  await page.evaluate(async () => {
    const { store } = await import('/state.ts');
    window.issue = { number: 16, title: 'Existing title', url: 'https://github.com/example/office/issues/16', state: 'OPEN', labels: [], assignees: [], author: 'alex' };
    store.maintenanceIssues = { repo: 'example/office', items: [issue], loading: false, fetchedAt: 1 };
    window.refreshes = 0;
    const { workPanel } = await import('/ui/maintenance-work.ts');
    document.querySelector('#panel').append(workPanel({ work: [] }, () => {}, () => {}, () => {}, () => { refreshes++; }, () => {}));
  });
  await page.getByRole('button', { name: 'Edit issue #16', exact: true }).click();
  await page.getByRole('button', { name: 'Edit title', exact: true }).click();
  await page.getByRole('textbox', { name: 'Issue title', exact: true }).fill('Manual title');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(writes.length, 0, 'Cancel must not save');
  await page.getByRole('button', { name: 'Edit issue #16', exact: true }).click();
  await page.getByRole('button', { name: 'Edit description', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Issue title', exact: true }).inputValue(), 'Manual title');
  await page.getByRole('textbox', { name: 'Issue description', exact: true }).fill('Manual description');
  failSave = true;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'GitHub unavailable' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Issue description', exact: true }).inputValue(), 'Manual description');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(writes.at(-1).number, 16);
  assert.equal(detail.title, 'Manual title');
  for (const writer of ['codex', 'claude']) {
    await page.getByRole('button', { name: 'Edit issue #16', exact: true }).click();
    await page.getByRole('textbox', { name: 'Requested changes' }).fill('Clarify acceptance criteria');
    await page.getByRole('combobox', { name: 'Issue writer model' }).selectOption(writer);
    const count = writes.length;
    await page.getByRole('button', { name: 'Revise with AI' }).click();
    await page.getByRole('status').filter({ hasText: 'Review the draft' }).waitFor();
    assert.equal(writes.length, count + 1, 'Drafting must not save');
    assert.equal(writes.at(-1).writer, writer);
    assert.equal(writes.at(-1).number, 16);
    await page.getByRole('button', { name: 'Edit title', exact: true }).click();
    await page.getByRole('textbox', { name: 'Issue title', exact: true }).fill(`Reviewed ${writer}`);
    await page.screenshot({ path: `/tmp/issue16-${writer}-editor.png` });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(writes.at(-1).confirm, true);
    assert.equal(writes.at(-1).title, `Reviewed ${writer}`);
  }
  await page.evaluate(async () => {
    const { openMaintenanceIssue } = await import('/ui/maintenance-board.ts');
    openMaintenanceIssue(issue, () => {}, () => {});
  });
  await page.getByRole('button', { name: 'Edit description', exact: true }).click();
  await page.getByRole('textbox', { name: 'Issue description', exact: true }).fill('Pencil modal edit');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  // A new draft also requires review and an explicit creation confirmation.
  await page.getByRole('button', { name: '+ Add issue', exact: true }).click();
  await page.getByRole('textbox', { name: 'Issue title', exact: true }).fill('New idea');
  await page.getByRole('textbox', { name: 'Issue description', exact: true }).fill('New idea context');
  const count = writes.length;
  await page.getByRole('button', { name: 'Draft issue for review' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(writes.length, count + 1);
  assert.equal(writes.at(-1).queue, true);
  await page.getByRole('button', { name: '+ Add issue', exact: true }).click();
  await page.getByRole('button', { name: 'Review draft', exact: true }).click();
  await page.getByRole('button', { name: 'Edit description', exact: true }).click();
  await page.getByRole('textbox', { name: 'Issue description', exact: true }).fill('Reviewed new description');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(writes.length, count + 1, 'Canceling draft review must not create');
  await page.getByRole('button', { name: '+ Add issue', exact: true }).click();
  await page.getByRole('button', { name: 'Review draft', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'Issue description', exact: true }).inputValue(), 'Reviewed new description');
  await page.screenshot({ path: '/tmp/issue16-draft-review.png' });
  await page.getByRole('button', { name: 'Create GitHub issue', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(writes.at(-1).confirm, true);
  assert.equal(writes.at(-1).body, 'Reviewed new description');
  assert.equal(await page.evaluate(() => refreshes), 4);
  assert.deepEqual(errors, []);
  console.log('Passed: manual edits, cancel recovery, save retry, Luna/Haiku review, modal pencils, new draft confirmation and refresh.');
} finally { await browser.close(); }
