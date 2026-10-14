import {
  compact, convertToLlm, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { contentText, type Context } from '@earendil-works/pi-ai';
import { protectOutboundData } from '@prjct.app/pi-secrets/privacy';
import { stripLedger } from './ledger.ts';

/**
 * The compaction summary, written by extending the session's last request
 * instead of replaying the history as text. Adapted from
 * disler/self-compact-pi-agent (MIT, Copyright (c) 2026 IndyDevDan).
 */

type Messages = SessionBeforeCompactEvent['preparation']['messagesToSummarize'];

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
  return { ...session, input: [...session.input, ...rebuilt.input.slice(at + 1)], tool_choice: 'none',
    ...(maxOutput === undefined ? {} : { max_output_tokens: maxOutput }) };
};

// The session streams through streamSimple (Pi 0.87+); older hosts only offer complete().
type Registry<O> = ExtensionContext['modelRegistry'] & {
  streamSimple?: (m: NonNullable<ExtensionContext['model']>, c: Context, o: O) => { result(): ReturnType<ExtensionContext['modelRegistry']['complete']> };
};

export const modelKey = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;

/** Room the cache-shared request needs past the live context: the summary itself plus the instructions. */
const SUMMARY_OUTPUT_TOKENS = 32_768;
const SUMMARY_INSTRUCTION_TOKENS = 2_048;
const summaryOutputTokens = (model: { maxTokens?: number }): number => Math.min(model.maxTokens || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS);

const JOURNALED_ROLES = new Set(['user', 'assistant', 'toolResult', 'bashExecution']);

/**
 * Why the cache-shared path cannot run, or undefined when it can. Overflow
 * recovery cannot resend the full context, and a stale or foreign snapshot
 * would summarize the wrong transcript.
 */
export const cachedSummaryBlocker = (
  event: SessionBeforeCompactEvent, ctx: ExtensionContext, snapshot: RequestSnapshot | undefined, usedTokens: number | null,
): string | undefined => {
  if (event.reason === 'overflow') return 'overflow recovery';
  return snapshotBlocker(ctx, snapshot, usedTokens);
};

/** Why a captured request cannot be extended now, or undefined when it can. */
export const snapshotBlocker = (ctx: ExtensionContext, snapshot: RequestSnapshot | undefined, usedTokens: number | null): string | undefined => {
  if (!snapshot) return 'no session request captured yet';
  if (!ctx.model || modelKey(ctx.model) !== snapshot.model) return 'the model changed since the last request';
  if (usedTokens === null || usedTokens + summaryOutputTokens(ctx.model) + SUMMARY_INSTRUCTION_TOKENS > ctx.model.contextWindow) return 'no room to resend the context';
  // The newest journaled message must be the newest one the snapshot carries.
  const journaled = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === 'message');
  const carried = [...snapshot.messages, ...snapshot.tail].reverse()
    .find(message => JOURNALED_ROLES.has((message as { role?: string }).role ?? '')) as { timestamp?: number } | undefined;
  if (journaled?.type === 'message' && journaled.message.timestamp !== carried?.timestamp) return 'the session moved past the captured request';
  return undefined;
};

type Settings = Pick<ReturnType<ExtensionAPI['getSettings']>, 'thinkingBudgets'>;

/**
 * One auxiliary request that extends the last session request instead of
 * replaying it as text: same system prompt, same tool declarations, same
 * messages, same session id, one extra user message. The provider bills the
 * shared prefix as cached input, and the Codex WebSocket sends only the new
 * message. Only a finished text answer is accepted.
 */
export const askCached = async (
  ctx: ExtensionContext, snapshot: RequestSnapshot, task: string, settings: Settings = {}, signal?: AbortSignal, maxTokens?: number,
) => {
  const model = ctx.model;
  if (!model) throw new Error('No model available.');
  // System messages carry the prompt and tool declarations; pass them through untouched
  // (hosts before 0.87 drop them in convertToLlm).
  const history = [...snapshot.messages, ...snapshot.tail].flatMap(message => (message as { role?: string }).role === 'system'
    ? [message as Context['messages'][number]] : convertToLlm([message] as Messages));
  const context: Context = await protectOutboundData({ messages: [...history, { role: 'user', content: [{ type: 'text', text: task }], timestamp: Date.now() }] });
  const options = {
    maxTokens: maxTokens ?? summaryOutputTokens(model),
    // Keep the tool declarations in the cached prefix, but forbid new tool calls
    // through Pi's provider-neutral option (Anthropic and Chat Completions too).
    toolChoice: 'none' as const,
    thinkingBudgets: settings.thinkingBudgets,
    signal,
    sessionId: ctx.sessionManager.getSessionId(),
    ...(model.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== 'off' ? { reasoning: ctx.thinkingLevel } : {}),
    // The final tool results were produced after the last guarded request.
    // Guard both them and the reused provider body before this auxiliary call.
    onPayload: async (body: unknown) => protectOutboundData(extendPayload(snapshot.payload, body) ?? body),
  };
  const registry = ctx.modelRegistry as Registry<typeof options>;
  const response = registry.streamSimple
    ? await registry.streamSimple(model, context, options).result()
    : await ctx.modelRegistry.complete(model, context, options);
  if (signal?.aborted || response.stopReason === 'aborted') throw new Error('Request cancelled.');
  if (response.stopReason === 'error') throw new Error(response.errorMessage || 'Request failed.');
  if (response.stopReason !== 'stop' || response.content.some(block => block.type === 'toolCall')) {
    throw new Error(`Incomplete answer (${response.stopReason}).`);
  }
  const text = contentText(response.content).trim();
  if (!text) throw new Error('Empty answer.');
  return { text, usage: response.usage };
};

