import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context, Model, SimpleStreamOptions, StreamFunction } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responses } from '@earendil-works/pi-ai/api/openai-responses';

const context: Context = { messages: [
  { role: 'system', content: 'Preserve the original user constraints.', timestamp: 1,
    toolsAdded: [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: {} } }] },
  { role: 'user', content: 'Summarize the original task and unresolved evidence.', timestamp: 2 },
] };

// Exercise the public provider adapters without sending a request or reading credentials.
const payload = async (stream: StreamFunction<any, SimpleStreamOptions>, model: Model<any>, input: Context, toolChoice?: 'none') => {
  const captured: Record<string, any>[] = [];
  const response = await stream(model, normalizeContext(input), {
    apiKey: 'offline-fixture', maxTokens: 32768, reasoning: 'high', toolChoice,
    fetch: async () => { throw new Error('Unexpected network request'); },
    onPayload: body => { captured.push(body as Record<string, any>); throw new Error('Captured before transport'); },
  }).result();
  assert.equal(response.stopReason, 'error');
  assert.match(response.errorMessage ?? '', /Captured before transport/);
  assert.equal(captured.length, 1);
  return captured[0]!;
};

for (const [api, provider, stream] of [
  ['anthropic-messages', 'minimax', anthropic],
  ['openai-completions', 'fixture', completions],
  ['openai-responses', 'fixture', responses],
] as const) {
  test(`${api}: summary tool choice preserves the transcript, tools and reasoning`, async () => {
    const model: Model<any> = { id: 'fixture', name: 'Fixture', api, provider, baseUrl: 'http://127.0.0.1.invalid',
      reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 128000,
      compat: { forceAdaptiveThinking: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const baseline = await payload(stream, model, context);
    const summary = await payload(stream, model, context, 'none');
    assert.deepEqual(summary.tool_choice, api === 'anthropic-messages' ? { type: 'none' } : 'none');
    const { tool_choice: _before, ...before } = baseline;
    const { tool_choice: _after, ...after } = summary;
    assert.deepEqual(after, before, 'only tool selection may change');
    assert.ok(summary.tools.length > 0, 'tool declarations remain in the prefix');
  });
}

test('restoring the real context window prevents the SDK from clamping a large session to one output token', async () => {
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture',
    baseUrl: 'http://127.0.0.1.invalid', reasoning: true, input: ['text'], contextWindow: 1000000, maxTokens: 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const history: Context = { messages: [{ role: 'user', content: 'Preserve this evidence. '.repeat(65000), timestamp: 1 }] };
  const capped = await payload(completions, { ...model, contextWindow: 272000 }, history, 'none');
  const restored = await payload(completions, model, history, 'none');
  assert.equal(capped.max_completion_tokens ?? capped.max_tokens, 1);
  assert.equal(restored.max_completion_tokens ?? restored.max_tokens, 32768);
  assert.deepEqual(restored.messages, capped.messages, 'all evidence is preserved');
});
