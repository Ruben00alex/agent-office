import type { ClientMsg, MaintenanceChatState, ServerMsg } from '../../shared/protocol';
import { h, openModal } from './dom';
import { openStackChange, type MaintenanceActions } from './maintenance';
import { agentWorkspace } from './maintenance-workspace';
import { marqueeTitle } from './maintenance-content';
import { openMaintenanceIssueCreate } from './maintenance-work';
export { maintenanceContent, marqueeTitle } from './maintenance-content';

type Sent = Extract<ServerMsg, { t: 'maintenance.chat.sent' }>;
const receipts = new Set<(message: Sent) => void>();
export function onMaintenanceChatSent(message: Sent) { receipts.forEach(receive => receive(message)); }

/** 3D shell only: sidebar, modal lifetime and navigation back into the office. */
export function openMaintenanceChat(send: (message: ClientMsg) => void, actions: MaintenanceActions, _reviewStack: () => void, initial = '', startNew = false) {
  const status = h('span.maintenance-chat-status');
  const search = h('input', { type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search Maintenance history' });
  const archive = h('div.maintenance-chat-archive');
  let history: MaintenanceChatState | undefined;
  let selected: string | undefined;
  let fresh = startNew;
  const paintHistory = () => {
    const active = fresh ? undefined : selected ?? history?.worker?.id;
    const entries = history?.conversations.filter(c => c.title.toLowerCase().includes(search.value.toLowerCase())) ?? [];
    archive.replaceChildren(...entries.map(c => h('button.maintenance-conversation', {
      type: 'button', class: active === c.id ? 'selected' : '', 'aria-pressed': String(active === c.id),
      onclick: () => workspace.pick(c.id),
    }, marqueeTitle(c.title), h('small', {}, `${new Date(c.updatedAt).toLocaleDateString()} · ${c.count} messages`))));
  };
  const workspace = agentWorkspace('maintenance', {
    send,
    subscribe: receive => { receipts.add(receive); return () => receipts.delete(receive); },
    subtitle: text => { status.textContent = text ?? ''; },
    navigate: () => {},
    terminal: (worker, floor) => { modal.close(); actions.watch(worker, floor); },
    openChange: (sha, correct) => {
      const commit = history?.stack?.changes.find(c => c.sha === sha);
      if (commit) openStackChange(commit, { ...actions, correct });
    },
    history: (next, thread, isNew) => { history = next; selected = thread; fresh = isNew; paintHistory(); },
  }, initial, startNew);
  search.addEventListener('input', paintHistory);
  const tools = h('div.maintenance-chat-tools', {}, ...(workspace.actions ?? []));
  // Keep host controls thin; their behavior comes from the shared workspace menu.
  const menu = h('button', { type: 'button', 'aria-label': 'Maintenance actions', onclick: () => {
    const items = workspace.menu().filter(item => !item.hidden);
    const panel = h('div.modal', { role: 'dialog', 'aria-label': 'Maintenance actions' }, h('header', {}, h('h2', {}, 'Maintenance actions')));
    const sheet = openModal(panel);
    panel.append(h('div.body', {}, ...items.map(item => h('button.btn', { type: 'button', onclick: () => { sheet.close(); item.run(); } }, `${item.icon} ${item.label}`))));
  } }, '⋯');
  tools.append(menu);
  const el = h('div.modal.maintenance-chat', { role: 'dialog', 'aria-label': 'Maintenance engineering workspace' },
    h('header', {}, h('div', {}, h('h2', {}, 'Maintenance'), status), tools),
    h('div.maintenance-chat-layout', {},
      h('aside', {},
        h('button', { type: 'button', onclick: () => openMaintenanceIssueCreate(() => send({ t: 'maintenance.issues' })) }, '+ Add issue'),
        h('button', { type: 'button', onclick: () => workspace.pick(undefined, true) }, '+ New conversation'),
        h('button', { type: 'button', onclick: () => workspace.pick(undefined) }, 'Current conversation'),
        h('h3', {}, 'Conversation archive'), search, archive),
      workspace.el));
  const modal = openModal(el, { doing: 'chatting with Maintenance', onClose: () => workspace.dispose() });
  return Object.assign(modal, { review: workspace.review });
}
