/**
 * Tier 1 of the context strategy: stale tool I/O becomes a one-line stub
 * through Pi's own context edits, in batches, long before a compaction is
 * needed. Compaction stays the backstop for what clearing cannot reach.
 *
 * Measured on 148 compaction cycles of real sessions (2026-09-29): 89% of the
 * context was tool I/O (65% outputs, 25% call arguments such as edit and write
 * bodies), and 55% of the output was over 60 requests old when the session
 * compacted. Replaying 19.6k of those requests, clearing at 100k with the last
 * 20 requests kept cut compactions from 4.5 to 0.8 per 1000 requests and
 * tokens by 12%, with the context averaging ~108k instead of ~122k.
 *
 * Why batches: an edit changes the serialized prefix from the first edited
 * message on, so the provider cache misses from there once. Clearing a batch
 * of at least `batchTokens` at a time pays that miss rarely; between batches
 * the prefix is byte for byte the same.
 *
 * Why context edits: they are Pi's append-only mechanism, applied to every
 * provider the same way, kept across reload and resume, counted by Pi's own
 * usage estimate, and they never touch the raw history or the UI.
 */

export type ClearSettings = Readonly<{
  /** Clearing starts once the context reaches this many tokens. */
  atTokens: number;
  /** The newest requests whose tool I/O is never cleared. */
  keepRequests: number;
  /** Items smaller than this are not worth a stub. */
  minTokens: number;
  /** A batch must free at least this much, unless forced. */
  batchTokens: number;
}>;

export const CLEAR_DEFAULTS = { atTokens: 100_000, keepRequests: 20, minTokens: 200, batchTokens: 30_000 } as const;

/** Clearing never waits past this share of the window, so small windows clear early too. */
export const CLEAR_WINDOW_CAP = 0.4;

/** Tools whose results are the conversation itself, not bulk output. */
const PROTECTED_TOOLS = new Set(['answer', 'self_compact', 'context_usage']);

/** Marks a cleared tool result, so a second pass leaves it alone. */
export const STUB_PREFIX = '[cleared by self-compact:';

/** Argument strings shorter than this stay whole; longer ones keep only a preview. */
const LONG_ARG_CHARS = 800;
const PREVIEW_CHARS = 100;
/** A rough flat cost for an image block; its base64 length says nothing useful. */
const IMAGE_TOKENS = 1_500;

type Block = Readonly<Record<string, unknown> & { type?: string }>;
type Message = Readonly<{ role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean }>;
export type ProjectedEntryLike = Readonly<{ sourceEntry: Readonly<{ id: string; type: string }>; messages: readonly Message[] }>;
export type ContextEditDraft = Readonly<{ type: 'context_edit'; targetId: string; replacement: { content: unknown } }>;
export type ClearPlan = Readonly<{ edits: readonly ContextEditDraft[]; tokens: number }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const blocks = (content: unknown): readonly Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isRecord) : [];

const blockTokens = (block: Block): number => {
  if (block.type === 'image') return IMAGE_TOKENS;
  if (block.type === 'toolCall') return Math.ceil(JSON.stringify(block.arguments ?? {}).length / 4) + 10;
  const text = typeof block.text === 'string' ? block.text : typeof block.thinking === 'string' ? block.thinking : '';
  return Math.ceil(text.length / 4);
};

export const contentTokens = (content: unknown): number => blocks(content).reduce((sum, block) => sum + blockTokens(block), 0);

