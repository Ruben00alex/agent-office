import type { GhIssue, MaintenanceWorkItem } from './protocol.js';

export const MAINTENANCE_QUEUE_LABEL = 'maintenance:queued';
export const maintenanceQueued = (issue: GhIssue) => issue.state === 'OPEN' && issue.labels.some(l => l.name === MAINTENANCE_QUEUE_LABEL);

/** The labels the issue crafter picks from: what kind of work, and where. Created on GitHub when first used. */
export const ISSUE_LABELS = [
  { name: 'bug', color: 'd73a4a', description: 'Something is broken' },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'polish', color: 'f9d0c4', description: 'UI inconsistency or quality-of-life fix' },
  { name: 'ui', color: 'c5def5', description: 'Office interface: 3D, 2D and modals' },
  { name: 'server', color: 'bfdadc', description: 'Server, GitHub or deployment' },
  { name: 'agents', color: 'd4c5f9', description: 'Workers, Maintenance and Product Lead agents' },
  { name: 'docs', color: '0075ca', description: 'Documentation' },
];

export type MaintenanceLane = 'open' | 'queued' | 'progress' | 'review' | 'closed';
type Work = { status: MaintenanceWorkItem['status']; commits: number };
export const MAINTENANCE_LANES: { lane: MaintenanceLane; title: string }[] = [
  { lane: 'open', title: '📥 Backlog' },
  { lane: 'queued', title: '⏳ Queued' },
  { lane: 'progress', title: '🚧 In progress' },
  { lane: 'review', title: '👀 Needs review' },
  { lane: 'closed', title: '✅ Closed' },
];

/**
 * Where an issue sits. Maintenance's own execution record wins over GitHub assignees, because starting
 * an issue assigns it and nothing ever unassigns it: assignment alone would leave finished work "in progress" forever.
 */
export function maintenanceIssueLane(issue: GhIssue, work: Work | undefined = issue.work): MaintenanceLane {
  if (issue.state !== 'OPEN') return 'closed';
  if (work?.status === 'running') return 'progress';
  if (work?.status === 'review' || work?.status === 'done' || (work?.status === 'paused' && work.commits > 0) || issue.doneBy) return 'review';
  if (maintenanceQueued(issue)) return 'queued';
  if (work) return 'open';
  return issue.assignees.length > 0 || issue.labels.some(l => /progress|doing|wip|started/i.test(l.name)) ? 'progress' : 'open';
}

/** Lanes in workflow order. Queued issues start oldest first; the rest show the most recently touched first. */
export function maintenanceIssueColumns(items: GhIssue[], work?: (issue: GhIssue) => Work | undefined) {
  const recent = (a: GhIssue, b: GhIssue) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || b.number - a.number;
  return MAINTENANCE_LANES.map(({ lane, title }) => ({
    lane, title,
    items: items.filter(i => maintenanceIssueLane(i, work ? work(i) ?? i.work : i.work) === lane).sort(lane === 'queued' ? (a, b) => a.number - b.number : recent),
  }));
}
