import type { ClientMsg, WorkerInfo, MaintenanceAttachment, MaintenanceChatMessage, MaintenanceChatState, MaintenanceWorkItem, ServerMsg } from '../../shared/protocol';
import { fmtTokens, tokensOf } from '../../shared/protocol';
import { store } from '../state';
import { h } from './dom';
import { confirmDialog } from './prompt';
import { providerPicker, workerChoice } from './provider';
import { maintenanceTabs, type MaintenanceView } from './maintenance-tabs';
import { maintenanceReview } from './maintenance-review';
import { maintenanceConsole } from './maintenance-console';
import { maintenanceContent } from './maintenance-content';
import { generateTitleButton, maintenanceJson } from './maintenance-board';
import { imageComposer, imageEvidence } from './maintenance-images';
import { openMaintenanceIssueCreate, workPanelParts } from './maintenance-work';
import { issueCrafting, onIssueJobs } from './maintenance-issue-crafter';
import { actions, button, fill, iconButton, layout, note, openSheet, row, searchBox } from '../lite/kit';
import './maintenance-workspace.css';

const on = store.on.bind(store);
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
  product: { kind: 'product', name: 'Product Lead', endpoint: '/api/product/chat', sendType: 'product.chat.send', sentType: 'product.chat.sent', placeholder: 'Ask the Product Lead…', emptyTitle: 'What’s on your mind?', emptyText: 'Think out loud about the project, bounce an idea around, or ask how something works. No ticket needed: it’s just a conversation.' },
  maintenance: { kind: 'maintenance', name: 'Maintenance', endpoint: '/api/maintenance/chat', sendType: 'maintenance.chat.send', sentType: 'maintenance.chat.sent', placeholder: 'Ask Maintenance…', emptyTitle: 'What should we improve?', emptyText: 'Ask for a feature, report a bug, or follow up on a stacked change. Maintenance works in its own worktree; you review and ship the stack when ready.' },
};

/** One message: yours on the right, the agent's on the left; a run of messages from one side shares a header. */
function bubble(cfg: ChatConfig, m: MaintenanceChatMessage, prev?: MaintenanceChatMessage) {
  const user = m.role === 'user';
  const first = !prev || prev.role !== m.role || (user && prev.by !== m.by) || m.at - prev.at > 5 * 60_000;
  const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return h(
    'article.lp-msg',
    { class: `${user ? 'from-user' : 'from-agent'}${first ? ' first' : ''}`, 'data-message': m.id },
    first ? h('div.lp-msg-meta', {}, h('b', {}, user ? (m.by ?? 'You') : cfg.name), h('time', {}, time), m.phase === 'commentary' ? h('span', {}, 'progress') : null) : null,
    h('div.lp-bubble.maintenance-bubble', {}, user ? h('p.maintenance-user-text', {}, m.content) : maintenanceContent(m.content), m.attachments?.length ? imageEvidence(m.attachments) : null),
    m.pending ? h('small.lp-msg-pending', {}, 'sent · waiting for the agent') : null,
  );
}


let maintenanceView: MaintenanceView = 'chat';

export interface AgentWorkspaceHost {
  send(message: ClientMsg): void;
  subscribe(receive: (message: ServerMsg) => void): () => void;
  subtitle(text: string | undefined, tone?: 'live' | 'warn'): void;
  navigate(path: string): void;
  terminal(worker: WorkerInfo, floor: string): void;
  openChange(sha: string, correct: (context?: string) => void): void;
  history?(state: MaintenanceChatState, selected: string | undefined, fresh: boolean): void;
}

