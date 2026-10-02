import type { Net } from '../net';
import type { ServerMsg, WorkerInfo } from '../../shared/protocol';
import { h, openModal } from './dom';

export function openWorkChat(net: Net, worker: WorkerInfo, subscribe: (receive: (msg: ServerMsg) => void) => () => void) {
  const transcript = h('div.laptop-out', { 'aria-live': 'polite', style: 'max-height:45vh;overflow:auto;white-space:pre-wrap' });
  const question = h('input', { type: 'text', maxlength: 1000, 'aria-label': 'Question about work', placeholder: 'What are you doing right now?', autocomplete: 'off' });
  const send = h('button.btn.primary', { type: 'submit' }, 'Ask');
  const model = worker.provider === 'claude' ? 'Haiku' : 'GPT Luna';
  const form = h('form.modal.laptop', { role: 'dialog', 'aria-label': `Ask about ${worker.name}'s work` },
    h('header', {}, h('h2', {}, `Ask about ${worker.name}'s work`)),
    h('div.body', {}, h('p.laptop-note', {}, `${model} answers from recent prompts and activity. Questions do not interrupt the worker. Each answer uses a fresh snapshot.`), transcript, question),
    h('footer', {}, send));
  let pending: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (text: string) => {
    clearTimeout(timer);
    pending = undefined;
    send.disabled = false;
    transcript.append(h('p', {}, text));
    transcript.scrollTop = transcript.scrollHeight;
    question.focus();
  };
  const unsubscribe = subscribe(msg => {
    if (msg.t !== 'worker.work.answer' || msg.id !== pending) return;
    finish(msg.error ?? msg.answer ?? 'No answer received.');
  });
  openModal(form, { onClose: () => { unsubscribe(); clearTimeout(timer); } });
  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = question.value.trim() || 'What is this worker doing right now?';
    if (pending) return;
    if (!net.up) { transcript.append(h('p', {}, 'Office disconnected. Reconnect before asking.')); return; }
    pending = crypto.randomUUID().replaceAll('-', '');
    transcript.append(h('p', {}, `You: ${text}`));
    question.value = '';
    send.disabled = true;
    net.send({ t: 'worker.work.ask', workerId: worker.id, id: pending, question: text });
    timer = setTimeout(() => finish('No reply received. Check your connection and try again.'), 50_000);
  });
  question.focus();
}
