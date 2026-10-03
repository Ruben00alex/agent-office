import type { ClientMsg, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { MAINTENANCE_MODEL } from '../../shared/layout';
import { h, openModal } from './dom';
import { markdown } from './markdown';
import { store } from '../state';
import { maintenanceJson, openMaintenanceBoard } from './maintenance-board';

// The maintenance closet's laptop: ask a small model a question about Agent Office itself. It reads
// the office's source and docs and answers; building the thing instead is the Maintenance agent's job.

let ask: { id: string; show(m: Extract<ServerMsg, { t: 'maintenance.answer' }>): void } | null = null;
let counter = 0;

/** Routes the server's answer to the window waiting for it (main.ts hands every `maintenance.answer` here). */
export function onMaintenanceAnswer(msg: Extract<ServerMsg, { t: 'maintenance.answer' }>) {
  if (ask?.id === msg.id) ask.show(msg);
}

interface LaptopTurn { q: string; a: string; model: string; at: number }
interface LaptopThread { id: string; title: string; updatedAt: number; turns: LaptopTurn[] }
const ARCHIVE_KEY = 'agent-office.laptop.threads';

// The archive lives in this browser: the server keeps nothing of the laptop's questions.
function loadThreads(): LaptopThread[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((t) => t && typeof t.id === 'string' && Array.isArray(t.turns)) : [];
  } catch { return []; }
}
function saveThreads(threads: LaptopThread[]) {
  try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(threads.slice(0, 50))); } catch { /* private window or full: the chat still works */ }
}

