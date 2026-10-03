// The bookshelf: the project's Markdown files, listed by the office (server/docs.ts) and read in a
// window in the office (ui/bookshelf.ts).

/** One Markdown file in the project. */
export interface DocFile {
  /** From the project folder, with forward slashes: "docs/setup.md". */
  path: string;
  /** Its first heading (or front matter title), when it has one near the top. */
  title?: string;
  size: number;
  /** Its first paragraph, trimmed, so a search can find a doc by what it says it's about. */
  summary?: string;
  /** Last modified, ms since epoch. */
  mtime: number;
}

/** What GET /api/docs answers: every Markdown file in the floor's project, by path. */
export interface DocList {
  files: DocFile[];
  /** There were more than the office lists. */
  more: boolean;
  /** The patterns keeping docs off the shelf, and how many docs they hid. */
  excluded: string[];
  hidden: number;
}

/** Folders whose Markdown is somebody else's or generated, so it's off the shelf unless the project's config says otherwise. */
export const DEFAULT_DOC_EXCLUDES = ['platform/', 'vendor/', 'third_party/', '.generated/', 'generated/'];

/** The project's own say on what's a doc, from agent-office.docs.json at its root. */
export interface DocConfig {
  /** Path patterns kept off the shelf (replacing the defaults when given): "platform/", "docs/internal/**", "**\/CHANGELOG.md". */
  exclude?: string[];
  /** Patterns shown even when excluded. */
  include?: string[];
}

/** A pattern as a test on paths: "dir/" is that folder anywhere in the project, * stays in a folder and ** goes through them. */
function patternTest(pattern: string): (p: string) => boolean {
  const dirOnly = pattern.trim().endsWith('/');
  const pat = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!pat) return () => false;
  const re = pat
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  // A bare name ("vendor/") matches anywhere; one with a path in it matches from the project folder.
  const anywhere = !pat.includes('/') || pat.startsWith('**/');
  const rx = new RegExp(`${anywhere ? '(^|/)' : '^'}${re}${dirOnly ? '/' : '$'}`, 'i');
  return (p) => rx.test(p);
}

/** Whether `p` is kept off the shelf by `config` (the defaults when it names no excludes). */
export function docExcluded(p: string, config: DocConfig = {}): boolean {
  const exclude = config.exclude ?? DEFAULT_DOC_EXCLUDES;
  if (!exclude.some((x) => patternTest(x)(p))) return false;
  return !(config.include ?? []).some((x) => patternTest(x)(p));
}

/** Where a doc sits on the shelf: the project's own pages, its docs folder, or the notes of the code. */
export type DocGroup = 'project' | 'docs' | 'dev';

export const DOC_GROUPS: { id: DocGroup; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'docs', label: 'User docs' },
  { id: 'dev', label: 'Dev notes' },
];

export function docGroup(p: string): DocGroup {
  if (!p.includes('/')) return 'project';
  return /^(docs?|documentation|guides?|wiki)\//i.test(p) ? 'docs' : 'dev';
}

/** The first paragraph of prose in a doc's head: no front matter, headings, badges, fences or tables. */
export function docSummary(head: string): string | undefined {
  const text = head.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  let fenced = false;
  const para: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const t = line.trim();
    const skip = fenced || !t || /^(#|>|\||!\[|\[!\[|<|[-*+]\s|\d+\.\s|=+$|-+$)/.test(t);
    if (skip) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const out = para.join(' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, 240) : undefined;
}

/** What GET /api/docs/file answers. */
export interface DocText {
  path: string;
  text: string;
}

/** A file the bookshelf shows: Markdown, by its extension. */
export function isDocPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p) && !/(^|\/)\.\.?(\/|$)/.test(p);
}

/**
 * Where a link in the doc at `from` goes in the project, as a path from the project folder, with any
 * #anchor apart: "../README.md#setup" from "docs/a.md" is { path: "README.md", hash: "setup" }. A link
 * starting with / is from the project folder, as on GitHub. Undefined for links elsewhere (another
 * site, mailto:…) or out of the project.
 */
export function resolveDocLink(from: string, href: string): { path: string; hash: string } | undefined {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return undefined;
  const hashAt = href.indexOf('#');
  const hash = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  let rel = (hashAt >= 0 ? href.slice(0, hashAt) : href).replace(/\?.*$/, '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return undefined;
  }
  // Just an anchor: somewhere in this same doc.
  if (!rel) return { path: from, hash };
  const parts = rel.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? { path: parts.join('/'), hash } : undefined;
}
