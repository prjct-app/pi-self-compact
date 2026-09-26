import { randomUUID } from 'node:crypto';
import {
  compact, convertToLlm, findCutPoint, serializeConversation, sessionEntryToContextMessages, SettingsManager,
  type CompactionEntry, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type Context } from '@earendil-works/pi-ai';
import type { LoadedPrompt } from './prompts.ts';

/**
 * The self-compact summary runs through Pi's own compact(), which owns split
 * turns, previous-summary merging, file tracking and transport retries; only
 * the system prompt and instructions are replaced. Adapted from
 * disler/self-compact-pi-agent (MIT, Copyright (c) 2026 IndyDevDan).
 */

/**
 * Mirrors Pi's prepareCompaction(): false when Pi would answer "Nothing to
 * compact" because the branch still fits inside keepRecentTokens.
 */
export const hasCompactionMaterial = (entries: readonly SessionEntry[], keepRecentTokens: number): boolean => {
  if (!entries.length || entries[entries.length - 1]!.type === 'compaction') return false;
  const previous = entries.reduce((found, entry, index) => entry.type === 'compaction' ? index : found, -1);
  const firstKept = previous < 0 ? -1
    : entries.findIndex(entry => entry.id === (entries[previous] as CompactionEntry).firstKeptEntryId);
  const start = previous < 0 ? 0 : firstKept >= 0 ? firstKept : previous + 1;
  const cut = findCutPoint([...entries], start, entries.length, keepRecentTokens);
  const end = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const carries = (entry: SessionEntry): boolean => sessionEntryToContextMessages(entry).length > 0;
  return entries.slice(start, end).some(entry => entry.type !== 'compaction' && carries(entry))
    || (cut.isSplitTurn && entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).some(carries));
};

/** Pi's retained recent history for this directory (global settings merged with the project's). */
export const keepRecentTokens = (cwd: string): number => SettingsManager.create(cwd).getCompactionKeepRecentTokens();

type Messages = SessionBeforeCompactEvent['preparation']['messagesToSummarize'];

const historyInput = (messages: Messages, previous?: string): string =>
  `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ''}`;

const instructionsFor = (event: SessionBeforeCompactEvent): string => [
  'Summarize the supplied historical data. Do not continue the task, simulate tools, or claim actions without tool-result evidence. Keep pending actions pending.',
  event.preparation.isSplitTurn ? 'This is a split turn. Summarize only the supplied history or turn prefix; the recent suffix remains available.' : '',
  event.customInstructions ? `Additional summarization instructions from the operator: ${event.customInstructions}` : '',
].filter(Boolean).join('\n\n');

/** Match complete known inputs, so tag-like text inside the history cannot cut it short. */
const replaceInstructions = (context: Context, inputs: readonly string[], instructions: string, budgetChars: number) => {
  const truncated = { value: false };
  // Pi 0.86 carries the system prompt as a leading system message as well as
  // `systemPrompt`; drop Pi's summarizer message so only ours applies.
  const messages = context.messages.filter(message => (message as { role: string }).role !== 'system').map(message => {
    if (message.role !== 'user') return message;
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    return { ...message, content: content.map(block => {
      if (block.type !== 'text') return block;
      const input = inputs.find(candidate => block.text.startsWith(candidate));
      if (input === undefined) throw new Error('Unrecognized Pi summary input; cannot replace instructions safely.');
      if (input.length <= budgetChars) return { ...block, text: `${input}${instructions}` };
      truncated.value = true;
      return { ...block, text: `[earlier conversation truncated to fit summary budget]\n${input.slice(-budgetChars)}${instructions}` };
    }) };
  });
  return { messages, truncated: truncated.value };
};

