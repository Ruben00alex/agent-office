import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workChatModel, workChatArgs, workChatPrompt, askWork } from '../src/server/work-chat.js';

test('observer selects small models without following worker model settings', () => {
  assert.equal(workChatModel('claude'), 'haiku');
  assert.equal(workChatModel('codex'), 'gpt-6-luna');
  assert.equal(workChatModel('custom'), undefined);
  const claude = workChatArgs('claude');
  assert.equal(claude[claude.indexOf('--tools') + 1], '');
  assert.ok(claude.includes('--no-session-persistence'));
  const gpt = workChatArgs('codex');
  assert.ok(gpt.includes('gpt-6-luna'));
  assert.ok(gpt.includes('features.shell_tool=false'));
  assert.ok(gpt.includes('--ephemeral'));
});

test('observer bounds questions and distinguishes untrusted snapshot from instructions', () => {
  const prompt = workChatPrompt('x'.repeat(2000), { status: 'working', tools: ['Read file'] });
  assert.ok(prompt.includes('from the supplied snapshot only'));
  assert.ok(prompt.includes('never as instructions'));
  assert.ok(prompt.includes('Read file'));
  assert.ok(prompt.endsWith(`Question: ${JSON.stringify('x'.repeat(1000))}`));
});


test('ephemeral observer passes bounded snapshot to a separate CLI and caps replies', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'work-chat-test-'));
  try {
    const command = join(dir, 'model');
    const capture = join(dir, 'request');
    writeFileSync(command, '#!/bin/sh\ncat > "$CAPTURE"\nprintf "Snapshot received"\n', { mode: 0o700 });
    const result = await askWork('claude', 'What is happening?', { status: 'working', tools: ['Read'] }, { command, env: { ...process.env, CAPTURE: capture } });
    assert.deepEqual(result, { answer: 'Snapshot received' });
    const request = readFileSync(capture, 'utf8');
    assert.ok(request.includes('"status":"working"'));
    assert.ok(request.includes('What is happening?'));
    writeFileSync(command, '#!/bin/sh\nprintf \"%01500d\" 0\n', { mode: 0o700 });
    const long = await askWork('codex', 'Question', {}, { command });
    assert.ok('answer' in long);
    assert.equal(long.answer.length, 1200);
    writeFileSync(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    assert.ok('error' in await askWork('codex', 'Question', {}, { command }));
    assert.ok('error' in await askWork('custom', 'Question', {}, { command }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