export function openLaptop(send: (msg: ClientMsg) => void) {
  let threads = loadThreads().sort((a, b) => b.updatedAt - a.updatedAt);
  let current: LaptopThread = { id: `t${Date.now().toString(36)}`, title: '', updatedAt: Date.now(), turns: [] };
  let waiting: string | null = null;

  const ta = h('textarea', { rows: 1, maxlength: 4000, placeholder: 'e.g. How does a worker get from the queue to a desk?', 'aria-label': 'Question', enterkeyhint: 'send' }) as HTMLTextAreaElement;
  const log = h('div.lp-chatlog.maintenance-chat-messages', { role: 'log', 'aria-label': 'Laptop conversation', 'aria-live': 'polite' });
  const scroller = h('div.maintenance-chat-main', {}, log);
  const send$ = h('button.btn.primary.lp-send', { type: 'submit', 'aria-label': 'Send' }, '➤') as HTMLButtonElement;
  const form = h('form.lp-compose', {}, ta, send$) as HTMLFormElement;
  form.noValidate = true;
  const search = h('input', { type: 'search', placeholder: 'Search conversations', 'aria-label': 'Search laptop history' }) as HTMLInputElement;
  const archive = h('div.maintenance-chat-archive');

  const msg = (user: boolean, ...kids: (Node | string)[]) =>
    h('article.lp-msg', { class: user ? 'from-user first' : 'from-agent first' }, h('div.lp-bubble.maintenance-bubble', {}, ...kids));
  const paintLog = () => {
    const rows: HTMLElement[] = [];
    for (const t of current.turns) {
      rows.push(msg(true, h('p.maintenance-user-text', {}, t.q)));
      rows.push(msg(false, h('div.laptop-answer', {}, markdown(t.a)), h('p.laptop-model', {}, `— ${t.model}`)));
    }
    if (waiting) rows.push(msg(false, h('p.laptop-wait', {}, '⏳ Looking through the code…')));
    log.replaceChildren(...(rows.length ? rows : [h('div.lp-chat-empty.maintenance-chat-empty', {}, h('h3', {}, 'Ask about the office'),
      h('p', {}, `A small model (${MAINTENANCE_MODEL}) reads the office's own source and docs and never changes anything. Follow-ups keep the conversation's context. To change something, tell the Maintenance agent at the counter.`))]));
    scroller.scrollTop = scroller.scrollHeight;
  };
  const paintArchive = () => {
    const q = search.value.trim().toLowerCase();
    const hits = threads.filter((t) => !q || t.title.toLowerCase().includes(q) || t.turns.some((x) => x.q.toLowerCase().includes(q) || x.a.toLowerCase().includes(q)));
    archive.replaceChildren(...hits.map((t) => h('button.maintenance-conversation', {
      type: 'button', class: t.id === current.id ? 'selected' : '', 'aria-pressed': String(t.id === current.id),
      onclick: () => { if (waiting) return; current = t; paintLog(); paintArchive(); ta.focus(); },
    }, t.title, h('small', {}, `${new Date(t.updatedAt).toLocaleDateString()} · ${t.turns.length * 2} messages`))));
    if (!hits.length) archive.replaceChildren(h('p.lp-note', {}, q ? 'No matching conversations' : 'Past conversations appear here.'));
  };
  const busy = (on: boolean) => { send$.disabled = on; ta.disabled = on; };
  const remember = () => {
    threads = [current, ...threads.filter((t) => t.id !== current.id)];
    saveThreads(threads);
  };

  const go = () => {
    const question = ta.value.trim();
    if (!question || waiting) return;
    const id = `q${Date.now().toString(36)}${counter++}`;
    const thread = current;
    const context = thread.turns.slice(-6).map(({ q, a }) => ({ q, a }));
    waiting = id;
    ta.value = '';
    busy(true);
    log.append(msg(true, h('p.maintenance-user-text', {}, question)));
    ask = {
      id,
      show: (m) => {
        waiting = null;
        busy(false);
        if (m.error) {
          ta.value = question;
          paintLog();
          log.append(h('p.lp-banner.bad', { role: 'alert' }, m.error));
        } else {
          thread.turns.push({ q: question, a: m.answer ?? '', model: m.model, at: Date.now() });
          thread.updatedAt = Date.now();
          if (!thread.title) thread.title = question.length > 60 ? `${question.slice(0, 57)}…` : question;
          if (current === thread) { remember(); paintLog(); paintArchive(); }
          else remember();
        }
        ta.focus();
      },
    };
    scroller.scrollTop = scroller.scrollHeight;
    send({ t: 'maintenance.ask', id, question, context });
  };

  const fresh = () => {
    if (waiting) return;
    current = { id: `t${Date.now().toString(36)}`, title: '', updatedAt: Date.now(), turns: [] };
    paintLog(); paintArchive(); ta.focus();
  };
  const el = h('div.modal.maintenance-chat.laptop-chat', { role: 'dialog', 'aria-label': 'Office laptop' },
    h('header', {}, h('div', {}, h('h2', {}, '💻 Ask about the office'), h('span.maintenance-chat-status', {}, `Read-only · ${MAINTENANCE_MODEL}`))),
    h('div.maintenance-chat-layout', {},
      h('aside', {}, h('button', { type: 'button', onclick: fresh }, '+ New conversation'), h('h3', {}, 'Conversation archive'), search, archive),
      h('div.lite-maintenance-workspace', {}, scroller, form)));
  const modal = openModal(el, { doing: 'asking the office laptop', onClose: () => void (ask = null) });

  form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
  });
  search.addEventListener('input', paintArchive);
  paintLog();
  paintArchive();
  setTimeout(() => ta.focus(), 30);
  return modal;
}

/**
 * The Maintenance agent's stack: what he's committed since the office last restarted, and the big button
 * that commits what's left, checks it all, pushes, rebuilds and restarts the office, once.
 */
export interface MaintenanceActions {
  correct(context?: string): void;
  watch(worker: WorkerInfo, floor: string): void;
}

