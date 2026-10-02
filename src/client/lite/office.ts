// The Office tab: floors and projects, services, docs, the whiteboard, search, spend, the jukebox,
// updates and settings: the rest of what the 3D office has that makes sense on a phone.

import type { FloorInfo, ServerMsg } from '../../shared/protocol';
import { JUKEBOX_TUNES, STREAM, checkStreamUrl, trackTitle, tuneById } from '../../shared/jukebox';
import { floorPalette, normalizeRepo, sameRepo } from '../../shared/floors';
import { isDocPath, resolveDocLink, type DocFile, type DocList, type DocText } from '../../shared/docs';
import { SEARCH_MAX, SEARCH_MIN, searchKey } from '../../shared/search';
import { WING } from '../../shared/layout';
import { isAsleep } from '../../shared/status';
import { saveSettings, saveProfile, store } from '../state';
import { clip, h, timeAgo, toast } from '../ui/dom';
import { confirmDialog } from '../ui/prompt';
import { copy } from '../ui/team';
import { guessOs, OS_LABEL, type Os, openTeam } from '../ui/team';
import { serviceTunnel, serviceUrl } from '../ui/services';
import { filterDocs, shelfOrder, size, slug } from '../ui/bookshelf';
import { markdownFile } from '../ui/markdown';
import { highlight, search } from '../ui/search';
import { usageLabel, fmtCost } from '../ui/usage';
import { fmtReset } from '../ui/limits';
import { buildSettings } from '../ui/settings';
import { openAccounts } from '../ui/accounts';
import { needsSigningIn, openSignIns } from '../ui/signins';
import { openCharacter } from '../ui/character';
import { openExpand } from '../ui/floorplan';
import { describeSky } from '../world/sky';
import { go, live, type Screen } from './app';
import { actions, button, chip, empty, fill, heading, input, note, page, row, searchBox, segmented } from './kit';
import { net, notifier, onServerMessage, openWorker, settings, showTerminal } from './ctx';

const on = store.on.bind(store);

// ---- The tab ----------------------------------------------------------------------------------
export function officeScreen(): Screen {
  const el = page();
  const paint = () => {
    const f = store.currentFloor();
    const up = store.upgrade;
    const hasUpdate = up.available && !!up.latest;
    fill(
      el,
      heading('This project'),
      row({ icon: '🏢', title: 'Floors & projects', sub: `${store.project?.name ?? f?.name ?? 'No floor yet'} · switch floors or add a project`, onclick: () => go('floors') }),
      row({ icon: '📚', title: 'Docs', sub: 'Read the project’s Markdown files', onclick: () => go('docs') }),
      row({ icon: '🌐', title: 'Services', sub: 'Web servers the workers are running', right: store.services.items.length ? h('span.n.lp-count', {}, String(store.services.items.length)) : undefined, onclick: () => go('services') }),
      row({ icon: '🔎', title: 'Search', sub: 'The chat and every terminal on this floor', onclick: () => go('search') }),
      row({ icon: '📝', title: 'Whiteboard', sub: 'Draw together, live', onclick: () => go('whiteboard') }),
      heading('Together'),
      row({ icon: '🎵', title: 'Jukebox', sub: store.jukebox.on ? `Playing ${trackTitle(store.jukebox)}` : 'Put something on for the floor', onclick: () => go('jukebox') }),
      row({ icon: '🔔', title: 'Ring the gong', sub: 'A cheer for the whole floor', onclick: () => net.send({ t: 'gong' }) }),
      row({ icon: '💸', title: 'Spend & limits', sub: `Today ${fmtCost(store.usage.today.cost)} · plan usage`, onclick: () => go('spend') }),
      heading('You & the office'),
      row({ icon: '⚙️', title: 'Settings', sub: 'Notifications, workers, building, your look', onclick: () => go('settings') }),
      row({ icon: '🔐', title: 'Your sign-ins', sub: needsSigningIn() ? '⚠️ Sign in to Claude: needed' : 'The Claude plan and GitHub account your workers use', onclick: () => openSignIns(net), cls: store.me.account ? '' : 'hidden' }),
      store.invites ? row({ icon: '👥', title: 'Invite teammates', sub: 'Share the office with a link', onclick: () => openTeam(net) }) : null,
      store.me.admin ? row({ icon: '🔑', title: 'Accounts', sub: 'Invite people, see who has an account, revoke them', onclick: () => openAccounts(net) }) : null,
      hasUpdate || up.available ? row({ icon: '⬆️', title: hasUpdate ? 'Update available' : 'Updates', sub: hasUpdate ? `${up.behind ?? up.changes?.length ?? 0} new change${(up.behind ?? 1) === 1 ? '' : 's'} · upgrade the office` : 'Check for a new version', onclick: () => go('upgrade') }) : null,
      row({ icon: '🚪', title: 'The 3D office', sub: 'Walk around: what only works there', onclick: () => go('about3d') }),
    );
  };
  return { title: 'Office', el, dispose: live(on, ['floors', 'floor', 'project', 'services', 'jukebox', 'usage', 'upgrade', 'me', 'signins'], paint) };
}

