import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installSelfCompact } from '../src/index.ts';
import { SUMMARY_PROMPT } from '../src/prompts.ts';
import { cachedSummaryBlocker, extendPayload } from '../src/summary.ts';

type Handler = (event: any, ctx: any) => Promise<any>;

/** A fake Pi host: journaled entries, a usage gauge the test moves, and every registration recorded. */
const host = (cwd: string) => {
  const handlers = new Map<string, Handler[]>();
  const registered: string[] = [];
  const entries: any[] = [];
  const notices: string[] = [];
  const gauge = { tokens: 0 };
  const record = (kind: string) => () => { registered.push(kind); };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool: record('tool'), registerFlag: record('flag'), registerCommand: record('command'),
    registerMessageRenderer: record('renderer'), registerEntryRenderer: record('renderer'),
    appendEntry: record('entry'), sendMessage: record('message'), sendUserMessage: record('message'),
  } as unknown as ExtensionAPI;
  entries.push({ type: 'message', id: 'u1', parentId: null, timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'x'.repeat(200_000), timestamp: 1 } });
  entries.push({ type: 'message', id: 'a1', parentId: 'u1', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 2, stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } } });
  entries.push({ type: 'message', id: 'u2', parentId: 'a1', timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'y'.repeat(200_000), timestamp: 3 } });
  const ctx: any = {
    cwd, mode: 'rpc', hasUI: true,
    model: { provider: 'test', id: 'm', contextWindow: 272_000, maxTokens: 16_384 },
    getContextUsage: () => ({ tokens: gauge.tokens, contextWindow: 272_000, percent: gauge.tokens / 272_000 * 100 }),
    sessionManager: { getBranch: () => entries, getSessionId: () => 'sc-session' },
    ui: { notify(message: string) { notices.push(message); } },
  };
  const emit = async (name: string, event: any = {}): Promise<any[]> => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { pi, ctx, emit, handlers, registered, entries, notices, gauge };
};

const preparation = () => ({ firstKeptEntryId: 'u2', tokensBefore: 155_000, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
  fileOps: { read: new Set(['a.ts', 'b.ts']), written: new Set<string>(), edited: new Set(['b.ts']) } });

/** Captures one session request and the reply after it, as Pi would journal them. */
const captureRequest = async (h: ReturnType<typeof host>) => {
  const system = { role: 'system', content: 'PROMPT', timestamp: 0 };
  const sent = [system, ...h.entries.filter(entry => entry.type === 'message').map(entry => entry.message)];
  await h.emit('context_with_system', { messages: sent });
  const answer = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }], timestamp: 4 };
  const toolResult = { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], timestamp: 5 };
  for (const message of [answer, toolResult]) {
    await h.emit('message_end', { message });
    h.entries.push({ type: 'message', id: `m${message.timestamp}`, parentId: null, timestamp: new Date().toISOString(), message });
  }
  return { sent, answer, toolResult };
};

test('adds nothing the model sees: no tool, no flag, no command, no context or tool_call hook, no messages', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-sc-surface-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  assert.equal(installSelfCompact(h.pi), true);
  assert.deepEqual(h.registered, []);
  for (const name of ['context', 'tool_call', 'before_agent_start', 'turn_end', 'agent_end', 'agent_settled']) {
    assert.equal(h.handlers.has(name), false, `${name} is not hooked`);
  }
  await h.emit('session_start', { reason: 'startup' });
  h.gauge.tokens = 260_000;
  await captureRequest(h);
  assert.deepEqual(h.registered, [], 'a full context still adds no message or entry');
});

test('an automatic compaction gets the summary that extends the cached session request', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-sc-cached-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  const requests: { context: any; options: any }[] = [];
  h.ctx.modelRegistry = {
    streamSimple(_model: unknown, context: unknown, options: unknown) {
      requests.push({ context, options });
      return { result: async () => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'SUMMARY' }],
        usage: { input: 900, output: 300, cacheRead: 150_000, cacheWrite: 0, totalTokens: 151_200 } }) };
    },
  };
  h.gauge.tokens = 232_000;
  const { sent, answer, toolResult } = await captureRequest(h);
  const [result] = await h.emit('session_before_compact', { reason: 'threshold', preparation: preparation(), signal: new AbortController().signal });
  assert.equal(requests.length, 1, 'one request, no replay');
  const { context, options } = requests[0]!;
  assert.deepEqual(context.messages.slice(0, -1), [...sent, answer, toolResult], 'the sent transcript is the unchanged prefix');
  assert.equal(context.messages.at(-1).role, 'user');
  assert.match(context.messages.at(-1).content[0].text, /context-compaction summarizer/);
  assert.equal(context.systemPrompt, undefined, 'the system prompt stays the session one');
  assert.equal(options.sessionId, 'sc-session', 'routed to the session cache');
  assert.equal(result.compaction.summary, 'SUMMARY\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>');
  assert.equal(result.compaction.firstKeptEntryId, 'u2');
  assert.equal(result.compaction.details.selfCompact.summary, 'cache-shared');
  assert.equal(result.compaction.details.selfCompact.cacheRead, 150_000);
});

