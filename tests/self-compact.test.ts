import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installSelfCompact } from '../src/index.ts';
import { BUILTIN_PROMPTS, loadPrompt, renderTemplate } from '../src/prompts.ts';
import { HANDOFF_TYPE, recoverState, STATE_TYPE, type EntryLike } from '../src/state.ts';
import { cachedSummaryBlocker, extendPayload, replaceInstructions, summaryInputs } from '../src/summary.ts';
import { levelFor, loadThresholdFile, parseSpec, resolveThresholds, DEFAULT_SPECS } from '../src/thresholds.ts';
import { momentLine, momentState, verdictOf } from '../src/moment.ts';

// keepRecentTokens reads Pi settings; never let the developer's own settings leak in.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-memory-sc-agent-'));
// Nor the developer's TypeSafe key: Jev is absent unless a test injects one.
process.env.PI_SELF_COMPACT_OFFLINE = '1';

test('threshold specs accept tokens, k/m suffixes and percentages', () => {
  assert.deepEqual(parseSpec('270000', 'x'), { kind: 'tokens', value: 270_000, raw: '270000' });
  assert.deepEqual(parseSpec('1.5m', 'x'), { kind: 'tokens', value: 1_500_000, raw: '1.5m' });
  assert.deepEqual(parseSpec('20%', 'x'), { kind: 'percent', value: 20, raw: '20%' });
  assert.throws(() => parseSpec('12.5', 'x'), /whole token count/);
  assert.throws(() => parseSpec('101%', 'x'), /above 100%/);
  assert.throws(() => parseSpec('lots', 'x'), /Invalid x/);
});

test('default lines are absolute on large windows and clamp on small ones', () => {
  const large = resolveThresholds(DEFAULT_SPECS, 272_000, true);
  assert.ok(large.ok);
  assert.deepEqual([large.thresholds.softTokens, large.thresholds.warnTokens, large.thresholds.forcedTokens], [100_000, 150_000, 180_000]);
  assert.equal(large.thresholds.clamped, false);
  const small = resolveThresholds(DEFAULT_SPECS, 128_000, true);
  assert.ok(small.ok);
  assert.deepEqual([small.thresholds.softTokens, small.thresholds.warnTokens, small.thresholds.forcedTokens], [64_000, 83_200, 102_400]);
  assert.equal(small.thresholds.clamped, true);
  assert.equal(levelFor(null, small.thresholds), 'unknown');
  assert.equal(levelFor(1, small.thresholds), 'idle');
  assert.equal(levelFor(64_000, small.thresholds), 'notice');
  assert.equal(levelFor(90_000, small.thresholds), 'warning');
  assert.equal(levelFor(102_400, small.thresholds), 'forced');
});

test('explicit lines are validated and the cutoff is capped at 90% of the window', () => {
  const explicit = resolveThresholds({ softAt: '10%', at: '20%', buffer: '80%' }, 100_000, false);
  assert.ok(explicit.ok);
  assert.equal(explicit.thresholds.forcedTokens, 90_000);
  const reversed = resolveThresholds({ softAt: '50k', at: '40k', buffer: '0' }, 200_000, false);
  assert.equal(reversed.ok, false);
  const tooHigh = resolveThresholds({ softAt: '10%', at: '95%', buffer: '0' }, 200_000, false);
  assert.equal(tooHigh.ok, false);
  const noWindow = resolveThresholds(DEFAULT_SPECS, 0, true);
  assert.equal(noWindow.ok, false);
});

test('thresholds.json sets persistent lines, project before global, and rejects bad files', async t => {
  const project = await mkdtemp(join(tmpdir(), 'pi-memory-sc-th-project-'));
  const global = await mkdtemp(join(tmpdir(), 'pi-memory-sc-th-global-'));
  t.after(() => Promise.all([project, global].map(dir => rm(dir, { recursive: true, force: true }))));
  assert.equal(loadThresholdFile([project, global]), undefined);
  await writeFile(join(global, 'thresholds.json'), '{ "softAt": "90k", "at": 110000 }');
  assert.deepEqual(loadThresholdFile([project, global]), { path: join(global, 'thresholds.json'), specs: { softAt: '90k', at: '110000' } });
  await writeFile(join(project, 'thresholds.json'), '{ "at": "40%" }');
  assert.deepEqual(loadThresholdFile([project, global])?.specs, { at: '40%' });
  await writeFile(join(project, 'thresholds.json'), '{ "warn": "1k" }');
  assert.throws(() => loadThresholdFile([project, global]), /unknown keys warn/);
  await writeFile(join(project, 'thresholds.json'), '{ nope');
  assert.throws(() => loadThresholdFile([project, global]), /thresholds\.json/);
});