// ---- Floors -----------------------------------------------------------------------------------
export function floorsScreen(): Screen {
  const el = page();
  const paint = () => {
    const p = store.project;
    const cur = store.currentFloor();
    const plan = store.floorPlan;
    fill(
      el,
      heading('Floors'),
      ...(store.floors.length
        ? [...store.floors].reverse().map((f, ri) => floorRow(f, store.floors.length - 1 - ri))
        : [empty('🏢', 'No floors yet', 'Every project is a floor of this building. Add your first project below.')]),
      row({ icon: '➕', title: 'Add a project', sub: 'Clone one of your repositories as a new floor', onclick: () => go('floors/add') }),
      ...(cur && p
        ? [
            heading('This floor'),
            h('dl.lp-facts', {}, ...[['Project', p.name], ['Repository', cur.repo], ['Branch', p.branch], ['Folder', cur.dir], ['People here', String(cur.people)], ['Added', `${timeAgo(cur.addedAt)} by ${cur.addedBy}`]].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k as string), h('dd', {}, v as string)])),
            actions(
              button(plan.wing >= WING.rows ? '🔨 Back office: built out' : `🔨 Back office (${plan.wing}/${WING.rows})`, () => openExpand(net), '', 'Add desks to this floor'),
              store.me.admin && !cur.cloning ? button('🗑 Remove floor', () => confirmRemove(cur), 'danger') : null,
            ),
          ]
        : []),
    );
  };
  const floorRow = (f: FloorInfo, i: number) => {
    const here = f.id === store.floor;
    const pal = floorPalette(f.palette);
    const stats = f.cloning ? '⏳ Cloning…' : [f.busy ? `👷 ${f.busy} working` : '', f.waiting ? `🙋 ${f.waiting} waiting` : '', `💻 ${f.workers}`, f.people ? `🧑 ${f.people}` : ''].filter(Boolean).join(' · ');
    const r = row({
      icon: String(i + 1),
      title: `${f.name}${here ? ' · you are here' : ''}`,
      sub: `${f.repo ?? f.dir} · ${stats}`,
      onclick: () => {
        if (f.cloning) return toast('Still being cloned', 'warn');
        if (!here) net.send({ t: 'floor.go', floor: f.id });
        go('workers');
      },
      cls: here ? 'on' : '',
    });
    r.querySelector('.ico')?.setAttribute('style', `background:${pal.trim};color:#fff;border-radius:50%;width:28px;height:28px;display:grid;place-items:center;font-size:14px;font-weight:900`);
    return r;
  };
  const confirmRemove = (f: FloorInfo) => {
    const next = store.floors.find((o) => o.id !== f.id && !o.cloning);
    confirmDialog(`Take ${f.name} off the building?`, `${f.workers ? `Its ${f.workers} worker${f.workers === 1 ? '' : 's'} stop. ` : ''}${f.people ? `Everyone on it rides to ${next ? next.name : 'the lobby'}. ` : ''}Nothing is deleted: its checkout stays in ${f.dir}.`, '🗑 Remove floor', () => net.send({ t: 'floor.remove', floor: f.id }));
  };
  return { title: 'Floors', el, dispose: live(on, ['floors', 'floor', 'floorPlan', 'peers', 'me', 'project'], paint) };
}

