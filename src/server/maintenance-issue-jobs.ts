import { randomUUID } from 'node:crypto';

export interface IssueJobInput { title: string; body: string; queue: boolean; writer: string; attachments: string[] }
export interface IssueJob extends IssueJobInput {
  id: string;
  by: string;
  status: 'drafting' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  issue?: { number: number; url: string; title: string };
}

/** Drafting runs here on the server, so it outlives the form and the browser connection that started it. A failed job keeps its input for retry. */
export class IssueJobs {
  private readonly jobs = new Map<string, IssueJob>();
  constructor(private readonly run: (job: IssueJob) => Promise<{ number: number; url: string; title: string }>, private readonly keep = 20) {}

  list(): IssueJob[] { return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt); }

  start(input: IssueJobInput, by: string): IssueJob {
    const job: IssueJob = { ...input, id: randomUUID(), by, status: 'drafting', startedAt: Date.now() };
    this.jobs.set(job.id, job);
    this.execute(job);
    for (const old of this.list().filter(j => j.status !== 'drafting').slice(this.keep)) this.jobs.delete(old.id);
    return job;
  }

  retry(id: string): IssueJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error('That issue draft is gone');
    if (job.status !== 'failed') throw new Error('Only a failed draft can be retried');
    job.status = 'drafting'; job.error = undefined; job.startedAt = Date.now(); job.finishedAt = undefined;
    this.execute(job);
    return job;
  }

  dismiss(id: string) {
    if (this.jobs.get(id)?.status === 'drafting') throw new Error('Wait for the draft to finish');
    this.jobs.delete(id);
  }

  private execute(job: IssueJob) {
    this.run(job).then(issue => { job.issue = issue; job.status = 'done'; }, err => { job.error = (err as Error).message; job.status = 'failed'; })
      .finally(() => { job.finishedAt = Date.now(); });
  }
}