test('prompt overrides are read fresh, placeholders render, and empty overrides are errors', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-memory-sc-prompts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(loadPrompt('soft', [dir]).source, 'built-in');
  await writeFile(join(dir, 'WARNING.md'), 'warn at {{used_tokens}} / {{unknown}}\n');
  const warning = loadPrompt('warning', [dir]);
  assert.equal(renderTemplate(warning.text, { used_tokens: '1,000' }), 'warn at 1,000 / {{unknown}}');
  await writeFile(join(dir, 'SUMMARY.md'), '   \n');
  assert.throws(() => loadPrompt('summary', [dir]), /empty/);
  assert.match(BUILTIN_PROMPTS.forced, /\{\{forced_tokens\}\}/);
});

test('recovery keeps the latest snapshot and resolves each handoff phase from the branch', () => {
  const snapshot = (status: string): EntryLike => ({ type: 'custom', customType: STATE_TYPE,
    data: { version: 1, cycle: 1, locked: true, handoff: { id: 'h1', note: 'NOTE', status, attempts: 0, savedAt: 1 } } });
  const returned: EntryLike = { type: 'custom_message', customType: HANDOFF_TYPE, details: { id: 'h1' } };
  const answer: EntryLike = { type: 'message', message: { role: 'assistant' } };
  assert.deepEqual(recoverState([]).state, { version: 1, cycle: 0, locked: false });
  assert.equal(recoverState([snapshot('pending')]).state.handoff?.status, 'pending');
  assert.equal(recoverState([snapshot('compacting'), { type: 'compaction', details: { handoffId: 'h1' } }]).state.handoff?.status, 'ready');
  const unanswered = recoverState([snapshot('ready'), returned]);
  assert.equal(unanswered.unanswered, true);
  const answered = recoverState([snapshot('ready'), returned, answer]);
  assert.equal(answered.answered, true);
  assert.equal(answered.unanswered, false);
});

type Handler = (event: any, ctx: any) => Promise<any>;

/** A fake Pi host: journaled entries, a usage gauge the test moves, and recorded side effects. */
const host = (cwd: string) => {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const sent: { message: any; options: any }[] = [];
  const compactions: unknown[] = [];
  const statuses: (string | undefined)[] = [];
  const gauge = { tokens: 0, idle: true };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool(definition: any) { tools.set(definition.name, definition); },
    registerFlag() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, registerCommand() {},
    getFlag: () => undefined,
    appendEntry(customType: string, data: unknown) { entries.push({ type: 'custom', customType, data }); },
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
    sendUserMessage(text: string) { sent.push({ message: { content: text }, options: {} }); },
  } as unknown as ExtensionAPI;
  // A long user message gives Pi's cut-point search something older than keepRecentTokens.
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
    ui: { notify() {}, setStatus(_key: string, text: string | undefined) { statuses.push(text); } },
    isIdle: () => gauge.idle,
    compact(options: unknown) { compactions.push(options); },
  };
  const emit = async (name: string, event: any = {}): Promise<any[]> => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { pi, ctx, emit, tools, entries, sent, compactions, statuses, gauge };
};