export function addProjectScreen(): Screen {
  let filter = '';
  let selected: string | null = null;
  let adding: string | null = null;
  let error = '';
  const list = h('div.lp-repos');
  const status = h('div');
  const addBtn = button('🛗 Add floor', () => add(), 'primary') as HTMLButtonElement;
  const box = searchBox('Search your repositories, or type owner/name', (q) => {
    filter = q;
    if (selected && !sameRepo(selected, normalizeRepo(filter))) selected = null;
    paint();
  });
  const refresh = button('↻ Refresh the list', () => {
    store.repos = { ...store.repos, loading: true, error: undefined };
    net.send({ t: 'floor.repos', refresh: true });
    paint();
  });
  const choice = () => selected ?? normalizeRepo(filter);
  const add = () => {
    const pick = choice();
    if (!pick || adding) return;
    adding = pick;
    error = '';
    net.send({ t: 'floor.add', repo: pick });
    paint();
  };
  const paint = () => {
    const r = store.repos;
    const q = filter.trim().toLowerCase();
    const typed = normalizeRepo(filter);
    const matches = r.list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? '').toLowerCase().includes(q)).slice(0, 60);
    const repoRow = (name: string, sub: string, lock = false) => {
      const floor = store.floors.find((f) => sameRepo(f.repo, name));
      return row({
        icon: lock ? '🔒' : '📦',
        title: name,
        sub: floor ? 'Already a floor — tap to go there' : sub,
        right: selected && sameRepo(selected, name) ? h('span.chev', {}, '✓') : floor ? h('span.chev', {}, '→') : undefined,
        cls: selected && sameRepo(selected, name) ? 'on' : '',
        onclick: () => {
          if (adding) return;
          if (floor) {
            if (!floor.cloning) net.send({ t: 'floor.go', floor: floor.id });
            return go('workers');
          }
          selected = name;
          paint();
        },
      });
    };
    const rows = [
      ...(typed && !r.list.some((x) => sameRepo(x.name, typed)) ? [repoRow(typed, 'Not in your list — the office will try to clone it')] : []),
      ...matches.map((x) => repoRow(x.name, x.description ?? (x.pushedAt ? `pushed ${timeAgo(x.pushedAt)}` : ''), x.private)),
    ];
    fill(list, ...(rows.length ? rows : [h('p.lp-note', {}, r.loading ? 'Asking GitHub for your repositories…' : r.error ? '' : q ? 'Nothing matches. Type owner/name to clone any repository.' : 'No repositories.')]));
    const pick = choice();
    fill(
      status,
      adding ? h('p.lp-note', {}, `⏳ Cloning ${adding} into ${store.projectsDir.dir}/${adding}… A big repository can take a minute.`) : note(`Cloned into ${pick ? `${store.projectsDir.dir}/${pick}` : `${store.projectsDir.dir}/<owner>/<repo>`} with the office’s gh login.${store.me.admin ? ' Change the folder in Settings → Building.' : ''}`),
      ...[r.error, error].filter(Boolean).map((e) => h('p.lp-note.bad', {}, e as string)),
    );
    addBtn.disabled = !!adding || !pick || store.floors.some((f) => sameRepo(f.repo, pick));
    addBtn.textContent = adding ? '⏳ Cloning…' : pick ? `🛗 Add ${pick}` : '🛗 Add floor';
  };
  const offMsg = onServerMessage((msg: ServerMsg) => {
    if (msg.t !== 'floor.added' || !adding || msg.repo !== adding) return;
    adding = null;
    if (msg.error || !msg.floor) {
      error = msg.error ?? 'The floor could not be added';
      return paint();
    }
    net.send({ t: 'floor.go', floor: msg.floor });
    go('workers', true);
  });
  const offs = [on('repos', paint), on('floors', paint), on('projectsDir', paint)];
  if (!store.repos.loading && (!store.repos.at || Date.now() - store.repos.at > 5 * 60_000 || store.repos.error)) {
    store.repos = { ...store.repos, loading: true };
    net.send({ t: 'floor.repos' });
  }
  paint();
  return { title: 'Add a project', el: page(box, list, status, actions(addBtn, refresh)), dispose: () => (offMsg(), offs.forEach((o) => o())) };
}

