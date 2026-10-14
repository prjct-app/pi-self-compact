import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const privacyEnvironment = { previous: process.env.PRJCT_HOME, root: '' };
before(async () => { privacyEnvironment.root = await mkdtemp(join(tmpdir(), 'pi-sc-ledger-')); process.env.PRJCT_HOME = privacyEnvironment.root; });
after(async () => { if (privacyEnvironment.previous === undefined) delete process.env.PRJCT_HOME; else process.env.PRJCT_HOME = privacyEnvironment.previous; await rm(privacyEnvironment.root, { recursive: true, force: true }); });
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installSelfCompact } from '../src/index.ts';
import { applySelection, collectLedger, droppedBefore, LEDGER_HEADER, selectionInstructions, stripLedger, withLedger } from '../src/ledger.ts';

const user = (id: string, content: unknown, at = '2026-10-14T09:30:00.000Z') =>
  ({ type: 'message', id, timestamp: at, message: { role: 'user', content, timestamp: Date.parse(at) } });
const assistant = (id: string, text: string) =>
  ({ type: 'message', id, timestamp: '2026-10-14T09:31:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('collects every user message before the first kept entry, text only, long ones truncated with their entry', () => {
  const branch = [
    user('u1', 'No sustituyas pantallas por vistas simplificadas.'),
    assistant('a1', 'ok'),
    user('u2', [{ type: 'text', text: 'log:' }, { type: 'image', data: 'x' }, { type: 'text', text: 'e'.repeat(3_000) }]),
    { type: 'custom_message', id: 'c1', timestamp: '2026-10-14T09:32:00.000Z', content: 'team message' },
    user('u3', 'kept verbatim in the context'),
    user('u3b', '<skill name="agent-tickets">long skill text</skill>'),
  ];
  const items = collectLedger(branch, 'u3');
  assert.deepEqual(items.map(item => item.entryId), ['u1', 'u2'], 'kept messages and non-user entries are excluded');
  assert.equal(items[0]!.text, 'No sustituyas pantallas por vistas simplificadas.');
  assert.equal(items[1]!.text.length, 2_000);
  assert.ok(items[1]!.text.startsWith('log:\n[image]\neee'));
  assert.equal(items[1]!.truncatedChars, 3_013 - 2_000);
  assert.deepEqual(collectLedger(branch, 'missing').map(item => item.entryId), ['u1', 'u2', 'u3'], 'an unknown cut carries everything');
});

test('three compactions in a row: the ledger is rebuilt from the branch, never duplicated or paraphrased', () => {
  const branch: any[] = [user('u1', 'Regla del día 1: no desplegar sin autorización.'), assistant('a1', 'ok'), user('u2', 'segundo pedido')];
  const first = withLedger('SUMMARY 1', collectLedger(branch, 'u2'));
  branch.push({ type: 'compaction', id: 'k1', summary: first, firstKeptEntryId: 'u2' }, assistant('a2', 'ok'), user('u3', 'tercer pedido'));
  // The summarizer copied the carried section into its own text; it must not survive twice.
  const second = withLedger(`SUMMARY 2\n\n${first}`, collectLedger(branch, 'u3'));
  branch.push({ type: 'compaction', id: 'k2', summary: second, firstKeptEntryId: 'u3' }, assistant('a3', 'ok'), user('u4', 'cuarto'));
  const third = withLedger('SUMMARY 3\n\n<read-files>\na.ts\n</read-files>', collectLedger(branch, 'u4'));
  assert.equal(third.split(LEDGER_HEADER).length, 2, 'exactly one ledger');
  assert.match(third, /u1\] Regla del día 1: no desplegar sin autorización\.\n.*u2\] segundo pedido\n.*u3\] tercer pedido\n\n<read-files>/u);
  assert.doesNotMatch(third, /cuarto/, 'the kept message is not repeated');
  assert.equal(second.split(LEDGER_HEADER).length, 2);
});

test('stripping and re-adding the ledger keeps the prose and the file lists', () => {
  const items = collectLedger([user('u1', 'hola')], 'none');
  const summary = withLedger('PROSE\n\n<read-files>\na.ts\n</read-files>', items);
  assert.equal(stripLedger(summary), 'PROSE\n\n<read-files>\na.ts\n</read-files>');
  assert.equal(withLedger(summary, items), summary, 'idempotent');
  assert.equal(withLedger('PROSE', []), 'PROSE', 'nothing to carry, nothing added');
});

