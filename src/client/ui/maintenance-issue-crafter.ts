import type { GhIssue, GhIssueDetail, MaintenanceAttachment } from '../../shared/protocol';
import { ISSUE_LABELS } from '../../shared/maintenance-issues';
import { store } from '../state';
import { h, openModal, toast } from './dom';
import { imageComposer } from './maintenance-images';
import { markdown } from './markdown';

export async function maintenancePost<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

type Turn = { role: 'user' | 'assistant'; content: string; error?: boolean };
export interface IssueJobView {
  id: string; title: string; body: string; queue: boolean; writer: string; attachments: string[]; number?: number;
  draft?: { title: string; body: string; labels?: string[]; reply?: string };
  status: 'drafting' | 'ready' | 'saving' | 'done' | 'failed'; error?: string; issue?: { number: number; url: string; title: string };
}

// ---- Crafting turns run on the server, so closing the crafter (or reloading) never interrupts one. This watches them.
let jobs: IssueJobView[] = [];
const jobListeners = new Set<(jobs: IssueJobView[]) => void>();
let jobPoll: number | undefined;

async function pollIssueJobs() {
  try {
    const before = new Map(jobs.map(j => [j.id, j.status]));
    ({ jobs } = await (await fetch('/api/maintenance/issue-jobs', { credentials: 'same-origin' })).json() as { jobs: IssueJobView[] });
    // Nobody is looking at the crafter: say when its turn finishes.
    for (const job of jobs) if (before.get(job.id) === 'drafting' && job.status !== 'drafting' && !openCrafters.has(sessionKey(job.number))) {
      if (job.status === 'failed') toast(`Couldn't update the issue draft “${job.title}”: ${job.error}`, 'error');
      else toast(`The issue draft “${job.draft?.title ?? job.title}” is updated. Open it to keep going or create it.`);
    }
    for (const fn of jobListeners) fn(jobs);
    if (!jobs.some(j => j.status === 'drafting')) { clearInterval(jobPoll); jobPoll = undefined; }
  } catch { /* Try again on the next tick. */ }
}
export function watchIssueJobs() { if (jobPoll === undefined) jobPoll = window.setInterval(() => void pollIssueJobs(), 2000); void pollIssueJobs(); }
/** Whether a crafting turn is running anywhere: the Work tab animates its + Add issue button only then. */
export const issueCrafting = () => jobs.some(j => j.status === 'drafting');
export function onIssueJobs(fn: () => void) { jobListeners.add(fn); return () => jobListeners.delete(fn); }

// ---- One crafting session per new issue and per existing issue, kept in the browser until the issue is saved.
interface Session { messages: Turn[]; title: string; body: string; labels: string[]; queue: boolean; writer: string; attachments: MaintenanceAttachment[]; job?: string; crafted?: string }
const sessionKey = (number?: number) => `agent-office.issue-crafter.${number ?? 'new'}`;
const openCrafters = new Set<string>();
function loadSession(number?: number): Session | undefined {
  try { const s = JSON.parse(localStorage.getItem(sessionKey(number)) ?? 'null'); return s && Array.isArray(s.messages) ? s : undefined; } catch { return undefined; }
}
/** A new-issue conversation is waiting in this browser. */
export const hasIssueDraft = () => !!loadSession()?.messages.length;

/**
 * The issue crafter: talk to the issue writer on the left while it keeps the issue on the right up to date.
 * Every message goes through the model with the draft as it stands, so hand edits on the right are kept and refined.
 */