// ---- Services ---------------------------------------------------------------------------------
export function servicesScreen(): Screen {
  let os: Os = guessOs();
  let picked: number | null = null;
  const el = page();
  const paint = () => {
    const s = store.services;
    const direct = !!s.tailnet && location.hostname === s.tailnet;
    fill(
      el,
      note(direct ? 'Web servers the workers are running. Each has its own link on your Tailscale network: open it from here.' : 'Web servers the workers are running. Opening one from a phone needs the office on your Tailscale network; otherwise copy its tunnel command to run on a computer.'),
      direct ? null : h('div', {}, segmented<Os>((Object.keys(OS_LABEL) as Os[]).map((o) => ({ id: o, label: OS_LABEL[o] })), os, (o) => ((os = o), paint()))),
      ...(s.items.length
        ? s.items.map((svc) => {
            const w = store.workers.get(svc.workerId);
            const url = serviceUrl(svc.port);
            const cmd = direct ? url : serviceTunnel(s, svc.port, os);
            return h(
              'div.lp-card.lp-service',
              {},
              h('div.lp-cardbody', {}, h('b.lp-ttl', {}, svc.title || svc.command), h('span.lp-meta', {}, chip(`:${svc.port}`), chip(w?.name ?? 'A worker'), w?.worktree ? chip(`🌿 ${w.worktree.branch}`) : null, chip(`started ${timeAgo(svc.since)}`))),
              actions(
                h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener' }, 'Open ↗'),
                button(picked === svc.port ? '✓ Copied' : direct ? 'Copy link' : 'Copy tunnel command', async () => ((picked = (await copy(cmd)) ? svc.port : null), paint(), setTimeout(() => ((picked = null), paint()), 1800))),
                w ? button('🖥️ Terminal', () => openWorker(w.id)) : null,
              ),
            );
          })
        : [empty('🌐', 'Nothing running yet', 'When a worker starts a web server — npm run dev, a preview build — it shows up here within a few seconds. Try prompting: “start the dev server in the background so we can review it”.')]),
    );
  };
  const timer = setInterval(paint, 30_000);
  const off = live(on, ['services', 'workers'], paint);
  return { title: '🌐 Services', el, dispose: () => (off(), clearInterval(timer)) };
}

// ---- Docs -------------------------------------------------------------------------------------
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
let docFiles: { floor: string; files: DocFile[]; more: boolean } | null = null;
let docQuery = '';

export function docsScreen(): Screen {
  const floor = store.floor ?? '';
  const list = h('div');
  const el = page(searchBox('Filter the docs…', (q) => ((docQuery = q), paint()), docQuery), list);
  const paint = () => {
    if (!docFiles || docFiles.floor !== floor) return fill(list, h('p.lp-note', {}, 'Looking along the shelves…'));
    const hits = docQuery.trim() ? filterDocs(docFiles.files, docQuery) : shelfOrder(docFiles.files).map((doc) => ({ doc }));
    fill(
      list,
      h('p.lp-note', {}, `${hits.length}${docQuery.trim() ? ` of ${docFiles.files.length}` : ''} doc${hits.length === 1 ? '' : 's'}${docFiles.more ? ' (the first ones)' : ''}`),
      ...(hits.length ? hits.map(({ doc }) => row({ icon: '📄', title: doc.title ?? doc.path.slice(doc.path.lastIndexOf('/') + 1), sub: doc.path, onclick: () => go(`doc/${encodeURIComponent(doc.path)}`) })) : [empty('📭', docFiles.files.length ? 'No doc matches that' : 'No Markdown files in this project yet')]),
    );
  };
  if (!floor) fill(list, empty('🏢', 'Pick a floor first'));
  else if (docFiles?.floor === floor) paint();
  else {
    paint();
    getJson<DocList>(`/api/docs?${new URLSearchParams({ floor })}`)
      .then((r) => ((docFiles = { floor, files: r.files, more: !!r.more }), list.isConnected && paint()))
      .catch((e: Error) => list.isConnected && fill(list, h('p.lp-note.bad', {}, `Couldn't look along the shelves: ${e.message}`)));
  }
  return { title: '📚 Docs', sub: store.project?.name, el };
}

