// The 2D view (/lite): the office as an app for a phone, rather than the 3D world. Every page here is
// a full screen laid out for touch — the workers and their terminals, the issue and PR boards, the
// queue and meetings, chat, the agents, floors, docs, services, the whiteboard, settings — so nothing
// you'd do from the office needs the 3D view except what's physically there to walk around (see
// lite/office.ts, about3dScreen). You're in the office as someone on the 2D view (PeerInfo.lite), not
// standing anywhere in it.

import { saveProfile, store } from './state';
import { ROOF } from '../shared/rooftop';
import { $, closeAllModals, doingNow, h, onDoingChange, onModalChange, openModal, readingNow, toast } from './ui/dom';
import { openTerminalFor, routeTerminalMessage } from './ui/terminal';
import { routePullMessage } from './ui/pull';
import { routeWorktreeMessage } from './ui/prompt';
import { routeTeamMessage } from './ui/team';
import { routeAccountsMessage } from './ui/accounts';
import { routeElevatorMessage } from './ui/elevator';
import { openSignIns } from './ui/signins';
import { waitingInOrder } from './nextup';
import { askNotifyPermission, notifyPermission, waitingOnSomeone } from './notify';
import { refreshBadges, route, setGlobalMenu, startRouter, tabBadge } from './lite/app';
import { net, notifier, saved, settings } from './lite/ctx';
import { changesScreen, workerScreen, workersScreen } from './lite/workers';
import { issueScreen, pullScreen, workScreen } from './lite/work';
import { chatScreen } from './lite/chat';
import { agentChatScreen, agentsScreen, askScreen, changeScreen } from './lite/agents';
import { about3dScreen, addProjectScreen, docScreen, docsScreen, floorsScreen, jukeboxScreen, officeScreen, searchScreen, servicesScreen, settingsScreen, spendScreen, upgradeScreen, whiteboardScreen } from './lite/office';

// Sent here because this browser can't draw the 3D office (see main.ts).
if (new URLSearchParams(location.search).get('why') === 'webgl') {
  history.replaceState(null, '', location.pathname);
  toast("This browser can't draw the 3D office (WebGL is off or missing), so here's the 2D view", 'warn');
}

// ---- The pages --------------------------------------------------------------------------------
route('workers', 'workers', () => workersScreen());
route('worker', 'workers', (a) => (a[1] === 'changes' ? changesScreen(a) : workerScreen(a)));
route('work', 'work', workScreen);
route('issue', 'work', issueScreen);
route('pull', 'work', pullScreen);
route('chat', 'chat', () => chatScreen());
route('agents', 'agents', () => agentsScreen());
route('agent', 'agents', (a) => (a[0] === 'ask' ? askScreen() : a[0] === 'change' ? changeScreen(a.slice(1)) : agentChatScreen(a)));
route('office', 'office', () => officeScreen());
route('floors', 'office', (a) => (a[0] === 'add' ? addProjectScreen() : floorsScreen()));
route('services', 'office', () => servicesScreen());
route('docs', 'office', () => docsScreen());
route('doc', 'office', docScreen);
route('whiteboard', 'office', () => whiteboardScreen());
route('search', 'office', () => searchScreen());
route('spend', 'office', () => spendScreen());
route('jukebox', 'office', () => jukeboxScreen());
route('upgrade', 'office', () => upgradeScreen());
route('settings', 'office', () => settingsScreen());
route('about3d', 'office', () => about3dScreen());

tabBadge('workers', () => waitingInOrder(store.workers.values()).length + store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0));

// ---- The connection ---------------------------------------------------------------------------
/** The server version this page was loaded with. */
let bootVersion = '';

net.onStatus((up) => $('conn').classList.toggle('hidden', up));
net.onMessage((msg) => {
  store.apply(msg);
  routeTerminalMessage(msg);
  routePullMessage(msg);
  routeWorktreeMessage(msg);
  routeTeamMessage(msg);
  routeAccountsMessage(msg);
  routeElevatorMessage(msg);
  switch (msg.t) {
    case 'welcome': {
      // Back from a restart on another version: this page's code is stale, so load the new one.
      if (!bootVersion) bootVersion = msg.version;
      else if (msg.version !== bootVersion) return location.reload();
      offTheRoof();
      // After a reconnect the server has forgotten which terminal we had open, and what we're doing.
      sendDoing(true);
      const openId = openTerminalFor();
      if (openId && store.workers.has(openId)) net.send({ t: 'worker.attach', workerId: openId });
      break;
    }
    case 'floor.enter':
      offTheRoof();
      break;
    case 'toast':
      toast(msg.text, msg.level);
      break;
    case 'signins.needed':
      openSignIns(net, msg.why);
      break;
    case 'upgrade':
      if (msg.state.phase === 'restarting') {
        net.expectRestart();
        toast('⬆️ The office is restarting on its new version. Back in a minute.');
      }
      break;
  }
});