test('a full cycle: guidance, forced lock, note, compaction, verbatim return, unlock', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-cycle-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  const controller = installSelfCompact(h.pi);
  assert.ok(controller);
  await h.emit('session_start', { reason: 'startup' });

  h.gauge.tokens = 10_000;
  const [quiet] = await h.emit('context', { messages: [] });
  assert.equal(quiet, undefined, 'below the notice line nothing is injected');

  h.gauge.tokens = 155_000;
  const [warned] = await h.emit('context', { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] });
  assert.equal(warned.messages.length, 2);
  assert.equal(warned.messages[1].customType, 'self-compact-guidance');
  assert.match(warned.messages[1].content, /WARNING/);
  assert.equal(h.entries.some(entry => entry.customType === 'self-compact-phase'), true);
  const [allowed] = await h.emit('tool_call', { toolName: 'bash', toolCallId: 't1', input: {} });
  assert.equal(allowed, undefined, 'the warning does not block tools');

  h.gauge.tokens = 185_000;
  const [blocked] = await h.emit('tool_call', { toolName: 'bash', toolCallId: 't2', input: {} });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /self_compact/);
  assert.equal(h.tools.has('context_usage'), false, 'the gauge is not a tool: the guidance messages carry the numbers');

  const note = '  Goal: ship.\nDONE: a.ts\nNEXT ACTION: run npm test  ';
  const saved = await h.tools.get('self_compact').execute('c1', { note_to_self: note }, undefined, undefined, h.ctx);
  assert.equal(saved.terminate, true);
  await h.emit('agent_settled');
  assert.equal(h.compactions.length, 1, 'compaction starts once Pi is idle');

  const [automatic] = await h.emit('session_before_compact', { reason: 'threshold', signal: new AbortController().signal });
  assert.equal(automatic, undefined, 'automatic compaction is left to the memory handoff policy');

  h.gauge.tokens = 30_000;
  await h.emit('session_compact', { reason: 'manual' });
  const returned = h.sent.find(item => item.message.customType === HANDOFF_TYPE);
  assert.ok(returned);
  assert.equal(returned.message.content, note, 'the note comes back byte for byte');
  assert.equal(returned.options.triggerTurn, true);

  await h.emit('message_end', { message: { role: 'custom', customType: HANDOFF_TYPE, details: returned.message.details } });
  const [free] = await h.emit('tool_call', { toolName: 'bash', toolCallId: 't4', input: {} });
  assert.equal(free, undefined, 'tools are restored after the handoff');
  assert.match(controller.describe(h.ctx).join('\n'), /cycles 1/);
});

test('a saved note compacts as soon as something wakes the agent, without waiting for idle', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-woken-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  h.gauge.tokens = 185_000;
  await h.tools.get('self_compact').execute('c1', { note_to_self: 'Goal: ship.\nNEXT ACTION: npm test' }, undefined, undefined, h.ctx);
  // A teammate's message or a subagent's question keeps Pi busy: agent_settled never comes.
  h.gauge.idle = false;
  await h.emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'Back. Resending.' }] } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.compactions.length, 1, 'the woken reply starts compaction');
  const [blocked] = await h.emit('tool_call', { toolName: 'team_message', toolCallId: 't1', input: {} });
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true, 'the run stops instead of looping on blocked tools');
  assert.match(blocked.reason, /compaction is running/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.compactions.length, 1, 'one compaction, not one per wake');
});

test('a tool call that meets a saved note starts compaction and ends the run', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-woken-tool-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  h.gauge.tokens = 185_000;
  await h.tools.get('self_compact').execute('c1', { note_to_self: 'Goal: ship.\nNEXT ACTION: npm test' }, undefined, undefined, h.ctx);
  h.gauge.idle = false;
  const [blocked] = await h.emit('tool_call', { toolName: 'bash', toolCallId: 't1', input: {} });
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true);
  assert.match(blocked.reason, /compaction is starting now/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.compactions.length, 1);
});