export function docScreen([enc]: string[]): Screen {
  const path = decodeURIComponent(enc ?? '');
  const floor = store.floor ?? '';
  const q = (params: Record<string, string>) => new URLSearchParams({ floor, ...params }).toString();
  const remote = store.project?.remote;
  const repoUrl = remote ? remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '') : undefined;
  const body = h('div', {}, h('div.lp-loading', {}, h('span.spinner')));
  const toc = h('select.lp-toc', { 'aria-label': 'Jump to a heading' }) as HTMLSelectElement;
  toc.hidden = true;
  const jump = (hash: string) => {
    const at = hash ? (body.querySelector(`[data-anchor="${CSS.escape(hash.replace(/^user-content-/, ''))}"]`) ?? body.querySelector(`[id="${CSS.escape(hash)}"]`)) : null;
    if (at) at.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  };
  toc.addEventListener('change', () => (jump(toc.value), (toc.value = '')));
  body.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[data-doc]') : null;
    if (!a) return;
    e.preventDefault();
    if (a.dataset.doc === path) return jump(a.dataset.hash ?? '');
    go(`doc/${encodeURIComponent(a.dataset.doc!)}`);
  });
  getJson<DocText>(`/api/docs/file?${q({ path })}`)
    .then((doc) => {
      const md = doc.text.trim() ? markdownFile(doc.text) : h('div.md', {}, h('p.none', {}, 'This file is empty.'));
      const seen = new Map<string, number>();
      const heads: { level: number; text: string; anchor: string }[] = [];
      for (const hd of md.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')) {
        const base = slug(hd.textContent ?? '');
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const anchor = n ? `${base}-${n}` : base;
        hd.dataset.anchor = anchor;
        const level = Number(hd.tagName[1]);
        if (level <= 3 && hd.textContent?.trim()) heads.push({ level, text: hd.textContent.trim(), anchor });
      }
      for (const a of md.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const to = resolveDocLink(path, a.getAttribute('href') ?? '');
        if (!to) continue;
        if (to.path === path || isDocPath(to.path)) {
          a.removeAttribute('target');
          a.dataset.doc = to.path;
          a.dataset.hash = to.hash;
        } else if (repoUrl) a.href = `${repoUrl}/blob/HEAD/${to.path.split('/').map(encodeURIComponent).join('/')}${to.hash ? `#${to.hash}` : ''}`;
        else a.removeAttribute('href');
      }
      for (const img of md.querySelectorAll<HTMLImageElement>('img[src]')) {
        const to = resolveDocLink(path, img.getAttribute('src') ?? '');
        if (to) img.src = `/api/docs/picture?${q({ path: to.path })}`;
      }
      toc.replaceChildren(h('option', { value: '' }, '☰ Contents'), ...heads.map((x) => h('option', { value: x.anchor }, `${' '.repeat(x.level - 1)}${clip(x.text, 60)}`)));
      toc.hidden = heads.length < 3;
      const words = doc.text.split(/\s+/).filter(Boolean).length;
      fill(body, h('p.lp-note', {}, [`${Math.max(1, Math.round(words / 220))} min read`, path].join(' · ')), md);
    })
    .catch((e: Error) => fill(body, h('p.lp-note.bad', {}, `Couldn't open ${path}: ${e.message}`)));
  return { title: path.slice(path.lastIndexOf('/') + 1), sub: path.includes('/') ? path : undefined, el: page(toc, body) };
}

// ---- Whiteboard -------------------------------------------------------------------------------
declare const __EXCALIDRAW_ASSETS__: string;

