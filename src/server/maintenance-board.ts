import { execFile } from 'node:child_process';
import type { MaintenanceIssues, MaintenanceWorkItem } from '../shared/protocol.js';
import { GitHub, gh } from './github.js';
import { originRepo } from './building.js';
import type { GhAs } from './signins.js';
import { ISSUE_LABELS, MAINTENANCE_QUEUE_LABEL, maintenanceQueued } from '../shared/maintenance-issues.js';
import { officeSourceDir } from './maintenance.js';

/** What the board needs from Maintenance's execution record for an issue. */
export type MaintenanceWorkRecord = { number: number; status: MaintenanceWorkItem['status']; commits: { sha: string }[] };

/** A separate GitHub feed, rooted in the office source rather than a floor's project. */
export class MaintenanceBoard {
  private github?: GitHub;
  state: MaintenanceIssues = { items: [], fetchedAt: 0, loading: false };

  /** Open issues the source's default branch already holds the work for, by number. */
  private shipped = new Map<number, string>();
  private shipTimer?: NodeJS.Timeout;
  /** Issues this office already tried to close on shipping, so a failing close is not retried every poll. */
  private autoClosed = new Set<number>();

  /** `work` is Maintenance's record per issue: its status for the lanes, and its commits to see whether they have shipped. */
  constructor(private emit: (state: MaintenanceIssues) => void, private source = officeSourceDir(), private work: () => MaintenanceWorkRecord[] = () => []) {
    if (this.source) {
      const repo = originRepo(this.source);
      if (repo) {
        this.state.repo = repo;
        this.github = new GitHub(this.source, (state) => this.set({ ...state, repo: this.state.repo }), () => {}, repo);
      } else this.state.error = "The office source needs a GitHub origin remote for its maintenance issues board";
    }
    else this.state.error = "Can't find Agent Office's own source (set AGENT_OFFICE_SOURCE)";
  }

  private set(state: MaintenanceIssues) {
    // The stack ships by pushing commits, which close nothing on GitHub: flag open issues whose work is already on main.
    const records = new Map(this.work().map((w) => [w.number, w]));
    const items = state.items.map((i) => {
      const doneBy = i.state === 'OPEN' ? i.doneBy ?? this.shipped.get(i.number) : undefined;
      const record = records.get(i.number);
      const work = record ? { status: record.status, commits: record.commits.length } : undefined;
      return doneBy === i.doneBy && work?.status === i.work?.status && work?.commits === i.work?.commits ? i : { ...i, doneBy, work };
    });
    this.state = { ...state, items };
    this.emit(this.state);
  }

  /** Maintenance's record changed (a session started, finished or was reviewed): move the cards to match. */
  workChanged() {
    if (this.state.fetchedAt) this.set({ ...this.state, items: this.github?.issues.items ?? this.state.items });
  }

  /** Only recorded Maintenance work proves a commit belongs to an issue in this repository. */
  private async findShipped() {
    if (!this.source) return;
    const found = new Map<number, string>();
    const onMain = new Map<string, boolean>();
    const shippedSha = async (sha: string) => {
      if (!/^[a-f0-9]{7,40}$/.test(sha)) return false;
      if (!onMain.has(sha)) onMain.set(sha, await new Promise<boolean>((resolve) => execFile('git', ['merge-base', '--is-ancestor', sha, 'origin/HEAD'], { cwd: this.source }, (err) => resolve(!err))));
      return onMain.get(sha)!;
    };
    const finished: MaintenanceWorkRecord[] = [];
    for (const w of this.work()) {
      let all = w.commits.length > 0;
      for (const c of w.commits) {
        const ok = await shippedSha(c.sha);
        if (ok && !found.has(w.number)) found.set(w.number, `commit ${c.sha.slice(0, 7)} on main`);
        all &&= ok;
      }
      // Finished agent work whose every commit is on main has shipped: the issue is done.
      if (all && (w.status === 'review' || w.status === 'done')) finished.push(w);
    }
    const same = found.size === this.shipped.size && [...found].every(([k, v]) => this.shipped.get(k) === v);
    this.shipped = found;
    // Reapply evidence to GitHub's undecorated items, so removed evidence clears old badges.
    if (!same) this.set({ ...this.state, items: this.github?.issues.items ?? this.state.items });
    await this.closeShipped(finished);
  }

  /** Shipping the stack pushes commits, which close nothing on GitHub; close the issues it finished, saying which commits did it. */
  private async closeShipped(finished: MaintenanceWorkRecord[]) {
    if (!this.github || !this.state.repo) return;
    let closed = false;
    for (const w of finished) {
      const issue = this.state.items.find((i) => i.number === w.number);
      if (!issue || issue.state !== 'OPEN' || this.autoClosed.has(w.number)) continue;
      this.autoClosed.add(w.number);
      const shas = w.commits.map((c) => c.sha.slice(0, 7)).join(', ');
      const error = await this.github.close('issue', w.number, { reason: 'completed', comment: `Shipped to main by Agent Office Maintenance (${shas}).` });
      if (error) { console.warn(`agent-office: could not close shipped maintenance issue #${w.number}: ${error}`); continue; }
      closed = true;
      if (issue.labels.some((l) => l.name === MAINTENANCE_QUEUE_LABEL)) await this.github.setLabels('issue', w.number, [], [MAINTENANCE_QUEUE_LABEL]);
    }
    if (closed) await this.github.refresh();
  }

  start() {
    this.github?.start();
    void this.identify();
    setTimeout(() => void this.findShipped(), 8000);
    this.shipTimer = setInterval(() => void this.findShipped(), 90_000);
  }