test('Pi writes its own summary on overflow, without a snapshot, and when the cached request fails', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-sc-fallback-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  const signal = new AbortController().signal;
  h.gauge.tokens = 232_000;
  assert.deepEqual(await h.emit('session_before_compact', { reason: 'threshold', preparation: preparation(), signal }), [undefined], 'no snapshot yet');
  await captureRequest(h);
  assert.deepEqual(await h.emit('session_before_compact', { reason: 'overflow', preparation: preparation(), signal }), [undefined]);
  h.ctx.modelRegistry = { streamSimple: () => ({ result: async () => { throw new Error('provider down'); } }) };
  assert.deepEqual(await h.emit('session_before_compact', { reason: 'threshold', preparation: preparation(), signal }), [undefined]);
  assert.match(h.notices.join('\n'), /Pi writes its own \(provider down\)/);
  await h.emit('session_compact', {});
  assert.deepEqual(await h.emit('session_before_compact', { reason: 'manual', preparation: preparation(), signal }), [undefined], 'a compaction drops the snapshot');
});

test('the summary prompt asks for plain sentences and never mentions a note', () => {
  assert.doesNotMatch(SUMMARY_PROMPT, /note/i);
  assert.match(SUMMARY_PROMPT, /plain, complete sentences/);
});

test('explicit opt-out installs nothing', () => {
  const h = host(tmpdir());
  assert.equal(installSelfCompact(h.pi, { enabled: false }), false);
  assert.equal(h.handlers.size, 0);
});

test('the summary body is the session body with only the new input items appended', () => {
  const session = { model: 'm', tools: [{ name: 'grep', parameters: { properties: {} } }], service_tier: 'priority', input: [{ n: 1 }, { n: 2 }] };
  const rebuilt = { model: 'm', tools: [{ name: 'grep', strict: null }], input: [{ n: 1 }, { n: 2 }, { n: 3 }, { task: true }] };
  assert.deepEqual(extendPayload(session, rebuilt), { ...session, input: [{ n: 1 }, { n: 2 }, { n: 3 }, { task: true }] });
  assert.equal(extendPayload(session, { input: [{ n: 9 }] }), undefined, 'no anchor: the rebuilt body goes out unchanged');
  assert.equal(extendPayload(undefined, rebuilt), undefined);
  assert.equal(extendPayload({ messages: [] }, rebuilt), undefined, 'non-Responses payloads are left alone');
});

test('the cache-shared summary is skipped when its snapshot cannot be trusted', () => {
  const entries = [{ type: 'message', message: { role: 'user', timestamp: 7 } }];
  const ctx: any = { model: { provider: 'test', id: 'm', contextWindow: 272_000 }, sessionManager: { getBranch: () => entries } };
  const snapshot = { model: 'test/m', messages: [{ role: 'system' }, { role: 'user', timestamp: 7 }], tail: [] };
  const threshold: any = { reason: 'threshold' };
  assert.equal(cachedSummaryBlocker(threshold, ctx, snapshot, 150_000), undefined);
  assert.match(cachedSummaryBlocker(threshold, ctx, undefined, 150_000)!, /no session request/);
  assert.match(cachedSummaryBlocker(threshold, ctx, { ...snapshot, model: 'test/other' }, 150_000)!, /model changed/);
  assert.match(cachedSummaryBlocker({ reason: 'overflow' } as any, ctx, snapshot, 150_000)!, /overflow/);
  assert.match(cachedSummaryBlocker(threshold, ctx, snapshot, 265_000)!, /no room/);
  assert.match(cachedSummaryBlocker(threshold, ctx, { ...snapshot, messages: snapshot.messages.slice(0, 1) }, 150_000)!, /moved past/);
});
