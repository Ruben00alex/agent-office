// The Codex account's plan limits, asked of Codex itself the way limits.ts asks Claude Code: the
// app server's `account/rateLimits/read` answers with what the usage screen shows, whether or not
// any worker is running. Worker rollouts stop carrying percentages once the limit is hit, so they
// alone leave the meter stale exactly when it matters.

import { spawn } from 'node:child_process';
import os from 'node:os';
import type { PlanLimits, PlanWindow } from '../shared/protocol.js';

const POLL_MS = 2 * 60_000;
const MIN_GAP_MS = 20_000;
const TIMEOUT_MS = 30_000;
/** No account to read (an API key, signed out, an old `codex`): look again much later. */
const NO_PLAN_MS = 30 * 60_000;
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 10 * 60_000;

/** The windows of an `account/rateLimits/read` answer, or undefined when it has none. */
export function appServerPlanLimits(answer: any, at: number): PlanLimits | undefined {
  const rl = answer?.rateLimits;
  if (!rl || typeof rl !== 'object') return;
  const windows: PlanWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
    const minutes = w.windowDurationMins;
    const label = minutes === 10080 ? 'Week' : Number.isSafeInteger(minutes) && minutes > 0 ? (minutes % 60 === 0 ? `${minutes / 60}h session` : `${minutes}m session`) : key === 'primary' ? '5h session' : 'Week';
    const reset = w.resetsAt;
    windows.push({ label, pct: Math.max(0, Math.min(100, w.usedPercent)),
      ...(typeof reset === 'number' && Number.isFinite(reset) && reset > 0 && reset <= 8640000000000 ? { resetsAt: reset * 1000 } : {}) });
  }
  const plan = typeof rl.planType === 'string' ? rl.planType.slice(0, 24) : undefined;
  return windows.length ? { windows, at, ...(plan ? { plan } : {}) } : undefined;
}

export class CodexLimitsReader {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRead = 0;
  private fails = 0;
  private closed = false;

  /**
   * @param codex the `codex` binary, or null when it isn't installed (nothing is ever read)
   * @param wanted whether anyone is in the office to see the numbers; polls are skipped when not
   * @param onChange gets each fresh answer
   */
  constructor(
    private codex: string | null,
    private env: Record<string, string>,
    private wanted: () => boolean,
    private onChange: (limits: PlanLimits) => void,
  ) {
    this.schedule(0);
  }

  refresh() {
    if (this.running || Date.now() - this.lastRead < MIN_GAP_MS) return;
    this.schedule(0);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.closed || !this.codex) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), ms);
    this.timer.unref();
  }

  private async read() {
    if (!this.wanted()) return this.schedule(POLL_MS);
    this.running = true;
    const answer = await ask(this.codex!, this.env);
    this.running = false;
    this.lastRead = Date.now();
    if (this.closed) return;
    let next = POLL_MS;
    if (answer === null) {
      if (++this.fails >= FAILS_BEFORE_BACKOFF) {
        this.fails = 0;
        next = BACKOFF_MS;
      }
    } else {
      this.fails = 0;
      const limits = appServerPlanLimits(answer, Date.now());
      if (limits) this.onChange(limits);
      else next = NO_PLAN_MS;
    }
    this.schedule(next);
  }
}

/** The app server's rate-limits answer, or null when it couldn't give one. */
function ask(codex: string, env: Record<string, string>): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const child = spawn(codex, ['app-server'], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (v: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
      child.stdin.end();
      child.kill();
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 10_000).unref();
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg?.id === 1) {
          if (msg.error) return finish(null);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg?.id === 2) finish(msg.error ? null : (msg.result ?? null));
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-office', version: '1' } } });
  });
}
