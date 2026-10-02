// The Work tab: the issues and pull requests (lists, and a page for each with its conversation, diff,
// merge and close), the task queue, and the meeting room.

import type { GhIssue, GhIssueDetail, GhPull, GhPullDetail, GhReviewComment, QueueTask } from '../../shared/protocol';
import { store, workerForPull } from '../state';
import { officeFull } from '../../shared/machine';
import { clip, h, STATUS_LABEL, timeAgo, toast } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import { providerLabel, providerPicker, modelBadge } from '../ui/provider';
import { officePrompt } from '../ui/prompts';
import { issueMeeting, meetingForm, renderStatus } from '../ui/meeting';
import type { MeetingPreset } from '../ui/meeting';
import { issuePrompt } from '../ui/boards';
import { markdown } from '../ui/markdown';
import { looksGenerated, parseDiff, renderFileDiff, renderThread, repliesOf, STATUS_WORD, type DiffFile } from '../ui/pulldiff';
import { CHECK_ICON, REVIEW_BADGE, checksList, commentBox, commentCard, conflicted, errorBox, fixAndMergePrompt, fixConflictsPrompt, getJson, getText, issueContext, labelButton, mergePref, mergeStatus, openClose, openMerge, pullContext, reviewPrompt, spinnerRow, stateOf, avatar } from '../ui/pull';
import { labelChip } from '../ui/pull';
import { go, live, type Screen } from './app';
import { actions, button, chip, empty, fill, heading, layout, page, searchBox, segmented, textarea } from './kit';
import { net, openWorker, sendToWorker } from './ctx';

const on = store.on.bind(store);
type View = 'issues' | 'pulls' | 'queue' | 'meeting';

const byUpdated = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

/** The tabs at the top of the Work pages, with how much is in each. */
function views(active: View) {
  return segmented<View>(
    [
      { id: 'issues', label: '📌 Issues', count: store.issues.items.filter((i) => i.state === 'OPEN').length },
      { id: 'pulls', label: '🔀 PRs', count: store.pulls.items.filter((p) => p.state === 'OPEN').length },
      { id: 'queue', label: '📋 Queue', count: store.queue.tasks.filter((t) => t.status !== 'done').length },
      { id: 'meeting', label: '🤝 Meeting', count: store.meeting.current?.status === 'running' ? 1 : 0 },
    ],
    active,
    (v) => go(`work/${v}`, true),
  );
}

function refreshButton(): HTMLElement {
  return button('🔄', () => net.send({ t: 'gh.refresh' }), '', 'Refresh from GitHub');
}

const stamp = (st: { loading: boolean; fetchedAt?: number }) => (st.loading ? 'Refreshing…' : st.fetchedAt ? `Updated ${timeAgo(st.fetchedAt)}` : '');

export function workScreen([view]: string[]): Screen {
  const v: View = view === 'pulls' || view === 'queue' || view === 'meeting' ? view : 'issues';
  if (v === 'issues') return issuesScreen();
  if (v === 'pulls') return pullsScreen();
  if (v === 'queue') return queueScreen();
  return meetingScreen();
}

// ---- Issues -----------------------------------------------------------------------------------
type IssueFilter = 'open' | 'progress' | 'closed';
let issueFilter: IssueFilter = 'open';
let issueQuery = '';
const issueLabels = new Set<string>();

function issueGroups(items: GhIssue[]) {
  const open = items.filter((i) => i.state === 'OPEN');
  const progress = open.filter((i) => i.assignees.length > 0 || i.labels.some((l) => /progress|doing|wip|started/i.test(l.name)) || store.taskForIssue(i.number)?.status === 'running');
  return { open: open.filter((i) => !progress.includes(i)), progress, closed: items.filter((i) => i.state !== 'OPEN').sort(byUpdated).slice(0, 60) };
}

function queueChip(issue: number): HTMLElement | null {
  const t = store.taskForIssue(issue);
  if (!t) return null;
  if (t.status === 'queued') return chip('📋 queued', 'queue');
  if (t.status === 'running') return chip(`🤖 ${t.workerName ?? 'a worker'}`, 'running');
  return t.pr ? chip(`🔀 PR #${t.pr.number}`, 'done') : null;
}