export function whiteboardScreen(): Screen {
  const floor = store.floor;
  const host = h('div.lp-whiteboard', {}, h('div.lp-loading', {}, h('span.spinner')));
  const people = h('p.lp-note');
  let app: import('../ui/whiteboard-app').WhiteboardApp | undefined;
  let closed = false;
  if (!floor) return { title: '📝 Whiteboard', el: page(empty('🏢', 'Pick a floor first')) };
  const paintPeople = () => {
    const others = store.drawing.filter((id) => id !== store.you).flatMap((id) => store.peers.get(id) ?? []);
    people.textContent = others.length ? `🟢 LIVE with ${others.map((p) => p.name).join(', ')}` : 'Just you for now. Anyone on this floor can join in.';
  };
  const offMsg = onServerMessage((msg: ServerMsg) => {
    if (!app) return;
    if (msg.t === 'welcome') {
      net.send({ t: 'wb.open' });
      app.resync();
    } else if (['wb.update', 'wb.pointer', 'wb.people', 'peer.update', 'peer.leave'].includes(msg.t)) app.receive(msg);
  });
  net.send({ t: 'wb.open' });
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH ??= __EXCALIDRAW_ASSETS__;
  import('../ui/whiteboard-app').then(
    (m) => {
      if (closed) return;
      host.replaceChildren();
      app = m.mountWhiteboard(host, (msg) => net.send(msg), `${store.project?.name ?? 'office'} whiteboard`);
    },
    () => host.replaceChildren(h('p.lp-note.bad', {}, "Couldn't load the whiteboard. Check your connection and open it again.")),
  );
  const off = live(on, ['drawing', 'peers'], paintPeople);
  return {
    title: '📝 Whiteboard',
    el: h('div.lp.lp-wide', {}, people, host),
    dispose: () => {
      closed = true;
      off();
      offMsg();
      app?.unmount();
      net.send({ t: 'wb.close' });
    },
  };
}

// ---- Search -----------------------------------------------------------------------------------
let lastQuery = '';

export function searchScreen(): Screen {
  const status = h('p.lp-note');
  const results = h('div');
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (q: string) => {
    lastQuery = q;
    const mine = ++seq;
    if (searchKey(q).length < SEARCH_MIN) {
      status.textContent = `Finds words in the office chat and in every worker's terminal, including what they showed before the office restarted.`;
      return fill(results);
    }
    status.textContent = 'Searching…';
    try {
      const found = await search(q);
      if (mine !== seq) return;
      const needle = searchKey(found.q);
      const byWorker = new Map<string, typeof found.terminals>();
      for (const hit of found.terminals) {
        if (!store.workers.has(hit.workerId)) continue;
        byWorker.set(hit.workerId, [...(byWorker.get(hit.workerId) ?? []), hit]);
      }
      const count = found.chat.length + [...byWorker.values()].reduce((n, l) => n + l.length, 0);
      status.textContent = !count ? `Nothing in the chat or any terminal matches “${found.q.trim()}”.` : `${count} ${count === 1 ? 'line' : 'lines'}, newest first${found.more ? ' (add words to narrow it down)' : ''}.`;
      fill(
        results,
        found.chat.length ? h('section.search-group', {}, h('h4', {}, '💬 Chat'), h('ul', {}, ...found.chat.map((c) => h('li.search-hit', {}, h('div.search-meta', {}, h('b', { style: `color:${c.color}` }, c.name), h('span', {}, timeAgo(c.at))), h('div.search-text', {}, ...highlight(c.text, needle)))))) : null,
        ...[...byWorker].map(([id, hits]) => {
          const w = store.workers.get(id)!;
          return h('section.search-group', {}, h('h4', {}, h('span.dot', { style: `background:${w.color}` }), [w.name, w.worktree && `🌿 ${w.worktree.branch}`].filter(Boolean).join(' · ')), h('ul', {}, ...hits.map((hit) => h('li.search-hit.term', { onclick: () => showTerminal(id, { needle, fromEnd: hit.rows - hit.row }), role: 'button', tabindex: 0 }, h('code', {}, ...highlight(hit.text, needle))))));
        }),
      );
    } catch (e) {
      if (mine === seq) status.textContent = `Couldn't search: ${(e as Error).message}`;
    }
  };
  const box = searchBox('Search the chat and every terminal…', (q) => (clearTimeout(timer), (timer = setTimeout(() => void run(q), 250))), lastQuery);
  box.maxLength = SEARCH_MAX;
  void run(lastQuery);
  return { title: '🔎 Search', el: page(box, status, results), dispose: () => clearTimeout(timer) };
}

