import { convertToLlm, serializeConversation, type CompactionResult, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactResult } from '@earendil-works/pi-coding-agent';
import { SUMMARY_PROMPT } from './prompts.ts';
import { branchFileOps } from './files.ts';
import { applySelection, collectLedger, droppedBefore, ledgerDetails, selectionInstructions, withLedger } from './ledger.ts';
import { askCached, askPlain, cachedSummaryBlocker, fileLists, generateCachedSummary, generateNativeSummary, modelKey, snapshotBlocker, type RequestSnapshot } from './summary.ts';
import {
  applyOps, foldTask, parseOps, renderState, restoreState, REVIEW_CHARS, reviewTask, STATE_ENTRY, stateDetails, unfolded, userMessages,
  type ProjectState,
} from './state.ts';

/**
 * Pi decides when to compact (`compaction.reserveTokens`) and how much recent
 * history stays verbatim (`compaction.keepRecentTokens`). This extension only
 * writes the summary: it extends the session's last request, so the provider
 * bills the shared prefix as cached input and the summarizer reads every tool
 * result whole. When that cannot run (overflow, a model change, a stale
 * snapshot, an error) it runs Pi's own summarizer.
 *
 * The summary is the project state (see state.ts): after each run the model
 * edits it item by item, and a compaction renders it instead of rewriting a
 * summary of a summary. When the state cannot be updated, the previous
 * behaviour runs: a summary followed by the user's messages that still apply
 * (see ledger.ts).
 *
 * It adds nothing to the context: no tool, no guidance, no notes, no locks.
 * Asking the model to write its own handoff note under a character cap made
 * it squeeze words together, and that shorthand was all it read after each
 * compaction.
 */

export type SelfCompactOptions = Readonly<{ enabled?: boolean }>;

