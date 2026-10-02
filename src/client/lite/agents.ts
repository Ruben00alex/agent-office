// The Agents tab: the Product Lead and Maintenance as full-screen chats, the board agents, the
// laptop that answers questions about the office, and Maintenance's work, review and shipping.

import type { MaintenanceAttachment, MaintenanceChatMessage, MaintenanceChatState, MaintenanceWorkItem, ServerMsg } from '../../shared/protocol';
import { MAINTENANCE_DESK, MAINTENANCE_MODEL, PRODUCT_DESK, STATION_AGENT, STATIONS } from '../../shared/layout';
import { isAsleep, isBusy } from '../../shared/status';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { markdown } from '../ui/markdown';
import { openPrompt, confirmDialog } from '../ui/prompt';
import { providerPicker, workerChoice } from '../ui/provider';
import { maintenanceContent } from '../ui/maintenance-chat';
import { maintenanceJson } from '../ui/maintenance-board';
import { imageComposer, imageEvidence } from '../ui/maintenance-images';
import { openMaintenanceIssueCreate, workPanel } from '../ui/maintenance-work';
import { renderDiff } from '../ui/changes';
import { go, live, type Screen } from './app';
import { actions, button, empty, fill, heading, note, page, row, segmented, textarea } from './kit';
import { net, onServerMessage, openWorker } from './ctx';

const on = store.on.bind(store);

const STATION_INFO: Record<string, { icon: string; offer: string; example: string }> = {
  issues: { icon: '📌', offer: 'I file, find, triage, label and close issues', example: 'File an issue: the dog walks straight through the jukebox' },
  pulls: { icon: '🔀', offer: 'I sum up, review, comment on and merge PRs', example: 'Review the newest PR and tell me if it’s ready to merge' },
  queue: { icon: '📋', offer: 'I turn requests into tasks for fresh workers', example: 'Queue every open bug issue, most important first' },
};

/** A board agent's prompt: the same box the kiosk gives you at the office. */
function askBoardAgent(deskId: string, kind: string) {
  const w = store.workerAtDesk(deskId);
  const name = STATION_AGENT[kind as 'issues'].name;
  const info = STATION_INFO[kind];
  if (w?.status === 'needs_input') {
    toast(`The ${name} is waiting on an answer — here's its terminal`, 'warn');
    return openWorker(w.id);
  }
  openPrompt({
    title: `${info.icon} Ask the ${name}`,
    subtitle: !w ? `${info.offer}, in a terminal of its own.` : isAsleep(w.status) ? `The ${name} is asleep: this wakes it up.` : isBusy(w.status) ? `The ${name} is busy. Your prompt waits in its input box.` : undefined,
    placeholder: `e.g. ${info.example}`,
    submitLabel: 'Send ✨',
    providerOption: true,
    providerLabel: 'Runs on',
    providerCurrent: workerChoice(w),
    onSubmit: (text, o) => net.send({ t: 'station.prompt', deskId, prompt: text, ...(o.picked && o.provider ? { provider: o.provider, model: o.model, effort: o.effort } : {}) }),
  });
}

