import type { ClientMsg, MaintenanceChatMessage, MaintenanceChatState, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { fullPlanWindow } from '../../shared/protocol';
import { PRODUCT_DESK } from '../../shared/layout';
import { store } from '../state';
import { h, openModal } from './dom';
import { confirmDialog } from './prompt';
import { maintenanceContent, marqueeTitle } from './maintenance-chat';
import { generateTitleButton, maintenanceJson } from './maintenance-board';
import { providerPicker, workerChoice } from './provider';

type Sent = Extract<ServerMsg, { t: 'product.chat.sent' }>;
const receipts = new Set<(message: Sent) => void>();
export function onProductChatSent(message: Sent) { receipts.forEach(receive => receive(message)); }

function bubble(message: MaintenanceChatMessage) {
  const user = message.role === 'user';
  return h('article.maintenance-message', { class: user ? 'from-user' : 'from-agent', 'data-message': message.id },
    h('div.maintenance-message-meta', {}, h('b', {}, user ? message.by ?? 'You' : 'Product Lead'),
      h('time', { datetime: new Date(message.at).toISOString() }, new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
    h('div.maintenance-bubble', {}, user ? h('p.maintenance-user-text', {}, message.content) : maintenanceContent(message.content)));
}

/**
 * The chat with the Product Lead standing by on this floor: a conversation partner for the project
 * (think out loud, brainstorm, ask about the code), not a worker taking requests. It's a view over that
 * agent's one session; archived conversations are read-only.
 */
export function openProductChat(send: (message: ClientMsg) => void, watch: (worker: WorkerInfo) => void, startNew = false) {
  let closed = false;
  let selected: string | undefined;
  let newConversation = startNew;
  let state: MaintenanceChatState | undefined;
  let generation = 0;
  let messageKey = '';
  let archiveKey = '';
  let historyFailed = false;
  let messages: MaintenanceChatMessage[] = [];
  let pending: { id: string; text: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const floor = store.floor ?? '';
  const draftKey = 'agent-office.product-draft-v1';
  const draftScope = () => `${floor}:${newConversation ? 'new' : selected ?? state?.worker?.id ?? 'current'}`;
  let loadedDraft = '';
  let drafts: Record<string, string> = {};
  try { const saved = JSON.parse(localStorage.getItem(draftKey) ?? '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) drafts = saved; } catch { /* Storage unavailable. */ }

  const search = h('input', { type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search Product Lead conversations' });
  const archive = h('div.maintenance-chat-archive');
  const list = h('div.maintenance-chat-messages', { role: 'log', 'aria-label': 'Conversation with the Product Lead', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const status = h('span.maintenance-chat-status', {}, 'Connecting…');
  const conversationTitle = h('div.maintenance-chat-title');
  const error = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const note = h('p.maintenance-composer-note');
  const input = h('textarea', { rows: 2, maxlength: 20000, placeholder: 'What’s on your mind about the project?', 'aria-label': 'Message to the Product Lead' });
  const older = h('button.maintenance-older.hidden', { type: 'button' }, 'Load earlier messages');
  const submit = h('button.maintenance-send', { type: 'submit' }, 'Send');
  const retitle = generateTitleButton('/api/product/chat-title', () => state?.conversation?.id, () => void refresh(), (m) => showError(m));
  const terminal = h('button', { type: 'button', onclick: () => { if (state?.worker) { modal.close(); watch(state.worker); } } }, 'Open terminal');
  const end = h('button', { type: 'button', onclick: () => {
    const worker = state?.worker;
    if (!worker) return;
    confirmDialog('End Product Lead session?', 'Stops the active session for everyone, including unfinished replies. Earlier conversations remain in history.', 'End session', () => {
      send({ t: 'worker.kill', workerId: worker.id });
      create.click();
    });
  } }, 'End session');
  const current = h('button.maintenance-current', { type: 'button', onclick: () => { saveDraft(); newConversation = false; selected = undefined; loadedDraft = ''; messageKey = ''; messages = []; void refresh(); } }, 'Current conversation');
  const create = h('button.maintenance-new', { type: 'button', onclick: () => {
    saveDraft(); newConversation = true; selected = undefined; loadedDraft = ''; messages = []; messageKey = ''; showError(''); void refresh().then(() => input.focus());
  } }, '+ New conversation');
  // The Product Lead is on what it was started on; picking something else moves it there.
  const model = providerPicker(store.project, 'product-provider', 'Runs on', () => newConversation ? undefined : workerChoice(state?.worker));
  model.element.addEventListener('click', () => setTimeout(updateControls));
  const form = h('form.maintenance-chat-composer', {}, error, input, h('div.maintenance-composer-bottom', {}, note, submit));
  const close = h('button.close', { type: 'button', 'aria-label': 'Close Product Lead chat' }, '✕');
  const el = h('div.modal.maintenance-chat.product-chat', { role: 'dialog', 'aria-label': 'Chat with the Product Lead' },
    h('header', {}, h('div', {}, h('span.maintenance-experiment', {}, 'AGENT OFFICE · PRODUCT'), h('h2', {}, '🧭 Product Lead'), status),
      conversationTitle,
      h('div.maintenance-chat-tools', {}, retitle, terminal, end, close)),
    h('div.maintenance-chat-layout', {},
      h('aside', {}, create, current, h('h3', {}, 'Past conversations'), h('small', {}, 'Shared with everyone on this floor'), search, archive),
      h('section.maintenance-chat-main', {}, older, list, model.element, form)));
  const modal = openModal(el, { doing: 'chatting with the Product Lead', onClose: () => {
    saveDraft();
    closed = true;
    generation++;
    clearInterval(poll);
    if (pending) clearTimeout(pending.timer);
    receipts.delete(receive);
    offWorkers();
  } });
  close.addEventListener('click', () => modal.close());

  function showError(text: string) { error.textContent = text; error.classList.toggle('hidden', !text); }
  function drawArchive() {
    if (!state) return;
    const q = search.value.trim().toLowerCase();
    const entries = state.conversations.filter(c => c.title.toLowerCase().includes(q));
    const active = newConversation ? undefined : selected ?? state.worker?.id;
    archive.replaceChildren(...entries.map(c => h('button.maintenance-conversation', {
      type: 'button', class: active === c.id ? 'selected' : '', 'aria-pressed': String(active === c.id),
      onclick: () => { saveDraft(); newConversation = false; selected = c.id; loadedDraft = ''; messages = []; messageKey = ''; void refresh(); },
    }, marqueeTitle(c.title), h('small', {}, `${new Date(c.updatedAt).toLocaleDateString()} · ${c.count} messages`))),
    ...(!entries.length ? [h('p.maintenance-archive-empty', {}, q ? 'No matching conversations' : 'Conversations appear here once you start talking.')] : []));
  }
  search.addEventListener('input', drawArchive);
  function saveDraft() {
    if (loadedDraft) drafts[loadedDraft] = input.value;
    try { localStorage.setItem(draftKey, JSON.stringify(drafts)); } catch { /* Storage unavailable. */ }
  }
  function loadDraft() {
    const scope = draftScope();
    if (loadedDraft === scope) return;
    loadedDraft = scope;
    input.value = typeof drafts[scope] === 'string' ? drafts[scope] : '';
  }
  function updateControls() {
    const worker = state?.worker;
    model.repaint();
    const archived = !newConversation && !!selected && selected !== worker?.id;
    const waiting = worker?.status === 'needs_input';
    // Stuck on a provider whose plan is used up, a message moves it to one with room (the server picks it).
    const spent = !!worker && !!fullPlanWindow(worker.provider === 'claude' ? store.limits : worker.provider === 'codex' ? store.codexLimits : undefined);
    const busy = !!worker && !['idle', 'done', 'exited'].includes(worker.status);
    status.textContent = worker ? (worker.status === 'working' ? 'thinking…' : waiting ? 'waiting on you' : worker.status === 'starting' ? 'getting settled…' : 'here') : 'here whenever you want to talk';
    const activeTitle = newConversation ? 'New conversation' : state?.conversations.find(c => c.id === (selected ?? worker?.id))?.title ?? '';
    if (conversationTitle.title !== activeTitle) { conversationTitle.title = activeTitle; conversationTitle.textContent = activeTitle; }
    terminal.disabled = !worker;
    end.disabled = !worker || !!pending;
    create.disabled = !!pending;
    input.disabled = !!pending || archived || !state || historyFailed;
    submit.disabled = input.disabled || (waiting && !model.edited() && !spent) || (newConversation && busy);
    note.textContent = newConversation ? (busy ? 'End the current session to stop its reply and start a new conversation.' : 'A fresh start: the earlier conversations stay in the list.')
      : archived ? 'An earlier conversation, read-only. Choose Current conversation to carry on talking.'
      : waiting ? 'The Product Lead is waiting for an answer or an approval. Open its terminal to respond.'
      : state && !state.richReplies ? 'This provider replies in its terminal; your messages are still kept here.'
      : busy ? 'Replying… you can keep typing, your next message waits its turn · Shift+Enter for a new line'
      : 'Enter to send · Shift+Enter for a new line · anyone on this floor can join in';
    current.setAttribute('aria-pressed', String(!newConversation && !archived));
  }
  async function refresh(before?: string) {
    const ticket = ++generation;
    const previousSelected = selected;
    try {
      const params = new URLSearchParams({ floor });
      if (selected) params.set('thread', selected);
      if (before) params.set('before', before);
      let next = await maintenanceJson<MaintenanceChatState>(`/api/product/chat?${params}`);
      if (closed || ticket !== generation || previousSelected !== selected) return;
      state = next;
      loadDraft();
      if (historyFailed) { showError(''); historyFailed = false; }
      if (newConversation) next = { ...next, conversation: undefined };
      const incoming = next.conversation?.messages ?? [];
      const sameThread = list.dataset.thread === next.conversation?.id;
      const byId = new Map<string, MaintenanceChatMessage>();
      if (sameThread) messages.forEach(m => byId.set(m.id, m));
      // A message accepted by the office is replaced by its transcript entry once that is logged.
      const logged = new Set(incoming.filter(m => !m.pending && m.role === 'user').map(m => m.content));
      for (const [id, m] of byId) if (m.pending && logged.has(m.content)) byId.delete(id);
      incoming.forEach(m => byId.set(m.id, m));
      messages = [...byId.values()].sort((a, b) => a.at - b.at);
      const key = JSON.stringify([next.conversation?.id, messages]);
      if (key !== messageKey) {
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
        const height = list.scrollHeight;
        const top = list.scrollTop;
        messageKey = key;
        list.dataset.thread = next.conversation?.id ?? '';
        list.replaceChildren(...messages.map(bubble), ...(!messages.length ? [h('div.maintenance-chat-empty', {}, h('h3', {}, 'What’s on your mind?'), h('p', {}, 'Think out loud about the project, bounce an idea around, or ask how something works. No ticket needed: it’s just a conversation.'))] : []));
        if (before) list.scrollTop = top + list.scrollHeight - height;
        else if (atBottom || !sameThread) list.scrollTop = list.scrollHeight;
      }
      if (before || !sameThread || messages.length === incoming.length) older.classList.toggle('hidden', !next.conversation?.hasOlder);
      const aKey = JSON.stringify([next.conversations, selected, next.worker?.id, newConversation]);
      if (archiveKey !== aKey) { archiveKey = aKey; drawArchive(); }
      updateControls();
    } catch (err) {
      if (!closed && ticket === generation) { historyFailed = true; showError(`Could not load the conversation: ${(err as Error).message}`); status.textContent = 'Connection unavailable · retrying'; updateControls(); }
    }
  }
  older.addEventListener('click', () => { if (messages.length) void refresh(messages[0].id); });
  function receive(message: Sent) {
    if (pending?.id !== message.id || closed) return;
    clearTimeout(pending.timer);
    const text = pending.text;
    pending = undefined;
    if (message.error) { input.value = text; showError(message.error); updateControls(); input.focus(); return; }
    input.value = '';
    if (loadedDraft) delete drafts[loadedDraft];
    loadedDraft = '';
    saveDraft();
    newConversation = false;
    selected = message.workerId;
    messageKey = '';
    void refresh().then(() => { if (!closed) input.focus(); });
  }
  receipts.add(receive);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || submit.disabled || !model.valid()) return;
    showError('');
    const id = crypto.randomUUID();
    saveDraft();
    pending = { id, text, timer: setTimeout(() => {
      pending = undefined;
      updateControls();
      showError('No answer from the office yet. Check the terminal before sending again.');
    }, 30_000) };
    updateControls();
    send({ t: 'product.chat.send', id, prompt: text, ...(model.edited() ? { provider: model.value(), model: model.model(), effort: model.effort() } : {}), ...(newConversation ? { newConversation: true } : { thread: selected }) });
  });
  input.addEventListener('input', saveDraft);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  const offWorkers = store.on('workers', () => void refresh());
  const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
  updateControls();
  void refresh().then(() => { if (!closed && !input.disabled) input.focus(); });
  return modal;
}

/** Whether this worker is the Product Lead: its chat is the way in, not its terminal. */
export const isProductLead = (w: Pick<WorkerInfo, 'deskId'>) => w.deskId === PRODUCT_DESK;