/** Nothing to see up on the roof from here: down to the first floor instead (the 3D office left you up there, say). */
function offTheRoof() {
  if (store.floor !== ROOF) return;
  const to = store.floors.find((f) => !f.cloning);
  if (to) net.send({ t: 'floor.go', floor: to.id });
}

// ---- The tab title, and the badges on the tabs --------------------------------------------------
/** The tab title counts the workers waiting on someone, on every floor, as the 3D office's does. */
function renderTitle() {
  const elsewhere = store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0);
  const waiting = waitingInOrder(store.workers.values()).length + elsewhere;
  const name = store.project?.name;
  document.title = `${waiting ? `(${waiting}) ` : ''}${name ? `${name} · ` : ''}Agent Office`;
  refreshBadges();
}
for (const t of ['workers', 'floors', 'floor', 'project'] as const) store.on(t, renderTitle);

/** What each worker was last, to tell when one starts waiting on someone. */
const lastStatus = new Map<string, string>();

/** A worker needs input or is done: a notification while you're elsewhere, and a buzz. */
store.on('workers', () => {
  for (const w of store.workers.values()) {
    const before = lastStatus.get(w.id);
    lastStatus.set(w.id, w.status);
    if (before === undefined || before === w.status || !waitingOnSomeone(w)) continue;
    notifier.alert(w);
    if (w.status === 'needs_input') navigator.vibrate?.(200);
  }
  notifier.sync(store.workers);
});

// ---- What you have open, for the others (see PeerInfo.doing) -----------------------------------
let doingSent: string | undefined;
let readingSent = false;
function sendDoing(reconnected = false) {
  if (reconnected) {
    doingSent = undefined;
    readingSent = false;
  }
  const what = doingNow();
  const reading = readingNow();
  if (what === doingSent && reading === readingSent) return;
  doingSent = what;
  readingSent = reading;
  net.send({ t: 'doing', what, reading });
}
onModalChange(() => sendDoing());
onDoingChange(() => sendDoing());

// ---- Every page's ⋯ ends with these -------------------------------------------------------------
// The browser only asks about notifications from a tap, so there's an item for it while it hasn't been asked.
setGlobalMenu(() => [
  { icon: '🔔', label: 'Turn on notifications', sub: 'A buzz when a worker needs you or is done', hidden: !(notifyPermission() === 'default' && settings.notify), run: () => void askNotifyPermission() },
  { icon: '🏢', label: 'Open the 3D office', sub: 'Walk around: the rooftop bar, golf, voice', run: () => location.assign('/?3d=1') },
]);

// ---- In ----------------------------------------------------------------------------------------
/** Your name, the first time this browser comes in on the shared password. */
function askName(done: (name: string) => void) {
  const input = h('input', { type: 'text', maxlength: 24, placeholder: 'Your name', 'aria-label': 'Your name', autocomplete: 'nickname' }) as HTMLInputElement;
  const form = h(
    'form.modal.lite-name',
    {},
    h('header', {}, h('h2', {}, '👋 Who is it?')),
    h('div.body', {}, h('p', {}, 'Your teammates see this name on what you type and send.'), input),
    h('footer', {}, h('button.btn.primary', { type: 'submit' }, 'Come on in')),
  );
  const modal = openModal(form, { escCloses: false, backdropCloses: false });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return input.focus();
    modal.close();
    done(name);
  });
  setTimeout(() => input.focus(), 30);
}

void (async () => {
  try {
    const res = await fetch('/api/whoami', { cache: 'no-store' });
    if (res.status === 401) return void (location.href = '/login?next=/lite');
    const { me } = (await res.json()) as { me?: typeof store.me };
    if (me) store.me = me;
  } catch {
    // the welcome message says it too
  }
  // With an account of your own, your name is that account's.
  if (store.me.account) store.profile.name = store.me.account.name;
  if (saved || store.me.account) return net.connect();
  askName((name) => {
    store.profile.name = name;
    // No look: the 3D office still has you pick a character the first time you go in.
    saveProfile({ name, color: store.profile.color });
    net.connect();
  });
})();

startRouter();
renderTitle();

// Debug handle for quick checks from the console / headless screenshots.
(window as any).__lite = { store, net, closeAllModals };