// ---- The tab ----------------------------------------------------------------------------------
export function agentsScreen(): Screen {
  const el = page();
  const paint = () => {
    const product = store.workerAtDesk(PRODUCT_DESK);
    const maint = store.workerAtDesk(MAINTENANCE_DESK);
    const stack = store.maintenance;
    const status = (w?: { status: string }) => (w ? (w.status === 'working' ? 'thinking…' : w.status === 'needs_input' ? '🙋 waiting on you' : 'here') : 'here whenever you want to talk');
    fill(
      el,
      heading('Talk to an agent'),
      row({ icon: '🧭', title: 'Product Lead', sub: `Think the project through · ${status(product)}`, onclick: () => go('agent/product') }),
      row({ icon: '🛠️', title: 'Maintenance', sub: `Changes the office itself · ${stack.changes.length ? `${stack.changes.length} change${stack.changes.length === 1 ? '' : 's'} stacked` : status(maint)}`, onclick: () => go('agent/maintenance') }),
      row({ icon: '💻', title: 'Ask about the office', sub: 'How Agent Office works, answered from its own code', onclick: () => go('agent/ask') }),
      heading('Board agents'),
      ...STATIONS.filter((s) => s.station && STATION_INFO[s.station]).map((s) => {
        const w = store.workerAtDesk(s.id);
        const info = STATION_INFO[s.station!];
        return row({ icon: info.icon, title: STATION_AGENT[s.station!].name, sub: `${info.offer}${w ? ` · ${w.status === 'needs_input' ? '🙋 waiting on you' : isAsleep(w.status) ? '💤 asleep' : w.status === 'working' ? 'working' : 'ready'}` : ''}`, onclick: () => askBoardAgent(s.id, s.station!) });
      }),
      heading('Permissions'),
      h(
        'label.lp-switch',
        {},
        h('input', { type: 'checkbox', checked: store.approvals.easy, onchange: (e: Event) => net.send({ t: 'approvals.set', easy: (e.target as HTMLInputElement).checked }) }),
        h('span.txt', {}, h('b', {}, '⚡ Easy approvals'), h('small', {}, 'Workers hired or resumed from now on start in their agent’s own automatic permission mode, so they stop asking for every command.')),
      ),
      store.approvals.easy && store.approvals.by ? note(`Turned on by ${store.approvals.by}.`) : null,
    );
  };
  return { title: 'Agents', el, dispose: live(on, ['workers', 'maintenance', 'approvals'], paint) };
}

// ---- The laptop -------------------------------------------------------------------------------
let counter = 0;
export function askScreen(): Screen {
  const ta = textarea('e.g. How does a worker get from the queue to a desk?', 3);
  const out = h('div.laptop-out', { 'aria-live': 'polite' });
  const send = button('Ask 💬', () => go_(), 'primary');
  let waiting = '';
  const busy = (b: boolean) => ((send.disabled = b), (ta.disabled = b));
  function go_() {
    const question = ta.value.trim();
    if (!question || send.disabled) return;
    waiting = `q${Date.now().toString(36)}${counter++}`;
    busy(true);
    fill(out, h('p.laptop-wait', {}, '⏳ Looking through the code…'));
    net.send({ t: 'maintenance.ask', id: waiting, question });
  }
  const off = onServerMessage((m: ServerMsg) => {
    if (m.t !== 'maintenance.answer' || m.id !== waiting) return;
    busy(false);
    if (m.error) fill(out, h('p.setting-note.bad', { role: 'alert' }, m.error));
    else fill(out, h('div.laptop-answer', {}, markdown(m.answer ?? '')), h('p.laptop-model', {}, `— ${m.model}`));
  });
  return { title: '💻 Ask about the office', el: page(note(`A small model (${MAINTENANCE_MODEL}) reads the office's own source and docs. To change something, tell Maintenance.`), ta, actions(send), out), dispose: off };
}

// ---- A chat with an agent ---------------------------------------------------------------------
interface ChatConfig {
  kind: 'product' | 'maintenance';
  name: string;
  endpoint: string;
  sendType: 'product.chat.send' | 'maintenance.chat.send';
  sentType: 'product.chat.sent' | 'maintenance.chat.sent';
  placeholder: string;
  emptyTitle: string;
  emptyText: string;
}

const CONFIG: Record<'product' | 'maintenance', ChatConfig> = {
  product: { kind: 'product', name: 'Product Lead', endpoint: '/api/product/chat', sendType: 'product.chat.send', sentType: 'product.chat.sent', placeholder: 'What’s on your mind about the project?', emptyTitle: 'What’s on your mind?', emptyText: 'Think out loud about the project, bounce an idea around, or ask how something works. No ticket needed: it’s just a conversation.' },
  maintenance: { kind: 'maintenance', name: 'Maintenance', endpoint: '/api/maintenance/chat', sendType: 'maintenance.chat.send', sentType: 'maintenance.chat.sent', placeholder: 'Ask Maintenance to build, fix, or explain something…', emptyTitle: 'What should we improve?', emptyText: 'Ask for a feature, report a bug, or follow up on a stacked change. Maintenance works in its own worktree; you review and ship the stack when ready.' },
};

