import type { ClientMsg, GhIssue, GhIssueDetail } from '../../shared/protocol';
import { MAINTENANCE_DESK } from '../../shared/layout';
import { store } from '../state';
import { h, openModal, timeAgo } from './dom';
import { maintenancePost, openMaintenanceIssueCreate } from './maintenance-work';
import { markdown } from './markdown';

export async function maintenanceJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

/** The "Generate title" button: asks the server for a fresh title for the conversation `id()` returns, then calls `done`. */
export function generateTitleButton(endpoint: string, id: () => string | undefined, done: () => void, fail: (message: string) => void) {
  const button = h('button', { type: 'button', title: 'Write a short title for this conversation from its first message', onclick: async () => {
    const thread = id();
    if (!thread || button.disabled) return;
    button.disabled = true; button.textContent = 'Titling…';
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: thread }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      done();
    } catch (err) { fail((err as Error).message); }
    button.disabled = false; button.textContent = 'Generate title';
  } }, 'Generate title') as HTMLButtonElement;
  return button;
}

export { maintenanceIssueColumns } from '../../shared/maintenance-issues';
import { maintenanceIssueColumns } from '../../shared/maintenance-issues';

/** Office source issues have no floor queue, carried cards or floor-worker actions. */
export function openMaintenanceIssue(issue: GhIssue, correct: (context?: string) => void, send?: (msg: ClientMsg) => void) {
  const body = h('div.body', {}, h('p', {}, 'Loading issue and comments…'));
  const modal = openModal(h('div.modal.maintenance-issue', { role: 'dialog', 'aria-label': 'Agent Office issue' },
    h('header', {}, h('h2', {}, `🛠️ Agent Office · #${issue.number}`)), body));
  void maintenanceJson<GhIssueDetail>(`/api/maintenance/issue?number=${issue.number}`).then((detail) => {
    body.replaceChildren(h('h3', {}, issue.title), h('p.setting-note', {}, `${store.maintenanceIssues.repo ?? 'Agent Office source repository'} · ${detail.state}${issue.doneBy && detail.state === 'OPEN' ? ` · ✅ ${issue.doneBy}, still open: close it if the work is done` : ''}`),
      h('div', {}, markdown(detail.body || '_No description._')),
      h('button.btn.primary', { type: 'button', onclick: () => { modal.close(); correct(`Agent Office issue #${issue.number}: ${issue.title}\n${issue.url}`); } }, '🛠️ Ask Maintenance about this'),
      ...(detail.state === 'OPEN' && send ? [h('button.btn', { type: 'button', onclick: () => { void maintenancePost('/api/maintenance/queue', { number: issue.number }).then(() => { modal.close(); send({ t: 'maintenance.issues' }); }).catch(error => body.append(h('p.setting-note.bad', { role: 'alert' }, error.message))); } }, 'Add to Maintenance queue'), h('button.btn', { type: 'button', title: 'Close this issue on GitHub', onclick: () => { void maintenancePost('/api/maintenance/queue', { number: issue.number, close: true }).then(() => { modal.close(); send({ t: 'maintenance.issues' }); }).catch(error => body.append(h('p.setting-note.bad', { role: 'alert' }, `Couldn't close #${issue.number}: ${error.message}`))); } }, '✓ Close issue'), h('button.btn.primary', { type: 'button', onclick: () => { if (issue.doneBy && !confirm(`#${issue.number} looks already done (${issue.doneBy}) but is still open. Start Maintenance on it anyway?`)) return; send({ t: 'station.prompt', deskId: MAINTENANCE_DESK, prompt: '', maintenanceIssue: issue.number }); modal.close(); } }, '🚧 Move to In progress & start Maintenance')] : []),
      h('a.btn', { href: issue.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on GitHub ↗'),
      h('h3', {}, 'Comments'), ...detail.comments.map((comment) => h('section.maintenance-comment', {}, h('strong', {}, `${comment.author} · ${timeAgo(comment.createdAt)}`), markdown(comment.body))),
      ...(detail.comments.length ? [] : [h('p.setting-note', {}, 'No comments yet.')]));
  }).catch((error) => body.replaceChildren(h('p.setting-note.bad', { role: 'alert' }, String(error))));
  return modal;
}

export function openMaintenanceBoard(send: (msg: ClientMsg) => void, correct: (context?: string) => void) {
  const body = h('div.body');
  const status = h('span.board-status');
  const el = h('div.modal.board', { role: 'dialog', 'aria-label': 'Agent Office issues Kanban' },
    h('header', {}, h('h2', {}, '🛠️ Agent Office issues'), h('span.board-scope', { title: 'Close, queue and start Maintenance here; floor queues and workers belong to the floor boards' }, 'Agent Office source'), status,
      h('button.btn', { type: 'button', onclick: () => openMaintenanceIssueCreate(() => send({ t: 'maintenance.issues' })) }, '+ Add issue'),
      h('button.btn', { type: 'button', onclick: () => send({ t: 'maintenance.issues' }) }, '🔄 Refresh')), body);
  let closeError = '';
  const render = () => {
    const state = store.maintenanceIssues;
    status.textContent = state.loading ? 'Refreshing…' : state.fetchedAt ? `Updated ${timeAgo(state.fetchedAt)}` : '';
    body.replaceChildren();
    const columns = h('div.maintenance-columns');
    body.append(h('p.maintenance-repo', {}, `${state.repo ?? 'Agent Office source repository'} · Shared across every floor`));
    if (state.error) body.append(h('p.setting-note.bad', { role: 'alert' }, state.error));
    if (closeError) body.append(h('p.setting-note.bad', { role: 'alert' }, closeError));
    for (const column of maintenanceIssueColumns(state.items)) {
      const cards = h('ul');
      column.items.forEach((issue) => cards.append(h('li.maintenance-card', {}, h('button.maintenance-note', {
        type: 'button', title: issue.title, style: `background:${['#fff7b0', '#ffd6e0', '#caffbf', '#bde0fe', '#ffe5b4'][issue.number % 5]}`,
        onclick: () => openMaintenanceIssue(issue, correct, send),
      }, h('strong', {}, `#${issue.number}`), h('span', {}, issue.title), ...(issue.doneBy && issue.state === 'OPEN' ? [h('small.done-flag', {}, `✅ ${issue.doneBy}, still open`)] : [])),
        ...(issue.state === 'OPEN' ? [h('button.btn.maintenance-close', { type: 'button', title: `Close issue #${issue.number} on GitHub`, 'aria-label': `Close issue #${issue.number}`, onclick: (e: Event) => {
          const button = e.currentTarget as HTMLButtonElement;
          button.disabled = true;
          closeError = '';
          void maintenancePost('/api/maintenance/queue', { number: issue.number, close: true })
            .then(() => send({ t: 'maintenance.issues' }))
            .catch((error) => { closeError = `Couldn't close #${issue.number}: ${error.message}`; render(); });
        } }, '✓ Close')] : []))));
      if (!column.items.length) cards.append(h('li.empty', {}, state.loading ? 'Loading…' : 'Nothing here'));
      columns.append(h('section.column', {}, h('h4', {}, `${column.title} · ${column.items.length}`), cards));
    }
    body.append(columns);
  };
  const unsub = store.on('maintenanceIssues', render);
  const modal = openModal(el, { onClose: unsub });
  render();
  send({ t: 'maintenance.issues' });
  return modal;
}
