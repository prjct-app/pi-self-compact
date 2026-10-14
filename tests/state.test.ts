import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const privacyEnvironment = { previous: process.env.PRJCT_HOME, root: '' };
before(async () => { privacyEnvironment.root = await mkdtemp(join(tmpdir(), 'pi-sc-state-')); process.env.PRJCT_HOME = privacyEnvironment.root; });
after(async () => { if (privacyEnvironment.previous === undefined) delete process.env.PRJCT_HOME; else process.env.PRJCT_HOME = privacyEnvironment.previous; await rm(privacyEnvironment.root, { recursive: true, force: true }); });
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installSelfCompact } from '../src/index.ts';
import { applyOps, currentRequest, EMPTY_STATE, parseOps, renderState, restoreState, STATE_ENTRY, STATE_HEADER, unfolded, userMessages } from '../src/state.ts';

const user = (id: string, text: string, ts = '2026-10-14T10:00:00.000Z') => ({ type: 'message', id, timestamp: ts, message: { role: 'user', content: text, timestamp: Date.parse(ts) } });
const assistant = (id: string, text: string) => ({ type: 'message', id, timestamp: '2026-10-14T10:01:00.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 2, stopReason: 'stop', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });

test('edits add, update and resolve items; rules quote the user, and a review never touches rules', () => {
  const users = new Map([['u1', 'Nunca sustituyas pantallas por vistas simplificadas.'], ['u2', '<skill name="x">skill text</skill>']]);
  const added = applyOps(EMPTY_STATE, parseOps(`Here: [
    {"op":"add","kind":"rule","text":"no simplified screens","source":"u1"},
    {"op":"add","kind":"rule","text":"follow the tickets skill","source":"u2"},
    {"op":"add","kind":"open","text":"Migrate the widget detail page."},
    {"op":"add","kind":"fact","text":"PR #271 adds the admin adapter."},
    {"op":"add","kind":"bogus","text":"ignored"},
    {"op":"resolve","id":"s999","reason":"unknown ids are ignored"}]`), '2026-10-14T10:00:00.000Z', users);
  assert.deepEqual(added.items.map(item => [item.id, item.kind]), [['s1', 'rule'], ['s2', 'rule'], ['s3', 'open'], ['s4', 'fact']]);
  const rendered = renderState(added, users);
  assert.match(rendered, new RegExp(`^${STATE_HEADER.replace(/[()]/g, '\\$&')}`));
  assert.match(rendered, /user message u1\] "Nunca sustituyas pantallas por vistas simplificadas\." \(no simplified screens\)/u, 'the user\'s exact words');
  assert.match(rendered, /\[s2 · 2026-10-14\] follow the tickets skill/u, 'an expanded skill is never quoted');
  const done = applyOps(added, [{ op: 'resolve', id: 's3', reason: 'merged in #266' }, { op: 'update', id: 's4', text: 'PR #271 (merged) adds the admin adapter.' }], 'x', users);
  assert.doesNotMatch(renderState(done, users), /Migrate the widget/u, 'resolved items leave the rendering');
  assert.match(renderState(done, users), /\(merged\)/u);
  assert.equal(done.items.length, 4, 'resolved items are kept, only hidden');
  const reviewed = applyOps(done, [{ op: 'resolve', id: 's1', reason: 'old' }, { op: 'update', id: 's2', text: 'reworded' }, { op: 'add', kind: 'fact', text: 'reviews add nothing' }], 'x', users, true);
  assert.deepEqual(reviewed, done, 'a review cannot resolve, reword or add');
  assert.throws(() => parseOps('no edits here'), /No JSON array/u);
});

test('the state is restored from the branch and only the unfolded part is offered', () => {
  const state = { v: 1 as const, items: [], next: 3, through: 'a1' };
  const branch: any[] = [user('u1', 'hola'), assistant('a1', 'hola'), { type: 'custom', id: 'c1', customType: STATE_ENTRY, data: state }, user('u2', 'sigue'), assistant('a2', 'ok')];
  assert.deepEqual(restoreState(branch), state);
  assert.deepEqual(unfolded(branch, state).map(entry => entry.id), ['c1', 'u2', 'a2']);
  assert.deepEqual(restoreState([user('u1', 'x')]), EMPTY_STATE);
  assert.deepEqual([...userMessages(branch).keys()], ['u1', 'u2']);
});

/** A fake host whose model answers state edits for state requests and a summary otherwise. */
const host = (answer: (task: string) => string) => {
  const handlers = new Map<string, ((event: any, ctx: any) => Promise<any>)[]>();
  const entries: any[] = [user('u1', 'Regla: nunca despliegues sin mi autorización.'), assistant('a1', 'Entendido.')];
  const requests: string[] = [];
  const pi = {
    on(name: string, handler: any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    getSettings: () => ({}),
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', id: `c${entries.length}`, customType, data }); },
  } as unknown as ExtensionAPI;
  const ctx: any = {
    cwd: tmpdir(), hasUI: false, model: { provider: 'test', id: 'm', contextWindow: 272_000, maxTokens: 16_384 },
    getContextUsage: () => ({ tokens: 100_000 }),
    sessionManager: { getBranch: () => entries, getSessionId: () => 's' },
    modelRegistry: { streamSimple(_m: unknown, context: any) {
      const task = JSON.stringify(context.messages.at(-1));
      requests.push(task);
      return { result: async () => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: answer(task) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } }) };
    } },
  };
  installSelfCompact(pi);
  const emit = async (name: string, event: any = {}) => { const out = []; for (const handler of handlers.get(name) ?? []) out.push(await handler(event, ctx)); return out; };
  return { entries, requests, emit, ctx };
};
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('after a run the state takes in the user\'s rule; a compaction renders the state instead of a summary', async () => {
  const h = host(task => /project state/.test(task) ? '[{"op":"add","kind":"rule","text":"no deploy without approval","source":"u1"}]' : 'SUMMARY');
  await h.emit('agent_end', {});
  await settle();
  const saved = h.entries.filter(entry => entry.customType === STATE_ENTRY);
  assert.equal(saved.length, 1, 'the state is saved as a custom entry, never sent to the model');
  assert.equal(saved[0].data.through, 'a1');
  h.entries.push(user('u2', 'ahora el widget'), assistant('a2', 'Hecho.'));
  const preparation = { firstKeptEntryId: 'u2', tokensBefore: 200_000, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
    settings: { enabled: true, reserveTokens: 72_000, keepRecentTokens: 60_000 }, fileOps: { read: new Set(['a.ts']), written: new Set<string>(), edited: new Set<string>() } };
  const [result] = await h.emit('session_before_compact', { reason: 'threshold', preparation, signal: new AbortController().signal });
  assert.equal(result.compaction.details.selfCompact.summary, 'state');
  assert.match(result.compaction.summary, /"Regla: nunca despliegues sin mi autorización\."/u);
  assert.match(result.compaction.summary, /<read-files>\na\.ts\n<\/read-files>/u);
  assert.equal(h.requests.some(task => /context-compaction summarizer/.test(task)), false, 'no summary request at all');
  assert.equal(h.entries.filter(entry => entry.customType === STATE_ENTRY).at(-1).data.through, 'a2', 'the compaction folded what came after the last update');
});

