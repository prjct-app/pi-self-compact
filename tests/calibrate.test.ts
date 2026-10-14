import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { calibrationPath, thresholdFor, updateCalibration } from '../src/calibrate.ts';
import { installSelfCompact } from '../src/index.ts';
import { STATE_ENTRY } from '../src/state.ts';

const bands = (rates: Record<number, [number, number]>) => Object.fromEntries(Object.entries(rates).map(([k, [failed, edits]]) => [k, { failed, edits }]));

test('the threshold is where failed edits rise clearly and stay up; no rise or too little data means Pi decides', () => {
  assert.equal(thresholdFor(bands({ 0: [5, 60], 50000: [6, 100], 100000: [14, 100], 150000: [21, 100] })), 100000);
  assert.equal(thresholdFor(bands({ 0: [5, 60], 50000: [6, 100], 100000: [7, 100], 150000: [6, 100], 200000: [19, 100], 250000: [30, 60] })), 200000);
  assert.equal(thresholdFor(bands({ 0: [5, 100], 50000: [5, 100], 100000: [9, 100], 150000: [5, 100] })), undefined, 'one high band that does not stay up is noise');
  assert.equal(thresholdFor(bands({ 0: [1, 10], 50000: [2, 30], 100000: [6, 43], 150000: [6, 28] })), undefined, 'too few edits to judge');
  assert.equal(thresholdFor(undefined), undefined);
});

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const edit = (i: number, context: number, failed: boolean) =>
  line({ type: 'message', id: `a${i}`, message: { role: 'assistant', provider: 'p', model: 'm', usage: { input: 10, cacheRead: context - 10 }, content: [{ type: 'toolCall', id: `c${i}`, name: 'edit', arguments: {} }] } })
  + line({ type: 'message', id: `r${i}`, message: { role: 'toolResult', toolCallId: `c${i}`, toolName: 'edit', isError: failed, content: [{ type: 'text', text: failed ? 'Could not find the exact text' : 'ok' }] } });

test('journals are scanned incrementally into counts per model and band', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sc-calib-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'sessions', 'cwd'), { recursive: true });
  const journal = join(root, 'sessions', 'cwd', 's.jsonl');
  await writeFile(journal, Array.from({ length: 70 }, (_, i) => edit(i, 30_000, i % 20 === 0)).join(''));
  const first = await updateCalibration(root);
  assert.deepEqual(first.models['p/m']!['0'], { edits: 70, failed: 4 });
  await appendFile(journal, Array.from({ length: 50 }, (_, i) => edit(100 + i, 120_000, i % 4 === 0)).join(''));
  const second = await updateCalibration(root);
  assert.deepEqual(second.models['p/m']!['0'], { edits: 70, failed: 4 }, 'old lines are not counted twice');
  assert.deepEqual(second.models['p/m']!['100000'], { edits: 50, failed: 13 });
  assert.equal(JSON.parse(await readFile(calibrationPath(root), 'utf8')).v, 1);
});

test('past the calibrated threshold, a turn boundary proposes the project state as the compaction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-sc-propose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'self-compact'), { recursive: true });
  await writeFile(calibrationPath(root), JSON.stringify({ v: 1, files: {}, models: { 'test/m': bands({ 0: [5, 100], 50000: [6, 100], 100000: [20, 100], 150000: [25, 100] }) } }));
  const handlers = new Map<string, any[]>();
  const pad = 'x'.repeat(4000);
  const entries: any[] = [
    { type: 'message', id: 'u1', timestamp: '2026-10-14T10:00:00.000Z', message: { role: 'user', content: 'Nunca borres datos de producción.', timestamp: 1 } },
    ...Array.from({ length: 40 }, (_, i) => ({ type: 'message', id: `a${i}`, timestamp: '2026-10-14T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: `${pad}${i}` }], timestamp: 2 + i, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } })),
  ];
  const pi = {
    on(name: string, handler: any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    getSettings: () => ({ compaction: { reserveTokens: 72_000, keepRecentTokens: 5_000 } }),
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', id: `c${entries.length}`, customType, data }); },
  } as unknown as ExtensionAPI;
  installSelfCompact(pi, { agentDir: root, calibrationDelayMs: 0 });
  const notices: string[] = [];
  const ctx: any = { cwd: root, hasUI: true, ui: { notify: (m: string) => notices.push(m) }, model: { provider: 'test', id: 'm', contextWindow: 272_000, maxTokens: 16_384 },
    getContextUsage: () => ({ tokens: tokens.value }), sessionManager: { getBranch: () => entries, getSessionId: () => 's' },
    modelRegistry: { streamSimple: () => ({ result: async () => ({ role: 'assistant', stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      content: [{ type: 'text', text: '[{"op":"add","kind":"rule","text":"no prod deletes","source":"u1"}]' }] }) }) } };
  const tokens = { value: 90_000 };
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  await new Promise(resolve => setTimeout(resolve, 50));
  const boundary = async () => { const out = []; for (const handler of handlers.get('turn_end') ?? []) out.push(await handler({ entries: [] }, ctx)); return out[0]; };
  assert.equal(await boundary(), undefined, 'below the calibrated threshold nothing happens');
  tokens.value = 120_000;
  // The calibration loads in the background; give it a moment.
  const proposed = await (async () => { for (let i = 0; i < 80; i++) { const out = await boundary(); if (out) return out; await new Promise(r => setTimeout(r, 25)); } return undefined; })();
  assert.ok(proposed, `proposal: ${notices.join(" | ")}`);
  assert.equal(proposed.entries.length, 1);
  const draft = proposed.entries[0];
  assert.equal(draft.type, 'compaction');
  assert.equal(draft.details.selfCompact.trigger, 'calibrated');
  assert.equal(draft.details.selfCompact.threshold, 100000);
  assert.match(draft.summary, /"Nunca borres datos de producción\."/u);
  assert.ok(entries.findIndex(entry => entry.id === draft.firstKeptEntryId) > 0, 'a real cut, recent entries kept');
  assert.ok(entries.some(entry => entry.customType === STATE_ENTRY));
  assert.match(draft.summary, /### Current request \(user message u1, verbatim/u, 'the request being worked on survives a cut in the middle of the task');

  // A kept tail that is most of the context would trigger again at once: no proposal.
  entries.push({ type: 'message', id: 'big', timestamp: '2026-10-14T10:02:00.000Z', message: { role: 'toolResult', toolCallId: 'x', toolName: 'read', content: [{ type: 'text', text: 'y'.repeat(260_000) }], isError: false, timestamp: 99 } });
  tokens.value = 110_000;
  assert.equal(await boundary(), undefined);
});