const oneLine = (text: string, max: number): string => {
  const line = text.trim().split('\n')[0]!.replace(/\s+/gu, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a call was about, in a few words: the path, command or query it took. */
const subjectOf = (args: unknown): string | undefined => {
  if (!isRecord(args)) return undefined;
  const named = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'name'].map(key => args[key]);
  const text = [...named, ...Object.values(args)].find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return text === undefined ? undefined : oneLine(text, PREVIEW_CHARS);
};

const stubFor = (tool: string, tokens: number, subject: string | undefined, isError: boolean): string =>
  `${STUB_PREFIX} ${isError ? 'failed ' : ''}${tool} output, ~${tokens.toLocaleString('en-US')} tokens${subject ? ` · ${subject}` : ''}. Run it again if you still need it.]`;

/** Long strings anywhere in the arguments keep a preview; everything else stays as sent. */
const shrink = (value: unknown): Readonly<{ value: unknown; saved: number }> => {
  if (typeof value === 'string') {
    if (value.length < LONG_ARG_CHARS) return { value, saved: 0 };
    const stub = `${value.slice(0, PREVIEW_CHARS)}… [cleared ~${Math.round(value.length / 4).toLocaleString('en-US')} tokens, already used]`;
    return { value: stub, saved: Math.floor((value.length - stub.length) / 4) };
  }
  if (Array.isArray(value)) {
    const parts = value.map(shrink);
    return { value: parts.map(part => part.value), saved: parts.reduce((sum, part) => sum + part.saved, 0) };
  }
  if (isRecord(value)) {
    const parts = Object.entries(value).map(([key, item]) => [key, shrink(item)] as const);
    return { value: Object.fromEntries(parts.map(([key, part]) => [key, part.value])), saved: parts.reduce((sum, [, part]) => sum + part.saved, 0) };
  }
  return { value, saved: 0 };
};

/**
 * Every stale tool output and long call argument outside the newest
 * `keepRequests` requests, as context edits, with the tokens they free.
 * Idempotent: what was cleared before is already a stub in the projection.
 */
export function planClear(entries: readonly ProjectedEntryLike[], settings: Pick<ClearSettings, 'keepRequests' | 'minTokens'>): ClearPlan {
  const only = (entry: ProjectedEntryLike): Message | undefined =>
    entry.sourceEntry.type === 'message' && entry.messages.length === 1 ? entry.messages[0] : undefined;
  const calls = new Map(entries.flatMap(entry => entry.messages).filter(message => message.role === 'assistant')
    .flatMap(message => blocks(message.content)).filter(block => block.type === 'toolCall' && typeof block.id === 'string')
    .map(block => [block.id as string, block] as const));
  const total = entries.reduce((sum, entry) => sum + entry.messages.filter(message => message.role === 'assistant').length, 0);

  const planned = entries.reduce<{ seen: number; edits: ContextEditDraft[]; tokens: number }>((acc, entry) => {
    const seen = acc.seen + entry.messages.filter(message => message.role === 'assistant').length;
    const message = only(entry);
    if (!message || total - seen < settings.keepRequests) return { ...acc, seen };
    const targetId = entry.sourceEntry.id;

    if (message.role === 'toolResult' && !PROTECTED_TOOLS.has(message.toolName ?? '')) {
      const first = blocks(message.content)[0];
      if (typeof first?.text === 'string' && first.text.startsWith(STUB_PREFIX)) return { ...acc, seen };
      const tokens = contentTokens(message.content);
      if (tokens < settings.minTokens) return { ...acc, seen };
      const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
      const text = stubFor(message.toolName ?? 'tool', tokens, subjectOf(call?.arguments), message.isError === true);
      const edit: ContextEditDraft = { type: 'context_edit', targetId, replacement: { content: [{ type: 'text', text }] } };
      return { seen, edits: [...acc.edits, edit], tokens: acc.tokens + tokens - Math.ceil(text.length / 4) };
    }

    if (message.role === 'assistant') {
      const shrunk = blocks(message.content).map(block => {
        if (block.type !== 'toolCall') return { block, saved: 0 };
        const args = shrink(block.arguments);
        return { block: args.saved > 0 ? { ...block, arguments: args.value } : block, saved: args.saved };
      });
      const saved = shrunk.reduce((sum, part) => sum + part.saved, 0);
      if (saved < settings.minTokens) return { ...acc, seen };
      const edit: ContextEditDraft = { type: 'context_edit', targetId, replacement: { content: shrunk.map(part => part.block) } };
      return { seen, edits: [...acc.edits, edit], tokens: acc.tokens + saved };
    }
    return { ...acc, seen };
  }, { seen: 0, edits: [], tokens: 0 });

  return { edits: planned.edits, tokens: planned.tokens };
}

/** The token count clearing starts at for a window: the setting, capped to a share of small windows. */
export const clearLine = (atTokens: number, window: number): number =>
  window > 0 ? Math.min(atTokens, Math.floor(CLEAR_WINDOW_CAP * window)) : atTokens;