// ---- Spend & limits ---------------------------------------------------------------------------
export function spendScreen(): Screen {
  const el = page();
  const paint = () => {
    const u = store.usage;
    const now = Date.now();
    const line = (a: string, b: string, cls = '', c?: string) => h('div.lp-spend', {}, h('span', {}, a), h('b', { class: cls }, b), c ? h('small', {}, c) : null);
    const plan = (label: string, l: { plan?: string; windows: { label: string; pct: number; resetsAt?: number }[]; at: number }) =>
      l.windows.length
        ? [heading(`${label}${l.plan ? ` · ${l.plan}` : ''}`), ...l.windows.map((w) => line(w.label, `${Math.round(w.pct)}%`, w.pct >= 90 ? 'bad' : w.pct >= 75 ? 'warn' : '', w.resetsAt ? `resets ${fmtReset(w.resetsAt, now)}` : undefined)), h('div', {}, ...l.windows.map((w) => h('div.lp-meter', { class: w.pct >= 90 ? 'over' : w.pct >= 75 ? 'near' : '' }, h('i', { style: `width:${Math.min(100, w.pct)}%` }))))]
        : [];
    fill(
      el,
      heading('Spend'),
      line('Today', usageLabel(u.today)),
      line('All time', usageLabel(u.total)),
      u.budget !== undefined ? line('Daily budget', `${fmtCost(u.today.cost)} of ${fmtCost(u.budget)}`, u.today.cost >= u.budget ? 'bad' : '', u.pauseHiring && u.today.cost >= u.budget ? 'hiring paused' : undefined) : null,
      ...plan('Claude limits', store.limits),
      ...plan('Codex limits', store.codexLimits),
      actions(button('🔄 Refresh limits', () => net.send({ t: 'limits.refresh' }))),
    );
  };
  return { title: '💸 Spend & limits', el, dispose: live(on, ['usage', 'limits'], paint) };
}

// ---- Jukebox ----------------------------------------------------------------------------------
export function jukeboxScreen(): Screen {
  const now = h('div.lp-card.lp-now');
  const list = h('div');
  const url = input('https://… internet radio, or a link to an .mp3');
  const play = () => {
    const u = checkStreamUrl(url.value);
    if ('error' in u) return toast(u.error, 'warn'), url.focus();
    net.send({ t: 'jukebox.play', url: u.url });
    url.value = '';
  };
  const paint = () => {
    const j = store.jukebox;
    const stream = j.track === STREAM;
    fill(
      now,
      h('div.lp-cardbody', {}, h('b.lp-ttl', {}, `${stream ? '📻' : '💿'} ${j.on ? trackTitle(j) : 'The jukebox is off'}`), h('span.lp-meta', {}, chip(j.on ? [stream ? 'a stream' : tuneById(j.track)?.mood, j.by && `put on by ${j.by}`].filter(Boolean).join(' · ') : j.by ? `${j.by} turned it off` : 'Pick a tune to put it on'))),
      actions(j.on ? button('⏭️ Skip', () => net.send({ t: 'jukebox.skip' })) : button('▶️ Play', () => net.send({ t: 'jukebox.play' }), 'primary'), j.on ? button('⏹️ Stop', () => net.send({ t: 'jukebox.stop' })) : null),
    );
    fill(list, ...JUKEBOX_TUNES.map((t) => row({ icon: j.on && j.track === t.id ? '🔊' : '🎵', title: t.title, sub: t.mood, cls: j.on && j.track === t.id ? 'on' : '', onclick: () => !(j.on && j.track === t.id) && net.send({ t: 'jukebox.play', track: t.id }) })));
  };
  const off = live(on, ['jukebox'], paint);
  return {
    title: '🎵 Jukebox',
    el: page(now, note('It plays in the 3D office, for everyone on this floor, louder the closer they are to the lounge. This is the remote.'), heading('Put on a tune'), list, heading('Or play a stream'), url, actions(button('📻 Play stream', play, 'primary'))),
    dispose: off,
  };
}

