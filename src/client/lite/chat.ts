// The Chat tab: the office's chat, and who is in the office.

import { store } from '../state';
import { h, timeAgo } from '../ui/dom';
import { go, live, type Screen } from './app';
import { empty, fill, page, segmented } from './kit';
import { net } from './ctx';

const on = store.on.bind(store);
type View = 'chat' | 'people';

const tabs = (active: View) =>
  segmented<View>(
    [
      { id: 'chat', label: '💬 Chat' },
      { id: 'people', label: '👥 People', count: store.peers.size },
    ],
    active,
    (v) => go(`chat/${v}`, true),
  );

export function chatScreen([view]: string[]): Screen {
  return view === 'people' ? peopleScreen() : talkScreen();
}

function talkScreen(): Screen {
  const log = h('div.lp-chatlog', { role: 'log', 'aria-live': 'polite' });
  const input = h('input', { type: 'text', maxlength: 500, placeholder: 'Say something to the office…', 'aria-label': 'Message', enterkeyhint: 'send', autocomplete: 'off' }) as HTMLInputElement;
  const form = h('form.lp-composer.lp-chatform', {}, input, h('button.btn.primary', { type: 'submit' }, 'Send'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    net.send({ t: 'chat', text });
    input.value = '';
  });
  const paint = () => {
    const stuck = document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 160;
    fill(
      log,
      ...(store.chat.length
        ? store.chat.map((c) => h('div.lite-chat-line', {}, h('span.dot', { style: `background:${c.color}` }), h('div', {}, h('b', {}, c.name, h('small', {}, ` ${timeAgo(c.at)}`)), h('p', {}, c.text))))
        : [empty('💬', 'Nobody has said anything yet', 'Say hello to everyone in the office.')]),
    );
    if (stuck) requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  };
  const off = live(on, ['chat'], paint);
  requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  return { title: 'Chat', el: page(tabs('chat'), log, form), dispose: off };
}

function peopleScreen(): Screen {
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
              h('span', {}, h('b', {}, p.name, p.id === store.you ? ' (you)' : ''), h('small', {}, [p.lite ? '📱 on the 2D view' : p.doing ?? '🏢 in the 3D office', p.floor ? floors.get(p.floor) : null, p.voice ? '🎙️ in voice' : null].filter(Boolean).join(' · '))),
            ),
          )
        : [empty('👥', 'Nobody else is here')]),
    );
  };
  return { title: 'Chat', el: page(tabs('people'), list), dispose: live(on, ['peers', 'floors'], paint) };
}
