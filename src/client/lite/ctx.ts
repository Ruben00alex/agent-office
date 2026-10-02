// What every 2D page shares: the connection, your settings, and the actions on workers.

import { Net } from '../net';
import { AVATAR_COLORS, loadProfile, loadSettings, store } from '../state';
import { randomLook } from '../../shared/avatar';
import { DESK_BY_ID, nextFreeSeat } from '../../shared/layout';
import { isAsleep, isBusy } from '../../shared/status';
import type { AgentEffort, AgentProvider, ServerMsg, WorkerInfo } from '../../shared/protocol';
import { toast } from '../ui/dom';
import { openTerminal, type TerminalFind } from '../ui/terminal';
import { confirmDialog, lostWorktreeDialog, openPrompt, sendHomeDialog } from '../ui/prompt';
import { openAsk } from '../ui/ask';
import { DesktopNotifier } from '../notify';
import { go } from './app';

export const saved = loadProfile();
store.profile = { name: saved?.name ?? 'Guest', color: saved?.color ?? AVATAR_COLORS[1], look: saved?.look ?? randomLook() };
export const net = new Net(() => store.profile, () => null, true);
export const settings = loadSettings();

const listeners = new Set<(msg: ServerMsg) => void>();
/** Pages hear every server message here (a reply to something they asked for). */
export function onServerMessage(fn: (msg: ServerMsg) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
net.onMessage((msg) => listeners.forEach((fn) => fn(msg)));

export const notifier = new DesktopNotifier(() => settings.notify, (id) => openWorker(id));

/** Its terminal, with the keypad, waking it up first if it's asleep. */
export function openWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  if (w.lost) return fixLostWorktree(w);
  if (isAsleep(w.status)) {
    if (!w.sessionId && w.kind !== 'shell') toast(`${w.name} has no saved session — starting a fresh one`, 'warn');
    net.send({ t: 'worker.resume', workerId: id });
  }
  showTerminal(id);
}

export function showTerminal(id: string, find?: TerminalFind) {
  // The terminal's Changes button goes to the changes page, which comes back here.
  openTerminal(net, id, () => go(`worker/${id}/changes`), find, { keypad: true });
}

/** Its worktree was deleted outside agent-office: put it back (everyone's who lost theirs), or send it home. */
export function fixLostWorktree(w: WorkerInfo) {
  if (!w.lost || !w.worktree) return;
  const worktree = w.worktree;
  const others = [...store.workers.values()].filter((o) => o.lost && o.id !== w.id);
  lostWorktreeDialog({
    name: w.name,
    worktree,
    lost: w.lost,
    workspace: w.repos?.length ? worktree.path.replace(/[\\/][^\\/]*$/, '') : undefined,
    others: others.map((o) => o.name),
    openTerminal: isAsleep(w.status) ? undefined : () => showTerminal(w.id),
    rebuild: (all) => {
      toast(all ? `Rebuilding ${others.length + 1} worktrees…` : `Rebuilding ${w.name}'s worktree…`);
      net.send({ t: 'worker.rebuild', workerId: w.id, all });
    },
    sendHome: () => sendHome(w),
  });
}

export function sendHome(w: WorkerInfo) {
  const where = DESK_BY_ID.get(w.deskId)?.label ?? 'its desk';
  if (!w.worktree) return confirmDialog(`Send ${w.name} home?`, `This stops its ${w.kind === 'shell' ? 'shell' : 'session'} at ${where} for everyone and frees the desk.`, 'Send home', () => net.send({ t: 'worker.kill', workerId: w.id }));
  sendHomeDialog({
    workerId: w.id,
    name: w.name,
    where: DESK_BY_ID.get(w.deskId)?.label ?? 'its desk',
    worktree: w.worktree,
    repos: w.repos?.length ? [w.worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
    ask: () => net.send({ t: 'worker.worktree', workerId: w.id }),
    onConfirm: (cleanup) => net.send({ t: 'worker.kill', workerId: w.id, cleanup }),
  });
}

export function promptWorker(id: string) {
  const w = store.workers.get(id);
  if (!w) return;
  openPrompt({
    title: `✍️ Prompt ${w.name}`,
    subtitle: w.status === 'working' ? `${w.name} is busy, so this waits in its input box until it's done.` : undefined,
    placeholder: 'What should it do next?',
    submitLabel: 'Send',
    onSubmit: (text) => net.send({ t: 'worker.prompt', workerId: id, prompt: text }),
  });
}

export function hire(deskId: string, prompt: string, worktree: boolean, provider?: AgentProvider, model?: string, effort?: AgentEffort, repos?: string[]) {
  net.send({ t: 'worker.spawn', deskId, prompt, worktree, provider, model, effort, repos: repos?.length ? repos : undefined });
}

/** A prompt for a worker who's here, or a new one at a free desk. */
export function sendToWorker(title: string, text: { context?: string; initial?: string; newTask?: boolean; issue?: number } = {}) {
  if (!store.project) return toast('Pick a floor first', 'warn');
  const desk = nextFreeSeat((id) => !!store.workerAtDesk(id), store.floorPlan.wing)?.id;
  const newTask = text.newTask ?? !text.context;
  const awake = [...store.workers.values()].filter((w) => w.kind === 'agent' && !isAsleep(w.status)
    && (!newTask || (!isBusy(w.status) && !w.meeting && !DESK_BY_ID.get(w.deskId)?.station)));
  if (!desk && !awake.length) return toast('Every desk and bean bag is taken — send a worker home first', 'warn');
  openAsk({
    title,
    ...text,
    newDesk: desk ? DESK_BY_ID.get(desk)!.label : undefined,
    workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status })),
    worktreeOption: !!store.project.branch,
    providerOption: true,
    repoOptions: store.floors.filter((f) => f.id !== store.floor && f.branch && !f.cloning).map((f) => ({ id: f.id, name: f.name })),
    onSubmit: (prompt, to, worktree, provider, model, effort, repos) => {
      if (to) net.send({ t: 'worker.prompt', workerId: to, prompt, newTask, issue: text.issue });
      else if (desk) hire(desk, prompt, worktree, provider, model, effort, repos);
    },
  });
}

/** A shell at a free desk, for typing commands rather than prompting an agent. */
export function openShell() {
  const desk = nextFreeSeat((id) => !!store.workerAtDesk(id), store.floorPlan.wing)?.id;
  if (!desk) return toast('Every desk is taken — send a worker home first', 'warn');
  net.send({ t: 'worker.spawn', deskId: desk, kind: 'shell' });
}