function issueCard(it: GhIssue): HTMLElement {
  const task = store.taskForIssue(it.number);
  const queueable = it.state === 'OPEN' && !(task && task.status !== 'done');
  return h(
    'li.lp-card',
    {},
    h(
      'button.lp-cardbtn',
      { type: 'button', onclick: () => go(`issue/${it.number}`) },
      h('span.lp-num', {}, `#${it.number}`),
      h('b.lp-ttl', {}, it.title),
      h('span.lp-meta', {}, ...it.labels.slice(0, 4).map(labelChip), queueChip(it.number), it.assignees.length ? chip(`👤 ${it.assignees.join(', ')}`) : chip(`by ${it.author}`), it.comments ? chip(`💬 ${it.comments}`) : null, chip(timeAgo(it.updatedAt))),
    ),
    queueable ? h('button.btn.lp-quick', { type: 'button', 'aria-label': `Add #${it.number} to the queue`, onclick: () => net.send({ t: 'queue.add', prompt: issuePrompt(it), title: `#${it.number} ${it.title}`, issue: it.number }) }, '+📋') : null,
  );
}

function issuesScreen(): Screen {
  const list = h('ul.lp-cards');
  const bar = h('div.lp-filters');
  const labelRow = h('div.lp-labels');
  const status = h('p.lp-note');
  const el = layout({ top: [views('issues'), searchBox('Filter by title…', (q) => ((issueQuery = q), paint()), issueQuery), bar, labelRow, status], scroll: [list] }).el;
  const paint = () => {
    const st = store.issues;
    status.textContent = stamp(st);
    if (st.error && !st.items.length) {
      fill(list, h('li', {}, errorBox(st.error, () => net.send({ t: 'gh.refresh' }))));
      return;
    }
    const g = issueGroups(st.items);
    bar.replaceChildren(
      segmented<IssueFilter>(
        [
          { id: 'open', label: '📥 Open', count: g.open.length },
          { id: 'progress', label: '🚧 Doing', count: g.progress.length },
          { id: 'closed', label: '✅ Closed' },
        ],
        issueFilter,
        (f) => ((issueFilter = f), paint()),
      ),
    );
    const inGroup = g[issueFilter];
    const names = new Map<string, string>();
    for (const i of inGroup) for (const l of i.labels) names.set(l.name, l.color);
    labelRow.replaceChildren(
      ...[...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, color]) => h('button.lp-labelpick', { type: 'button', 'aria-pressed': String(issueLabels.has(name)), onclick: () => (issueLabels.has(name) ? issueLabels.delete(name) : issueLabels.add(name), paint()) }, labelChip({ name, color }))),
    );
    const words = issueQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = inGroup.filter((i) => (!issueLabels.size || i.labels.some((l) => issueLabels.has(l.name))) && words.every((w) => `${i.number} ${i.title}`.toLowerCase().includes(w)));
    fill(list, ...(shown.length ? shown.map(issueCard) : [h('li', {}, empty('📭', words.length || issueLabels.size ? 'Nothing matches' : 'Nothing here'))]));
  };
  const off = live(on, ['issues', 'queue'], paint);
  const timer = setInterval(() => (status.textContent = stamp(store.issues)), 15_000);
  return { title: 'Work', el, actions: [refreshButton()], dispose: () => (off(), clearInterval(timer)) };
}