export const generateSummary = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext, system: LoadedPrompt) => {
  const model = ctx.model;
  if (!model) throw new Error('No model available for compaction.');
  const inputs = [
    historyInput(event.preparation.messagesToSummarize, event.preparation.previousSummary),
    historyInput(event.preparation.turnPrefixMessages),
  ].sort((a, b) => b.length - a.length);
  const instructions = instructionsFor(event);
  const truncated = { value: false };
  const result = await compact(
    event.preparation, model, undefined, undefined, event.customInstructions, event.signal, ctx.thinkingLevel,
    async (summaryModel, context, options) => {
      const maxTokens = Math.min(options?.maxTokens ?? 8192, summaryModel.maxTokens || 8192, 8192);
      const budgetChars = Math.max(8000, (summaryModel.contextWindow - maxTokens - 2000) * 4 - system.text.length - instructions.length);
      const replaced = replaceInstructions(context, inputs, instructions, budgetChars);
      truncated.value ||= replaced.truncated;
      const response = await ctx.modelRegistry.complete(summaryModel, { ...context, systemPrompt: system.text, messages: replaced.messages }, {
        ...options, maxTokens, signal: event.signal, cacheRetention: 'none', sessionId: randomUUID(),
        ...(summaryModel.api === 'openai-completions' && summaryModel.reasoning ? { reasoningEffort: 'low' as const } : {}),
      });
      if (event.signal.aborted || response.stopReason === 'aborted') throw new Error('Compaction summary cancelled.');
      if (response.stopReason !== 'error' && !response.content.some(block => block.type === 'text' && block.text.trim())) {
        throw new Error('Summary response was empty.');
      }
      const stream = createAssistantMessageEventStream();
      stream.end(response);
      return stream;
    },
    undefined, SettingsManager.create(ctx.cwd).getRetrySettings(),
  );
  if (event.signal.aborted) throw new Error('Compaction summary cancelled.');
  return { result, truncatedInput: truncated.value };
};

/**
 * The transcript of the last session request exactly as Pi sent it (leading
 * system message and tool declarations included), plus every message the
 * session journaled after it.
 */
export type RequestSnapshot = Readonly<{
  model: string;
  messages: readonly unknown[];
  tail: readonly unknown[];
  /** The provider body of that request, as the extensions before self-compact left it. */
  payload?: unknown;
}>;

type InputBody = { input: unknown[] } & Record<string, unknown>;
const inputBody = (value: unknown): value is InputBody =>
  typeof value === 'object' && value !== null && Array.isArray((value as { input?: unknown }).input);

/**
 * The session's own body with only the new input items appended (Responses-style
 * payloads). Pi's session path builds tool schemas the transcript cannot reproduce,
 * so rebuilding the body from messages misses the cache from the first byte. The
 * new items are what follows the session's last input item in the rebuilt body;
 * when that anchor is missing the rebuilt body is sent unchanged.
 */
export const extendPayload = (session: unknown, rebuilt: unknown): unknown => {
  if (!inputBody(session) || !inputBody(rebuilt) || !session.input.length) return undefined;
  const anchor = JSON.stringify(session.input.at(-1));
  const at = rebuilt.input.findLastIndex(item => JSON.stringify(item) === anchor);
  if (at < 0) return undefined;
  const { max_output_tokens: maxOutput } = rebuilt;
  return { ...session, input: [...session.input, ...rebuilt.input.slice(at + 1)], ...(maxOutput === undefined ? {} : { max_output_tokens: maxOutput }) };
};

export const modelKey = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/** Room the cache-shared request needs past the live context: the summary itself plus the instructions. */
const CACHED_HEADROOM_TOKENS = 16_000;

const JOURNALED_ROLES = new Set(['user', 'assistant', 'toolResult', 'bashExecution']);

/**
 * Why the cache-shared path cannot run, or undefined when it can. Overflow
 * recovery cannot resend the full context, and a stale or foreign snapshot
 * would summarize the wrong transcript.
 */