/** A minimal host whose cache-shared path is blocked, so Pi's summarizer runs. */
const host = (registry: unknown) => {
  const handlers = new Map<string, ((event: any, ctx: any) => Promise<any>)[]>();
  const pi = {
    on(name: string, handler: any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    getSettings: () => ({}),
  } as unknown as ExtensionAPI;
  const entries = [user('u1', 'No toques producción. AKIAIOSFODNN7EXAMPLE'), assistant('a1', 'ok'), user('u2', 'sigue')];
  const ctx: any = {
    cwd: tmpdir(), hasUI: false, model: { provider: 'test', id: 'm', contextWindow: 272_000, maxTokens: 16_384 },
    getContextUsage: () => ({ tokens: 260_000 }), modelRegistry: registry,
    sessionManager: { getBranch: () => entries, getSessionId: () => 'sc-session' },
  };
  installSelfCompact(pi);
  const preparation = {
    firstKeptEntryId: 'u2', tokensBefore: 260_000, isSplitTurn: false, turnPrefixMessages: [],
    messagesToSummarize: entries.slice(0, 2).map(entry => entry.message),
    previousSummary: withLedger('OLD SUMMARY', collectLedger(entries, 'u2')),
    settings: { enabled: true, reserveTokens: 40_000, keepRecentTokens: 60_000 },
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
  };
  const compact = async (reason: string) => {
    const results = [];
    for (const handler of handlers.get('session_before_compact') ?? []) {
      results.push(await handler({ reason, preparation, signal: new AbortController().signal }, ctx));
    }
    return results;
  };
  return { compact };
};

test('overflow and other blocked cases still carry the ledger, through Pi\'s summarizer with outbound data guarded', async () => {
  const sent: string[] = [];
  const registry = {
    streamSimple(_model: unknown, context: any) {
      sent.push(JSON.stringify(context));
      return { result: async () => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'NATIVE SUMMARY\n<keep-user-messages>u1</keep-user-messages>' }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } }) };
    },
  };
  const [result] = await host(registry).compact('overflow');
  const summarySent = sent.filter(text => /OLD SUMMARY/.test(text));
  assert.equal(summarySent.length, 1, 'the state update answered no edits, so Pi\'s summarizer runs once');
  assert.equal(summarySent[0]!.includes(LEDGER_HEADER), false, 'the previous ledger is not handed to the summarizer');
  assert.equal(sent.some(text => text.includes('AKIAIOSFODNN7EXAMPLE')), false, 'pi-secrets guards every request');
  sent.splice(0, sent.length, ...summarySent);
  assert.match(result.compaction.summary, /^NATIVE SUMMARY\n\n## User messages, verbatim/u);
  assert.match(result.compaction.summary, /u1\] No toques producción/u);
  assert.equal(result.compaction.details.selfCompact.summary, 'native');
  assert.equal(result.compaction.details.selfCompact.ledger.selected, 'model');
  assert.doesNotMatch(result.compaction.summary, /keep-user-messages/u);
  assert.match(sent[0]!, /keep-user-messages/u, 'Pi\'s summarizer is asked to choose too');
  assert.equal(result.compaction.firstKeptEntryId, 'u2');
});

test('when Pi\'s summarizer fails too, Pi keeps its own compaction path', async () => {
  const failing = { streamSimple: () => ({ result: async () => { throw new Error('down'); } }) };
  assert.deepEqual(await host(failing).compact('overflow'), [undefined]);
  assert.deepEqual(await host(undefined).compact('overflow'), [undefined]);
});

test('the summarizer chooses which messages still apply; the host copies them, and dropped ones are not offered again', () => {
  const branch: any[] = [user('u1', 'Regla: nunca despliegues sin autorización.'), user('u2', 'continua'), user('u3', 'arregla el login'), user('u4', 'kept')];
  const candidates = collectLedger(branch, 'u4');
  assert.match(selectionInstructions(candidates), /- u2: continua\n/u);
  const first = applySelection('SUMMARY\n<keep-user-messages>u1 u3 bogus</keep-user-messages>', candidates, new Set());
  assert.equal(first.summary, 'SUMMARY', 'the keep line never reaches the summary');
  assert.deepEqual(first.items.map(item => item.entryId), ['u1', 'u3'], 'unknown ids are ignored');
  assert.deepEqual(first.dropped, ['u2']);
  assert.equal(first.items[0]!.text, 'Regla: nunca despliegues sin autorización.', 'kept words are the user\'s, not the model\'s');
  branch.push({ type: 'compaction', id: 'k1', details: { selfCompact: { ledger: { dropped: first.dropped } } } }, user('u5', 'el login ya quedó'), user('u6', 'kept'));
  const dropped = droppedBefore(branch);
  const next = collectLedger(branch, 'u6', dropped);
  assert.deepEqual(next.map(item => item.entryId), ['u1', 'u3', 'u4', 'u5'], 'a dropped message is not offered again');
  const second = applySelection('S2 <keep-user-messages>u1</keep-user-messages>', next, dropped);
  assert.deepEqual(second.dropped.sort(), ['u2', 'u3', 'u4', 'u5']);
  const none = applySelection('S3', next, dropped);
  assert.equal(none.selected, 'all', 'no keep line: nothing is lost');
  assert.equal(none.items.length, 4);
  assert.equal(applySelection('S4 <keep-user-messages></keep-user-messages>', next, dropped).items.length, 0, 'an explicit empty choice is respected');
});
