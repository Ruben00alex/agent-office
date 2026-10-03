// The 2D view's shell: hash routes between full-screen pages (so the phone's back button walks back
// through them), a top bar with the page's title and actions, and a bottom tab bar.

import { $, h } from '../ui/dom';
import { openSheet, row } from './kit';

export interface Screen {
  title: string;
  el: HTMLElement;
  /** Under the title, small. */
  sub?: string;
  /** Buttons on the right of the top bar. */
  actions?: HTMLElement[];
  /** What the ⋯ in the top bar offers for this page, read when it's opened (so it can follow the page's state). */
  menu?: () => MenuItem[];
  /** Called when the page is left: unsubscribe, stop timers. */
  dispose?: () => void;
}

export interface MenuItem {
  icon: string;
  label: string;
  sub?: string;
  danger?: boolean;
  hidden?: boolean;
  run(): void;
}

let globalMenu: () => MenuItem[] = () => [];
/** Items every page's ⋯ ends with (the 3D office, notifications). */
export function setGlobalMenu(fn: () => MenuItem[]) {
  globalMenu = fn;
}

/** Changes the line under the page's title while you're on it (a chat's status, say). */
export function setSubtitle(text: string | undefined, tone?: 'live' | 'warn') {
  const sub = $('lite-sub');
  sub.textContent = text ?? '';
  sub.classList.toggle('hidden', !text);
  sub.dataset.tone = tone ?? '';
}

function openMenu() {
  const items = [...(current?.menu?.() ?? []), ...globalMenu()].filter((i) => !i.hidden);
  const sheet = openSheet({
    title: current?.title ?? 'Menu',
    body: h('div.sheet-list', {}, ...items.map((i) => row({ icon: i.icon, title: i.label, sub: i.sub, cls: i.danger ? 'danger' : '', right: h('span'), onclick: () => (sheet.close(), i.run()) }))),
  });
}

type Factory = (args: string[]) => Screen;

export type Tab = 'workers' | 'work' | 'chat' | 'agents' | 'office';

export const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'workers', icon: '🤖', label: 'Workers' },
  { id: 'work', icon: '📌', label: 'Work' },
  { id: 'chat', icon: '💬', label: 'Chat' },
  { id: 'agents', icon: '🧭', label: 'Agents' },
  { id: 'office', icon: '🏢', label: 'Office' },
];

const routes = new Map<string, { make: Factory; tab: Tab }>();
let current: Screen | null = null;
/** The path each tab was last on, so tapping a tab you left comes back where you were. */
const lastIn = new Map<Tab, string>();
/** How many pages deep this history entry is (kept in history.state, so the browser's own back and a reload agree with it). */
let depth = 0;
/** Set while go(…, true) swaps the entry in place, so the swap doesn't count as a page deeper. */
let replacing = false;
const badges = new Map<Tab, () => number>();

export function route(name: string, tab: Tab, make: Factory) {
  routes.set(name, { make, tab });
}

export function tabBadge(tab: Tab, count: () => number) {
  badges.set(tab, count);
}

const pathOf = () => location.hash.replace(/^#\/?/, '') || 'workers';

export function go(path: string, replace = false) {
  const next = `#/${path}`;
  if (location.hash === next) return render();
  if (replace) {
    replacing = true;
    location.replace(next);
  } else location.hash = next;
}

/** Up one page: where you came from, or the tab's front page when this was opened directly. */
export function back(fallback?: string) {
  if (depth > 0) history.back();
  else go(fallback ?? routes.get(pathOf().split('/')[0])?.tab ?? 'workers', true);
}

/** The page changed by the address: work out how deep it is, and remember that in the history entry. */
function navigated(initial = false) {
  const state = history.state as { depth?: number } | null;
  depth = typeof state?.depth === 'number' ? state.depth : initial ? 0 : replacing ? depth : depth + 1;
  replacing = false;
  try {
    history.replaceState({ depth }, '');
  } catch {
    /* nothing to write to */
  }
  render();
}

export function currentPath(): string {
  return pathOf();
}

function render() {
  current?.dispose?.();
  current = null;
  const [name, ...args] = pathOf().split('/').map(decodeURIComponent);
  const r = routes.get(name) ?? routes.get('workers')!;
  const screen = r.make(args);
  current = screen;
  lastIn.set(r.tab, pathOf());
  const main = $('screen');
  main.replaceChildren(screen.el);
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  // A page inside a tab (an issue, a worker, a floor) has a way back; the tabs' own front pages don't.
  const root = name !== r.tab;
  $('lite-title').textContent = screen.title;
  setSubtitle(screen.sub);
  $('lite-back').classList.toggle('hidden', !root);
  $('lite-actions').replaceChildren(...(screen.actions ?? []));
  for (const t of TABS) $(`tab-${t.id}`).classList.toggle('on', t.id === r.tab);
  document.body.dataset.screen = name;
  // The tabs belong to the tabs' own front pages; a page inside one is a screen of its own, with the room to itself.
  document.body.dataset.root = root ? '0' : '1';
}

export function refreshBadges() {
  for (const t of TABS) {
    const n = badges.get(t.id)?.() ?? 0;
    const el = $(`tab-${t.id}`).querySelector('.n')!;
    el.textContent = n ? String(n) : '';
  }
}

export function startRouter() {
  $('lite-back').addEventListener('click', () => back());
  $('lite-menu').addEventListener('click', openMenu);
  const nav = $('lite-tabs');
  nav.replaceChildren(
    ...TABS.map((t) =>
      h(
        'button.lite-tab',
        {
          type: 'button',
          id: `tab-${t.id}`,
          'aria-label': t.label,
          title: t.label,
          onclick: () => {
            const to = lastIn.get(t.id) ?? t.id;
            // Tapping the tab you're on goes back to its front page.
            go(t.id === routes.get(pathOf().split('/')[0])?.tab ? t.id : to);
          },
        },
        h('span.ico', { 'aria-hidden': 'true' }, t.icon),
        h('span.lbl', {}, t.label),
        h('span.n', {}),
      ),
    ),
  );
  window.addEventListener('hashchange', () => navigated());
  navigated(true);
  foldableSidebar();
}

/** The desktop sidebar folds down to its icons, giving the page the width; the choice is remembered in this browser. */
function foldableSidebar() {
  const key = 'agent-office.lite-sidebar-folded';
  const button = $('lite-fold');
  const set = (folded: boolean) => {
    document.body.dataset.nav = folded ? 'folded' : 'open';
    const label = folded ? 'Expand sidebar' : 'Collapse sidebar';
    button.setAttribute('aria-expanded', String(!folded));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = folded ? '»' : '«';
  };
  let folded = false;
  try {
    folded = localStorage.getItem(key) === '1';
  } catch {
    /* storage unavailable */
  }
  set(folded);
  button.addEventListener('click', () => {
    folded = !folded;
    set(folded);
    try {
      localStorage.setItem(key, folded ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  });
}

/** Re-render the page you're on (after the first welcome, say). */
export function rerender() {
  render();
}

/** Runs `fn` now and whenever a store topic changes; returns what to call on leaving the page. */
export function live(on: (topic: any, fn: () => void) => () => void, topics: string[], fn: () => void): () => void {
  const offs = topics.map((t) => on(t, fn));
  fn();
  return () => offs.forEach((o) => o());
}
