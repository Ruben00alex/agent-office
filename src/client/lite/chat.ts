// The Chat tab: the office's chat, with who is in the office a tap away.

import { store } from '../state';
import { h, timeAgo } from '../ui/dom';
import { live, setSubtitle, type Screen } from './app';
import { empty, fill, iconButton, layout, openSheet } from './kit';
import { net } from './ctx';

const on = store.on.bind(store);

/** Who's in the office, and what they're up to, in a sheet over the chat. */
function openPeople() {
  const list = h('div.lp-people');
  const paint = () => {
    const peers = [...store.peers.values()];
    const floors = new Map(store.floors.map((f) => [f.id, f.name]));
    fill(
      list,
      ...(peers.length
        ? peers.map((p) =>
            h(
              'div.lite-person',
              {},
              h('span.dot', { style: `background:${p.color}` }),
              h('span', {}, h('b', {}, p.name, p.id === store.you ? ' (you)' : ''), h('small', {}, [p.lite ? '📱 on the 2D view' : (p.doing ?? '🏢 in the 3D office'), p.floor ? floors.get(p.floor) : null, p.voice ? '🎙️ in voice' : null].filter(Boolean).join(' · '))),
            ),
          )
        : [empty('👥', 'Nobody else is here')]),
    );
  };
  const off = live(on, ['peers', 'floors'], paint);
  openSheet({ title: 'In the office', tall: true, body: list, onClose: off });
}

export function chatScreen(): Screen {
  const log = h('div.lp-chatlog', { role: 'log', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', maxlength: 500, placeholder: 'Message the office…', 'aria-label': 'Message', enterkeyhint: 'send', autocomplete: 'off' }) as HTMLInputElement;
  const send = h('button.btn.primary.lp-send', { type: 'submit', 'aria-label': 'Send' }, '➤');
  const form = h('form.lp-compose', {}, input, send);
  const view = layout({ scroll: [log], bottom: [form] });
  view.scroller.classList.add('lp-chatscroll');
  const jump = h('button.lp-jump.hidden', { type: 'button', 'aria-label': 'Jump to the latest message', onclick: () => view.scroller.scrollTo({ top: view.scroller.scrollHeight, behavior: 'smooth' }) }, '↓');
  view.scroller.append(jump);
  const near = () => view.scroller.scrollHeight - view.scroller.scrollTop - view.scroller.clientHeight < 120;
  view.scroller.addEventListener('scroll', () => jump.classList.toggle('hidden', near()), { passive: true });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    net.send({ t: 'chat', text });
    input.value = '';
  });
  const paint = () => {
    const stuck = near();
    setSubtitle(`${store.peers.size} here`);
    fill(
      log,
      ...(store.chat.length
        ? store.chat.map((c, i) => {
            const prev = store.chat[i - 1];
            const mine = c.from === store.you;
            const first = !prev || prev.from !== c.from || c.at - prev.at > 5 * 60_000;
            return h(
              'article.lp-msg',
              { class: `${mine ? 'from-user' : 'from-agent'}${first ? ' first' : ''}` },
              first ? h('div.lp-msg-meta', {}, h('span.dot', { style: `background:${c.color}` }), h('b', {}, mine ? 'You' : c.name), h('time', {}, timeAgo(c.at))) : null,
              h('div.lp-bubble', {}, h('p.maintenance-user-text', {}, c.text)),
            );
          })
        : [empty('💬', 'Nobody has said anything yet', 'Say hello to everyone in the office.')]),
    );
    if (stuck) requestAnimationFrame(() => (view.scroller.scrollTop = view.scroller.scrollHeight));
  };
  const off = live(on, ['chat', 'peers'], paint);
  requestAnimationFrame(() => (view.scroller.scrollTop = view.scroller.scrollHeight));
  return { title: 'Chat', el: view.el, actions: [iconButton('👥', 'Who is here', openPeople)], dispose: off };
}
