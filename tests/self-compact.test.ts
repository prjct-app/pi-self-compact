import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installSelfCompact } from '../src/index.ts';
import { BUILTIN_PROMPTS, loadPrompt, renderTemplate } from '../src/prompts.ts';
import { HANDOFF_TYPE, recoverState, STATE_TYPE, type EntryLike } from '../src/state.ts';
import { levelFor, parseSpec, resolveThresholds, DEFAULT_SPECS } from '../src/thresholds.ts';

// keepRecentTokens reads Pi settings; never let the developer's own settings leak in.
process.env.PI_CODING_AGENT_DIR = await mkdtemp(join(tmpdir(), 'pi-memory-sc-agent-'));

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
  const [usage] = await h.emit('tool_call', { toolName: 'context_usage', toolCallId: 't3', input: {} });
  assert.equal(usage, undefined, 'the gauge stays readable while locked');

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
