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
