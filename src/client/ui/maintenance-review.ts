import type { ClientMsg, MaintenanceChatState } from '../../shared/protocol';
import { h } from './dom';
import { maintenanceJson } from './maintenance-board';
import { confirmDialog } from './prompt';
import { actions, button, empty, fill, heading, note, row } from '../lite/kit';

export async function maintenanceReview(subview: HTMLElement, stack: NonNullable<MaintenanceChatState['stack']>, worker: MaintenanceChatState['worker'], send: (message: ClientMsg) => void, openChange: (sha: string) => void) {
  const w = worker;
  const shipping = stack.phase === 'shipping';
  const agentBusy = !!w && !['idle', 'done', 'exited'].includes(w.status);
  const total = stack.changes.length + (stack.dirty ? 1 : 0);
  const check = button('🧪 Run typecheck, tests & build', () => send({ t: 'maintenance.check' }));
  check.disabled = stack.validation?.phase === 'running' || shipping || agentBusy;
  const ship = button(shipping ? '⏳ Shipping…' : `🚀 Commit, push & rebuild${total > 1 ? ` (${total} changes)` : ''}`, () => confirmDialog('Ship the stack?', 'Runs the typecheck and tests, pushes, rebuilds and restarts the office once for everyone. Workers keep running through the restart.', 'Ship it', () => send({ t: 'maintenance.ship' })), 'primary');
  ship.disabled = shipping || agentBusy || stack.validation?.phase === 'running' || !!stack.unavailable || (!stack.changes.length && !stack.dirty);
  const working = h('div', {}, h('p.lp-note', {}, 'Loading working edits…'));
  fill(
    subview,
    note(`${stack.changes.length} stacked commit${stack.changes.length === 1 ? '' : 's'} · ${stack.dirty} edited file${stack.dirty === 1 ? '' : 's'} · ${stack.branch ?? 'maintenance/stack'}`),
    stack.unavailable ? h('p.setting-note.bad', { role: 'alert' }, stack.unavailable) : null,
    stack.validation ? h('p.lp-note', {}, stack.validation.phase === 'running' ? `⏳ Checking: ${stack.validation.step ?? 'Starting'}…` : `${stack.validation.phase === 'passed' ? '✅' : '❌'} Checks ${stack.validation.phase} · ${new Date(stack.validation.finishedAt ?? stack.validation.at).toLocaleString()}${stack.validation.sha ? ` · HEAD ${stack.validation.sha}` : ''}`) : null,
    stack.validation?.error ? h('pre.maintenance-diff', {}, stack.validation.error) : null,
    shipping ? h('p.laptop-wait', {}, h('span.spinner'), ` ${stack.step ?? 'Shipping'}…${stack.by ? ` (started by ${stack.by})` : ''}`) : null,
    stack.phase === 'failed' && stack.error ? h('pre.upgrade-error', {}, stack.error) : null,
    stack.note ? h('p.upgrade-status.ok', {}, stack.note) : null,
    actions(check, ship, button('Refresh diff', () => void maintenanceReview(subview, stack, worker, send, openChange))),
    heading('Stacked changes'),
    ...(stack.changes.length ? [...stack.changes].reverse().map((c) => row({ icon: '🔹', title: c.subject, sub: c.sha, onclick: () => openChange(c.sha) })) : [empty('🛠️', 'Nothing stacked', 'Ask Maintenance for something in Chat.')]),
    heading('Uncommitted work'),
    working,
  );
  try {
    const r = await maintenanceJson<{ files: string; diff: string; truncated: boolean }>('/api/maintenance/working');
    if (!working.isConnected) return;
    fill(working, h('pre.maintenance-working-files', {}, r.files || 'No uncommitted changes.'), r.diff ? h('details', {}, h('summary', {}, 'Tracked working diff'), h('pre.maintenance-diff', {}, r.diff)) : null, r.truncated ? h('p.lp-note', {}, 'Large changes: truncated. Ask Maintenance to explain the rest.') : null);
  } catch (err) {
    if (working.isConnected) fill(working, h('p.maintenance-chat-error', {}, (err as Error).message));
  }
}

