// The Workers tab: every worker on the floor and how it's doing, a page per worker with everything
// you can do to it, and its changes (files, diff, commit, discard, pull request).

import { store } from '../state';
import { DESK_BY_ID } from '../../shared/layout';
import { canLabel } from '../../shared/floorplan';
import { openDeskLabel } from '../ui/floorplan';
import { isAsleep } from '../../shared/status';
import { changedImageType, type ChangedFile, type ChangesState, type ServerMsg, type WorkerInfo } from '../../shared/protocol';
import { clip, h, STATUS_LABEL, timeAgo, toast } from '../ui/dom';
import { modelBadge, providerLabel } from '../ui/provider';
import { fmtCost, usageLabel } from '../ui/usage';
import { MEETING_PATTERNS } from '../../shared/meetings';
import { confirmDialog, openPrompt } from '../ui/prompt';
import { pathLabel, plusMinus, renderDiff, renderPreview, STATUS_WORD } from '../ui/changes';
import { byUrgency, waitingInOrder, waitingLabel } from '../nextup';
import { waitingOnSomeone } from '../notify';
import { back, go, live, type Screen } from './app';
import { actions, button, empty, fill, heading, layout, page, row } from './kit';
import { fixLostWorktree, net, onServerMessage, openShell, openWorker, promptWorker, sendHome, sendToWorker, showTerminal } from './ctx';

const on = store.on.bind(store);

// ---- The list ---------------------------------------------------------------------------------
function card(w: WorkerInfo): HTMLElement {
  const desk = DESK_BY_ID.get(w.deskId);
  const waiting = waitingOnSomeone(w);
  const asleep = isAsleep(w.status);
  const badge = w.kind === 'agent' ? modelBadge(w.provider, w.model, w.effort) : undefined;
  const task = w.task?.name ?? w.title ?? (w.prompt ? clip(w.prompt, 90) : undefined);
  const now = w.lost
    ? '🌿 Its worktree was deleted outside agent-office: open it to fix it'
    : w.status === 'needs_input'
      ? `🙋 ${w.activity ?? 'Waiting on an answer'}`
      : asleep
        ? '💤 Asleep: open it to wake it up'
        : w.status === 'done'
          ? w.task?.summary && `✅ ${w.task.summary}`
          : (w.task?.summary ?? w.activity);
  const sub = [
    w.kind === 'agent' ? `⚙️ ${providerLabel(w.provider, store.project)}${badge ? ` · ${badge}` : ''}` : '🐚 shell',
    desk && (desk.station ? `📌 ${desk.label}` : desk.label),
    w.worktree && `🌿 ${w.worktree.branch}`,
    w.pr && `🔀 PR #${w.pr.number}`,
    w.lastInput && `⌨️ ${w.lastInput.by} ${timeAgo(w.lastInput.at)}`,
  ].filter(Boolean);
  return h(
    'li.lite-worker',
    { class: `${w.status}${waiting ? ' waiting' : ''}` },
    h(
      'button.lite-card',
      { type: 'button', onclick: () => openWorker(w.id), 'aria-label': `${w.name}, ${STATUS_LABEL[w.status] ?? w.status}: open its terminal` },
      h('span.dot', { style: `background:${w.color}` }),
      h(
        'span.lite-info',
        {},
        h('span.lite-name', {}, w.name),
        task ? h('span.lite-task', {}, task) : null,
        now ? h('span.lite-now', {}, now) : null,
        h('span.lite-sub', {}, sub.join(' · ')),
      ),
      h('span.lite-state', {}, h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status), waiting && w.waitingSince ? h('small', {}, timeAgo(w.waitingSince)) : null),
    ),
    h('div.lite-side', {}, asleep || w.lost || w.status === 'needs_input' ? null : h('button.btn.lite-say', { type: 'button', 'aria-label': `Send ${w.name} a prompt`, onclick: () => promptWorker(w.id) }, '✍️'), h('button.btn.lite-say', { type: 'button', 'aria-label': `${w.name}: everything you can do`, onclick: () => go(`worker/${w.id}`) }, '⋯')),
  );
}

