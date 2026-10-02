import type { MaintenanceAttachment, ClientMsg, MaintenanceChatState, MaintenanceWorkItem } from '../../shared/protocol';
import { store } from '../state';
import { h, openModal, toast } from './dom';
import { openMaintenanceIssue } from './maintenance-board';
import { maintenanceIssueColumns, maintenanceQueued } from '../../shared/maintenance-issues';
import { imageComposer, imageEvidence } from './maintenance-images';
import { openStackChange } from './maintenance';

export async function maintenancePost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

interface IssueJobView { id: string; title: string; body: string; queue: boolean; writer: string; attachments: string[]; status: 'drafting' | 'done' | 'failed'; error?: string; issue?: { number: number; url: string; title: string } }
const jobStatus = new Map<string, IssueJobView['status']>();
const jobListeners = new Set<(jobs: IssueJobView[]) => void>();
let jobPoll: number | undefined;
let jobsDone: () => void = () => {};

/** Drafting runs on the server; this just watches it, so closing the form (or reloading) never interrupts a draft. */
async function pollIssueJobs() {
  try {
    const { jobs } = await (await fetch('/api/maintenance/issue-jobs', { credentials: 'same-origin' })).json() as { jobs: IssueJobView[] };
    for (const job of jobs) {
      const before = jobStatus.get(job.id);
      jobStatus.set(job.id, job.status);
      if (before !== 'drafting' || job.status === 'drafting') continue;
      if (job.status === 'done') { toast(`Issue #${job.issue?.number} created: ${job.issue?.title}`); jobsDone(); }
      else toast(`Issue draft “${job.title}” failed: ${job.error}. Open + Add issue to retry or edit it.`, 'error');
    }
    for (const fn of jobListeners) fn(jobs);
    if (!jobs.some(j => j.status === 'drafting')) { clearInterval(jobPoll); jobPoll = undefined; }
  } catch { /* Try again on the next tick. */ }
}
function watchIssueJobs() { if (jobPoll === undefined) jobPoll = window.setInterval(() => void pollIssueJobs(), 3000); void pollIssueJobs(); }

