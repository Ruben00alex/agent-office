import type { ClientMsg, GhIssue, GhLabel, MaintenanceChatState, MaintenanceWorkItem } from '../../shared/protocol';
import { store } from '../state';
import { h, timeAgo } from './dom';
import { openMaintenanceIssue } from './maintenance-board';
import { maintenanceIssueColumns, MAINTENANCE_QUEUE_LABEL, type MaintenanceLane } from '../../shared/maintenance-issues';
import { imageEvidence } from './maintenance-images';
import { hasIssueDraft, issueCrafting, maintenancePost, openIssueCrafter, watchIssueJobs } from './maintenance-issue-crafter';
import { openStackChange } from './maintenance';

export { maintenancePost } from './maintenance-issue-crafter';

/** + Add issue everywhere opens the crafter, carrying on any conversation this browser has going. */
export function openMaintenanceIssueCreate(saved: () => void) { return openIssueCrafter({ saved }); }

/** A GitHub label as a chip tinted with its own color, the text darkened from it so it stays readable. */
export function labelChip(label: GhLabel) {
  const hex = (label.color ?? '').replace('#', '').padEnd(6, '0').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) || 0);
  const text = `rgb(${[r, g, b].map(c => Math.round(c * 0.45)).join(',')})`;
  return h('span.issue-tag', { style: `background:#${hex}2e;border-color:#${hex}66;color:${text}` }, label.name);
}

const LANE_ORDER: MaintenanceLane[] = ['progress', 'review', 'queued', 'open', 'closed'];
const CLOSED_SHOWN = 10;
let closedOpen = false;
let watching = false;

export function workPanel(...args: Parameters<typeof workPanelParts>) {
  const { head, list } = workPanelParts(...args);
  return h('div.maintenance-work-panel', {}, head, ...list.childNodes);
}