export const cachedSummaryBlocker = (
  event: SessionBeforeCompactEvent, ctx: ExtensionContext, snapshot: RequestSnapshot | undefined, usedTokens: number | null,
): string | undefined => {
  if (!snapshot) return 'no session request captured yet';
  if (!ctx.model || modelKey(ctx.model) !== snapshot.model) return 'the model changed since the last request';
  if (event.reason === 'overflow') return 'overflow recovery';
  if (usedTokens === null || usedTokens + CACHED_HEADROOM_TOKENS > ctx.model.contextWindow) return 'no room to resend the context';
  // The newest journaled message must be the newest one the snapshot carries.
  const journaled = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === 'message');
  const carried = [...snapshot.messages, ...snapshot.tail].reverse()
    .find(message => JOURNALED_ROLES.has((message as { role?: string }).role ?? '')) as { timestamp?: number } | undefined;
  if (journaled?.type === 'message' && journaled.message.timestamp !== carried?.timestamp) return 'the session moved past the captured request';
  return undefined;
};

/**
 * Summarizes by extending the last session request instead of replaying it as
 * text: same system prompt, same tool declarations, same messages, same
 * session id, one extra user message. The provider bills the shared prefix as
 * cached input, and the Codex WebSocket sends only the new message.
 */
export const generateCachedSummary = async (
  event: SessionBeforeCompactEvent, ctx: ExtensionContext, system: LoadedPrompt, snapshot: RequestSnapshot,
) => {
  const model = ctx.model;
  if (!model) throw new Error('No model available for compaction.');
  const { preparation } = event;
  const task = [
    system.text,
    'Summarize the conversation above for the compaction. Reply with the summary text only and call no tools.',
    `Everything before the most recent ~${keepRecentTokens(ctx.cwd).toLocaleString('en-US')} tokens is replaced by your summary; that recent part stays verbatim, so keep it brief.`,
    event.customInstructions ? `Additional summarization instructions from the operator: ${event.customInstructions}` : '',
  ].filter(Boolean).join('\n\n');
  // System messages carry the prompt and tool declarations; pass them through untouched
  // (hosts before 0.87 drop them in convertToLlm).
  const history = [...snapshot.messages, ...snapshot.tail].flatMap(message => (message as { role?: string }).role === 'system'
    ? [message as Context['messages'][number]] : convertToLlm([message] as Messages));
  const context: Context = { messages: [...history, { role: 'user', content: [{ type: 'text', text: task }], timestamp: Date.now() }] };
  const options = {
    maxTokens: Math.min(model.maxTokens || 8192, 8192),
    signal: event.signal,
    sessionId: ctx.sessionManager.getSessionId(),
    ...(model.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== 'off' ? { reasoning: ctx.thinkingLevel } : {}),
    onPayload: (body: unknown) => extendPayload(snapshot.payload, body),
  };
  // The session streams through streamSimple (Pi 0.87+); older hosts only offer complete().
  type Registry = typeof ctx.modelRegistry & {
    streamSimple?: (m: typeof model, c: Context, o: typeof options) => { result(): ReturnType<typeof ctx.modelRegistry.complete> };
  };
  const registry = ctx.modelRegistry as Registry;
  const response = registry.streamSimple
    ? await registry.streamSimple(model, context, options).result()
    : await ctx.modelRegistry.complete(model, context, options);
  if (event.signal.aborted || response.stopReason === 'aborted') throw new Error('Compaction summary cancelled.');
  if (response.stopReason === 'error') throw new Error(response.errorMessage || 'Summary request failed.');
  const text = response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
  if (!text) throw new Error('Summary response was empty.');
  const modified = new Set([...preparation.fileOps.edited, ...preparation.fileOps.written]);
  const readFiles = [...preparation.fileOps.read].filter(file => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  const files = [
    readFiles.length ? `<read-files>\n${readFiles.join('\n')}\n</read-files>` : '',
    modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>` : '',
  ].filter(Boolean).join('\n\n');
  return {
    summary: files ? `${text}\n\n${files}` : text,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage: response.usage,
    details: { readFiles, modifiedFiles },
  };
};