export const installSelfCompact = (pi: ExtensionAPI, options: SelfCompactOptions = {}): boolean => {
  if (options.enabled === false) return false;
  const R = {
    /** The last session request as sent, so the summary can extend its cached prefix. */
    snapshot: undefined as RequestSnapshot | undefined,
    warned: false,
    /** The project state, restored lazily from the branch. */
    state: undefined as ProjectState | undefined,
    /** State updates run one at a time, in order. */
    folding: Promise.resolve() as Promise<unknown>,
  };
  const reset = (): void => { R.snapshot = undefined; };
  const notify = (ctx: ExtensionContext, message: string): void => {
    if (R.warned || !ctx.hasUI) return;
    R.warned = true;
    try { ctx.ui.notify(message, 'warning'); } catch { /* UI only. */ }
  };

  pi.on('session_start', async () => { reset(); R.state = undefined; });
  pi.on('session_tree', async () => { reset(); R.state = undefined; });
  pi.on('session_compact', async () => reset());

  // Runs after every `context` handler, so the snapshot matches the request byte for byte.
  (pi.on as (event: string, handler: (event: { messages: readonly unknown[] }, ctx: ExtensionContext) => Promise<undefined>) => void)(
    'context_with_system', async (event, ctx) => {
      R.snapshot = ctx.model ? { model: modelKey(ctx.model), messages: event.messages, tail: [] } : undefined;
      return undefined;
    });

  // The provider body as sent: Pi builds tool schemas on the session path that the
  // transcript alone does not reproduce, so the summary reuses this body as its prefix.
  // Handlers after this one still rewrite it; list self-compact last among packages.
  pi.on('before_provider_request', async event => {
    if (R.snapshot && !R.snapshot.payload) R.snapshot = { ...R.snapshot, payload: event.payload };
    return undefined;
  });

  pi.on('message_end', async event => {
    if (R.snapshot) R.snapshot = { ...R.snapshot, tail: [...R.snapshot.tail, event.message] };
  });

  type Branch = Parameters<typeof restoreState>[0];
  const settings = () => pi.getSettings?.() ?? {};
  const CHUNK_CHARS = 400_000;

  /** The text of a span for a standalone request, cut into pieces a request can hold. */
  const transcripts = (span: Branch): string[] => {
    const messages = span.flatMap(entry => entry.type === 'message' && entry.message ? [entry.message]
      : entry.type === 'custom_message' ? [{ role: 'custom', customType: entry.customType, content: (entry as { content?: unknown }).content ?? '', display: false, timestamp: 0 }] : []);
    return messages.reduce<string[]>((parts, message) => {
      const text = serializeConversation(convertToLlm([message] as Parameters<typeof convertToLlm>[0]));
      const last = parts.at(-1) ?? '';
      return last && last.length + text.length > CHUNK_CHARS ? [...parts, text] : [...parts.slice(0, -1), `${last}${last ? '\n' : ''}${text}`];
    }, []);
  };

  /**
   * Brings the project state up to date with everything not folded yet, by
   * extending the cached session request when it can and through standalone
   * requests over the transcript otherwise. Saves the state as a custom entry
   * (never sent to the model) and returns it.
   */
  const updateState = async (ctx: ExtensionContext, signal?: AbortSignal, cachedAllowed = true): Promise<ProjectState> => {
    const branch = ctx.sessionManager.getBranch() as Branch;
    const users = userMessages(branch);
    const start = R.state ?? restoreState(branch);
    // A session that predates the state starts from its last compaction: the summary there stands for what came before.
    const latest = [...branch].reverse().find(entry => entry.type === 'compaction') as (Branch[number] & { firstKeptEntryId?: string; summary?: string }) | undefined;
    const fresh = !start.through && !start.items.length;
    const bootstrapFrom = fresh && latest?.firstKeptEntryId ? branch.findIndex(entry => entry.id === latest.firstKeptEntryId) : -1;
    const span = bootstrapFrom > 0 ? branch.slice(bootstrapFrom) : unfolded(branch, start);
    const earlier = bootstrapFrom > 0 && latest?.summary ? `[Earlier summary]: ${latest.summary}` : '';
    if (!span.some(entry => entry.type === 'message' || entry.type === 'custom_message')) return start;
    const at = span.find(entry => entry.timestamp)?.timestamp ?? new Date().toISOString();
    const ask = async (task: string) => {
      const blocked = cachedAllowed ? snapshotBlocker(ctx, R.snapshot, ctx.getContextUsage()?.tokens ?? null) : 'standalone';
      return blocked || !R.snapshot ? askPlain(ctx, task, signal) : askCached(ctx, R.snapshot, task, settings(), signal, 8_000);
    };
    const cached = cachedAllowed && !snapshotBlocker(ctx, R.snapshot, ctx.getContextUsage()?.tokens ?? null);
    const folded = cached
      ? applyOps(start, parseOps((await ask(foldTask(start, users, span))).text), at, users)
      : await [earlier, ...transcripts(span)].filter(Boolean).reduce<Promise<ProjectState>>(async (previous, transcript) => {
        const current = await previous;
        return applyOps(current, parseOps((await askPlain(ctx, foldTask(current, users, span, transcript), signal)).text), at, users);
      }, Promise.resolve(start));
    const reviewed = renderState(folded, users).length > REVIEW_CHARS
      ? applyOps(folded, parseOps((await ask(reviewTask(folded, users))).text), at, users, true)
      : folded;
    const next: ProjectState = { ...reviewed, through: span.at(-1)!.id };
    pi.appendEntry(STATE_ENTRY, next);
    R.state = next;
    return next;
  };
  const queueUpdate = (ctx: ExtensionContext, signal?: AbortSignal, cachedAllowed = true): Promise<ProjectState> => {
    const run = R.folding.catch(() => undefined).then(() => updateState(ctx, signal, cachedAllowed));
    R.folding = run.catch(() => undefined);
    return run;
  };

  // After each run the state takes in what happened, in the background: the user is reading the answer.
  // Runs woken by a small message are folded together later, so a busy teammate does not pay a request per wake.
  const FOLD_AFTER_CHARS = 30_000;
  pi.on('agent_end', async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch() as Branch;
    const span = unfolded(branch, R.state ?? restoreState(branch));
    const asked = span.some(entry => entry.type === 'message' && entry.message?.role === 'user');
    if (!asked && transcripts(span).join('').length < FOLD_AFTER_CHARS) return;
    void queueUpdate(ctx).catch(error => notify(ctx, `self-compact: project state not updated (${error instanceof Error ? error.message : String(error)})`));
  });

  pi.on('session_before_compact', async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch() as Parameters<typeof collectLedger>[0] & Parameters<typeof droppedBefore>[0];
    const dropped = droppedBefore(branch);
    const candidates = collectLedger(branch, event.preparation.firstKeptEntryId, dropped);
    const extra = selectionInstructions(candidates);
    // File lists for the whole session, not just this span: Pi skips the lists of summaries an extension wrote.
    const withFiles = { ...event, preparation: { ...event.preparation,
      fileOps: branchFileOps(branch as Parameters<typeof branchFileOps>[0], event.preparation.firstKeptEntryId, event.preparation.fileOps) } };
    const withUserMessages = (result: CompactionResult, summary: 'cache-shared' | 'native', more: object = {}): SessionBeforeCompactResult => {
      const selection = applySelection(result.summary, candidates, dropped);
      return { compaction: { ...result, summary: withLedger(selection.summary, selection.items), details: {
        ...(result.details as object | undefined),
        selfCompact: { summary, ...more, ledger: ledgerDetails(selection) },
      } } };
    };
    // The project state is the summary: no summary of a summary.
    try {
      const state = await queueUpdate(ctx, event.signal, event.reason !== 'overflow');
      const rendered = renderState(state, userMessages(branch as Parameters<typeof userMessages>[0]));
      if (rendered && !event.signal.aborted) {
        const files = fileLists(withFiles.preparation.fileOps);
        return { compaction: {
          summary: files.text ? `${rendered}\n\n${files.text}` : rendered,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles, selfCompact: { summary: 'state', state: stateDetails(state, rendered) } },
        } };
      }
    } catch (error) {
      if (event.signal.aborted) return undefined;
      notify(ctx, `self-compact: project state unavailable, writing a summary instead (${error instanceof Error ? error.message : String(error)})`);
    }
    const snapshot = R.snapshot;
    if (snapshot && !cachedSummaryBlocker(event, ctx, snapshot, ctx.getContextUsage()?.tokens ?? null)) {
      try {
        const result = await generateCachedSummary(withFiles, ctx, SUMMARY_PROMPT, snapshot, pi.getSettings?.() ?? {}, extra);
        return withUserMessages(result, 'cache-shared', { input: result.usage.input, cacheRead: result.usage.cacheRead });
      } catch (error) {
        if (event.signal.aborted) return undefined;
        notify(ctx, `self-compact: cache-shared summary failed, Pi's summarizer writes it (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return nativeWithLedger(withFiles, ctx, extra, withUserMessages);
  });

  return true;
};

/**
 * Pi's summarizer plus the ledger and the session's file lists. If even that
 * fails, Pi compacts on its own path and the next compaction restores both
 * from the branch.
 */
const nativeWithLedger = async (
  event: Parameters<typeof generateNativeSummary>[0], ctx: ExtensionContext, extra: string,
  wrap: (result: CompactionResult, summary: 'native') => SessionBeforeCompactResult,
): Promise<SessionBeforeCompactResult | undefined> => {
  if (event.signal.aborted) return undefined;
  try {
    return wrap(await generateNativeSummary(event, ctx, extra), 'native');
  } catch {
    return undefined;
  }
};

export default function selfCompact(pi: ExtensionAPI): void {
  installSelfCompact(pi);
}
