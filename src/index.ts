import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionBeforeCompactResult } from '@earendil-works/pi-coding-agent';
import { SUMMARY_PROMPT } from './prompts.ts';
import { branchFileOps } from './files.ts';
import { applySelection, collectLedger, droppedBefore, ledgerDetails, selectionInstructions, withLedger } from './ledger.ts';
import { cachedSummaryBlocker, generateCachedSummary, generateNativeSummary, modelKey, type RequestSnapshot } from './summary.ts';

/**
 * Pi decides when to compact (`compaction.reserveTokens`) and how much recent
 * history stays verbatim (`compaction.keepRecentTokens`). This extension only
 * writes the summary: it extends the session's last request, so the provider
 * bills the shared prefix as cached input and the summarizer reads every tool
 * result whole. When that cannot run (overflow, a model change, a stale
 * snapshot, an error) it runs Pi's own summarizer.
 *
 * Either summary is followed by the user's messages that still apply,
 * verbatim (see ledger.ts): the model chooses which, the host copies them.
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
  };
  const reset = (): void => { R.snapshot = undefined; };
  const notify = (ctx: ExtensionContext, message: string): void => {
    if (R.warned || !ctx.hasUI) return;
    R.warned = true;
    try { ctx.ui.notify(message, 'warning'); } catch { /* UI only. */ }
  };

  pi.on('session_start', async () => reset());
  pi.on('session_tree', async () => reset());
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