// ---- Updates ----------------------------------------------------------------------------------
export function upgradeScreen(): Screen {
  const el = page();
  const paint = () => {
    const u = store.upgrade;
    const busy = u.phase === 'building' || u.phase === 'restarting';
    const awake = [...store.workers.values()].some((w) => !isAsleep(w.status));
    const recheck = button('🔄 Check again', () => net.send({ t: 'upgrade.check' }));
    const go_ = button('⬆️ Upgrade now', () => confirmDialog('Upgrade the office?', 'It builds the new version while the office keeps running, then restarts it. Everyone reconnects automatically.', 'Upgrade', () => net.send({ t: 'upgrade.start' })), 'primary');
    recheck.disabled = !!u.checking || busy;
    go_.disabled = !u.latest || !!u.checking || busy;
    fill(
      el,
      u.current ? h('p.lp-note', {}, 'Running now: ', h('code', {}, u.current.sha), ` ${u.current.subject}`) : null,
      u.phase === 'building' ? h('p.laptop-wait', {}, h('span.spinner'), ` Building ${u.latest?.sha ?? 'the new version'}${u.by ? ` (started by ${u.by})` : ''}…`) : null,
      u.phase === 'failed' && u.error ? h('pre.upgrade-error', {}, u.error) : null,
      u.checking ? h('p.laptop-wait', {}, h('span.spinner'), ' Checking GitHub for changes…') : !u.latest && u.checkedAt ? h('p.upgrade-status.ok', {}, `✅ Up to date (checked ${timeAgo(u.checkedAt)})`) : null,
      u.latest ? heading(`New: ${(u.behind ?? 0) >= 50 ? '50+' : (u.behind ?? u.changes?.length ?? 0)} change(s)`) : null,
      u.latest ? h('ul.changes', {}, ...(u.changes ?? []).map((c) => h('li', {}, h('code', {}, c.sha), ' ', c.subject))) : null,
      u.latest && !busy ? note(`Upgrading restarts the office once. ${awake ? 'Workers keep working through the restart.' : ''}`) : null,
      actions(go_, recheck),
    );
  };
  return { title: '⬆️ Upgrade the office', el, dispose: live(on, ['upgrade', 'workers'], paint) };
}

// ---- Settings ---------------------------------------------------------------------------------
export function settingsScreen(): Screen {
  const built = buildSettings(
    net,
    settings,
    (next) => {
      Object.assign(settings, next);
      saveSettings(settings);
    },
    () =>
      openCharacter(false, (p) => {
        store.profile = p;
        saveProfile(p);
        net.send({ t: 'profile', name: p.name, color: p.color, look: p.look });
      }),
    () => {},
    notifier,
    async () => {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/login?next=/lite';
    },
    store.sky ? { now: describeSky(store.sky, store.officeNow()), live: !!store.sky.city } : undefined,
    undefined,
    { lite: true },
  );
  built.body.classList.add('lp-settings');
  return { title: '⚙️ Settings', el: h('div.lp.lp-wide', {}, built.body), dispose: built.dispose };
}

// ---- What only the 3D office has --------------------------------------------------------------
export function about3dScreen(): Screen {
  const items: [string, string, string][] = [
    ['🚶', 'Walking around', 'Moving, jumping, the camera and bumping into people. There is nothing to do from a phone that the pages here don’t cover.'],
    ['🪑', 'Sitting, the dog and breaks', 'Couches, bean bags, petting the dog, coffee and smoke breaks.'],
    ['🍸', 'The rooftop bar', 'Drinks, darts, axes and the DJ’s air horn.'],
    ['⛳', 'Golf, basketball, the arcade and the cars', 'Playing in the office takes the 3D world.'],
    ['🖼️', 'Hanging pictures', 'Pictures on a wall are placed by pointing at it.'],
    ['🎙️', 'Voice chat and screen sharing', 'They need a microphone, speakers and a big screen — and run in the 3D office.'],
    ['🛗', 'Riding the elevator, the garage and the roof', 'Floors are switched from Floors & projects here instead.'],
    ['✋', 'Carrying an issue card to a desk', 'Hand an issue to a worker from its page in Work instead.'],
  ];
  return {
    title: 'The 3D office',
    el: page(
      note('Everything a phone can do is in the tabs. These only make sense standing in the office:'),
      ...items.map(([i, t, d]) => h('div.lp-about', {}, h('span.ico', { 'aria-hidden': 'true' }, i), h('div', {}, h('b', {}, t), h('p', {}, d)))),
      actions(h('a.btn.primary', { href: '/?3d=1' }, '🏢 Open the 3D office')),
      note('The 3D office opens with this phone as someone standing in it; your teammates see you there instead of on the 2D view.'),
    ),
  };
}