test('the summary extends the cached session request instead of replaying it as text', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-cached-'));
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
  h.gauge.tokens = 155_000;
  const system = { role: 'system', content: 'PROMPT', timestamp: 0 };
  const sent = [system, ...h.entries.filter(entry => entry.type === 'message').map(entry => entry.message)];
  await h.emit('context_with_system', { messages: sent });
  const answer = { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'self_compact', arguments: {} }], timestamp: 4 };
  const toolResult = { role: 'toolResult', toolCallId: 'c1', toolName: 'self_compact', content: [{ type: 'text', text: 'saved' }], timestamp: 5 };
  for (const message of [answer, toolResult]) {
    await h.emit('message_end', { message });
    h.entries.push({ type: 'message', id: `m${message.timestamp}`, parentId: null, timestamp: new Date().toISOString(), message });
  }
  await h.tools.get('self_compact').execute('c1', { note_to_self: 'NEXT ACTION: test' }, undefined, undefined, h.ctx);

  const preparation = { firstKeptEntryId: 'u2', tokensBefore: 155_000, messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false,
    fileOps: { read: new Set(['a.ts', 'b.ts']), written: new Set<string>(), edited: new Set(['b.ts']) } };
  const [result] = await h.emit('session_before_compact', { reason: 'manual', preparation, signal: new AbortController().signal });
  assert.equal(requests.length, 1, 'one request, no replay');
  const { context, options } = requests[0]!;
  assert.deepEqual(context.messages.slice(0, -1), [...sent, answer, toolResult], 'the sent transcript is the unchanged prefix');
  assert.equal(context.messages.at(-1).role, 'user');
  assert.equal(context.systemPrompt, undefined, 'the system prompt stays the session one');
  assert.equal(options.sessionId, 'sc-session', 'routed to the session cache');
  assert.equal(options.cacheRetention, undefined);
  assert.equal(result.compaction.summary, 'SUMMARY\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>');
  assert.equal(result.compaction.firstKeptEntryId, 'u2');
  assert.equal(result.compaction.details.selfCompact.summary, 'cache-shared');
  assert.equal(result.compaction.details.selfCompact.cacheRead, 150_000);
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
  const manual: any = { reason: 'manual' };
  assert.equal(cachedSummaryBlocker(manual, ctx, snapshot, 150_000), undefined);
  assert.match(cachedSummaryBlocker(manual, ctx, undefined, 150_000)!, /no session request/);
  assert.match(cachedSummaryBlocker(manual, ctx, { ...snapshot, model: 'test/other' }, 150_000)!, /model changed/);
  assert.match(cachedSummaryBlocker({ reason: 'overflow' } as any, ctx, snapshot, 150_000)!, /overflow/);
  assert.match(cachedSummaryBlocker(manual, ctx, snapshot, 265_000)!, /no room/);
  assert.match(cachedSummaryBlocker(manual, ctx, { ...snapshot, messages: snapshot.messages.slice(0, 1) }, 150_000)!, /moved past/);
});

test('a sibling of self_compact in the same batch is blocked and ends the run', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-batch-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  h.entries.push({ type: 'message', id: 'a2', message: { role: 'assistant', content: [
    { type: 'toolCall', id: 'x1', name: 'read', arguments: { path: 'a' } },
    { type: 'toolCall', id: 'x2', name: 'self_compact', arguments: { note_to_self: 'NEXT ACTION: go' } },
  ] } });
  const [result] = await h.emit('tool_call', { toolName: 'read', toolCallId: 'x1', input: {} });
  assert.equal(result.block, true);
  assert.equal(result.terminate, true);
});

test('self_compact refuses when nothing can be compacted and never locks', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-empty-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  h.entries.splice(0, h.entries.length);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  await assert.rejects(h.tools.get('self_compact').execute('c1', { note_to_self: 'n' }, undefined, undefined, h.ctx), /Nothing to compact/);
  const [result] = await h.emit('tool_call', { toolName: 'bash', toolCallId: 't1', input: {} });
  assert.equal(result, undefined);
});

test('a reload after compaction but before delivery returns the saved note', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-reload-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  h.entries.push({ type: 'custom', customType: STATE_TYPE,
    data: { version: 1, cycle: 0, locked: true, handoff: { id: 'h9', note: 'NEXT ACTION: resume', status: 'compacting', attempts: 0, savedAt: 1 } } });
  h.entries.push({ type: 'compaction', id: 'c9', details: { handoffId: 'h9' } });
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'reload' });
  const returned = h.sent.find(item => item.message.customType === HANDOFF_TYPE);
  assert.equal(returned?.message.content, 'NEXT ACTION: resume');
});