/** The Work view in two parts: its controls (`head`), which the 2D view keeps fixed above the issue list (`list`), which scrolls. */
export function workPanelParts(state: MaintenanceChatState, send: (message: ClientMsg) => void, start: (item: MaintenanceWorkItem) => void, correct: (context?: string) => void, refresh: () => void, viewConversation: (id: string) => void) {
  // Crafting turns may have been started from another view or browser: show them here too.
  if (!watching) { watching = true; watchIssueJobs(); }
  const head = h('div.maintenance-work-head');
  const panel = h('div.maintenance-work-list');
  const github = store.maintenanceIssues;
  const error = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const fail = (message: string) => { error.textContent = message; error.classList.remove('hidden'); };
  const act = (promise: Promise<unknown>) => void promise.then(() => { send({ t: 'maintenance.issues' }); refresh(); }).catch(err => fail(err.message));
  const work = state.work ?? [];
  const workOf = (issue: GhIssue) => work.find(i => i.number === issue.number);
  const columns = maintenanceIssueColumns(github.items, issue => { const w = workOf(issue); return w ? { status: w.status, commits: w.commits.length } : undefined; });
  const queued = columns.find(c => c.lane === 'queued')!.items;
  const busy = !!state.worker && !['idle', 'done', 'exited'].includes(state.worker.status);
  const blocked = busy || work.some(i => i.status === 'running') || state.stack?.phase === 'shipping' || state.stack?.validation?.phase === 'running';
  const startIssue = (issue: GhIssue) => start(workOf(issue) ?? { repo: github.repo ?? '', number: issue.number, title: issue.title, url: issue.url, status: 'queued', by: issue.author, at: 0, attachments: [], commits: [] });
  const crafting = issueCrafting();
  const next = queued[0];
  head.append(h('div.maintenance-section-heading', {}, h('div', {}, h('h3', {}, 'Engineering backlog'), h('p', {}, `${github.repo ?? 'Agent Office'} · GitHub issues${github.loading ? ' · refreshing…' : github.fetchedAt ? ` · updated ${timeAgo(github.fetchedAt)}` : ''}`)),
    h('span.maintenance-add-wrap', {}, crafting ? h('span.maintenance-add-orb', { 'aria-hidden': 'true', title: 'The issue writer is drafting' }) : null,
      h('button.maintenance-add-issue', { type: 'button', onclick: () => openMaintenanceIssueCreate(refresh) }, crafting ? '✍️ Drafting…' : hasIssueDraft() ? '✍️ Continue draft' : '+ Add issue')),
    h('button', { type: 'button', title: 'Refresh issues from GitHub', disabled: github.loading, onclick: () => { send({ t: 'maintenance.issues' }); watchIssueJobs(); } }, '↻ Refresh')), error,
    h('div.maintenance-work-intro', {}, h('button', { type: 'button', 'aria-label': 'Start next queued issue', title: next ? `Start #${next.number}: ${next.title}` : undefined, disabled: blocked || !next || !!github.error || github.loading, onclick: () => next && startIssue(next) }, next ? `▶ Start #${next.number}` : '▶ Start next'),
      h('p', {}, next ? `Next up: ${next.title}` : 'Nothing queued. Queue an issue from the backlog to give Maintenance something to do.')));
  if (github.error) head.append(h('p.maintenance-chat-error', { role: 'alert' }, github.error));

  for (const lane of LANE_ORDER) {
    const column = columns.find(c => c.lane === lane)!;
    // Lanes that only matter while something is in them stay out of the way otherwise.
    if (!column.items.length && (lane === 'progress' || lane === 'review')) continue;
    const shown = lane === 'closed' ? column.items.slice(0, CLOSED_SHOWN) : column.items;
    const cards = shown.map(issue => card(issue, lane, queued.indexOf(issue)));
    const empty = column.items.length ? [] : [h('p.maintenance-muted', {}, github.loading ? 'Refreshing GitHub…' : lane === 'queued' ? 'Nothing queued.' : 'No open issues.')];
    if (lane === 'closed') {
      const details = h('details.work-lane.lane-closed', { open: closedOpen }, h('summary', {}, h('h4', {}, `${column.title}`, h('span.lane-count', {}, String(column.items.length)))), ...cards,
        ...(column.items.length > CLOSED_SHOWN && github.repo ? [h('a.lane-more', { href: `https://github.com/${github.repo}/issues?q=is%3Aissue+is%3Aclosed`, target: '_blank', rel: 'noopener noreferrer' }, `Older closed issues on GitHub ↗`)] : []));
      details.addEventListener('toggle', () => { closedOpen = details.open; });
      panel.append(details);
    } else panel.append(h(`section.work-lane.lane-${lane}`, {}, h('h4', {}, column.title, h('span.lane-count', {}, String(column.items.length))), ...cards, ...empty));
  }
  return { head, list: panel };

  function card(issue: GhIssue, lane: MaintenanceLane, position: number) {
    const item = workOf(issue);
    const open = issue.state === 'OPEN';
    const running = item?.status === 'running';
    const tags: HTMLElement[] = [];
    const pill = (text: string, tone = '') => tags.push(h(`span.issue-pill${tone ? `.${tone}` : ''}`, {}, text));
    if (lane === 'progress') pill(running ? '🤖 Agent working' : `👤 ${issue.assignees.join(', ') || 'In progress'}`, 'is-active');
    if (lane === 'review') {
      if (item?.status === 'review') pill('🤖 Agent finished · review it', 'is-attention');
      else if (item?.status === 'done') pill('👍 Reviewed · ship the stack', 'is-good');
      else if (item?.status === 'paused') pill(`⏸ Interrupted · ${item.commits.length} commit${item.commits.length === 1 ? '' : 's'}`, 'is-attention');
      if (issue.doneBy) pill(`✅ ${issue.doneBy}`, 'is-good');
    }
    if (lane === 'queued') pill(position === 0 ? '⏭ Next up' : `#${position + 1} in line`, position === 0 ? 'is-active' : '');
    if (lane === 'open' && item?.status === 'paused') pill('⏸ Interrupted');
    const labels = issue.labels.filter(l => l.name !== MAINTENANCE_QUEUE_LABEL).map(labelChip);
    const meta = [issue.updatedAt ? `updated ${timeAgo(issue.updatedAt)}` : '', issue.author ? `by ${issue.author}` : '', lane !== 'progress' && issue.assignees.length ? `assigned to ${issue.assignees.join(', ')}` : ''].filter(Boolean).join(' · ');

    const primary: HTMLElement[] = [];
    const secondary: HTMLElement[] = [];
    const button = (label: string, onclick: (e: Event) => void, attrs: Record<string, unknown> = {}) => h('button', { type: 'button', onclick, ...attrs }, label);
    const close = (main: boolean) => button('✓ Close', (e: Event) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      error.classList.add('hidden');
      void maintenancePost('/api/maintenance/queue', { number: issue.number, close: true })
        .then(() => { send({ t: 'maintenance.issues' }); refresh(); })
        .catch(err => { fail(`Couldn't close #${issue.number}: ${err.message}`); (e.target as HTMLButtonElement).disabled = false; });
    }, { class: main ? 'is-primary' : 'is-ghost', title: `Close issue #${issue.number} on GitHub`, 'aria-label': `Close issue #${issue.number}`, disabled: running });
    if (item?.workerId && (lane === 'progress' || lane === 'review')) (lane === 'progress' ? primary : secondary).push(button('💬 Conversation', () => viewConversation(item.workerId!), { class: lane === 'progress' ? 'is-primary' : 'is-ghost' }));
    if (open && lane === 'review') {
      if (item?.status === 'review') primary.push(button('Mark reviewed', () => act(maintenancePost('/api/maintenance/queue', { number: issue.number, reviewed: true })), { class: 'is-primary' }));
      primary.push(close(item?.status !== 'review'));
    }
    if (open && lane === 'queued') {
      primary.push(button('▶ Start', () => (!issue.doneBy || confirm(`#${issue.number} looks already done (${issue.doneBy}) but is still open. Start Maintenance on it anyway?`)) && startIssue(issue), { class: 'is-primary', disabled: blocked || !!github.error || github.loading }));
      secondary.push(button('Unqueue', () => act(maintenancePost('/api/maintenance/queue', { number: issue.number, remove: true })), { class: 'is-ghost', 'aria-label': 'Remove from queue', title: 'Remove from the Maintenance queue' }));
    }
    if (open && (lane === 'open' || lane === 'progress') && !running) (lane === 'open' ? primary : secondary).push(button('⏳ Queue', () => act(maintenancePost('/api/maintenance/queue', { number: issue.number, attachments: item?.attachments.map(i => i.id) ?? [] })), { class: lane === 'open' ? 'is-primary' : 'is-ghost', title: 'Add to the Maintenance queue' }));
    secondary.push(button('✎ Edit', () => openIssueCrafter({ issue, saved: refresh }), { class: 'is-ghost', 'aria-label': `Edit issue #${issue.number}` }));
    if (open && lane !== 'review') secondary.push(close(false));
    secondary.push(h('a.is-ghost', { href: issue.url, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub ↗'));

    const el = h(`article.maintenance-work-card.card-${lane}`, {},
      h('div.work-card-title', {}, h('span.issue-number', {}, `#${issue.number}`), h('button.maintenance-issue-title', { type: 'button', onclick: () => openMaintenanceIssue(issue, correct, send) }, issue.title)),
      ...(tags.length || labels.length ? [h('div.work-card-tags', {}, ...tags, ...labels)] : []),
      ...(meta ? [h('small.work-card-meta', {}, meta)] : []),
      ...(item?.attachments.length ? [imageEvidence(item.attachments)] : []),
      ...(item?.commits.length && lane !== 'closed' ? [h('div.work-card-commits', {}, ...item.commits.map(commit => h('button', { type: 'button', class: 'is-commit', onclick: () => openStackChange(commit, { correct, watch() {} }) }, h('code', {}, commit.sha.slice(0, 7)), ` ${commit.subject}`)))] : []),
      ...(lane === 'closed' ? [] : [h('div.work-card-actions', {}, ...primary, h('span.grow'), ...secondary)]));
    el.addEventListener('click', e => { if (!(e.target as Element).closest('button, a, img, input, select, textarea, summary')) openMaintenanceIssue(issue, correct, send); });
    return el;
  }
}