/** A standalone request through the session's model registry, outbound data guarded. */
export const askPlain = async (ctx: ExtensionContext, text: string, signal?: AbortSignal, maxTokens = 8_000) => {
  const model = ctx.model;
  if (!model) throw new Error('No model available.');
  const registry = ctx.modelRegistry as Registry<StreamOptions>;
  if (!registry?.streamSimple) throw new Error('This Pi host has no streamSimple.');
  const context = await protectOutboundData({ messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }] });
  const response = await registry.streamSimple(model, context as Context, {
    maxTokens, signal, ...(model.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== 'off' ? { reasoning: ctx.thinkingLevel } : {}),
    onPayload: async (body: unknown) => protectOutboundData(body),
  }).result();
  if (response.stopReason !== 'stop' || response.content.some(block => block.type === 'toolCall')) throw new Error(`Incomplete answer (${response.stopReason}).`);
  return { text: contentText(response.content).trim(), usage: response.usage };
};

type FileOps = SessionBeforeCompactEvent['preparation']['fileOps'];

export const fileLists = (fileOps: FileOps) => {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter(file => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  const text = [
    readFiles.length ? `<read-files>\n${readFiles.join('\n')}\n</read-files>` : '',
    modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join('\n')}\n</modified-files>` : '',
  ].filter(Boolean).join('\n\n');
  return { text, readFiles, modifiedFiles };
};

/** The cache-shared compaction summary (used when no project state is available). */
export const generateCachedSummary = async (
  event: SessionBeforeCompactEvent, ctx: ExtensionContext, system: string, snapshot: RequestSnapshot,
  settings: Settings = {}, extra = '',
) => {
  const { preparation } = event;
  const task = [
    system,
    'Summarize the conversation above for the compaction. Reply with the summary text only and call no tools.',
    `Pi retains about ${preparation.settings.keepRecentTokens.toLocaleString('en-US')} recent tokens verbatim. Preserve the full active objective and unresolved constraints even if they appear in that recent part; avoid repeating routine tool output.`,
    event.customInstructions ? `Additional summarization instructions from the operator: ${event.customInstructions}` : '',
    extra,
  ].filter(Boolean).join('\n\n');
  const { text, usage } = await askCached(ctx, snapshot, task, settings, event.signal);
  const files = fileLists(preparation.fileOps);
  return {
    summary: files.text ? `${text}\n\n${files.text}` : text,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage,
    details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
  };
};

type StreamOptions = Record<string, unknown> & { onPayload?: (body: unknown, model?: unknown) => unknown };

/**
 * Pi's own summarizer, for the compactions the cache-shared request cannot
 * write (overflow, a model change, a stale snapshot, a failed request), so
 * those summaries carry the user's messages too. It streams through the
 * session's model registry with request-time authentication, guards outbound
 * data like the cache-shared path, and drops the carried ledger from the
 * previous summary so the summarizer does not paraphrase it.
 */
export const generateNativeSummary = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext, extra = '') => {
  const model = ctx.model;
  if (!model) throw new Error('No model available for compaction.');
  const registry = ctx.modelRegistry as Registry<StreamOptions>;
  const streamSimple = registry?.streamSimple?.bind(registry);
  if (!streamSimple) throw new Error('This Pi host has no streamSimple.');
  const { preparation } = event;
  // Only a finished text answer may replace the conversation; anything else leaves Pi in charge.
  const stream = async (m: typeof model, context: Context, options: StreamOptions = {}) => {
    const response = streamSimple(m, await protectOutboundData(context), {
      ...options,
      onPayload: async (body: unknown, payloadModel?: unknown) =>
        protectOutboundData((await options.onPayload?.(body, payloadModel)) ?? body),
    });
    return { result: async () => {
      const message = await response.result();
      if (message.stopReason !== 'stop') throw new Error(`Incomplete compaction summary (${message.stopReason}).`);
      return message;
    } };
  };
  const reasoning = model.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== 'off' ? ctx.thinkingLevel : undefined;
  return compact(
    { ...preparation, previousSummary: preparation.previousSummary === undefined ? undefined : stripLedger(preparation.previousSummary) },
    model, undefined, undefined, [event.customInstructions, extra].filter(Boolean).join('\n\n') || undefined, event.signal, reasoning,
    stream as unknown as Parameters<typeof compact>[7], undefined, undefined, undefined, ctx.sessionManager.getSessionId(),
  );
};
