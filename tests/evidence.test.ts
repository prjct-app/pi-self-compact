import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceIndex, EVIDENCE_HEADER, renderEvidence } from '../src/evidence.ts';
import { stripLedger, withLedger } from '../src/ledger.ts';

const call = (id: string, callId: string, name: string, args: Record<string, unknown>) =>
  ({ type: 'message', id, message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] } });
const result = (id: string, callId: string, text: string, isError = false) =>
  ({ type: 'message', id, message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text }], isError } });
const user = (id: string) => ({ type: 'message', id, message: { role: 'user', content: 'sigue' } });

test('the index keeps every file the session touched and this span\'s failures', () => {
  const branch: any[] = [
    user('u0'),
    call('a1', 'c1', 'read', { path: 'src/a.ts' }), result('r1', 'c1', 'line1\nline2\nline3'),
    call('a2', 'c2', 'bash', { command: 'pnpm test' }), result('r2', 'c2', 'FAIL\nCommand exited with code 1', true),
    { type: 'compaction', id: 'k1', firstKeptEntryId: 'a3' },
    call('a3', 'c3', 'edit', { path: 'src/a.ts', edits: [] }), result('r3', 'c3', 'Successfully replaced 1 block(s)'),
    call('a4', 'c4', 'bash', { command: 'pnpm test' }), result('r4', 'c4', 'ok'),
    call('a7', 'c7', 'bash', { command: 'pnpm build' }), result('r7', 'c7', 'error TS2322\nCommand exited with code 2', true),
    call('a5', 'c5', 'read', { path: 'src/missing.ts' }), result('r5', 'c5', 'ENOENT: no such file', true),
    call('a6', 'c6', 'read', { path: 'src/b.ts' }), result('r6', 'c6', 'x'),
    user('u9'),
  ];
  const lines = evidenceIndex(branch, 'u9');
  assert.deepEqual(lines, [
    'Files touched in this session (latest state):',
    '[a3] edit src/a.ts',
    '[r6] read src/b.ts · 1 lines',
    'Commands whose latest run failed:',
    '[r7] $ pnpm build → failed (exit 2)',
    'Failed calls in this span:',
    '[r5] read src/missing.ts failed: ENOENT: no such file',
  ], 'files from the whole session at their latest state; failures from this span only, a test that failed then passed is not listed, successful commands are not listed');
  const before = evidenceIndex(branch, 'k1');
  assert.ok(before.includes('[r2] $ pnpm test → failed (exit 1)'));
  assert.ok(before.includes('[r1] read src/a.ts · 3 lines'));
});

test('the index follows the ledger, replaces Pi\'s path-only file lists, and is never duplicated', () => {
  const evidence = renderEvidence(['Files touched in this session (latest state):', '[r1] read a.ts · 3 lines'], 'memory_context (action read, entryId)');
  assert.match(evidence, /^## Evidence index .*\nRead any of them with memory_context/u);
  const summary = withLedger('PROSE\n\n<read-files>\na.ts\n</read-files>', [], evidence);
  assert.equal(summary, `PROSE\n\n${evidence}`, 'the index names the same files with ids');
  assert.equal(withLedger(summary, [], evidence), summary, 'idempotent');
  assert.equal(stripLedger(summary), 'PROSE');
  assert.equal(withLedger('PROSE\n\n<read-files>\na.ts\n</read-files>', []), 'PROSE\n\n<read-files>\na.ts\n</read-files>', 'without an index Pi\'s lists stay');
  assert.equal(renderEvidence([]), '');
  assert.equal(withLedger(`PROSE\n\n${EVIDENCE_HEADER}\nold`, [], evidence).split(EVIDENCE_HEADER).length, 2);
});

test('a file read before earlier compactions stays listed after later ones', () => {
  const branch: any[] = [call('a1', 'c1', 'read', { path: 'config.env.txt' }), result('r1', 'c1', 'x\ny'), user('u1'),
    { type: 'compaction', id: 'k1', firstKeptEntryId: 'u1' }, user('u2'), { type: 'compaction', id: 'k2', firstKeptEntryId: 'u2' }, user('u3')];
  assert.deepEqual(evidenceIndex(branch, 'u3'), ['Files touched in this session (latest state):', '[r1] read config.env.txt · 2 lines']);
});