test('subagent children and explicit opt-out install nothing', () => {
  const calls: string[] = [];
  const pi = new Proxy({}, { get: (_target, name) => () => { calls.push(String(name)); } }) as unknown as ExtensionAPI;
  assert.equal(installSelfCompact(pi, { enabled: false }), undefined);
  const previous = process.env.PI_SUBAGENTS_CHILD;
  process.env.PI_SUBAGENTS_CHILD = '1';
  try {
    assert.equal(installSelfCompact(pi), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENTS_CHILD;
    else process.env.PI_SUBAGENTS_CHILD = previous;
  }
  assert.deepEqual(calls, []);
});

test('a project prompt override replaces the built-in guidance', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-override-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.pi', 'self-compact'), { recursive: true });
  await writeFile(join(cwd, '.pi', 'self-compact', 'SOFT.md'), 'custom notice at {{used_percent}}');
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  h.gauge.tokens = 120_000;
  const [result] = await h.emit('context', { messages: [] });
  assert.equal(result.messages[0].content, 'custom notice at 44.1%');
});

test('a project thresholds.json moves the lines, and a bad one disables self-compact', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-thresholds-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dir = join(cwd, '.pi', 'self-compact');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'thresholds.json'), '{ "softAt": "200k", "at": "220k", "buffer": "20k" }');
  const h = host(cwd);
  const controller = installSelfCompact(h.pi);
  assert.ok(controller);
  await h.emit('session_start', { reason: 'startup' });
  const lines = controller.describe(h.ctx);
  assert.ok(lines.includes('state active'));
  assert.ok(lines.includes(`lines notice 200,000 · warning 220,000 · cutoff 240,000 · from ${join(dir, 'thresholds.json')}`));
  // Past the old default warning line but under the file's notice line: no guidance.
  h.gauge.tokens = 160_000;
  assert.deepEqual(await h.emit('context', { messages: [] }), [undefined]);
  await writeFile(join(dir, 'thresholds.json'), '{ "warn": "1k" }');
  await h.emit('session_start', { reason: 'reload' });
  assert.match(controller.describe(h.ctx)[0] ?? '', /^state rejected: .*unknown keys warn/);
  h.gauge.tokens = 260_000;
  assert.deepEqual(await h.emit('context', { messages: [] }), [undefined]);
});

test('/self-compact reports status, asks for a note on now, and rejects other words', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-command-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  const commands = new Map<string, any>();
  const notices: string[] = [];
  (h.pi as any).registerCommand = (name: string, definition: unknown) => { commands.set(name, definition); };
  h.ctx.ui.notify = (message: string) => { notices.push(message); };
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  const command = commands.get('self-compact');
  assert.deepEqual(command.getArgumentCompletions('').map((item: { value: string }) => item.value), ['status', 'now']);
  await command.handler('', h.ctx);
  assert.match(notices.at(-1) ?? '', /self-compact\nstate active\n/);
  await command.handler('now', h.ctx);
  assert.match(h.sent.at(-1)?.message.content, /^Compact now:/);
  await command.handler('bogus', h.ctx);
  assert.match(notices.at(-1) ?? '', /^Usage:/);
});

test('a session resumed past the cutoff hands off by itself, without a prompt', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-resume-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  h.gauge.tokens = 200_833;
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'resume' });
  await new Promise(resolve => setTimeout(resolve, 600));
  const request = h.sent.find(item => item.message.customType === 'self-compact-guidance');
  assert.ok(request, 'the handoff is requested automatically');
  assert.equal(request.options.triggerTurn, true);
  assert.match(request.message.content, /^Compact now:/);
  await h.emit('session_shutdown');
});

test('a run that stops at the warning line is asked to hand off, at most twice per cycle', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-auto-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  h.gauge.tokens = 90_000;
  await h.emit('agent_end');
  const requests = () => h.sent.filter(item => item.message.customType === 'self-compact-guidance');
  assert.equal(requests().length, 0, 'below the warning line nothing is requested');
  h.gauge.tokens = 155_000;
  for (const _ of [1, 2, 3]) await h.emit('agent_end');
  assert.equal(requests().length, 2);
  assert.deepEqual(requests()[0]?.options, { triggerTurn: true, deliverAs: 'followUp' });
  await h.emit('session_compact', { reason: 'manual' });
  await h.emit('agent_end');
  assert.equal(requests().length, 3, 'a new context epoch re-arms the requests');
  await h.emit('session_shutdown');
});