  stop() { this.github?.stop(); clearInterval(this.shipTimer); }

  private async identify() {
    if (!this.github) return;
    try {
      const repo = (await this.github.repoInfo()).nameWithOwner;
      this.set({ ...this.state, repo });
    } catch {
      // The issue feed carries an actionable GitHub error. Retry identity on refresh.
    }
  }

  async refresh() {
    await Promise.all([this.github?.refresh(), this.identify()]);
    await this.findShipped();
  }

  /** The crafter's labels exist before they are used; an existing label (perhaps recolored by the team) is left alone. */
  private async ensureLabels(labels: string[], as?: GhAs) {
    for (const name of labels) {
      const known = ISSUE_LABELS.find((l) => l.name === name);
      if (!known || this.state.items.some((i) => i.labels.some((l) => l.name === name))) continue;
      await gh(['label', 'create', name, '--repo', this.state.repo!, '--color', known.color, '--description', known.description], this.source!, undefined, as?.env).catch(() => {});
    }
  }

  async create(title: string, body: string, as?: GhAs, labels: string[] = []) {
    if (!this.github || !this.source || !this.state.repo) throw new Error(this.state.error ?? 'No maintenance repository');
    if (!title.trim() || title.length > 200 || body.length > 20000) throw new Error('Use a title up to 200 characters and a description up to 20,000.');
    await this.ensureLabels(labels, as);
    const url = (await gh(['issue', 'create', '--repo', this.state.repo, '--title', title.trim(), '--body', body, ...labels.flatMap((l) => ['--label', l])], this.source, undefined, as?.env)).trim();
    const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
    if (!number) throw new Error('GitHub did not return an issue URL');
    void this.refresh();
    return { number, title: title.trim(), url };
  }

  /** `labels`, when given, sets the crafter's labels on the issue; labels outside its vocabulary are untouched. */
  async edit(number: number, title: string, body: string, as?: GhAs, labels?: string[]) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Bad issue number');
    if (!this.github || !this.source || !this.state.repo) throw new Error('No maintenance repository');
    if (!title.trim() || title.length > 200 || body.length > 20000) throw new Error('Use a title up to 200 characters and a description up to 20,000.');
    const had = this.state.items.find((i) => i.number === number)?.labels.map((l) => l.name) ?? [];
    const add = labels?.filter((l) => !had.includes(l)) ?? [];
    const remove = labels ? had.filter((l) => ISSUE_LABELS.some((k) => k.name === l) && !labels.includes(l)) : [];
    await this.ensureLabels(add, as);
    await gh(['issue', 'edit', String(number), '--repo', this.state.repo, '--title', title.trim(), '--body', body, ...add.flatMap((l) => ['--add-label', l]), ...remove.flatMap((l) => ['--remove-label', l])], this.source, undefined, as?.env);
    await this.refresh();
    return { number, title: title.trim(), url: `https://github.com/${this.state.repo}/issues/${number}` };
  }

  /** Queue membership lives on GitHub; the office stores only execution evidence. */
  async queue(number: number, queued: boolean, as?: GhAs) {
    const detail = await this.issue(number);
    if (queued && detail.state !== 'OPEN') throw new Error('Reopen this issue before queuing it');
    if (!this.github || !this.source || !this.state.repo) throw new Error('No maintenance repository');
    if (queued) await gh(['label', 'create', MAINTENANCE_QUEUE_LABEL, '--repo', this.state.repo, '--color', 'f08c00', '--description', 'Waiting for Agent Office Maintenance', '--force'], this.source, undefined, as?.env);
    const result = await this.github.setLabels('issue', number, queued ? [MAINTENANCE_QUEUE_LABEL] : [], queued ? [] : [MAINTENANCE_QUEUE_LABEL], as);
    if (result.error) throw new Error(result.error);
    await this.refresh();
  }

  /** Closes an open issue on GitHub (completed), dropping it from the queue. Separate from shipping the stack. */
  async close(number: number, as?: GhAs) {
    const detail = await this.issue(number);
    if (detail.state !== 'OPEN') throw new Error('This issue is already closed');
    const error = await this.github!.close('issue', number, { reason: 'completed' }, as);
    if (error) throw new Error(error);
    const issue = this.state.items.find(i => i.number === number);
    if (issue && issue.labels.some(l => l.name === MAINTENANCE_QUEUE_LABEL)) await this.github!.setLabels('issue', number, [], [MAINTENANCE_QUEUE_LABEL], as);
    await this.refresh();
  }

  async claim(number: number, as?: GhAs) {
    await this.issue(number);
    return this.github!.claim(number, as);
  }

  async request(number: number, requireQueued = false) {
    await this.refresh();
    if (this.state.error) throw new Error(this.state.error);
    const detail = await this.issue(number);
    if (detail.state !== 'OPEN') throw new Error('Reopen this issue before starting Maintenance');
    const issue = this.state.items.find((item) => item.number === number);
    if (!issue) throw new Error('Refresh the maintenance board before starting this issue');
    if (requireQueued && !maintenanceQueued(issue)) throw new Error('This issue is no longer queued on GitHub. Refresh Work & issues before starting another issue.');
    return `Implement Agent Office issue #${number}: ${issue.title}\nhttps://github.com/${this.state.repo}/issues/${number}\n\n${detail.body}`;
  }

  async issue(number: number, viewer?: string) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Bad issue number');
    if (!this.github) throw new Error(this.state.error);
    return this.github.issueDetail(number, viewer);
  }
}
