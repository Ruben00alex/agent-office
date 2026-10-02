import { randomUUID } from 'node:crypto';

export interface IssueJobInput { title: string; body: string; queue: boolean; writer: string; attachments: string[]; number?: number; instructions?: string }
export interface IssueJob extends IssueJobInput {
  id: string;
  by: string;
  status: 'drafting' | 'ready' | 'saving' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  draft?: { title: string; body: string };
  issue?: { number: number; url: string; title: string };
}

/** Drafting runs here on the server, so it outlives the form and the browser connection that started it. A failed job keeps its input for retry. */
export class IssueJobs {
  private readonly jobs = new Map<string, IssueJob>();
  constructor(private readonly run: (job: IssueJob) => Promise<{ title: string; body: string }>, private readonly save: (job: IssueJob, draft: { title: string; body: string }) => Promise<{ number: number; url: string; title: string }>, private readonly keep = 20) {}

  list(): IssueJob[] { return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt); }

  start(input: IssueJobInput, by: string): IssueJob {
    const job: IssueJob = { ...input, id: randomUUID(), by, status: 'drafting', startedAt: Date.now() };
    this.jobs.set(job.id, job);
    this.execute(job);
    for (const old of this.list().filter(j => ['done', 'failed'].includes(j.status)).slice(this.keep)) this.jobs.delete(old.id);
    return job;
  }

  retry(id: string): IssueJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('That issue draft is gone');
    if (job.status !== 'failed' || job.draft) throw new Error('Only a failed draft can be retried');
    job.status = 'drafting'; job.error = undefined; job.startedAt = Date.now(); job.finishedAt = undefined;
    this.execute(job);
    return job;
  }

  async confirm(id: string, title: string, body: string): Promise<IssueJob> {
    const job = this.jobs.get(id);
    if (!job || !job.draft || !['ready', 'failed'].includes(job.status)) throw new Error('This draft is not ready to save');
    if (!title.trim() || title.length > 200 || body.length > 20000) throw new Error('Use a title up to 200 characters and a description up to 20,000.');
    job.draft = { title: title.trim(), body };
    job.status = 'saving'; job.error = undefined;
    try { job.issue = await this.save(job, job.draft); job.status = 'done'; }
    catch (err) { job.error = (err as Error).message; job.status = 'failed'; throw err; }
    finally { job.finishedAt = Date.now(); }
    return job;
  }

  dismiss(id: string) {
    if (['drafting', 'saving'].includes(this.jobs.get(id)?.status ?? '')) throw new Error('Wait for the draft to finish');
    this.jobs.delete(id);
  }

  private execute(job: IssueJob) {
    this.run(job).then(draft => { job.draft = draft; job.status = 'ready'; }, err => { job.error = (err as Error).message; job.status = 'failed'; })
      .finally(() => { job.finishedAt = Date.now(); });
  }
}
