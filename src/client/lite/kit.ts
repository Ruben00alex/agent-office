// Small building blocks for the 2D view's pages: touch-sized rows, cards, segmented tabs, empty states.

import { h, openModal } from '../ui/dom';

type Kid = Node | string | null | undefined | false;

export const page = (...kids: Kid[]) => h('div.lp', {}, ...kids);

export const heading = (text: string, ...right: Kid[]) => h('h2.lp-h', {}, h('span', {}, text), ...right);

export const empty = (icon: string, text: string, hint?: string) => h('div.lp-empty', {}, h('div.ico', { 'aria-hidden': 'true' }, icon), h('b', {}, text), hint ? h('p', {}, hint) : null);

export const note = (text: string | Node) => h('p.lp-note', {}, text);

/** A chip of text (labels, small facts). */
export const chip = (text: string, cls = '', style?: string) => h('span.lp-chip', { class: cls, style }, text);

/** A full-width tappable row: icon, title and a line under it, and a chevron. */
export function row(opts: { icon?: string; title: string; sub?: string; right?: Kid; onclick: () => void; cls?: string }) {
  return h(
    'button.lp-row',
    { type: 'button', class: opts.cls, onclick: opts.onclick },
    opts.icon ? h('span.ico', { 'aria-hidden': 'true' }, opts.icon) : null,
    h('span.txt', {}, h('b', {}, opts.title), opts.sub ? h('small', {}, opts.sub) : null),
    opts.right ?? h('span.chev', { 'aria-hidden': 'true' }, '›'),
  );
}

/** One of a few views, as a row of touch-sized tabs. */
export function segmented<T extends string>(options: { id: T; label: string; count?: number }[], active: T, pick: (id: T) => void) {
  return h(
    'div.lp-seg',
    { role: 'tablist' },
    ...options.map((o) =>
      h(
        'button',
        { type: 'button', role: 'tab', 'aria-selected': String(o.id === active), class: o.id === active ? 'on' : '', onclick: () => pick(o.id) },
        o.label,
        o.count ? h('span.n', {}, String(o.count)) : null,
      ),
    ),
  );
}

/** Buttons side by side, wrapping on a narrow screen. */
export const actions = (...kids: Kid[]) => h('div.lp-actions', {}, ...kids);

export function button(label: string, onclick: () => void, cls = '', title?: string) {
  return h('button.btn', { type: 'button', class: cls, onclick, title, 'aria-label': title }, label);
}

/** Text with a label above it, for forms. */
export const field = (label: string, input: HTMLElement, hint?: string) => h('label.lp-field', {}, h('span', {}, label), input, hint ? h('small', {}, hint) : null);

export function textarea(placeholder: string, rows = 3, value = '') {
  const t = h('textarea', { rows, placeholder, 'aria-label': placeholder }) as HTMLTextAreaElement;
  t.value = value;
  return t;
}

export function input(placeholder: string, value = '', type = 'text') {
  const i = h('input', { type, placeholder, 'aria-label': placeholder, autocomplete: 'off', autocapitalize: 'off' }) as HTMLInputElement;
  i.value = value;
  return i;
}

/** A search box that filters as you type. */
export function searchBox(placeholder: string, onInput: (q: string) => void, value = '') {
  const i = input(placeholder, value, 'search');
  i.classList.add('lp-search');
  i.addEventListener('input', () => onInput(i.value));
  return i;
}

/** Replaces what's in `el`, leaving out the nulls. */
export function fill(el: HTMLElement, ...kids: Kid[]) {
  el.replaceChildren(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));
}

/**
 * A page that never scrolls as a whole: `top` and `bottom` stay put and only `scroll` moves. Chats,
 * lists with a filter box, and anything with controls you shouldn't have to scroll back up to reach.
 */
export function layout(opts: { top?: Kid[]; scroll: Kid[] | HTMLElement; bottom?: Kid[] }): { el: HTMLElement; scroller: HTMLElement; top: HTMLElement; bottom: HTMLElement } {
  const scroller = opts.scroll instanceof HTMLElement ? opts.scroll : h('div.lp-scrollbody', {}, ...opts.scroll.filter((k): k is Node | string => !!k));
  scroller.classList.add('lp-scroll');
  const top = h('div.lp-top', {}, ...(opts.top ?? []));
  const bottom = h('div.lp-bottom', {}, ...(opts.bottom ?? []));
  top.classList.toggle('hidden', !top.childNodes.length);
  bottom.classList.toggle('hidden', !bottom.childNodes.length);
  return { el: h('div.lp.lp-fill', {}, top, scroller, bottom), scroller, top, bottom };
}

export interface Sheet {
  close(): void;
  el: HTMLElement;
}

/**
 * A panel that slides up from the bottom of the screen over what you're doing: for a menu, a picker or
 * a short form, so choosing never costs you your place. Tap outside, ✕ or Esc closes it.
 */
export function openSheet(opts: { title: string; body: HTMLElement; tall?: boolean; onClose?: () => void }): Sheet {
  const sheet = h('div.sheet', { role: 'dialog', 'aria-label': opts.title, class: opts.tall ? 'tall' : '' }, h('div.sheet-grab', { 'aria-hidden': 'true' }), h('header.sheet-head', {}, h('b', {}, opts.title)), h('div.sheet-body', {}, opts.body));
  const modal = openModal(sheet, { onClose: opts.onClose });
  modal.backdrop.classList.add('sheet-backdrop');
  return { close: modal.close, el: sheet };
}

/** A round, thumb-sized button with just an icon. */
export function iconButton(icon: string, label: string, onclick: () => void, cls = '') {
  return h('button.btn.lp-icon', { type: 'button', 'aria-label': label, title: label, class: cls, onclick }, icon);
}