/** The single chat/work/review implementation; hosts supply only navigation and presentation. */
export function agentWorkspace(kind: 'maintenance' | 'product', host: AgentWorkspaceHost, initial = '', startNew = false) {
  const net = { send: host.send };
  const onServerMessage = host.subscribe;
  const setSubtitle = host.subtitle;
  const go = host.navigate;
  const cfg = CONFIG[kind === 'maintenance' ? 'maintenance' : 'product'];
  const maintenance = cfg.kind === 'maintenance';
  const floor = store.floor ?? '';
  let closed = false;
  let selected: string | undefined;
  let newConversation = startNew;
  let state: MaintenanceChatState | undefined;
  let generation = 0;
  let messages: MaintenanceChatMessage[] = [];
  let messageKey = '';
  let historyFailed = false;
  let view: MaintenanceView = startNew || initial ? 'chat' : maintenance ? maintenanceView : 'chat';
  let issueStart = false;
  let pending: { id: string; text: string; attachments: MaintenanceAttachment[]; timer: ReturnType<typeof setTimeout> } | undefined;
  const draftKey = maintenance ? 'agent-office.maintenance-workspace-draft-v1' : `agent-office.lite-${cfg.kind}-draft`;
  let drafts: Record<string, string | { text: string; attachments: MaintenanceAttachment[] }> = {};
  try {
    const s = JSON.parse(localStorage.getItem(draftKey) ?? '{}');
    if (s && typeof s === 'object' && !Array.isArray(s)) drafts = s;
  } catch {
    /* storage unavailable */
  }
  let loadedDraft = '';
  const scope = () => `${maintenance ? '' : floor + ':'}${newConversation ? 'new' : (selected ?? state?.worker?.id ?? 'current')}`;

  const list = h('div.lp-chatlog.maintenance-chat-messages', { role: 'log', 'aria-label': `${cfg.name} conversation`, 'aria-live': 'polite' });
  const typing = h('div.lp-typing.hidden', { 'aria-label': `${cfg.name} is replying` }, h('i'), h('i'), h('i'));
  const errorEl = h('p.lp-banner.bad.hidden', { role: 'alert' });
  const banner = h('p.lp-banner.hidden');
  const input = h('textarea', { rows: 1, maxlength: 20000, placeholder: cfg.placeholder, 'aria-label': `Message to ${cfg.name}`, enterkeyhint: 'send' }) as HTMLTextAreaElement;
  input.value = initial;
  const grow = () => {
    input.style.height = 'auto';
    // scrollHeight leaves out the border, which a border-box height must include or the box scrolls by a pixel or two.
    const needed = input.scrollHeight + input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(needed, 140)}px`;
    input.style.overflowY = needed > 140 ? 'auto' : 'hidden';
  };
  const images = maintenance ? imageComposer(() => (saveDraft(), tray(), controls()), (t) => showError(t)) : null;
  const tray = () => images?.element.classList.toggle('hidden', !trayOpen && !images.images.length);
  let trayOpen = false;
  images?.element.classList.add('hidden', 'lp-tray');
  const attach = images ? iconButton('📎', 'Attach screenshots', () => ((trayOpen = !trayOpen), tray()), 'lp-attach') : null;
  const older = button('Load earlier messages', () => messages.length && void refresh(messages[0].id), 'hidden');
  const sendBtn = h('button.btn.primary.lp-send', { type: 'submit', 'aria-label': 'Send' }, '➤') as HTMLButtonElement;
  const model = providerPicker(store.project, `lite-${cfg.kind}-provider`, 'Runs on', () => (newConversation || view === 'work' ? undefined : workerChoice(state?.worker)));
  model.element.addEventListener('click', () => setTimeout(controls));
  const fixBtn = maintenance ? h('button.btn', { type: 'submit', title: 'Ask Maintenance to track and implement this fix', 'aria-label': 'Fix now' }, 'Fix now') as HTMLButtonElement : null;
  const form = h('form.lp-compose', {}, attach, input, fixBtn, sendBtn);
  const subview = h('div.lp-subview.hidden');
  // The Work view's controls (add, refresh, start next) stay above its issue list instead of scrolling away with it.
  const workHead = h('div.lp-workhead.hidden');
  const tabs = h('div');
  const conversationActions = actions(
    ...(host.history ? [] : [button('🧭 All agents', () => go('agents'))]),
    ...(maintenance ? [] : [button('🕘 History', openHistory)]),
  );
  const jump = h('button.lp-jump.hidden', { type: 'button', 'aria-label': 'Jump to the latest message', onclick: () => scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }) }, '↓');
  const frame = layout({ top: [tabs, conversationActions, workHead], scroll: [older, list, typing, subview, jump], bottom: [banner, errorEl, images?.element ?? null, form] });
  frame.el.classList.add('maintenance-chat-main');
  const consoleHost = h('div.maintenance-live-console');
  const consoleRail = h('section.maintenance-console-rail.lite-maintenance-console', {}, h('h3', {}, 'Live agent console'), consoleHost);
  let stackPanelKey = '';
  const stackPanel = h('div.maintenance-rail-stack');
  consoleRail.append(stackPanel);
  const attention = h('div.maintenance-attention.hidden', { role: 'status' });
  consoleRail.insertBefore(attention, consoleHost);
  const desktop = matchMedia('(min-width: 961px)');
  let consoleView: ReturnType<typeof maintenanceConsole> | undefined;
  let consoleWorker = '';
  const updateConsole = () => {
    const worker = maintenance && desktop.matches ? state?.worker : undefined;
    if ((worker?.id ?? '') !== consoleWorker) {
      consoleView?.dispose(); consoleView = undefined;
      consoleWorker = worker?.id ?? '';
      if (worker) consoleView = maintenanceConsole(consoleHost, worker, m => net.send(m));
    }
    if (worker) consoleView?.update(worker);
    else consoleHost.replaceChildren(note('The live console appears when Maintenance starts.'));
  };
  if (maintenance) desktop.addEventListener('change', updateConsole);
  const el = maintenance ? h('div.lite-maintenance-workspace', {}, frame.el, consoleRail) : frame.el;
  const scroller = frame.scroller;
  frame.top.classList.add('lp-top-slim');
  scroller.classList.add('lp-chatscroll');
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  scroller.addEventListener('scroll', () => jump.classList.toggle('hidden', nearBottom() || view !== 'chat'), { passive: true });
  const toBottom = () => requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
  input.addEventListener('input', grow);
  // A keyboard sends on Enter; a phone's Enter is a new line, and ➤ sends.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  function showError(text: string) {
    errorEl.textContent = text;
    errorEl.classList.toggle('hidden', !text);
  }
  const saveDraft = () => {
    if (loadedDraft) drafts[loadedDraft] = maintenance ? { text: input.value, attachments: images?.images ?? [] } : input.value;
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
    let draft = drafts[s];
    // Preserve existing browser drafts from either pre-consolidation host.
    if (maintenance && !draft) {
      try {
        const kiosk = JSON.parse(localStorage.getItem('agent-office.maintenance-draft-v1') ?? '{}');
        const lite = JSON.parse(localStorage.getItem('agent-office.lite-maintenance-draft') ?? '{}');
        draft = kiosk[s] ?? lite[`${floor}:${s}`];
        if (draft) {
          drafts[s] = draft;
          localStorage.setItem(draftKey, JSON.stringify(drafts));
          delete kiosk[s]; delete lite[`${floor}:${s}`];
          localStorage.setItem('agent-office.maintenance-draft-v1', JSON.stringify(kiosk));
          localStorage.setItem('agent-office.lite-maintenance-draft', JSON.stringify(lite));
        }
      } catch { /* Storage unavailable. */ }
    }
    if (!input.value) input.value = typeof draft === 'string' ? draft : draft?.text ?? '';
    if (draft && typeof draft !== 'string') images?.set(Array.isArray(draft.attachments) ? draft.attachments.filter(i => i && /^[a-f0-9-]{36}$/.test(i.id)) : []);
    if (!maintenance && !draft) {
      try {
        const old = JSON.parse(localStorage.getItem('agent-office.product-draft-v1') ?? '{}');
        const migrated = old[s];
        if (typeof migrated === 'string') {
          drafts[s] = migrated;
          if (!input.value) input.value = migrated;
          localStorage.setItem(draftKey, JSON.stringify(drafts));
          delete old[s];
          localStorage.setItem('agent-office.product-draft-v1', JSON.stringify(old));
        }
      } catch { /* Storage unavailable. */ }
    }
    tray();
    grow();
  };
  const pick = (thread: string | undefined, fresh = false) => {
    saveDraft();
    view = maintenanceView = 'chat';
    newConversation = fresh;
    selected = thread;
    loadedDraft = '';
    input.value = '';
    images?.set([]);
    messages = [];
    messageKey = '';
    showError('');
    paintFrame();
    void refresh();
  };

  /** Everything that isn't the conversation itself lives behind sheets, so the messages get the screen. */
  function openHistory() {
    if (!state) return;
    const active = newConversation ? undefined : (selected ?? state.worker?.id);
    const search = searchBox('Search conversations', () => paint());
    const listEl = h('div.sheet-list');
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const entries = (state?.conversations ?? []).filter((c) => c.title.toLowerCase().includes(q));
      fill(
        listEl,
        row({ icon: '➕', title: 'New conversation', sub: 'A fresh start; the others stay here', onclick: () => (sheet.close(), pick(undefined, true)) }),
        ...entries.map((c) => row({ icon: active === c.id ? '💬' : '🗨️', title: c.title, sub: `${new Date(c.updatedAt).toLocaleDateString()} · ${c.count} messages`, onclick: () => (sheet.close(), pick(c.id)), cls: active === c.id ? 'on' : '' })),
        entries.length ? null : h('p.lp-note', {}, q ? 'No matching conversations' : 'Conversations appear here once you start talking.'),
      );
    };
    const sheet = openSheet({ title: 'Conversations', tall: true, body: h('div.sheet-stack', {}, search, listEl) });
    paint();
  }

  function openRunsOn() {
    openSheet({ title: 'Runs on', body: h('div.sheet-stack', {}, model.element, h('p.lp-note', {}, 'Picking another moves it off its current model: it starts afresh there with your next message.')) });
  }

  function paintFrame() {
    const chat = view === 'chat';
    older.classList.toggle('hidden', !chat || !state?.conversation?.hasOlder);
    list.classList.toggle('hidden', !chat);
    typing.classList.toggle('hidden', !chat || !typingNow());
    subview.classList.toggle('hidden', chat);
    workHead.classList.toggle('hidden', view !== 'work');
    frame.bottom.classList.toggle('hidden', !chat);
    if (!chat) jump.classList.add('hidden');
    if (maintenance) {
      fill(
        tabs,
        maintenanceTabs(
          view,
          (v) => {
            const wasChat = view === 'chat';
            view = maintenanceView = v;
            reviewKey = '';
            paintFrame();
            paintView();
            // The conversation opens at its latest message; Work and Review open at their top.
            if (wasChat === (v === 'chat')) return;
            if (v === 'chat') toBottom();
            else scroller.scrollTop = 0;
          },
          (state?.stack ?? store.maintenance).changes.length,
        ),
      );
    }
    frame.top.classList.remove('hidden');
  }

  const typingNow = () => {
    const w = state?.worker;
    return !!w && w.status === 'working' && !newConversation && !(selected && selected !== w.id);
  };

  function controls() {
    updateConsole();
    const w = state?.worker;
    const stack = state?.stack ?? store.maintenance;
    const validation = stack.validation;
    const stackKey = JSON.stringify([stack, w?.usage]);
    if (stackPanelKey !== stackKey) {
      stackPanelKey = stackKey;
      fill(stackPanel,
        h('h3', {}, `Stack · ${stack.changes.length} commits${stack.dirty ? ` + ${stack.dirty} edited` : ''}`),
        validation ? h('p.maintenance-rail-badge', { class: validation.phase === 'passed' ? 'good' : validation.phase === 'failed' ? 'bad' : '' }, validation.phase === 'running' ? `Checking: ${validation.step ?? 'Starting'}…` : `Checks ${validation.phase}`) : note('Run checks before shipping.'),
        ...[...stack.changes].reverse().map(commit => h('button.maintenance-rail-commit', { type: 'button', title: commit.subject, onclick: () => host.openChange(commit.sha, correctHere) }, h('code', {}, commit.sha.slice(0, 7)), ` ${commit.subject}`)),
        w?.usage ? h('p.maintenance-rail-tokens', {}, `${fmtTokens(tokensOf(w.usage))} tokens this session`) : null,
        button('Review stack →', () => { view = maintenanceView = 'review'; reviewKey = ''; paintFrame(); paintView(); }),
      );
    }
    const waiting = w?.status === 'needs_input' && state?.terminalInputRequired !== false;
    attention.classList.toggle('hidden', !waiting);
    fill(attention, waiting ? h('b', {}, 'Your attention is needed') : null, waiting ? h('p', {}, w.activity ?? 'Answer the prompt in the live console.') : null);
    model.repaint();
    const archived = !newConversation && !!selected && selected !== w?.id;
    const busy = !!w && !['idle', 'done', 'exited'].includes(w.status);
    // The state of things is the page's subtitle; only what needs saying stands over the composer.
    if (historyFailed) setSubtitle('Connection unavailable · retrying', 'warn');
    else if (!w) setSubtitle(maintenance ? 'Ready for your first request' : 'Here whenever you want to talk');
    else if (waiting) setSubtitle('Waiting on you', 'warn');
    else if (w.status === 'working') setSubtitle('Working…', 'live');
    else if (w.status === 'starting') setSubtitle('Getting settled…', 'live');
    else setSubtitle(`Here${state?.floorName && maintenance ? ` · ${state.floorName}` : ''}`);
    input.disabled = !!pending || archived || !state || historyFailed;
    images?.disable(input.disabled);
    sendBtn.disabled = input.disabled || !!images?.uploading || (waiting && !model.edited()) || (newConversation && busy) || state?.stack?.phase === 'shipping' || state?.stack?.validation?.phase === 'running';
    if (fixBtn) fixBtn.disabled = sendBtn.disabled || !input.value.trim();
    const say = newConversation
      ? waiting ? `${cfg.name} is waiting for an answer or approval. Open its terminal from ⋯${maintenance ? '' : ', or End the session to start fresh'}.` : busy ? (maintenance ? 'Wait for the current reply to finish before starting a new conversation.' : 'Use End the session in ⋯ to stop the reply and start fresh.') : 'New conversation: the earlier ones stay in History.'
      : archived ? 'An earlier conversation, read-only. Open History to go back to the current one.'
        : waiting ? `${cfg.name} is waiting for an answer or approval. Open its terminal from ⋯ to respond.`
          : state && !state.richReplies ? 'This provider replies in its terminal; your messages are still kept here.'
            : model.edited() ? 'It will move to the model you picked, starting afresh there.'
              : '';
    banner.textContent = say;
    banner.classList.toggle('hidden', !say);
    typing.classList.toggle('hidden', view !== 'chat' || !typingNow());
    paintFrame();
    paintView();
  }

  function correctHere(context?: string) {
    const draft = input.value;
    view = maintenanceView = 'chat';
    pick(undefined);
    input.value = context ? `${context}\n\n${draft}` : draft;
    saveDraft();
    input.focus();
  }

  // ---- Maintenance's Work and Review views
  let reviewKey = '';
  function paintView() {
    if (!maintenance || !state || view === 'chat') return;
    if (view === 'work') {
      const parts = workPanelParts(
        state,
        (m) => net.send(m),
        (item: MaintenanceWorkItem) => startIssue(item),
        correctHere,
        () => {
          net.send({ t: 'maintenance.issues' });
          void refresh();
        },
        (id) => {
          view = maintenanceView = 'chat';
          pick(id);
        },
      );
      fill(workHead, parts.head);
      fill(subview, parts.list);
      return;
    }
    const stack = state.stack ?? store.maintenance;
    const key = JSON.stringify([stack, state.worker?.status]);
    if (key === reviewKey) return;
    reviewKey = key;
    void maintenanceReview(subview, stack, state.worker, m => net.send(m), sha => host.openChange(sha, correctHere));
  }


  function startIssue(item: MaintenanceWorkItem) {
    if (pending) return;
    issueStart = true;
    saveDraft();
    showError('');
    const id = crypto.randomUUID();
    pending = { id, text: input.value, attachments: [...(images?.images ?? [])], timer: setTimeout(() => ((pending = undefined), showError('No acknowledgement yet. Check the current work before starting again.'), void refresh()), 30_000) };
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
      host.history?.(next, selected, newConversation);
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
        const atBottom = nearBottom();
        messageKey = key;
        list.dataset.thread = next.conversation?.id ?? '';
        fill(list, ...messages.map((m, i) => bubble(cfg, m, messages[i - 1])), messages.length ? null : h('div.lp-chat-empty.maintenance-chat-empty', {}, h('h3', {}, cfg.emptyTitle), h('p', {}, cfg.emptyText)));
        if (atBottom || !sameThread) toBottom();
      }
      controls();
    } catch (err) {
      if (!closed && ticket === generation) {
        historyFailed = true;
        showError(`Could not load the conversation: ${(err as Error).message}`);
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
    grow();
    images?.set([]);
    tray();
    if (loadedDraft && !issueStart) delete drafts[loadedDraft];
    issueStart = false;
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
    const quickFix = !!fixBtn && (e as SubmitEvent).submitter === fixBtn;
    if (quickFix && fixBtn?.disabled) return;
    const text = input.value.trim() || (images?.images.length ? 'Please inspect the attached screenshots.' : '');
    if (!text || sendBtn.disabled || !model.valid()) return;
    showError('');
    const id = crypto.randomUUID();
    issueStart = false;
    saveDraft();
    pending = { id, text, attachments: [...(images?.images ?? [])], timer: setTimeout(() => ((pending = undefined), controls(), showError('No answer from the office yet. Check the terminal before sending again.')), 30_000) };
    controls();
    toBottom();
    net.send({
      t: cfg.sendType,
      id,
      prompt: text,
      ...(quickFix ? { quickFix: true } : {}),
      ...(maintenance ? { attachments: images?.images.map((i) => i.id) } : {}),
      ...(model.edited() ? { provider: model.value(), model: model.model(), effort: model.effort() } : {}),
      ...(newConversation ? { newConversation: true } : { thread: maintenance ? (selected ?? state?.worker?.id) : selected }),
    } as never);
  });
  input.addEventListener('input', () => { saveDraft(); controls(); });
  images?.bind(frame.bottom);

  const offs = [on('workers', () => void refresh())];
  if (maintenance) {
    let crafting = issueCrafting();
    // Repaint only when drafting starts or stops (the + Add issue orb), not on every poll.
    offs.push(onIssueJobs(() => { if (crafting !== issueCrafting()) { crafting = !crafting; paintView(); } }), on('maintenanceIssues', () => ((reviewKey = ''), paintView())), on('maintenance', () => ((reviewKey = ''), state && (state.stack = store.maintenance), controls())));
    net.send({ t: 'maintenance.issues' });
    net.send({ t: 'maintenance.stack' });
  }
  const poll = setInterval(() => !document.hidden && void refresh(), 2500);
  paintFrame();
  void refresh();
  return {
    review: () => { view = maintenanceView = 'review'; reviewKey = ''; paintFrame(); paintView(); },
    correct: correctHere,
    pick,
    title: cfg.kind === 'product' ? '🧭 Product Lead' : '🛠️ Maintenance',
    el,
    actions: [iconButton('🕘', 'Conversations', openHistory), generateTitleButton(`${cfg.endpoint}-title`, () => state?.conversation?.id, () => void refresh(), showError)],
    menu: () => [
      { icon: '➕', label: 'New conversation', run: () => pick(undefined, true) },
      { icon: '🖥️', label: 'Open its terminal', sub: 'Answer a permission prompt, watch it work', hidden: !(state?.worker && state.floor), run: () => state?.worker && state.floor && host.terminal(state.worker, state.floor) },
      { icon: '🧠', label: 'Runs on…', sub: 'Move it to another model', run: openRunsOn },
      { icon: '💡', label: 'Capture an idea as an issue', hidden: !maintenance, run: () => openMaintenanceIssueCreate(() => net.send({ t: 'maintenance.issues' })) },
      { icon: '⏏️', label: 'End the session', sub: maintenance ? 'Stops it for everyone; history and stacked commits stay' : 'Stops it for everyone; conversation history stays', danger: true, hidden: !state?.worker, run: () => { const worker = state?.worker; if (worker) confirmDialog(`End ${cfg.name} session?`, 'Stops the active session for everyone, including unfinished replies. Earlier conversations remain in History.', 'End session', () => { net.send({ t: 'worker.kill', workerId: worker.id }); if (!maintenance) pick(undefined, true); }); } },
    ],
    dispose: () => {
      saveDraft();
      consoleView?.dispose();
      desktop.removeEventListener('change', updateConsole);
      closed = true;
      generation++;
      clearInterval(poll);
      if (pending) clearTimeout(pending.timer);
      offSent();
      offs.forEach((o) => o());
    },
  };
}