test('the returned note renders as one summary line and shows in full only when expanded', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-render-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  const renderers = new Map<string, any>();
  (h.pi as any).registerMessageRenderer = (type: string, renderer: unknown) => { renderers.set(type, renderer); };
  installSelfCompact(h.pi);
  const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
  const message = { content: 'GOAL\nNEXT ACTION: go', details: { cycle: 1, note: 'GOAL\nNEXT ACTION: go', tokensBefore: 200_833 } };
  const render = (expanded: boolean) => renderers.get(HANDOFF_TYPE)(message, { expanded, outputPad: 0 }, theme).render(200).join('\n');
  assert.match(render(false), /compacted from 200,833 tokens · cycle 1 · note returned to the agent \(20 chars\)/);
  assert.doesNotMatch(render(false), /NEXT ACTION/);
  assert.match(render(true), /NEXT ACTION: go/);
});

test('split-turn summaries are recognized in the Pi 0.85 and 0.87 formats', () => {
  const prefix: any[] = [{ role: 'user', content: 'refactor the parser', timestamp: 1 }];
  const history: any[] = [{ role: 'user', content: 'earlier work', timestamp: 0 }];
  const inputs = summaryInputs({ messagesToSummarize: history, turnPrefixMessages: prefix, previousSummary: undefined });
  const [conversation] = inputs.filter(input => input.startsWith('# Conversation'));
  const text = conversation!.slice('# Conversation\n'.length, -'\n\n# Instructions\n'.length);
  const piPrompts = [
    `<conversation>\n${text}\n</conversation>\n\nPI TURN PREFIX PROMPT`,
    `# Conversation\n${text}\n\n# Instructions\nPI TURN PREFIX PROMPT`,
  ];
  for (const prompt of piPrompts) {
    const context: any = { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: 0 }] };
    const { messages } = replaceInstructions(context, inputs, 'OURS', 1_000_000);
    const out = (messages[0] as any).content[0].text as string;
    assert.ok(out.endsWith('OURS') && !out.includes('PI TURN PREFIX PROMPT'), out);
  }
  const unknown: any = { messages: [{ role: 'user', content: [{ type: 'text', text: 'something else' }], timestamp: 0 }] };
  assert.throws(() => replaceInstructions(unknown, inputs, 'OURS', 1_000_000), /Unrecognized Pi summary input/);
});

const answers = (switched: number, boundary: number, busy: number) => ({
  switched_gears: { type: 'noul' as const, noul: switched },
  at_boundary: { type: 'noul' as const, noul: boundary },
  mid_operation: { type: 'noul' as const, noul: busy },
});

test('the moment: a half-done edit always holds; a finished turn is clean, or moved on when the request changed', () => {
  assert.equal(verdictOf(answers(0.95, 0.9, 0.7)), 'busy');
  assert.equal(verdictOf(answers(0.95, 0.9, 0.1)), 'moved_on');
  assert.equal(verdictOf(answers(0.2, 0.9, 0.1)), 'clean');
  assert.equal(verdictOf(answers(0.95, 0.4, 0.1)), 'continuing', 'a new request still in progress is not a checkpoint');
  assert.equal(verdictOf({}), undefined);
  assert.match(momentLine('clean') ?? '', /clean checkpoint/);
  assert.equal(momentLine('busy'), undefined);
  assert.equal(momentLine(undefined), undefined);
});

test('the moment reads requests since the last compaction and the last turn, never tool results', () => {
  const message = (role: string, content: unknown) => ({ type: 'message', message: { role, content } });
  const branch = [
    message('user', 'old task before compaction'),
    { type: 'compaction' },
    message('user', 'Fix the proration rounding'),
    message('assistant', [{ type: 'toolCall', name: 'read' }]),
    message('toolResult', [{ type: 'text', text: 'SECRET FILE BODY' }]),
    message('assistant', [{ type: 'text', text: 'Fixed; tests pass.' }]),
    message('user', 'Now write the release notes'),
    message('assistant', [{ type: 'toolCall', name: 'write' }, { type: 'text', text: 'Draft written.' }]),
  ];
  const state = momentState(branch);
  assert.deepEqual(state, {
    current_request: 'Now write the release notes',
    previous_requests: ['Fix the proration rounding'],
    recent_turn: 'Draft written.',
    tools_this_turn: ['write'],
  });
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
  assert.equal(momentState([message('user', 'only one request')]), undefined, 'nothing to move on from yet');
});

