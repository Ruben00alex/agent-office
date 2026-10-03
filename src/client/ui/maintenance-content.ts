import { h } from './dom';
import { markdown } from './markdown';

/** HTML keeps its styling in an opaque sandbox; it cannot access the office or fetch resources. */
function htmlPreview(source: string) {
  const frame = h('iframe.maintenance-html', { title: 'Agent HTML preview', sandbox: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) as HTMLIFrameElement;
  frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';"><style>body{font:15px system-ui;color:#17212f;margin:20px}pre{white-space:pre-wrap}</style>${source}`;
  return h('details.maintenance-preview', {}, h('summary', {}, 'Preview HTML'), frame);
}

/** A one-line title that shows in full as a tooltip and scrolls sideways on hover when it doesn't fit. */
export function marqueeTitle(text: string) {
  const inner = h('span.maintenance-marquee', {}, text);
  const outer = h('b', { title: text }, inner);
  outer.addEventListener('mouseenter', () => {
    const overflow = inner.scrollWidth - outer.clientWidth;
    if (overflow <= 0) return;
    // Measured while still plain text, then switched to a block that can slide.
    outer.style.setProperty('--shift', `-${overflow + 4}px`);
    outer.style.setProperty('--time', `${Math.max(1, (overflow + 4) / 40)}s`);
    outer.classList.add('sliding');
  });
  outer.addEventListener('mouseleave', () => outer.classList.remove('sliding'));
  return outer;
}

export function maintenanceContent(source: string): HTMLElement {
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(source)) {
    const preview = htmlPreview(source);
    preview.open = true;
    return h('div.maintenance-rich', {}, preview, h('details', {}, h('summary', {}, 'HTML source'), h('pre', {}, h('code', {}, source))));
  }
  const content = markdown(source);
  // Agent text is untrusted. The existing Markdown renderer sanitizes markup and executable URLs.
  for (const code of content.querySelectorAll('pre > code')) {
    if (/\blanguage-html\b/.test(code.className)) code.parentElement!.after(htmlPreview(code.textContent ?? ''));
    const copy = h('button.maintenance-copy', { type: 'button', 'aria-label': 'Copy code' }, 'Copy');
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(code.textContent ?? '').then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy unavailable'; });
    });
    code.parentElement!.append(copy);
  }
  return content;
}