export function openIssueCrafter(options: { issue?: GhIssue; saved: () => void }) {
  const { issue } = options;
  const key = sessionKey(issue?.number);
  const saved = loadSession(issue?.number);
  let s: Session = saved ?? { messages: [], title: issue?.title ?? '', body: '', labels: issue?.labels.map(l => l.name).filter(n => ISSUE_LABELS.some(k => k.name === n)) ?? [], queue: true, writer: 'auto', attachments: [] };
  let closed = false;
  let saving = false;
  let done = false;
  let loaded = !issue || !!saved;
  const persist = () => { if (!done) try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* Storage unavailable. */ } };

  // Left: the conversation.
  const log = h('div.crafter-log', { role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 3, maxlength: 8000, placeholder: issue ? `What should change in #${issue.number}?` : 'Describe the bug or idea. Paste screenshots too.', 'aria-label': 'Message the issue writer' });
  const send = h('button.btn.primary', { type: 'submit' }, 'Send');
  const error = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const showError = (text: string) => { error.textContent = text; error.classList.toggle('hidden', !text); };
  const images = imageComposer(() => { s.attachments = images.images; persist(); paint(); }, showError);
  images.set(s.attachments.filter(i => i && /^[a-f0-9-]{36}$/.test(i.id)));
  const chat = h('form.crafter-chat', {}, log, error, images.element, h('div.crafter-compose', {}, input, send));

  // Right: the issue, filled by the writer and editable by hand.
  const title = h('input', { type: 'text', maxlength: 200, placeholder: 'The writer fills this in', 'aria-label': 'Issue title' });
  const labels = h('div.crafter-labels', { role: 'group', 'aria-label': 'Labels' });
  const description = h('textarea.crafter-body-edit.hidden', { maxlength: 20000, 'aria-label': 'Issue description' });
  const preview = h('div.crafter-preview');
  let editing = false;
  const tab = (label: string, edit: boolean) => h('button', { type: 'button', role: 'tab', onclick: () => { editing = edit; paint(); if (edit) description.focus(); } }, label);
  const tabs = [tab('Preview', false), tab('Edit', true)];
  const queue = h('input', { type: 'checkbox' });
  const writer = h('select', { 'aria-label': 'Issue writer model' },
    h('option', { value: 'auto' }, 'Auto: Luna, then Haiku'), h('option', { value: 'codex' }, 'Codex · gpt-6-luna'), h('option', { value: 'claude' }, 'Claude Code · haiku'));
  const reset = h('button.btn', { type: 'button', title: 'Clear this conversation and draft', onclick: () => {
    if (!confirm(issue ? `Discard your unsaved changes to #${issue.number}?` : 'Discard this draft and start over?')) return;
    dismiss(s.job); dismiss(s.crafted);
    try { localStorage.removeItem(key); } catch { /* Storage unavailable. */ }
    s = { messages: [], title: issue?.title ?? '', body: '', labels: [], queue: true, writer: s.writer, attachments: [] };
    images.set([]);
    if (issue) { loaded = false; void load(); }
    paint();
  } }, 'Start over');
  const create = h('button.btn.primary', { type: 'button', onclick: () => void save() }, issue ? 'Save changes' : 'Create issue');
  const hint = h('span.grow');
  const draft = h('section.crafter-issue', { 'aria-label': 'Issue draft' },
    h('label.crafter-field', {}, h('span', {}, 'Title'), title),
    h('div.crafter-field', {}, h('span', {}, 'Labels'), labels),
    h('div.crafter-field.crafter-body', {}, h('div.crafter-body-head', {}, h('span', {}, 'Description'), h('div.crafter-tabs', { role: 'tablist' }, ...tabs)), preview, description),
    ...(issue ? [] : [h('label.crafter-queue', {}, queue, ' Add to the Maintenance queue')]));

  const el = h('div.modal.issue-crafter', { role: 'dialog', 'aria-label': issue ? `Edit issue #${issue.number}` : 'Issue crafter' },
    h('header', {}, h('h2', {}, issue ? `✍️ Edit #${issue.number}` : '✍️ New issue'), h('span.crafter-repo', {}, store.maintenanceIssues.repo ?? 'Agent Office')),
    h('div.crafter-panes', {}, chat, draft),
    h('footer', {}, h('label.crafter-writer', {}, 'Writer ', writer), hint, reset, create));

  const crafting = () => !!s.job;
  function paint() {
    log.replaceChildren(
      h('div.crafter-msg.assistant', {}, issue
        ? `Tell me what should change in #${issue.number}, and I'll update the issue on the right. You can also edit it by hand.`
        : 'Tell me about the bug or idea. I read the office source and write the issue on the right as we talk. Keep chatting to refine it, or edit it by hand.'),
      ...s.messages.map(m => m.role === 'user' ? h('div.crafter-msg.user', {}, m.content) : h(m.error ? 'div.crafter-msg.assistant.failed' : 'div.crafter-msg.assistant', {}, m.error ? m.content : markdown(m.content))),
      ...(crafting() ? [h('div.crafter-msg.assistant.crafter-typing', {}, h('span.maintenance-add-orb', { 'aria-hidden': 'true' }), ' Reading the office source and updating the issue…')] : []),
      ...(s.messages.at(-1)?.error ? [h('button.btn.crafter-retry', { type: 'button', onclick: () => { s.messages.pop(); void turn(); } }, 'Try again')] : []));
    log.scrollTop = log.scrollHeight;
    if (document.activeElement !== title) title.value = s.title;
    if (document.activeElement !== description) description.value = s.body;
    labels.replaceChildren(...ISSUE_LABELS.map(l => h('button.crafter-label', { type: 'button', 'aria-pressed': String(s.labels.includes(l.name)), title: l.description, style: `--label:#${l.color}`, disabled: !loaded || crafting(),
      onclick: () => { s.labels = s.labels.includes(l.name) ? s.labels.filter(n => n !== l.name) : [...s.labels, l.name]; persist(); paint(); } }, l.name)));
    preview.replaceChildren(s.body.trim() ? markdown(s.body) : h('p.maintenance-muted', {}, loaded ? 'The crafted issue appears here as you chat.' : 'Loading the issue…'));
    preview.classList.toggle('hidden', editing); description.classList.toggle('hidden', !editing);
    tabs.forEach((t, i) => t.setAttribute('aria-selected', String(i === Number(editing))));
    draft.classList.toggle('is-crafting', crafting());
    queue.checked = s.queue; writer.value = s.writer;
    title.disabled = description.disabled = !loaded || crafting();
    input.disabled = !loaded || saving; images.disable(saving);
    send.disabled = !loaded || saving || crafting() || images.uploading;
    // A new issue is always the writer's draft; an existing one can also be saved after hand edits alone.
    create.disabled = saving || crafting() || !loaded || !s.title.trim() || (!issue && !s.crafted);
    hint.textContent = crafting() ? 'Updating the issue…' : !issue && !s.crafted ? 'Send a message to have the writer draft the issue.' : '';
    reset.disabled = saving || (!s.messages.length && !s.crafted);
  }

  function dismiss(id?: string) { if (id) void maintenancePost('/api/maintenance/issue', { job: id }).catch(() => {}); }

  /** Sends the conversation and the draft as it stands to the writer. */
  async function turn() {
    showError(''); persist(); paint();
    try {
      const job = await maintenancePost<IssueJobView>('/api/maintenance/issue', { messages: s.messages.filter(m => !m.error), title: s.title, body: s.body, labels: s.labels, queue: s.queue, writer: s.writer, attachments: s.attachments.map(i => i.id), number: issue?.number });
      s.job = job.id; persist(); paint(); watchIssueJobs();
    } catch (err) { s.messages.push({ role: 'assistant', content: (err as Error).message, error: true }); persist(); paint(); }
  }

  /** A finished turn: its reply joins the conversation and its issue replaces the draft. */
  const apply = (all: IssueJobView[]) => {
    const job = s.job ? all.find(j => j.id === s.job) : undefined;
    if (closed || !s.job || (job && job.status === 'drafting')) return;
    s.job = undefined;
    if (!job) s.messages.push({ role: 'assistant', content: 'That update was lost (the office may have restarted). Try again.', error: true });
    else if (job.status === 'failed' || !job.draft) s.messages.push({ role: 'assistant', content: job.error ?? 'The writer did not answer.', error: true });
    else {
      s.messages.push({ role: 'assistant', content: job.draft.reply ?? 'Updated the issue.' });
      s.title = job.draft.title; s.body = job.draft.body; s.labels = job.draft.labels ?? s.labels;
      dismiss(s.crafted); s.crafted = job.id;
    }
    persist(); paint();
  };

  async function save() {
    if (saving || !s.title.trim()) return;
    if (!issue && !s.queue && s.attachments.length) { showError('Keep “Add to the Maintenance queue” checked to keep the screenshots with this issue, or remove them.'); return; }
    saving = true; showError(''); paint();
    try {
      if (s.crafted) await maintenancePost('/api/maintenance/issue', { job: s.crafted, confirm: true, title: s.title, body: s.body, labels: s.labels });
      else await maintenancePost('/api/maintenance/issue', { number: issue!.number, save: true, title: s.title, body: s.body, labels: s.labels });
      done = true;
      try { localStorage.removeItem(key); } catch { /* Storage unavailable. */ }
      toast(issue ? `Issue #${issue.number} updated` : `Issue created${s.queue ? ' and queued' : ''}`);
      options.saved(); modal.close();
    } catch (err) { showError((err as Error).message); saving = false; paint(); }
  }

  async function load() {
    if (!issue) return;
    try {
      const detail = await (await fetch(`/api/maintenance/issue?number=${issue.number}`, { credentials: 'same-origin' })).json() as GhIssueDetail & { error?: string };
      if (detail.error) throw new Error(detail.error);
      if (closed) return;
      s.title = detail.title ?? issue.title; s.body = detail.body ?? ''; s.labels = issue.labels.map(l => l.name).filter(n => ISSUE_LABELS.some(k => k.name === n));
      loaded = true; paint();
    } catch (err) { showError((err as Error).message); }
  }

  chat.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    s.messages.push({ role: 'user', content: text });
    input.value = '';
    void turn();
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chat.requestSubmit(); } });
  title.addEventListener('input', () => { s.title = title.value; persist(); paint(); });
  description.addEventListener('input', () => { s.body = description.value; persist(); });
  description.addEventListener('blur', () => paint());
  queue.addEventListener('change', () => { s.queue = queue.checked; persist(); });
  writer.addEventListener('change', () => { s.writer = writer.value; persist(); });
  images.bind(el);

  openCrafters.add(key);
  const off = onIssueJobs(() => apply(jobs));
  const modal = openModal(el, { onClose: () => { closed = true; openCrafters.delete(key); off(); persist(); } });
  paint();
  if (!loaded) void load();
  if (s.job) watchIssueJobs();
  input.focus();
  return modal;
}