function bubble(cfg: ChatConfig, m: MaintenanceChatMessage) {
  const user = m.role === 'user';
  return h(
    'article.maintenance-message',
    { class: user ? 'from-user' : 'from-agent', 'data-message': m.id },
    h('div.maintenance-message-meta', {}, h('b', {}, user ? (m.by ?? 'You') : cfg.name), h('time', {}, new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })), m.phase === 'commentary' ? h('span', {}, 'Progress') : m.pending ? h('span', {}, 'Accepted · awaiting agent') : null),
    h('div.maintenance-bubble', {}, user ? h('p.maintenance-user-text', {}, m.content) : maintenanceContent(m.content), m.attachments?.length ? imageEvidence(m.attachments) : null),
  );
}

type MaintenanceView = 'chat' | 'work' | 'review';
let maintenanceView: MaintenanceView = 'chat';
let carryDraft = '';

export function agentChatScreen([kind]: string[]): Screen {
  const cfg = CONFIG[kind === 'maintenance' ? 'maintenance' : 'product'];
  const maintenance = cfg.kind === 'maintenance';
  const floor = store.floor ?? '';
  let closed = false;
  let selected: string | undefined;
  let newConversation = false;
  let state: MaintenanceChatState | undefined;
  let generation = 0;
  let messages: MaintenanceChatMessage[] = [];
  let messageKey = '';
  let historyFailed = false;
  let showHistory = false;
  let view: MaintenanceView = maintenance ? maintenanceView : 'chat';
  let pending: { id: string; text: string; attachments: MaintenanceAttachment[]; timer: ReturnType<typeof setTimeout> } | undefined;
  const draftKey = `agent-office.lite-${cfg.kind}-draft`;
  let drafts: Record<string, string> = {};
  try {
    const s = JSON.parse(localStorage.getItem(draftKey) ?? '{}');
    if (s && typeof s === 'object' && !Array.isArray(s)) drafts = s;
  } catch {
    /* storage unavailable */
  }
  let loadedDraft = '';
  const scope = () => `${floor}:${newConversation ? 'new' : (selected ?? state?.worker?.id ?? 'current')}`;

  const list = h('div.maintenance-chat-messages.lp-chatlog', { role: 'log', 'aria-live': 'polite' });
  const status = h('p.lp-note.lp-chatstatus', {}, 'Connecting…');
  const errorEl = h('p.maintenance-chat-error.hidden', { role: 'alert' });
  const noteEl = h('p.lp-note');
  const input = h('textarea', { rows: 2, maxlength: 20000, placeholder: cfg.placeholder, 'aria-label': `Message to ${cfg.name}`, enterkeyhint: 'send' }) as HTMLTextAreaElement;
  if (carryDraft) {
    input.value = carryDraft;
    carryDraft = '';
  }
  const images = maintenance ? imageComposer(() => (saveDraft(), controls()), (t) => showError(t)) : null;
  const older = button('Load earlier messages', () => messages.length && void refresh(messages[0].id), 'hidden');
  const sendBtn = h('button.btn.primary', { type: 'submit' }, 'Send') as HTMLButtonElement;
  const model = providerPicker(store.project, `lite-${cfg.kind}-provider`, 'Runs on', () => (newConversation || view === 'work' ? undefined : workerChoice(state?.worker)));
  model.element.addEventListener('click', () => setTimeout(controls));
  const form = h('form.lp-composer', {}, errorEl, input, images?.element ?? null, h('div.lp-composer-row', {}, noteEl, sendBtn));
  const history = h('div.lp-history.hidden');
  const subview = h('div.lp-subview.hidden');
  const tools = h('div.lp-actions');
  const tabs = h('div');
  const el = page(status, tools, tabs, history, older, list, subview, model.element, form);

  function showError(text: string) {
    errorEl.textContent = text;
    errorEl.classList.toggle('hidden', !text);
  }
  const saveDraft = () => {
    if (loadedDraft) drafts[loadedDraft] = input.value;
    try {
      localStorage.setItem(draftKey, JSON.stringify(drafts));
    } catch {
      /* storage unavailable */
    }
  };
  const loadDraft = () => {
    const s = scope();
    if (loadedDraft === s) return;
    loadedDraft = s;
    if (!input.value || !drafts[s]) input.value = typeof drafts[s] === 'string' ? drafts[s] : input.value;
  };
  const pick = (thread: string | undefined, fresh = false) => {
    saveDraft();
    newConversation = fresh;
    selected = thread;
    loadedDraft = '';
    messages = [];
    messageKey = '';
    showHistory = false;
    showError('');
    paintFrame();
    void refresh();
  };

  function paintFrame() {
    const w = state?.worker;
    const busy = !!w && !['idle', 'done', 'exited'].includes(w.status);
    fill(
      tools,
      button('🕘 History', () => ((showHistory = !showHistory), paintFrame(), paintHistory())),
      button('+ New', () => pick(undefined, true)),
      w && state?.floor ? button('🖥️ Terminal', () => (state!.floor === store.floor ? openWorker(w.id) : switchAndOpen(w.id, state!.floor!))) : null,
      maintenance && w ? button('⏏️ End session', () => confirmDialog('End Maintenance session?', 'Stops the active session for everyone, including unfinished work. Conversation history, edited files and stacked commits remain.', 'End session', () => net.send({ t: 'worker.kill', workerId: w.id })), 'danger') : null,
    );
    if (maintenance) {
      fill(
        tabs,
        segmented<MaintenanceView>(
          [
            { id: 'chat', label: '💬 Chat' },
            { id: 'work', label: '📌 Work' },
            { id: 'review', label: '🚀 Review', count: store.maintenance.changes.length },
          ],
          view,
          (v) => ((view = maintenanceView = v), paintFrame(), paintView()),
        ),
      );
    }
    history.classList.toggle('hidden', !showHistory);
    const chat = view === 'chat';
    for (const x of [list, form]) x.classList.toggle('hidden', !chat || showHistory);
    older.classList.toggle('hidden', !chat || showHistory || !state?.conversation?.hasOlder);
    model.element.classList.toggle('hidden', view === 'review' || showHistory);
    subview.classList.toggle('hidden', chat || showHistory);
    void busy;
  }

  function paintHistory() {
    if (!showHistory || !state) return;
    const active = newConversation ? undefined : (selected ?? state.worker?.id);
    fill(
      history,
      ...(state.conversations.length
        ? state.conversations.map((c) => row({ icon: active === c.id ? '💬' : '🗨️', title: c.title, sub: `${new Date(c.updatedAt).toLocaleDateString()} · ${c.count} messages`, onclick: () => pick(c.id), cls: active === c.id ? 'on' : '' }))
        : [empty('🗨️', 'No conversations yet', 'They appear here once you start talking.')]),
    );
  }

  function controls() {
    const w = state?.worker;
    model.repaint();
    const archived = !newConversation && !!selected && selected !== w?.id;
    const waiting = w?.status === 'needs_input';
    const busy = !!w && !['idle', 'done', 'exited'].includes(w.status);
    status.textContent = w ? (w.status === 'working' ? `${cfg.name} is working…` : waiting ? '🙋 Waiting on you' : w.status === 'starting' ? 'Getting settled…' : `${cfg.name} · here${state?.floorName && maintenance ? ` · ${state.floorName}` : ''}`) : maintenance ? 'Ready for your first request' : 'Here whenever you want to talk';
    input.disabled = !!pending || archived || !state || historyFailed;
    images?.disable(input.disabled);
    sendBtn.disabled = input.disabled || !!images?.uploading || (waiting && !model.edited()) || (newConversation && busy) || state?.stack?.phase === 'shipping' || state?.stack?.validation?.phase === 'running';
    noteEl.textContent = newConversation
      ? busy ? 'Wait for the current reply to finish before starting a new conversation.' : 'A fresh start: earlier conversations stay in History.'
      : archived ? 'An earlier conversation, read-only. Tap History → the current one to carry on.'
        : waiting ? `${cfg.name} is waiting for an answer or approval. Open its terminal to respond.`
          : state && !state.richReplies ? 'This provider replies in its terminal; your messages are still kept here.'
            : busy ? 'Replying… your next message waits its turn.' : 'Anyone on this floor can join in.';
    paintFrame();
    paintHistory();
    paintView();
  }

  const switchAndOpen = (id: string, floorId: string) => {
    toast('Taking you to its floor to open the terminal');
    const unsub = on('floor', () => {
      if (store.floor !== floorId) return;
      unsub();
      setTimeout(() => openWorker(id), 250);
    });
    setTimeout(unsub, 15_000);
    net.send({ t: 'floor.go', floor: floorId });
  };

  // ---- Maintenance's Work and Review views
  let reviewKey = '';
  function paintView() {
    if (!maintenance || !state || view === 'chat') return;
    if (view === 'work') {
      fill(
        subview,
        workPanel(
          state,
          (m) => net.send(m),
          (item: MaintenanceWorkItem) => startIssue(item),
          (context) => ((carryDraft = context ? `${context}\n\n` : ''), (view = maintenanceView = 'chat'), (input.value = carryDraft || input.value), (carryDraft = ''), paintFrame(), input.focus()),
          () => {
            net.send({ t: 'maintenance.issues' });
            void refresh();
          },
          (id) => {
            view = maintenanceView = 'chat';
            pick(id);
          },
        ),
      );
      return;
    }
    const stack = state.stack ?? store.maintenance;
    const key = JSON.stringify([stack, state.worker?.status]);
    if (key === reviewKey) return;
    reviewKey = key;
    void paintReview(stack);
  }

  async function paintReview(stack = store.maintenance) {
    const w = state?.worker;
    const shipping = stack.phase === 'shipping';
    const agentBusy = !!w && !['idle', 'done', 'exited'].includes(w.status);
    const total = stack.changes.length + (stack.dirty ? 1 : 0);
    const check = button('🧪 Run typecheck, tests & build', () => net.send({ t: 'maintenance.check' }));
    check.disabled = stack.validation?.phase === 'running' || shipping || agentBusy;
    const ship = button(shipping ? '⏳ Shipping…' : `🚀 Commit, push & rebuild${total > 1 ? ` (${total} changes)` : ''}`, () => confirmDialog('Ship the stack?', 'Runs the typecheck and tests, pushes, rebuilds and restarts the office once for everyone. Workers keep running through the restart.', 'Ship it', () => net.send({ t: 'maintenance.ship' })), 'primary');
    ship.disabled = shipping || !!stack.unavailable || (!stack.changes.length && !stack.dirty);
    const working = h('div', {}, h('p.lp-note', {}, 'Loading working edits…'));
    fill(
      subview,
      note(`${stack.changes.length} stacked commit${stack.changes.length === 1 ? '' : 's'} · ${stack.dirty} edited file${stack.dirty === 1 ? '' : 's'} · ${stack.branch ?? 'maintenance/stack'}`),
      stack.unavailable ? h('p.setting-note.bad', { role: 'alert' }, stack.unavailable) : null,
      stack.validation ? h('p.lp-note', {}, stack.validation.phase === 'running' ? `⏳ Checking: ${stack.validation.step ?? 'Starting'}…` : `${stack.validation.phase === 'passed' ? '✅' : '❌'} Checks ${stack.validation.phase} · ${new Date(stack.validation.finishedAt ?? stack.validation.at).toLocaleString()}`) : null,
      stack.validation?.error ? h('pre.maintenance-diff', {}, stack.validation.error) : null,
      shipping ? h('p.laptop-wait', {}, h('span.spinner'), ` ${stack.step ?? 'Shipping'}…${stack.by ? ` (started by ${stack.by})` : ''}`) : null,
      stack.phase === 'failed' && stack.error ? h('pre.upgrade-error', {}, stack.error) : null,
      stack.note ? h('p.upgrade-status.ok', {}, stack.note) : null,
      actions(check, ship),
      heading('Stacked changes'),
      ...(stack.changes.length ? [...stack.changes].reverse().map((c) => row({ icon: '🔹', title: c.subject, sub: c.sha, onclick: () => go(`agent/change/${c.sha}`) })) : [empty('🛠️', 'Nothing stacked', 'Ask Maintenance for something in Chat.')]),
      heading('Uncommitted work'),
      working,
    );
    try {
      const r = await maintenanceJson<{ files: string; diff: string; truncated: boolean }>('/api/maintenance/working');
      if (closed || !working.isConnected) return;
      fill(working, h('pre.maintenance-working-files', {}, r.files || 'No uncommitted changes.'), r.diff ? h('details', {}, h('summary', {}, 'Tracked working diff'), h('pre.maintenance-diff', {}, r.diff)) : null, r.truncated ? h('p.lp-note', {}, 'Large changes: truncated. Ask Maintenance to explain the rest.') : null);
    } catch (err) {
      if (!closed && working.isConnected) fill(working, h('p.maintenance-chat-error', {}, (err as Error).message));
    }
  }

  function startIssue(item: MaintenanceWorkItem) {
    if (pending) return;
    saveDraft();
    showError('');
    const id = crypto.randomUUID();
    pending = { id, text: '', attachments: [], timer: setTimeout(() => ((pending = undefined), showError('No acknowledgement yet. Check the current work before starting again.'), void refresh()), 30_000) };
    net.send({ t: 'maintenance.chat.send', id, prompt: '', maintenanceIssue: item.number, newConversation: true, ...(model.edited() ? { provider: model.value(), model: model.model(), effort: model.effort() } : {}) });
    controls();
  }

  // ---- Loading the conversation
  async function refresh(before?: string) {
    const ticket = ++generation;
    const prev = selected;
    try {
      const params = new URLSearchParams();
      if (!maintenance) params.set('floor', floor);
      if (selected) params.set('thread', selected);
      if (before) params.set('before', before);
      let next = await maintenanceJson<MaintenanceChatState>(`${cfg.endpoint}?${params}`);
      if (closed || ticket !== generation || prev !== selected) return;
      state = next;
      loadDraft();
      if (historyFailed) {
        showError('');
        historyFailed = false;
      }
      if (newConversation) next = { ...next, conversation: undefined };
      const incoming = next.conversation?.messages ?? [];
      const sameThread = list.dataset.thread === next.conversation?.id;
      const byId = new Map<string, MaintenanceChatMessage>();
      if (sameThread) messages.forEach((m) => byId.set(m.id, m));
      const logged = new Set(incoming.filter((m) => !m.pending && m.role === 'user').map((m) => m.content));
      for (const [id, m] of byId) if (m.pending && logged.has(m.content)) byId.delete(id);
      incoming.forEach((m) => byId.set(m.id, m));
      messages = [...byId.values()].sort((a, b) => a.at - b.at);
      const key = JSON.stringify([next.conversation?.id, messages]);
      if (key !== messageKey) {
        const atBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 160;
        messageKey = key;
        list.dataset.thread = next.conversation?.id ?? '';
        fill(list, ...messages.map((m) => bubble(cfg, m)), messages.length ? null : h('div.maintenance-chat-empty', {}, h('h3', {}, cfg.emptyTitle), h('p', {}, cfg.emptyText)));
        if (atBottom || !sameThread) requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
      }
      controls();
    } catch (err) {
      if (!closed && ticket === generation) {
        historyFailed = true;
        showError(`Could not load the conversation: ${(err as Error).message}`);
        status.textContent = 'Connection unavailable · retrying';
        controls();
      }
    }
  }

  const offSent = onServerMessage((msg: ServerMsg) => {
    if (msg.t !== cfg.sentType || closed || pending?.id !== msg.id) return;
    clearTimeout(pending.timer);
    const { text, attachments } = pending;
    pending = undefined;
    if (msg.error) {
      input.value = text || input.value;
      images?.set(attachments);
      showError(msg.error);
      controls();
      return;
    }
    input.value = '';
    images?.set([]);
    if (loadedDraft) delete drafts[loadedDraft];
    loadedDraft = '';
    saveDraft();
    newConversation = false;
    selected = msg.workerId;
    messageKey = '';
    messages = [];
    view = maintenanceView = 'chat';
    void refresh();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim() || (images?.images.length ? 'Please inspect the attached screenshots.' : '');
    if (!text || sendBtn.disabled || !model.valid()) return;
    showError('');
    const id = crypto.randomUUID();
    saveDraft();
    pending = { id, text, attachments: [...(images?.images ?? [])], timer: setTimeout(() => ((pending = undefined), controls(), showError('No answer from the office yet. Check the terminal before sending again.')), 30_000) };
    controls();
    net.send({
      t: cfg.sendType,
      id,
      prompt: text,
      ...(maintenance ? { attachments: images?.images.map((i) => i.id) } : {}),
      ...(model.edited() ? { provider: model.value(), model: model.model(), effort: model.effort() } : {}),
      ...(newConversation ? { newConversation: true } : { thread: maintenance ? (selected ?? state?.worker?.id) : selected }),
    } as never);
  });
  input.addEventListener('input', saveDraft);
  images?.bind(form);

  const offs = [on('workers', () => void refresh())];
  if (maintenance) {
    offs.push(on('maintenanceIssues', () => ((reviewKey = ''), paintView())), on('maintenance', () => ((reviewKey = ''), state && (state.stack = store.maintenance), paintFrame(), paintView())));
    net.send({ t: 'maintenance.issues' });
    net.send({ t: 'maintenance.stack' });
  }
  const poll = setInterval(() => !document.hidden && void refresh(), 2500);
  paintFrame();
  void refresh();
  return {
    title: cfg.kind === 'product' ? '🧭 Product Lead' : '🛠️ Maintenance',
    el,
    actions: maintenance ? [button('+ Issue', () => openMaintenanceIssueCreate(() => net.send({ t: 'maintenance.issues' })), '', 'Capture an idea as an issue')] : undefined,
    dispose: () => {
      saveDraft();
      closed = true;
      generation++;
      clearInterval(poll);
      if (pending) clearTimeout(pending.timer);
      offSent();
      offs.forEach((o) => o());
    },
  };
}

/** One stacked commit: its diff, and a way to ask for it to be corrected. */
export function changeScreen([sha]: string[]): Screen {
  const body = h('div', {}, h('p.lp-note', {}, 'Loading change…'));
  const subject = store.maintenance.changes.find((c) => c.sha === sha)?.subject ?? sha;
  void maintenanceJson<{ diff: string; truncated: boolean }>(`/api/maintenance/change?sha=${encodeURIComponent(sha)}`)
    .then((r) =>
      fill(body, renderDiff(r.diff, r.truncated), actions(button('✍️ Correct this change', () => ((carryDraft = `Please correct stacked change ${sha}: ${subject}`), go('agent/maintenance', true)), 'primary'))),
    )
    .catch((err) => fill(body, h('p.setting-note.bad', { role: 'alert' }, String(err))));
  return { title: subject, sub: sha, el: page(body) };
}