/** Today's spend and the plan windows that are running low, as one tappable line (the 3D office keeps these on screen). */
function usageStrip(): HTMLElement | null {
  const u = store.usage;
  const windows = [...store.limits.windows.map((w) => ({ ...w, label: `Claude ${w.label}` })), ...store.codexLimits.windows.map((w) => ({ ...w, label: `Codex ${w.label}` }))];
  if (!windows.length && !u.today.cost && !u.budget) return null;
  const worst = windows.reduce((m, w) => Math.max(m, w.pct), 0);
  const bits = [`💸 Today ${fmtCost(u.today.cost)}${u.budget !== undefined ? ` of ${fmtCost(u.budget)}` : ''}`, ...windows.map((w) => `${w.label} ${Math.round(w.pct)}%`)];
  return h('button.lp-row.lite-usage', { type: 'button', class: worst >= 90 ? 'over' : worst >= 75 ? 'near' : '', onclick: () => go('spend'), 'aria-label': 'Usage and limits' }, h('span.txt', {}, h('small', {}, 'Usage'), h('b', {}, bits.join(' · '))), h('span.chev', { 'aria-hidden': 'true' }, '›'));
}

/** The meeting at the table (or the last one, until the room is cleared): a way back into it from here. */
function meetingStrip(): HTMLElement | null {
  const m = store.meeting.current;
  if (!m) return null;
  const p = MEETING_PATTERNS[m.pattern];
  const state = m.status === 'running' ? 'in progress' : m.status === 'done' ? 'finished' : 'stopped';
  return h('button.lp-row.lite-meeting', { type: 'button', onclick: () => go('work/meeting') }, h('span.ico', { 'aria-hidden': 'true' }, '🤝'), h('span.txt', {}, h('small', {}, `Meeting ${state}`), h('b', {}, `${p.icon} ${m.title}`)), h('span.chev', { 'aria-hidden': 'true' }, '›'));
}

export function workersScreen(): Screen {
  const strips = h('div.lite-strips');
  const waitingNow = h('span.lite-waiting');
  const floorBox = h('div.lp-floor');
  const elsewhere = h('div.lite-elsewhere');
  const list = h('ul.lite-workers');
  const el = layout({
    top: [floorBox, strips, elsewhere, h('h2.lp-h', {}, h('span', {}, 'Workers'), waitingNow)],
    scroll: [list],
    bottom: [actions(button('✨ New task', () => sendToWorker('✨ New task'), 'primary'), button('🐚 Shell', openShell, '', 'A shared shell at a free desk'))],
  }).el;
  const paint = () => {
    const f = store.currentFloor();
    const p = store.project;
    floorBox.replaceChildren(
      h(
        'button.lp-row.lp-floorbtn',
        { type: 'button', onclick: () => go('floors') },
        h('span.ico', { 'aria-hidden': 'true' }, '🏢'),
        h('span.txt', {}, h('small', {}, 'Floor'), h('b', {}, p?.name ?? f?.name ?? 'No floor yet'), h('small', {}, p ? [p.branch && `⎇ ${p.branch}`, f && `👥 ${f.people} here`].filter(Boolean).join(' · ') : 'Tap to add a project')),
        h('span.chev', { 'aria-hidden': 'true' }, '⌄'),
      ),
    );
    strips.replaceChildren(...[usageStrip(), meetingStrip()].filter((x): x is HTMLElement => !!x));
    const others = store.floors.filter((o) => o.id !== store.floor && o.waiting > 0 && !o.cloning);
    elsewhere.replaceChildren(...others.map((o) => h('button.btn.lite-go', { type: 'button', onclick: () => net.send({ t: 'floor.go', floor: o.id }) }, `🙋 ${o.waiting} waiting on ${o.name}`, h('span', { 'aria-hidden': 'true' }, '→'))));
    const ws = byUrgency(store.workers.values());
    list.replaceChildren(...ws.map(card));
    if (!ws.length) list.append(h('li.lite-empty', {}, store.project ? 'Nobody is working on this floor. ✨ New task hires someone.' : 'No workers here.'));
    waitingNow.textContent = waitingLabel(waitingInOrder(ws));
  };
  const off = live(on, ['workers', 'project', 'floor', 'floors', 'usage', 'limits', 'meeting'], paint);
  // "3m ago" moves on by itself.
  const timer = setInterval(paint, 30_000);
  return {
    title: 'Agent Office',
    el,
    dispose: () => {
      off();
      clearInterval(timer);
    },
  };
}