test('Jev asks nothing below the notice line, and a finished run that moved on hands off early', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-jev-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  const calls = { value: 0 };
  installSelfCompact(h.pi, { jev: async () => async () => { calls.value += 1; return answers(0.95, 0.9, 0.05); } });
  await h.emit('session_start', { reason: 'startup' });
  const requests = () => h.sent.filter(item => item.message.customType === 'self-compact-guidance');

  h.gauge.tokens = 90_000;
  await h.emit('turn_end');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.value, 0, 'below the notice line Jev is never asked');

  h.gauge.tokens = 110_000;
  h.gauge.idle = false;
  await h.emit('turn_end');
  await h.emit('agent_end');
  h.gauge.idle = true;
  await new Promise(resolve => setTimeout(resolve, 20));
  await h.emit('agent_settled');
  await h.emit('agent_settled');
  assert.equal(calls.value, 1);
  assert.equal(requests().length, 1, 'the verdict acted once the run was idle, and only once');
  assert.equal(requests()[0]?.message.details.movedOn, true);
  assert.equal(requests()[0]?.message.details.level, 'notice');
  await h.emit('session_shutdown');
});

test('at the warning line a clean checkpoint is said out loud; without Jev the guidance is unchanged', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-self-compact-jev-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const guidanceOf = async (jev?: () => Promise<any>) => {
    const h = host(cwd);
    installSelfCompact(h.pi, jev ? { jev } : {});
    await h.emit('session_start', { reason: 'startup' });
    h.gauge.tokens = 155_000;
    h.gauge.idle = false;
    await h.emit('turn_end');
    await new Promise(resolve => setTimeout(resolve, 20));
    const [result] = await h.emit('context', { messages: [] });
    await h.emit('session_shutdown');
    return String(result?.messages?.at(-1)?.content ?? '');
  };
  const plain = await guidanceOf();
  assert.ok(plain.length > 0);
  assert.doesNotMatch(plain, /clean checkpoint/);
  const clean = await guidanceOf(async () => async () => answers(0.2, 0.9, 0.05));
  assert.ok(clean.startsWith(plain), 'the line is added, nothing else changes');
  assert.match(clean, /clean checkpoint/);
  const failing = await guidanceOf(async () => async () => { throw new Error('timeout'); });
  assert.equal(failing, plain, 'a Jev failure changes nothing');
});

test('the notice line is awareness only: it never invites a compaction', () => {
  // Riding on every request past the notice line, an invitation made models
  // compact there instead of at the warning line.
  assert.match(BUILTIN_PROMPTS.soft, /Do not call `self_compact` yet/);
  assert.doesNotMatch(BUILTIN_PROMPTS.soft, /You decide when to compact|clean checkpoint/);
  assert.match(BUILTIN_PROMPTS.warning, /call `self_compact`/);
});

test('self-compact never edits the context, however full it is', async t => {
  // Clearing stale tool I/O at 100k (2026-09-29 to 10-03) stubbed the task in
  // progress in half the cases; compaction is the only context limit.
  const cwd = await mkdtemp(join(tmpdir(), 'pi-memory-sc-noclear-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = host(cwd);
  const flags: string[] = [];
  (h.pi as any).registerFlag = (name: string) => { flags.push(name); };
  installSelfCompact(h.pi);
  await h.emit('session_start', { reason: 'startup' });
  const output = { type: 'text', text: 'line\n'.repeat(4_000) };
  const contextEntries = Array.from({ length: 200 }, (_, n) => ({ sourceEntry: { id: `r${n}`, type: 'message' }, messages: [{ role: 'toolResult', toolCallId: `c${n}`, toolName: 'bash', content: [output] }] }));
  for (const tokens of [60_000, 110_000, 155_000, 230_000]) {
    h.gauge.tokens = tokens;
    const results = await h.emit('turn_end', { entries: [], context: { contextEntries } });
    assert.ok(results.every((result: unknown) => result === undefined), `no context edits at ${tokens}`);
  }
  assert.ok(flags.length > 0 && !flags.includes('context-clear-at'), 'no clearing flag');
});
