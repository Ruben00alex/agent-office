// The Agents tab: the Product Lead and Maintenance as full-screen chats, the board agents, the
// laptop that answers questions about the office, and Maintenance's work, review and shipping.

import type { ServerMsg } from '../../shared/protocol';
import { MAINTENANCE_DESK, MAINTENANCE_MODEL, PRODUCT_DESK, STATION_AGENT, STATIONS } from '../../shared/layout';
import { isAsleep, isBusy } from '../../shared/status';
import { store } from '../state';
import { h, toast } from '../ui/dom';
import { markdown } from '../ui/markdown';
import { openPrompt } from '../ui/prompt';
import { providerPicker, workerChoice } from '../ui/provider';
import { agentWorkspace } from '../ui/maintenance-workspace';
import { maintenanceJson } from '../ui/maintenance-board';
import { renderDiff } from '../ui/changes';
import { go, live, setSubtitle, type Screen } from './app';
import { actions, button, fill, heading, note, page, row, textarea } from './kit';
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
let carryDraft = '';
export function agentChatScreen([kind]: string[]): Screen {
  const initial = carryDraft;
  carryDraft = '';
  return agentWorkspace(kind === 'maintenance' ? 'maintenance' : 'product', {
    send: message => net.send(message), subscribe: onServerMessage, subtitle: setSubtitle,
    navigate: go,
    terminal: (worker, floor) => {
      if (floor === store.floor) return openWorker(worker.id);
      toast('Taking you to its floor to open the terminal');
      const off = on('floor', () => { if (store.floor === floor) { off(); setTimeout(() => openWorker(worker.id), 250); } });
      setTimeout(off, 15000);
      net.send({ t: 'floor.go', floor });
    },
    openChange: sha => go(`agent/change/${sha}`),
  }, initial);
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