// ---- One worker -------------------------------------------------------------------------------
/** Opens a worker's pull request: the 2D page for it when the board has it, else GitHub; opens one when there's none. */
export function openWorkerPr(w: WorkerInfo) {
  if (w.pr) {
    const n = w.pr.number;
    if (store.pulls.items.some((p) => p.number === n)) go(`pull/${n}`);
    else window.open(w.pr.url, '_blank', 'noopener');
  } else net.send({ t: 'worker.pr', workerId: w.id });
}

export function workerScreen([id]: string[]): Screen {
  const el = page();
  const paint = () => {
    const w = store.workers.get(id);
    if (!w) {
      el.replaceChildren(empty('🏠', 'This worker has gone home', 'Back on the workers list, the ones still here.'), actions(button('← Workers', () => go('workers', true))));
      return;
    }
    const desk = DESK_BY_ID.get(w.deskId);
    const asleep = isAsleep(w.status);
    const station = !!desk?.station;
    const badge = w.kind === 'agent' ? modelBadge(w.provider, w.model, w.effort) : undefined;
    const now = w.status === 'needs_input' ? `🙋 ${w.activity ?? 'Waiting on an answer'}` : w.status === 'done' ? w.task?.summary && `✅ ${w.task.summary}` : (w.task?.summary ?? w.activity);
    const facts: [string, string | undefined][] = [
      ['Runs on', w.kind === 'agent' ? `${providerLabel(w.provider, store.project)}${badge ? ` · ${badge}` : ''}` : 'a shared shell'],
      ['Desk', desk?.label],
      ['Branch', w.worktree?.branch],
      ['Based on', w.worktree?.from ?? w.worktree?.base],
      ['Folder', w.worktree?.path],
      ['Spent', w.usage ? usageLabel(w.usage, w.provider) : undefined],
      ['Last typed', w.lastInput ? `${w.lastInput.by} ${timeAgo(w.lastInput.at)}` : undefined],
      ['Watching', w.viewers.length ? w.viewers.join(', ') : undefined],
      ['Hired', `${timeAgo(w.createdAt)} by ${w.createdBy}`],
    ];
    fill(
      el,
      h(
        'div.lp-hero',
        {},
        h('span.dot', { style: `background:${w.color}` }),
        h('div', {}, h('b', {}, w.name), w.task?.name ?? w.title ? h('p', {}, (w.task?.name ?? w.title)!) : null, now ? h('p.lp-now', {}, now) : null),
        h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status),
      ),
      w.lost ? h('div.lp-warn', {}, '🌿 Its worktree was deleted outside agent-office.', button('Fix it', () => fixLostWorktree(w), 'primary')) : null,
      actions(
        button(asleep ? '▶️ Wake & open terminal' : '🖥️ Terminal', () => openWorker(w.id), 'primary'),
        asleep || w.lost ? null : button('✍️ Prompt', () => promptWorker(w.id)),
        w.kind === 'agent' && !w.lost ? button('🌿 Changes', () => go(`worker/${w.id}/changes`)) : null,
        w.kind === 'agent' && w.worktree ? button(w.prOpening ? '🔀 Opening PR…' : w.pr ? `🔀 PR #${w.pr.number}` : '🔀 Open PR', () => openWorkerPr(w), '', 'Pull request') : null,
        asleep && !w.lost ? button('▶️ Resume', () => net.send({ t: 'worker.resume', workerId: w.id })) : null,
        canLabel(w.deskId) ? button(store.floorPlan.labels[w.deskId] ? '🪧 Edit desk sign' : '🪧 Hang a sign', () => openDeskLabel(net, w.deskId), '', 'A sign over its desk, for everyone on this floor') : null,
        button(station ? '⏏️ End session' : '🏠 Send home', () => sendHome(w), 'danger'),
      ),
      ...(w.repos?.length
        ? [heading('Pull requests in other projects'), ...w.repos.map((r) => row({ icon: '🔀', title: r.name, sub: r.pr ? `PR #${r.pr.number}` : 'No pull request yet', onclick: () => (r.pr ? window.open(r.pr.url, '_blank', 'noopener') : net.send({ t: 'worker.pr', workerId: w.id })) }))]
        : []),
      heading('Details'),
      h('dl.lp-facts', {}, ...facts.filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      w.prompt ? h('details.lp-prompt', {}, h('summary', {}, 'Its first prompt'), h('p', {}, w.prompt)) : null,
    );
  };
  const off = live(on, ['workers'], paint);
  const w = store.workers.get(id);
  return { title: w?.name ?? 'Worker', el, dispose: off };
}