/** One issue: its description and comments, and what to do about it. */
export function issueScreen([n]: string[]): Screen {
  const number = Number(n);
  let it = store.issues.items.find((i) => i.number === number);
  const thread = h('div.lp-thread');
  const meta = h('div.lp-meta.lp-pad');
  const bar = h('div.lp-bar');
  let detail: GhIssueDetail | null = null;
  let error = '';
  let generation = 0;
  const el = page();
  if (!it) {
    el.append(empty('❓', `Issue #${number} isn't on this floor's board`, 'It may belong to another floor, or the board is still loading.'), actions(button('← Issues', () => go('work/issues', true))));
    return { title: `Issue #${number}`, el };
  }
  const comment = commentBox('issue', number, it.url, net, (c) => {
    if (!detail) return load();
    detail.comments.push(c);
    paintThread();
  });
  const queueProvider = providerPicker(store.project, `lite-issue-${number}`, 'Queue on');
  const paintFrame = () => {
    if (!it) return;
    const isOpen = it.state === 'OPEN';
    const task = store.taskForIssue(number);
    const onQueue = !!task && task.status !== 'done';
    fill(
      meta,
      h('span.pill', { class: isOpen ? 'done' : 'offline' }, isOpen ? 'open' : 'closed'),
      avatar(it.author),
      h('b', {}, it.author),
      chip(`opened ${timeAgo(it.createdAt)}`),
      it.assignees.length ? chip(`👤 ${it.assignees.join(', ')}`) : null,
      ...it.labels.map(labelChip),
      labelButton('issue', () => it!, net, (labels) => ((it = { ...it!, labels }), paintFrame())),
    );
    fill(
      bar,
      isOpen && !onQueue ? queueProvider.element : null,
      actions(
        isOpen
          ? button(onQueue ? (task!.status === 'running' ? `🤖 ${task!.workerName ?? 'A worker'} is on it` : '📋 On the queue') : '📋 Add to queue', () => net.send({ t: 'queue.add', prompt: issuePrompt(it!), title: `#${number} ${it!.title}`, issue: number, provider: queueProvider.value(), model: queueProvider.model(), effort: queueProvider.effort() }), '', 'A worker picks it up when a desk is free')
          : null,
        isOpen ? button('🤖 Hand to a worker', () => sendToWorker(`Hand issue #${number} to a worker`, { initial: issuePrompt(it!) }), 'primary') : null,
        button('✍️ Ask a worker', () => sendToWorker(`Ask about issue #${number}`, { context: issueContext(it!) })),
        button('🤝 Meeting', () => startMeeting(issueMeeting(number, it!.title))),
        isOpen ? button('✔️ Close…', () => openClose('issue', it!, net, load)) : null,
        h('a.btn', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub ↗'),
      ),
    );
    const q = bar.querySelector('button.btn');
    if (q && onQueue) (q as HTMLButtonElement).disabled = true;
  };
  const paintThread = () => {
    if (!it) return;
    fill(
      thread,
      commentCard({ id: 'body', author: it.author, body: detail?.body ?? it.body, createdAt: it.createdAt, url: it.url }, it.url, 'opened this'),
      error ? errorBox(error, load) : !detail ? spinnerRow('Loading comments…') : !detail.comments.length ? h('p.lp-note', {}, 'No comments yet.') : null,
      ...(detail?.comments.map((c) => commentCard(c, it!.url, 'commented')) ?? []),
    );
  };
  function load() {
    const g = ++generation;
    error = '';
    paintThread();
    getJson<GhIssueDetail>(`/api/gh/issue?number=${number}`)
      .then((d) => {
        if (g !== generation) return;
        detail = d;
        it = { ...it!, state: d.state };
        comment.setViewer(d.viewer);
      })
      .catch((e) => g === generation && (error = (e as Error).message))
      .finally(() => g === generation && (paintFrame(), paintThread()));
  }
  el.append(h('h1.lp-title', {}, it.title), meta, bar, thread, comment.el);
  const offs = [
    on('issues', () => {
      const fresh = store.issues.items.find((i) => i.number === number);
      if (fresh) {
        it = detail ? { ...fresh, state: fresh.state === 'OPEN' ? detail.state : fresh.state } : fresh;
        paintFrame();
      }
    }),
    on('queue', paintFrame),
  ];
  paintFrame();
  load();
  return { title: `Issue #${number}`, el, actions: [button('🔄', load, '', 'Reload')], dispose: () => (offs.forEach((o) => o()), comment.dispose()) };
}

// ---- Pull requests ----------------------------------------------------------------------------
type PullFilter = 'review' | 'approved' | 'draft' | 'merged' | 'closed';
let pullFilter: PullFilter = 'review';
let pullQuery = '';

function pullGroups(items: GhPull[]): Record<PullFilter, GhPull[]> {
  const open = items.filter((p) => p.state === 'OPEN');
  return {
    review: open.filter((p) => !p.isDraft && p.reviewDecision !== 'APPROVED'),
    approved: open.filter((p) => !p.isDraft && p.reviewDecision === 'APPROVED'),
    draft: open.filter((p) => p.isDraft),
    merged: items.filter((p) => p.state === 'MERGED').sort(byUpdated).slice(0, 40),
    closed: items.filter((p) => p.state === 'CLOSED').sort(byUpdated).slice(0, 30),
  };
}

function pullCard(it: GhPull): HTMLElement {
  const w = workerForPull(store.workers.values(), it);
  return h(
    'li.lp-card',
    {},
    h(
      'button.lp-cardbtn',
      { type: 'button', onclick: () => go(`pull/${it.number}`) },
      h('span.lp-num', {}, `#${it.number} ${CHECK_ICON[it.checks as 'pass'] ?? ''}`),
      h('b.lp-ttl', {}, it.title),
      h(
        'span.lp-meta',
        {},
        w ? chip(`🪑 ${w.name}`) : null,
        ...it.labels.slice(0, 3).map(labelChip),
        chip(`by ${it.author}`),
        it.reviewDecision === 'CHANGES_REQUESTED' ? chip('🛠 changes requested') : null,
        h('span.lp-chip.add', {}, `+${it.additions}`),
        h('span.lp-chip.del', {}, `−${it.deletions}`),
        chip(timeAgo(it.updatedAt)),
      ),
    ),
  );
}

function pullsScreen(): Screen {
  const list = h('ul.lp-cards');
  const bar = h('div.lp-filters');
  const status = h('p.lp-note');
  const el = layout({ top: [views('pulls'), searchBox('Filter by title…', (q) => ((pullQuery = q), paint()), pullQuery), bar, status], scroll: [list] }).el;
  const paint = () => {
    const st = store.pulls;
    status.textContent = stamp(st);
    if (st.error && !st.items.length) return fill(list, h('li', {}, errorBox(st.error, () => net.send({ t: 'gh.refresh' }))));
    const g = pullGroups(st.items);
    bar.replaceChildren(
      segmented<PullFilter>(
        [
          { id: 'review', label: '👀 Review', count: g.review.length },
          { id: 'approved', label: '👍 OK', count: g.approved.length },
          { id: 'draft', label: '✏️ Draft', count: g.draft.length },
          { id: 'merged', label: '🎉 Merged' },
          { id: 'closed', label: '🗑️' },
        ],
        pullFilter,
        (f) => ((pullFilter = f), paint()),
      ),
    );
    const words = pullQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = g[pullFilter].filter((p) => words.every((w) => `${p.number} ${p.title}`.toLowerCase().includes(w)));
    fill(list, ...(shown.length ? shown.map(pullCard) : [h('li', {}, empty('📭', words.length ? 'Nothing matches' : 'Nothing here'))]));
  };
  const off = live(on, ['pulls', 'workers'], paint);
  const timer = setInterval(() => (status.textContent = stamp(store.pulls)), 15_000);
  return { title: 'Work', el, actions: [refreshButton()], dispose: () => (off(), clearInterval(timer)) };
}

let pullTab: 'conversation' | 'files' = 'conversation';

/** One pull request: conversation and checks, the files changed, and merge, review or close. */
export function pullScreen([n]: string[]): Screen {
  const number = Number(n);
  let it = store.pulls.items.find((p) => p.number === number);
  const el = page();
  if (!it) {
    el.append(empty('❓', `PR #${number} isn't on this floor's board`, 'It may belong to another floor, or the board is still loading.'), actions(button('← Pull requests', () => go('work/pulls', true))));
    return { title: `PR #${number}`, el };
  }
  let detail: GhPullDetail | null = null;
  let files: DiffFile[] | null = null;
  let detailError = '';
  let diffError = '';
  let generation = 0;
  const openFiles = new Set<string>();
  const meta = h('div.lp-meta.lp-pad');
  const tabs = h('div');
  const body = h('div');
  const bar = h('div.lp-bar');
  const comment = commentBox('pull', number, it.url, net, (c) => {
    if (!detail) return load();
    detail.comments.push(c);
    paintBody();
  });

  const handToWorker = () => {
    const p = mergePref(detail?.repo.methods ?? ['squash', 'merge', 'rebase']);
    if (detail && conflicted(detail)) sendToWorker(`Fix conflicts & merge PR #${number}`, { initial: fixConflictsPrompt(it!, p.method, p.deleteBranch) });
    else sendToWorker(`Fix up & merge PR #${number}`, { initial: fixAndMergePrompt(it!, p.method, p.deleteBranch) });
  };

  const paintFrame = () => {
    const x = it!;
    const [word, cls] = stateOf(x);
    fill(
      meta,
      h('span.pill', { class: cls }, word),
      avatar(x.author),
      h('b', {}, x.author),
      chip(`${x.headRefName} → ${x.baseRefName}`),
      h('span.lp-chip.add', {}, `+${x.additions}`),
      h('span.lp-chip.del', {}, `−${x.deletions}`),
      ...x.labels.map(labelChip),
      labelButton('pull', () => it!, net, (labels) => ((it = { ...it!, labels }), paintFrame())),
      x.reviewDecision ? h('span.gh-badge', { class: REVIEW_BADGE[x.reviewDecision]?.[1] ?? '' }, x.reviewDecision === 'REVIEW_REQUIRED' ? 'review required' : (REVIEW_BADGE[x.reviewDecision]?.[0] ?? x.reviewDecision.toLowerCase())) : null,
    );
    const comments = detail ? detail.comments.length + detail.reviews.length + detail.reviewComments.filter((c) => !c.replyTo).length : 0;
    fill(
      tabs,
      segmented<'conversation' | 'files'>(
        [
          { id: 'conversation', label: '💬 Conversation', count: comments },
          { id: 'files', label: '📄 Files', count: files?.length },
        ],
        pullTab,
        (t) => ((pullTab = t), paintFrame(), paintBody()),
      ),
    );
    const isOpen = x.state === 'OPEN';
    const conflicts = !!detail && conflicted(detail);
    const w = workerForPull(store.workers.values(), x);
    const merge = button('🔀 Merge…', () => detail && openMerge(x, detail, net, handToWorker, load), conflicts ? '' : 'primary');
    merge.disabled = !detail;
    fill(
      bar,
      actions(
        isOpen ? merge : null,
        conflicts ? button('✨ Fix conflicts & merge', handToWorker, 'primary') : isOpen ? button('🤖 Fix & merge', handToWorker) : null,
        isOpen ? button('🔍 Review', () => sendToWorker(`Review PR #${number}`, { initial: reviewPrompt(x) })) : null,
        isOpen ? button('🤝 Review panel', () => startMeeting({ pattern: 'review', pr: number, title: `Review of PR #${number}`, prompt: officePrompt('pull.panel', { number, title: x.title, url: x.url, branch: x.headRefName, base: x.baseRefName }) })) : null,
        button('✍️ Ask a worker', () => sendToWorker(`Ask about PR #${number}`, { context: pullContext(x) })),
        w ? button(`🪑 ${w.name}`, () => go(`worker/${w.id}`)) : null,
        isOpen ? button('🚫 Close…', () => openClose('pull', x, net, load), 'danger') : null,
        h('a.btn', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, 'GitHub ↗'),
      ),
    );
  };

  const conversation = (): HTMLElement[] => {
    const x = it!;
    const out: HTMLElement[] = [commentCard({ id: 'body', author: x.author, body: detail?.body ?? x.body ?? '', createdAt: x.createdAt, url: x.url }, x.url, 'opened this')];
    if (detailError) return [...out, errorBox(detailError, load)];
    if (!detail) return [...out, spinnerRow('Loading the conversation…')];
    const d = detail;
    const replies = repliesOf(d.reviewComments);
    const items: { at: string; node: HTMLElement }[] = [
      ...d.comments.map((c) => ({ at: c.createdAt, node: commentCard(c, x.url, 'commented') })),
      ...d.reviews.map((r) => ({ at: r.createdAt, node: commentCard(r, x.url, '', REVIEW_BADGE[r.state ?? ''] ?? [r.state?.toLowerCase() ?? 'reviewed', '']) })),
      ...d.reviewComments
        .filter((c: GhReviewComment) => !c.replyTo)
        .map((c: GhReviewComment) => ({
          at: c.createdAt,
          node: h(
            'article.gh-card.gh-thread',
            {},
            h('header', {}, h('span', {}, '💬'), h('code', { title: c.path }, `${c.path}${c.line ? `:${c.line}` : ''}`), c.line == null ? h('span.gh-badge.muted', {}, 'outdated') : null),
            renderThread(c, replies, x.url),
          ),
        })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    out.push(...items.map((i) => i.node));
    if (!items.length) out.push(h('p.lp-note', {}, 'No comments or reviews yet.'));
    const st = mergeStatus(d);
    out.push(h('section.gh-mergebox', { class: st.cls }, h('div.gh-status', { class: st.cls }, h('span', {}, st.icon), st.text), d.checks.length ? checksList(d.checks) : null));
    out.push(comment.el);
    return out;
  };

  const fileBlock = (f: DiffFile) => {
    const shown = openFiles.has(f.path);
    const big = looksGenerated(f.path) || f.lines.length > 800;
    return h(
      'li.lp-file',
      { class: shown ? 'open' : '' },
      h(
        'button',
        { type: 'button', 'aria-expanded': String(shown), onclick: () => (shown ? openFiles.delete(f.path) : openFiles.add(f.path), paintBody()) },
        h('span.st', { class: f.status, title: STATUS_WORD[f.status] }, f.status),
        h('span.path', { title: f.path }, f.path),
        h('span.pm', {}, h('span.add', {}, `+${f.additions}`), ' ', h('span.del', {}, `−${f.deletions}`)),
      ),
      shown ? h('div.lp-diff', {}, big ? h('p.lp-note', {}, `Large or generated file (${f.lines.length} lines) — `, h('a', { href: `${it!.url}/files`, target: '_blank', rel: 'noopener' }, 'see it on GitHub')) : renderFileDiff(f, detail?.reviewComments ?? [], it!.url)) : null,
    );
  };

  function paintBody() {
    if (pullTab === 'conversation') return fill(body, ...conversation());
    if (diffError) return fill(body, errorBox(diffError, load));
    if (!files) return fill(body, spinnerRow('Loading the diff…'));
    fill(body, files.length ? h('ul.lp-files', {}, ...files.map(fileBlock)) : empty('📄', 'No files changed'));
  }

  function load() {
    const g = ++generation;
    detailError = diffError = '';
    paintBody();
    getJson<GhPullDetail>(`/api/gh/pull?number=${number}`)
      .then((d) => {
        if (g !== generation) return;
        detail = d;
        comment.setViewer(d.viewer);
        it = { ...it!, state: d.state, isDraft: d.isDraft, reviewDecision: d.reviewDecision };
      })
      .catch((e) => g === generation && (detailError = (e as Error).message))
      .finally(() => g === generation && (paintFrame(), paintBody()));
    getText(`/api/gh/pull/diff?number=${number}`)
      .then((text) => g === generation && (files = parseDiff(text)))
      .catch((e) => g === generation && (diffError = (e as Error).message))
      .finally(() => g === generation && (paintFrame(), paintBody()));
  }

  const frame = layout({ top: [tabs], scroll: [h('h1.lp-title', {}, it.title), meta, bar, body] });
  const offs = [
    on('pulls', () => {
      const fresh = store.pulls.items.find((p) => p.number === number);
      if (!fresh) return;
      it = detail ? { ...fresh, state: fresh.state === 'OPEN' ? detail.state : fresh.state } : fresh;
      paintFrame();
    }),
    on('workers', paintFrame),
  ];
  paintFrame();
  load();
  return {
    title: `PR #${number}`,
    el: frame.el,
    actions: [
      button('🔄', () => {
        net.send({ t: 'gh.refresh' });
        load();
      }, '', 'Reload from GitHub'),
    ],
    dispose: () => (offs.forEach((o) => o()), comment.dispose()),
  };
}

// ---- The queue --------------------------------------------------------------------------------
function outcome(t: QueueTask): string {
  switch (t.outcome) {
    case 'done':
      return t.pr ? 'finished' : 'finished, no PR found yet';
    case 'exited':
      return t.error ? `stopped: ${t.error}` : 'stopped before finishing';
    case 'killed':
      return 'sent home';
    case 'failed':
      return `couldn't start: ${t.error ?? 'unknown error'}`;
    default:
      return '';
  }
}

function queueScreen(): Screen {
  const limitValue = h('b');
  const minus = h('button.btn', { type: 'button', 'aria-label': 'Fewer workers at once' }, '−');
  const plus = h('button.btn', { type: 'button', 'aria-label': 'More workers at once' }, '+');
  minus.addEventListener('click', () => net.send({ t: 'queue.limit', maxWorkers: store.queue.maxWorkers - 1 }));
  plus.addEventListener('click', () => net.send({ t: 'queue.limit', maxWorkers: store.queue.maxWorkers + 1 }));
  const ta = textarea('Describe a task for the next free worker…', 3);
  const provider = providerPicker(store.project, 'lite-queue-provider');
  const add = () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    if (!provider.valid()) return;
    net.send({ t: 'queue.add', prompt: text, provider: provider.value(), model: provider.model(), effort: provider.effort() });
    ta.value = '';
  };
  const list = h('div');
  const form = h('div.lp-card.lp-form', {}, ta, provider.element, actions(button('Add to queue', add, 'primary')));

  const task = (t: QueueTask): HTMLElement => {
    const w = t.workerId ? store.workers.get(t.workerId) : undefined;
    const badge = modelBadge(t.provider, t.model, t.effort);
    const meta: string[] = [`⚙️ ${providerLabel(t.provider ?? w?.provider, store.project)}${badge ? ` · ${badge}` : ''}`];
    const btns: (HTMLElement | null)[] = [];
    let pos = '';
    if (t.status === 'running') {
      meta.push(`${t.workerName ?? 'a worker'} · ${w ? (STATUS_LABEL[w.status] ?? w.status) : 'gone'}`);
      if (t.branch) meta.push(`🌿 ${t.branch}`);
      if (t.startedAt) meta.push(`started ${timeAgo(t.startedAt)}`);
      if (w) {
        btns.push(button('🖥️ Terminal', () => openWorker(w.id)), button('⏹ Stop', () => confirmDialog(`Stop ${w.name}?`, `This sends ${w.name} home and stops the task. You can requeue it afterwards.`, 'Stop', () => net.send({ t: 'worker.kill', workerId: w.id }))));
      }
    } else if (t.status === 'queued') {
      const queued = store.queue.tasks.filter((x) => x.status === 'queued');
      const i = queued.indexOf(t);
      pos = String(i + 1);
      meta.push(`added by ${t.addedBy} ${timeAgo(t.addedAt)}`);
      const up = button('↑', () => net.send({ t: 'queue.move', taskId: t.id, delta: -1 }), '', 'Move up');
      const down = button('↓', () => net.send({ t: 'queue.move', taskId: t.id, delta: 1 }), '', 'Move down');
      up.disabled = i === 0;
      down.disabled = i === queued.length - 1;
      btns.push(up, down, button('✕ Remove', () => net.send({ t: 'queue.remove', taskId: t.id })));
    } else {
      meta.push(outcome(t));
      if (t.workerName) meta.push(t.workerName);
      if (t.finishedAt) meta.push(timeAgo(t.finishedAt));
      if (t.pr) btns.push(h('a.btn', { href: t.pr.url, target: '_blank', rel: 'noopener' }, `🔀 PR #${t.pr.number}${t.pr.state === 'MERGED' ? ' ✓' : ''}`));
      if (w) btns.push(button('🖥️ Terminal', () => openWorker(w.id)));
      btns.push(button('↻ Requeue', () => net.send({ t: 'queue.retry', taskId: t.id })), button('✕', () => net.send({ t: 'queue.remove', taskId: t.id }), '', 'Forget it'));
    }
    const issue = t.issue !== undefined ? store.issues.items.find((i) => i.number === t.issue) : undefined;
    return h(
      'li.lp-card.lp-task',
      { class: t.status },
      h(
        'div.lp-cardbody',
        {},
        pos ? h('span.lp-num', {}, `#${pos} in line`) : null,
        issue ? h('button.lp-link', { type: 'button', onclick: () => go(`issue/${issue.number}`) }, h('b', {}, t.title)) : h('b.lp-ttl', { title: t.prompt }, t.title),
        h('span.lp-meta', {}, ...meta.filter(Boolean).map((m) => chip(m))),
      ),
      actions(...btns),
    );
  };

  const paint = () => {
    const q = store.queue;
    limitValue.textContent = q.maxWorkers === 0 ? 'Paused' : String(q.maxWorkers);
    minus.toggleAttribute('disabled', q.maxWorkers <= 0);
    const running = q.tasks.filter((t) => t.status === 'running');
    const queued = q.tasks.filter((t) => t.status === 'queued');
    const done = q.tasks.filter((t) => t.status === 'done').slice().reverse();
    const m = store.machine;
    const group = (title: string, tasks: QueueTask[], extra?: HTMLElement) => (tasks.length ? [heading(`${title} · ${tasks.length}`, extra), h('ul.lp-cards', {}, ...tasks.map(task))] : []);
    fill(
      list,
      h('div.lp-limit', {}, h('span', {}, 'Workers at once'), minus, limitValue, plus),
      h('p.lp-note', {}, 'The queue keeps going while you’re away. Set it to 0 to pause. Issues are assigned on GitHub when they start.'),
      queued.length && officeFull(m) ? h('p.lp-note', {}, `⏸ The office is at its limit of ${m.limit} worker${m.limit === 1 ? '' : 's'}, so the next task waits until one goes home.`) : null,
      ...group('🤖 Working on it', running),
      ...group('⏳ Up next', queued),
      ...group('✅ Finished', done, button('Clear', () => net.send({ t: 'queue.clear' }))),
      running.length + queued.length + done.length ? null : empty('📋', 'Nothing on the queue yet', 'Add a task above, or tap +📋 on an issue.'),
    );
  };
  const off = live(on, ['queue', 'workers', 'issues', 'machine'], paint);
  const timer = setInterval(paint, 30_000);
  return { title: 'Work', el: layout({ top: [views('queue')], scroll: [form, list] }).el, dispose: () => (off(), clearInterval(timer)) };
}

// ---- The meeting room -------------------------------------------------------------------------
let pendingMeeting: MeetingPreset | undefined;

/** Opens the meeting page on its form, filled in from an issue or a pull request. */
export function startMeeting(preset?: MeetingPreset) {
  pendingMeeting = preset;
  go('work/meeting');
}

function meetingScreen(): Screen {
  const preset = pendingMeeting;
  pendingMeeting = undefined;
  const holder = h('div.lp-meeting');
  const foot = h('div.lp-bar.lp-meeting-foot');
  let showing: 'status' | 'form' = preset || !store.meeting.current ? 'form' : 'status';
  let form: ReturnType<typeof meetingForm> | null = null;
  const paint = () => {
    if (showing === 'status' && store.meeting.current) {
      form = null;
      const body = h('div.body.meeting');
      const f = h('footer');
      renderStatus(store.meeting.current, body, f, net, { openTerminal: openWorker, openPr: (id) => net.send({ t: 'worker.pr', workerId: id }) }, () => ((showing = 'form'), paint()));
      fill(holder, body);
      fill(foot, f);
      return;
    }
    if (!form) {
      form = meetingForm(net, preset, () => ((showing = 'status'), paint()), () => ((showing = 'status'), paint()));
      fill(holder, form.body);
      fill(foot, h('footer', {}, ...form.foot));
    }
    form.refresh();
  };
  const off = live(on, ['meeting', 'pulls'], paint);
  const w = on('workers', () => showing === 'status' && paint());
  return { title: 'Work', el: layout({ top: [views('meeting')], scroll: [holder], bottom: [foot] }).el, dispose: () => (off(), w()) };
}
