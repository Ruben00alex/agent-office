import { execFile } from 'node:child_process';
import type { MaintenanceIssues } from '../shared/protocol.js';
import { GitHub, gh, referencesIssue } from './github.js';
import { originRepo } from './building.js';
import type { GhAs } from './signins.js';
import { MAINTENANCE_QUEUE_LABEL, maintenanceQueued } from '../shared/maintenance-issues.js';
import { officeSourceDir } from './maintenance.js';

/** A separate GitHub feed, rooted in the office source rather than a floor's project. */
export class MaintenanceBoard {
  private github?: GitHub;
  state: MaintenanceIssues = { items: [], fetchedAt: 0, loading: false };

  /** Open issues the source's default branch already holds the work for, by number. */
  private shipped = new Map<number, string>();
  private shipTimer?: NodeJS.Timeout;

  /** `workCommits` lists the commits Maintenance made for each issue, to see whether they have shipped. */
  constructor(private emit: (state: MaintenanceIssues) => void, private source = officeSourceDir(), private workCommits: () => { number: number; sha: string }[] = () => []) {
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
    const items = state.items.map((i) => {
      const doneBy = i.state === 'OPEN' ? i.doneBy ?? this.shipped.get(i.number) : undefined;
      return doneBy === i.doneBy ? i : { ...i, doneBy };
    });
    this.state = { ...state, items };
    this.emit(this.state);
  }

  /** Looks through origin's default branch for commits that address an open issue, or that Maintenance made for it. */
  private async findShipped() {
    if (!this.source) return;
    const git = (args: string[]) => new Promise<string>((resolve) => execFile('git', args, { cwd: this.source, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out)));
    const log = await git(['log', '-n', '400', '--format=%h%x00%B%x01', 'origin/HEAD']);
    if (!log) return;
    const messages = log.split('\x01').map((m) => m.trim()).filter(Boolean);
    const found = new Map<number, string>();
    for (const issue of this.state.items) {
      if (issue.state !== 'OPEN') continue;
      const hit = messages.find((m) => referencesIssue(m, issue.number));
      if (hit) found.set(issue.number, `commit ${hit.split('\0')[0]} on main`);
    }
    for (const w of this.workCommits()) {
      if (found.has(w.number) || !/^[a-f0-9]{7,40}$/.test(w.sha)) continue;
      const ok = await new Promise<boolean>((resolve) => execFile('git', ['merge-base', '--is-ancestor', w.sha, 'origin/HEAD'], { cwd: this.source }, (err) => resolve(!err)));
      if (ok) found.set(w.number, `commit ${w.sha.slice(0, 7)} on main`);
    }
    const same = found.size === this.shipped.size && [...found].every(([k, v]) => this.shipped.get(k) === v);
    this.shipped = found;
    if (!same) this.set(this.state);
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

  async create(title: string, body: string, as?: GhAs) {
    if (!this.github || !this.source || !this.state.repo) throw new Error(this.state.error ?? 'No maintenance repository');
    if (!title.trim() || title.length > 200 || body.length > 20000) throw new Error('Use a title up to 200 characters and a description up to 20,000.');
    const url = (await gh(['issue', 'create', '--repo', this.state.repo, '--title', title.trim(), '--body', body], this.source, undefined, as?.env)).trim();
    const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
    if (!number) throw new Error('GitHub did not return an issue URL');
    void this.refresh();
    return { number, title: title.trim(), url };
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