// ---- Its changes ------------------------------------------------------------------------------
export function changesScreen([id]: string[]): Screen {
  const info = store.workers.get(id);
  let state: ChangesState | null = null;
  let repo: string | undefined;
  const open = new Set<string>();
  const diffs = new Map<string, { sig: string; node: HTMLElement }>();
  const asked = new Map<string, string>();
  const topBox = h('div.lp-top-inner');
  const listBox = h('div');
  const barBox = h('div.lp-actions');
  const frame = layout({ top: [topBox], scroll: [listBox], bottom: [barBox] });
  const el = frame.el;

  const watch = () => net.send({ t: 'changes.watch', workerId: id, repo });
  const unwatch = () => net.send({ t: 'changes.unwatch', workerId: id, repo });

  const ask = (f: ChangedFile) => {
    if (asked.get(f.path) === f.sig) return;
    asked.set(f.path, f.sig);
    net.send({ t: 'changes.diff', workerId: id, path: f.path, repo });
  };

  const fileRow = (f: ChangedFile) => {
    const shown = open.has(f.path);
    const slot = h('div.lp-diff');
    if (shown) {
      const d = diffs.get(f.path);
      if (d && d.sig === f.sig) slot.append(d.node);
      else {
        slot.append(h('p.lp-note', {}, 'Loading…'));
        ask(f);
      }
    }
    const letter = f.status === '?' ? 'A' : f.status;
    return h(
      'li.lp-file',
      { class: shown ? 'open' : '' },
      h(
        'button',
        { type: 'button', 'aria-expanded': String(shown), onclick: () => (shown ? open.delete(f.path) : open.add(f.path), paint()) },
        h('span.st', { class: letter, title: STATUS_WORD[f.status] }, letter),
        pathLabel(f.path),
        f.uncommitted ? h('span.dirty', { title: 'Not committed yet' }) : null,
        plusMinus(f.additions, f.deletions, f.binary),
      ),
      shown ? slot : null,
      shown && f.uncommitted && !state?.busy
        ? h('div.lp-actions', {}, button('↩︎ Discard this file', () => confirmDialog(`Discard the changes to ${f.path.split('/').pop()}?`, `This puts ${f.path} back to the last commit. ${f.status === '?' ? 'The file is deleted.' : 'Committed changes stay.'}`, 'Discard', () => net.send({ t: 'changes.discard', workerId: id, path: f.path, repo }))))
        : null,
    );
  };

  function paint() {
    const w = store.workers.get(id);
    if (!w) return el.replaceChildren(empty('🏠', 'This worker has gone home'), actions(button('← Workers', () => go('workers', true))));
    const s = state;
    const tabs = w.repos?.length
      ? h(
          'div.lp-seg',
          {},
          ...[{ id: undefined as string | undefined, name: w.worktree?.path.split(/[\\/]/).pop() ?? 'this project' }, ...w.repos.map((r) => ({ id: r.floor as string | undefined, name: r.name }))].map((t) =>
            h('button', { type: 'button', class: t.id === repo ? 'on' : '', onclick: () => switchRepo(t.id) }, `📁 ${t.name}`),
          ),
        )
      : null;
    const uncommitted = s?.files.filter((f) => f.uncommitted).length ?? 0;
    const busy = !!s?.busy;
    const head = !s
      ? h('p.lp-note', {}, 'Loading…')
      : s.error
        ? h('p.lp-note.bad', {}, `Couldn't read ${s.dir || 'the project folder'}: ${s.error}`)
        : h('p.lp-note', {}, [s.branch && `🌿 ${s.branch}`, s.base === 'HEAD' ? 'uncommitted changes' : `vs ${s.base}`, s.ahead ? `${s.ahead} commit${s.ahead > 1 ? 's' : ''} ahead` : '', s.dir ? '' : '📁 shared project folder'].filter(Boolean).join(' · '));
    const prButton = !s
      ? null
      : s.pr
        ? h('a.btn.primary', { href: s.pr.url, target: '_blank', rel: 'noopener' }, `🔀 PR #${s.pr.number} ↗`)
        : s.prBase
          ? (() => {
              const why = busy ? '' : uncommitted ? 'Commit first' : !s.ahead ? `Nothing on ${s.branch} that ${s.prBase} lacks yet` : '';
              const b = button('🔀 Open PR…', () => openPr(s), 'primary', why || `Push ${s.branch} and open a pull request against ${s.prBase}`);
              b.disabled = busy || !!why;
              return b;
            })()
          : null;
    const commit = button(uncommitted ? `✅ Commit ${uncommitted} file${uncommitted > 1 ? 's' : ''}…` : '✅ Commit…', () => openCommit(uncommitted));
    commit.disabled = busy || !uncommitted;
    const discard = button('🗑️ Discard all', () => confirmDiscard(uncommitted), 'danger');
    discard.disabled = busy || !uncommitted;
    fill(topBox, tabs, head, busy ? h('p.lp-note', {}, `⏳ ${s!.busy}`) : null);
    fill(
      listBox,
      s && !s.error
        ? s.files.length
          ? h('ul.lp-files', {}, ...s.files.map(fileRow), s.more ? h('li.lp-note', {}, `…and ${s.more} more`) : null)
          : empty('🌱', s.base === 'HEAD' ? 'Nothing uncommitted' : `${w.name} hasn't changed anything since ${s.base} yet`, 'This page follows the checkout as the worker works.')
        : null,
    );
    fill(barBox, commit, discard, prButton);
  }

  const openCommit = (n: number) =>
    openPrompt({
      title: `✅ Commit ${n} file${n === 1 ? '' : 's'}`,
      subtitle: `Stages everything in ${state?.dir || 'the project folder'} and commits it${state?.branch ? ` on ${state.branch}` : ''}.`,
      placeholder: 'What changed, and why',
      submitLabel: 'Commit',
      onSubmit: (text) => net.send({ t: 'changes.commit', workerId: id, message: text, repo }),
    });
  const confirmDiscard = (n: number) =>
    confirmDialog(`Discard all uncommitted changes?`, `This puts ${n} file${n === 1 ? '' : 's'} back to the last commit and deletes new files. Commits stay.${state?.dir ? '' : " That folder is shared: anyone's uncommitted edits there go too."}`, 'Discard everything', () => net.send({ t: 'changes.discard', workerId: id, repo }));
  const openPr = (s: ChangesState) =>
    openPrompt({
      title: '🔀 Open a pull request',
      subtitle: `Pushes ${s.branch} to origin and opens a PR against ${s.prBase}. The first line is the title; the rest is the description.`,
      initial: s.subject ?? '',
      placeholder: 'Title',
      submitLabel: 'Open PR ↗',
      onSubmit: (text) => {
        const [first, ...rest] = text.split('\n');
        net.send({ t: 'changes.pr', workerId: id, title: first.trim(), body: rest.join('\n').trim(), repo });
      },
    });

  function switchRepo(next?: string) {
    if (next === repo) return;
    unwatch();
    repo = next;
    state = null;
    open.clear();
    diffs.clear();
    asked.clear();
    paint();
    watch();
  }

  const offMsg = onServerMessage((msg: ServerMsg) => {
    if (msg.t === 'welcome') watch();
    else if (msg.t === 'changes' && msg.state.workerId === id && msg.state.repo === repo) {
      state = msg.state;
      // A file that changed again needs its diff fetched afresh.
      for (const f of state.files) if (open.has(f.path) && diffs.get(f.path)?.sig !== f.sig) asked.delete(f.path);
      paint();
    } else if (msg.t === 'changes.diff' && msg.workerId === id && msg.repo === repo) {
      const f = state?.files.find((x) => x.path === msg.path);
      if (!f) return;
      const type = changedImageType(f.path);
      const text = msg.error ? h('p.lp-note.bad', {}, msg.error) : renderDiff(msg.diff, msg.truncated);
      const node = type ? h('div', {}, renderPreview(id, repo, f), ...(type === 'image/svg+xml' ? [text] : [])) : text;
      diffs.set(msg.path, { sig: f.sig, node });
      paint();
    }
  });
  const offWorkers = on('workers', () => {
    if (!store.workers.has(id)) paint();
  });
  paint();
  watch();
  return {
    title: `${info?.name ?? 'Worker'} · changes`,
    el,
    dispose: () => {
      offMsg();
      offWorkers();
      unwatch();
    },
  };
}