export function openStack(send: (msg: ClientMsg) => void, actions?: MaintenanceActions) {
  const list = h('ol.stack-list');
  const status = h('div.stack-status', { 'aria-live': 'polite' });
  const big = h('button.btn.primary.stack-ship', { type: 'button' }, '🚀 Commit, push & rebuild');
  const note = h('p.stack-note', {}, 'Runs the typecheck and tests, pushes to the office’s repository, rebuilds and restarts the office once for everyone. Workers keep running through the restart.');
  const agentStatus = h('p.setting-note', {}, 'Looking for Maintenance…');
  const controls = h('div.maintenance-controls');
  const el = h(
    'div.modal.stack',
    { role: 'dialog', 'aria-label': 'Maintenance change stack' },
    h('header', {}, h('h2', {}, '🛠️ Maintenance · Agent Office')),
    h('div.body', {}, h('p.laptop-note', {}, 'Review what Maintenance has built, read the diffs, and send a correction before shipping. Nothing is rebuilt until you press the button.'), agentStatus, controls, list, status, big, note),
  );
  const modal = openModal(el, { onClose: () => void unsub() });

  const render = () => {
    const s = store.maintenance;
    const shipping = s.phase === 'shipping';
    const items: HTMLElement[] = [];
    if (s.dirty) items.push(h('li.stack-wip', {}, h('span', {}, '✏️ In the middle of a change'), h('small', {}, `${s.dirty} file${s.dirty === 1 ? '' : 's'} edited, not committed yet`)));
    // Newest on top, like a stack.
    for (const c of [...s.changes].reverse()) items.push(h('li', {},
      h('button.stack-change', { type: 'button', onclick: () => openStackChange(c, actions) }, h('code', {}, c.sha), ' ', c.subject, h('small', {}, 'Read change & diff →'))));
    list.replaceChildren(...(items.length ? items : [h('li.stack-empty', {}, 'Nothing waiting. Ask the Maintenance agent for something at his counter.')]));
    status.replaceChildren();
    if (s.unavailable) status.append(h('p.setting-note.bad', { role: 'alert' }, s.unavailable));
    if (shipping) status.append(h('p.laptop-wait', {}, h('span.spinner'), ` ${s.step ?? 'Shipping'}…${s.by ? ` (started by ${s.by})` : ''}`));
    if (s.phase === 'failed' && s.error) status.append(h('pre.upgrade-error', {}, s.error), h('button.btn', { type: 'button', onclick: () => send({ t: 'maintenance.stack' }) }, 'Look again'));
    if (s.note) status.append(h('p.upgrade-status.ok', {}, s.note));
    big.disabled = shipping || !!s.unavailable || (!s.changes.length && !s.dirty);
    big.textContent = shipping ? '⏳ Shipping…' : `🚀 Commit, push & rebuild${s.changes.length + (s.dirty ? 1 : 0) > 1 ? ` (${s.changes.length + (s.dirty ? 1 : 0)} changes)` : ''}`;
  };
  const unsub = store.on('maintenance', render);
  big.addEventListener('click', () => send({ t: 'maintenance.ship' }));
  render();
  send({ t: 'maintenance.stack' });
  if (actions) {
    controls.append(
      h('button.btn.primary', { type: 'button', onclick: () => { modal.close(); actions.correct(); } }, '✍️ Request / correct'),
      h('button.btn', { type: 'button', onclick: () => openMaintenanceBoard(send, actions.correct) }, '📌 Agent Office issues'));
    void maintenanceJson<{ worker?: WorkerInfo; floor?: string; floorName?: string }>('/api/maintenance/agent').then((agent) => {
      agentStatus.textContent = agent.worker ? `Maintenance: ${agent.worker.status.replace('_', ' ')} · ${agent.floorName}` : 'Maintenance is ready for your first request.';
      if (agent.worker && agent.floor) controls.append(h('button.btn', { type: 'button', onclick: () => { modal.close(); actions.watch(agent.worker!, agent.floor!); } }, '💻 Watch / answer in terminal'));
    }).catch((error) => { agentStatus.textContent = String(error); });
  } else agentStatus.remove();
  return modal;
}

/** Inspect a stacked commit without any commit/discard/deploy actions. */
export function openStackChange(change: { sha: string; subject: string }, actions?: MaintenanceActions) {
  const body = h('div.body', {}, h('p', {}, 'Loading change…'));
  const modal = openModal(h('div.modal.maintenance-change', { role: 'dialog', 'aria-label': 'Maintenance change details' },
    h('header', {}, h('h2', {}, change.subject)), body));
  void maintenanceJson<{ diff: string; truncated: boolean }>(`/api/maintenance/change?sha=${encodeURIComponent(change.sha)}`).then((result) => {
    body.replaceChildren(h('pre.maintenance-diff', {}, result.diff),
      ...(result.truncated ? [h('p.setting-note', {}, 'Large diff: showing the first 160,000 characters. Ask Maintenance to explain the rest.')] : []),
      ...(actions ? [h('button.btn.primary', { type: 'button', onclick: () => { modal.close(); actions.correct(`Please correct stacked change ${change.sha}: ${change.subject}`); } }, '✍️ Correct this change')] : []));
  }).catch((error) => body.replaceChildren(h('p.setting-note.bad', { role: 'alert' }, String(error))));
  return modal;
}