export function openMaintenanceIssueCreate(saved: () => void) {
  jobsDone = saved;
  const title = h('input', { type: 'text', maxlength: 200, placeholder: 'What should we improve?', 'aria-label': 'Issue title', required: true });
  const description = h('textarea', { rows: 6, maxlength: 20000, placeholder: 'Describe the problem, expected behavior and useful context…', 'aria-label': 'Issue description' });
  const error = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const showError = (text: string) => { error.textContent = text; error.classList.toggle('hidden', !text); };
  let sending = false;
  let completed = false;
  const draftKey = 'agent-office.maintenance-issue-draft-v1';
  const save = () => { if (completed) return; try { localStorage.setItem(draftKey, JSON.stringify({ title: title.value, body: description.value, attachments: images.images, queue: queue.checked })); } catch { /* Storage unavailable. */ } };
  const submit = h('button.btn.primary', { type: 'submit' }, 'Create GitHub issue & queue');
  const images = imageComposer(() => { save(); submit.disabled = sending || images.uploading; }, showError);
  const queue = h('input', { type: 'checkbox', checked: true });
  const writer = h('select', { 'aria-label': 'Issue writer model' },
    h('option', { value: 'auto' }, 'Auto: Codex gpt-6-luna, then Claude haiku'), h('option', { value: 'codex' }, 'Codex · gpt-6-luna'), h('option', { value: 'claude' }, 'Claude Code · haiku'));
  const writerKey = 'agent-office.maintenance-issue-writer-v1';
  try { const saved = localStorage.getItem(writerKey); if (saved === 'codex' || saved === 'claude') writer.value = saved; } catch { /* Storage unavailable. */ }
  writer.addEventListener('change', () => { try { localStorage.setItem(writerKey, writer.value); } catch { /* Storage unavailable. */ } });
  const updateLabel = () => { submit.textContent = queue.checked ? 'Create GitHub issue & queue' : 'Create GitHub issue'; };
  queue.addEventListener('change', () => { updateLabel(); save(); });
  title.addEventListener('input', save); description.addEventListener('input', save);
  try { const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null'); if (draft) { title.value = typeof draft.title === 'string' ? draft.title : ''; description.value = typeof draft.body === 'string' ? draft.body : ''; queue.checked = draft.queue !== false; images.set(Array.isArray(draft.attachments) ? draft.attachments.filter((i: MaintenanceAttachment) => i && /^[a-f0-9-]{36}$/.test(i.id)) : []); updateLabel(); } } catch { /* Storage unavailable. */ }
  const jobsBox = h('div.maintenance-issue-jobs.hidden', { role: 'status', 'aria-live': 'polite' });
  const renderJobs = (jobs: IssueJobView[]) => {
    const shown = jobs.filter(j => j.status !== 'done');
    jobsBox.classList.toggle('hidden', !shown.length);
    jobsBox.replaceChildren(...shown.map(job => job.status === 'drafting'
      ? h('p', {}, `⏳ Drafting “${job.title}” in the background. You can close this and keep using the office.`)
      : h('p.maintenance-chat-error', {}, `Draft “${job.title}” failed: ${job.error} `,
        h('button', { type: 'button', onclick: () => void maintenancePost('/api/maintenance/issue', { job: job.id, retry: true }).then(() => watchIssueJobs()).catch(err => showError(err.message)) }, 'Retry'), ' ',
        h('button', { type: 'button', onclick: () => { title.value = job.title; description.value = job.body; queue.checked = job.queue; writer.value = job.writer; updateLabel(); save(); void maintenancePost('/api/maintenance/issue', { job: job.id }).then(() => pollIssueJobs()); } }, 'Edit in form'), ' ',
        h('button', { type: 'button', onclick: () => void maintenancePost('/api/maintenance/issue', { job: job.id }).then(() => pollIssueJobs()) }, 'Dismiss'))));
  };
  jobListeners.add(renderJobs);
  const form = h('form.modal.maintenance-issue-create', { role: 'dialog', 'aria-label': 'Create maintenance issue' },
    h('header', {}, h('h2', {}, 'Capture an idea')),
    h('div.body', {}, h('p', {}, `Creates an issue in ${store.maintenanceIssues.repo ?? 'Agent Office’s repository'}. A small model (gpt-6-luna on Codex, or Claude Code with haiku if Codex is unavailable) reads the office source and crafts a technical issue from your idea. Drafting continues in the background, even if you close this. Maintenance keeps working on its current task.`), error, jobsBox, title, description, images.element,
      h('label', {}, 'Written by ', writer),
      h('label', {}, queue, ' Add to the Maintenance queue'), h('p.setting-note', {}, 'Start queued work when the agent is free. Screenshots stay with the queued item in the office; they are not published to GitHub.')),
    h('footer', {}, submit));
  images.bind(form);
  const modal = openModal(form, { onClose: () => { save(); jobListeners.delete(renderJobs); } });
  form.addEventListener('submit', e => {
    e.preventDefault(); if (sending || images.uploading || !title.value.trim()) return;
    if (!queue.checked && images.images.length) { showError('Keep “Add to the Maintenance queue” checked to retain screenshot evidence with this issue.'); return; }
    sending = true; submit.textContent = 'Starting…'; submit.disabled = true; showError('');
    void maintenancePost<IssueJobView>('/api/maintenance/issue', { title: title.value, body: description.value, queue: queue.checked, writer: writer.value, attachments: images.images.map(i => i.id) })
      .then(job => { completed = true; try { localStorage.removeItem(draftKey); } catch { /* Storage unavailable. */ } jobStatus.set(job.id, 'drafting'); toast(`Drafting “${job.title}” in the background. You’ll be told when the issue is created.`); modal.close(); watchIssueJobs(); })
      .catch(err => { showError(err.message); sending = false; updateLabel(); submit.disabled = false; });
  });
  watchIssueJobs();
  title.focus(); return modal;
}

export function workPanel(state: MaintenanceChatState, send: (message: ClientMsg) => void, start: (item: MaintenanceWorkItem) => void, correct: (context?: string) => void, refresh: () => void, viewConversation: (id: string) => void) {
  const panel = h('div.maintenance-work-panel');
  const github = store.maintenanceIssues;
  const error = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const act = (promise: Promise<unknown>) => void promise.then(refresh).catch(err => { error.textContent = err.message; error.classList.remove('hidden'); });
  const work = state.work ?? [];
  const queued = github.items.filter(maintenanceQueued).sort((a, b) => a.number - b.number);
  const busy = !!state.worker && !['idle', 'done', 'exited'].includes(state.worker.status);
  const blocked = busy || work.some(i => i.status === 'running') || state.stack?.phase === 'shipping' || state.stack?.validation?.phase === 'running';
  const startIssue = (issue: typeof queued[number]) => start(work.find(i => i.number === issue.number) ?? { repo: github.repo ?? '', number: issue.number, title: issue.title, url: issue.url, status: 'queued', by: issue.author, at: 0, attachments: [], commits: [] });
  panel.append(h('div.maintenance-section-heading', {}, h('div', {}, h('h3', {}, 'Engineering backlog'), h('p', {}, `${github.repo ?? 'Agent Office'} · GitHub issues`)),
    h('button', { type: 'button', onclick: () => openMaintenanceIssueCreate(refresh) }, '+ Add issue'),
    h('button', { type: 'button', onclick: () => send({ t: 'maintenance.issues' }) }, 'Refresh issues')), error,
    h('div.maintenance-work-intro', {}, h('button', { type: 'button', disabled: blocked || !queued.length || !!github.error || github.loading, onclick: () => startIssue(queued[0]) }, 'Start next queued issue'),
      h('p', {}, 'Tell Maintenance what to capture or queue in Conversation. Queued issues carry the maintenance:queued label on GitHub; the oldest issue starts first.')));
  if (github.error) panel.append(h('p.maintenance-chat-error', { role: 'alert' }, github.error));
  for (const column of maintenanceIssueColumns(github.items)) {
    panel.append(h('h4', {}, `${column.title} · ${column.items.length}`));
    for (const issue of column.items) {
      const item = work.find(i => i.number === issue.number);
      const card = h('article.maintenance-work-card', {}, h('button.maintenance-issue-title', { type: 'button', onclick: () => openMaintenanceIssue(issue, correct, send) }, `#${issue.number} · ${issue.title}`),
        h('a', { href: issue.url, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub ↗'));
      card.addEventListener('click', e => { if (!(e.target as Element).closest('button, a, img, input, select, textarea, summary')) openMaintenanceIssue(issue, correct, send); });
      if (issue.state === 'OPEN' && issue.doneBy) card.append(h('small', {}, `✅ ${issue.doneBy}, still open on GitHub`));
      if (issue.assignees.length) card.append(h('small', {}, `Assigned to ${issue.assignees.join(', ')}`));
      if (item?.workerId) {
        const activity = { queued: 'Waiting', running: 'Agent working', review: 'Agent turn ready for review', paused: 'Agent interrupted', done: 'Agent work reviewed' }[item.status];
        card.append(h('small', {}, `Session: ${activity}`), h('button', { type: 'button', onclick: () => viewConversation(item.workerId!) }, 'Conversation'));
      }
      if (issue.state === 'OPEN') {
        const inQueue = maintenanceQueued(issue);
        card.append(h('button', { type: 'button', disabled: item?.status === 'running', onclick: () => act(maintenancePost('/api/maintenance/queue', { number: issue.number, ...(inQueue ? { remove: true } : { attachments: item?.attachments.map(i => i.id) ?? [] }) })) }, inQueue ? 'Remove from queue' : 'Queue for Maintenance'));
        if (inQueue) card.append(h('button', { type: 'button', disabled: blocked || !!github.error || github.loading, onclick: () => (!issue.doneBy || confirm(`#${issue.number} looks already done (${issue.doneBy}) but is still open. Start Maintenance on it anyway?`)) && startIssue(issue) }, 'Start issue'));
        if (item?.status === 'review') card.append(h('button', { type: 'button', onclick: () => act(maintenancePost('/api/maintenance/queue', { number: issue.number, reviewed: true })) }, 'Mark agent work reviewed'));
      }
      if (item?.attachments.length) card.append(imageEvidence(item.attachments));
      for (const commit of item?.commits ?? []) card.append(h('button', { type: 'button', onclick: () => openStackChange(commit, { correct, watch() {} }) }, `${commit.sha} · ${commit.subject}`));
      panel.append(card);
    }
    if (!column.items.length) panel.append(h('p.maintenance-muted', {}, github.loading ? 'Refreshing GitHub…' : 'No issues.'));
  }
  return panel;
}