test('a run woken by a small message waits; a user turn is folded', async () => {
  const h = host(() => '[]');
  h.entries.push({ type: 'custom', id: 'c-state', customType: STATE_ENTRY, data: { v: 1, items: [], next: 1, through: 'a1' } },
    { type: 'custom_message', id: 't1', customType: 'team-message', content: 'lead: ok' }, assistant('a3', 'noted'));
  await h.emit('agent_end', {});
  await settle();
  assert.equal(h.requests.length, 0, 'a small team wake does not pay a request');
  h.entries.push(user('u3', 'revisa el login'), assistant('a4', 'revisado'));
  await h.emit('agent_end', {});
  await settle();
  assert.equal(h.requests.length, 1);
});

test('when the state cannot be updated, the summary path still compacts', async () => {
  const h = host(task => /project state/.test(task) ? 'not json' : 'SUMMARY TEXT');
  const preparation = { firstKeptEntryId: 'a1', tokensBefore: 200_000, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
    settings: { enabled: true, reserveTokens: 72_000, keepRecentTokens: 60_000 }, fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() } };
  const [result] = await h.emit('session_before_compact', { reason: 'overflow', preparation, signal: new AbortController().signal });
  assert.equal(result.compaction.details.selfCompact.summary, 'native');
  assert.match(result.compaction.summary, /^SUMMARY TEXT/u);
});

test('the current request is carried only when the cut leaves it out', () => {
  const branch: any[] = [user('u1', 'cuenta las líneas de big.txt'), assistant('a1', 'leyendo'), assistant('a2', 'sigo')];
  const users = userMessages(branch);
  assert.match(currentRequest(branch, 'a2', users), /^### Current request \(user message u1, verbatim[^\n]*\ncuenta las líneas de big\.txt$/u);
  assert.equal(currentRequest(branch, 'u1', users), '', 'already in the kept history');
  assert.equal(currentRequest([assistant('a1', 'x')], 'a1', new Map()), '');
});
