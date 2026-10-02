import type { GhIssue, GhIssueDetail } from '../../shared/protocol';
import { h, openModal, toast } from './dom';
import { maintenanceJson } from './maintenance-board';
import { maintenancePost, type IssueJobView } from './maintenance-work';

/** Both manual edits and model revisions require an explicit save. Closing keeps the browser draft. */
export function openIssueEditor(options: { issue?: GhIssue; field?: 'title' | 'description'; job?: IssueJobView; saved: () => void }) {
  const { issue } = options;
  let job = options.job;
  let busy = false;
  let closed = false;
  let loaded = false;
  let poll: number | undefined;
  const key = `agent-office.issue-edit.${job?.number ?? issue?.number ?? job?.id}`;
  const title = h('input', { type: 'text', maxlength: 200, 'aria-label': 'Issue title', disabled: true });
  const description = h('textarea', { rows: 10, maxlength: 20000, 'aria-label': 'Issue description', disabled: true });
  const instructions = h('textarea', { rows: 3, maxlength: 20000, placeholder: 'Describe the changes you want…', 'aria-label': 'Requested changes' });
  const writer = h('select', { 'aria-label': 'Issue writer model' }, h('option', { value: 'codex' }, 'Luna · gpt-6-luna'), h('option', { value: 'claude' }, 'Haiku'));
  const error = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const showError = (message: string) => { error.textContent = message; error.classList.toggle('hidden', !message); };
  const status = h('p', { role: 'status', 'aria-live': 'polite' });
  const persist = () => { if (loaded) try { localStorage.setItem(key, JSON.stringify({ title: title.value, body: description.value, instructions: instructions.value, writer: writer.value })); } catch { /* Storage unavailable. */ } };
  const controls: HTMLButtonElement[] = [];
  const pencil = (field: HTMLInputElement | HTMLTextAreaElement, label: string) => {
    const button = h('button', { type: 'button', 'aria-label': `Edit ${label}`, title: `Edit ${label}`, onclick: () => { field.disabled = false; field.focus(); } }, '✎');
    controls.push(button); return button;
  };
  const save = h('button.btn.primary', { type: 'submit' }, issue || job?.number ? 'Save changes' : 'Create GitHub issue');
  const generate = h('button.btn', { type: 'button', onclick: async () => {
    if (busy || !issue || !instructions.value.trim()) return;
    persist(); setBusy(true); showError('');
    try {
      job = await maintenancePost<IssueJobView>('/api/maintenance/issue', { number: issue.number, instructions: instructions.value, writer: writer.value });
      if (closed) return;
      status.textContent = 'Drafting changes. Nothing is saved until you confirm.';
      poll = window.setInterval(() => void checkJob(), 1500);
      void checkJob();
    } catch (err) { showError((err as Error).message); setBusy(false); }
  } }, 'Revise with AI');
  const setBusy = (value: boolean) => {
    busy = value; save.disabled = value || !loaded; generate.disabled = value || !loaded;
    controls.forEach(button => { button.disabled = value || !loaded; });
    if (value) { title.disabled = true; description.disabled = true; }
    instructions.disabled = value; writer.disabled = value;
  };
  const fill = (draft: { title: string; body: string }, restore = true) => {
    title.value = draft.title; description.value = draft.body; loaded = true;
    if (restore) try { const saved = JSON.parse(localStorage.getItem(key) ?? 'null'); if (saved) { title.value = saved.title; description.value = saved.body; instructions.value = saved.instructions ?? ''; writer.value = saved.writer ?? 'codex'; } } catch { /* Storage unavailable. */ }
    title.disabled = true; description.disabled = true; setBusy(false); persist();
    if (options.field) { const field = options.field === 'title' ? title : description; field.disabled = false; field.focus(); }
  };
  const checkJob = async () => {
    try {
      const { jobs } = await maintenanceJson<{ jobs: IssueJobView[] }>('/api/maintenance/issue-jobs');
      const latest = jobs.find(candidate => candidate.id === job?.id);
      if (closed || !busy || !latest || latest.status === 'drafting') return;
      clearInterval(poll); job = latest;
      if (latest.draft) { fill(latest.draft, false); status.textContent = 'Review the draft. Use the pencils to adjust it, then save.'; }
      else setBusy(false);
      if (latest.error) showError(latest.error);
    } catch (err) { if (!closed) status.textContent = `Waiting for draft: ${(err as Error).message}`; }
  };
  const form = h('form.modal.maintenance-issue-create', { role: 'dialog', 'aria-label': issue || job?.number ? `Edit issue #${issue?.number ?? job?.number}` : 'Review issue draft' },
    h('header', {}, h('h2', {}, issue || job?.number ? `Edit issue #${issue?.number ?? job?.number}` : 'Review issue draft')),
    h('div.body', {}, error, status, h('label.issue-edit-field', {}, 'Title ', pencil(title, 'title'), title), h('label.issue-edit-field', {}, 'Description ', pencil(description, 'description'), description),
      ...(issue ? [h('label', {}, 'Requested changes', instructions), h('label', {}, 'Written by ', writer), generate] : [])),
    h('footer', {}, h('button.btn', { type: 'button', onclick: () => modal.close() }, 'Cancel'), save));
  const modal = openModal(form, { onClose: () => { closed = true; clearInterval(poll); persist(); } });
  [title, description, instructions, writer].forEach(field => field.addEventListener('input', persist));
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !loaded || !title.value.trim()) return;
    persist(); setBusy(true); showError('');
    try {
      await maintenancePost('/api/maintenance/issue', job?.draft ? { job: job.id, confirm: true, title: title.value, body: description.value } : { number: issue?.number, save: true, title: title.value, body: description.value });
      loaded = false; try { localStorage.removeItem(key); } catch { /* Storage unavailable. */ }
      toast(issue || job?.number ? 'Issue updated' : 'Issue created'); options.saved(); modal.close();
    } catch (err) { showError((err as Error).message); setBusy(false); }
  });
  setBusy(false);
  if (job?.draft) fill(job.draft);
  else if (issue) void maintenanceJson<GhIssueDetail>(`/api/maintenance/issue?number=${issue.number}`).then(detail => { if (!closed) fill({ title: detail.title ?? issue.title, body: detail.body }); }).catch(err => { showError(err.message); });
  return modal;
}
