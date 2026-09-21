/**
 * Durable self-compact state: one snapshot entry per change, rebuilt from the
 * session branch on start, reload and /tree. Adapted from
 * disler/self-compact-pi-agent (MIT, Copyright (c) 2026 IndyDevDan).
 */

export type HandoffStatus = 'pending' | 'compacting' | 'failed' | 'ready' | 'done';

export type Handoff = Readonly<{
  /** Durable id carried in the compaction details and in the returned message. */
  id: string;
  note: string;
  status: HandoffStatus;
  attempts: number;
  savedAt: number;
  error?: string;
}>;

export type SelfCompactState = Readonly<{
  version: 1;
  cycle: number;
  locked: boolean;
  handoff?: Handoff;
}>;

/** Snapshot entries, never sent to the model. */
export const STATE_TYPE = 'self-compact-state';
/** The message that returns the note verbatim; sent to the model. */
export const HANDOFF_TYPE = 'self-compact-handoff';
/** TUI-only line printed once per threshold crossing. */
export const PHASE_TYPE = 'self-compact-phase';
/** Transient guidance injected per request; never persisted. */
export const GUIDANCE_TYPE = 'self-compact-guidance';

export const emptyState = (): SelfCompactState => ({ version: 1, cycle: 0, locked: false });

/** Structural subset of Pi's SessionEntry. */
export type EntryLike = Readonly<{
  type: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  message?: Readonly<{ role?: string; usage?: unknown; stopReason?: string }>;
}>;

export type Recovered = Readonly<{
  state: SelfCompactState;
  /** The returned note was journaled but no assistant answered it. */
  unanswered: boolean;
  /** The returned note was journaled and answered. */
  answered: boolean;
}>;

const lastIndexWhere = <T>(items: readonly T[], match: (item: T) => boolean): number =>
  items.reduce((found, item, index) => match(item) ? index : found, -1);

const isSnapshot = (entry: EntryLike): boolean =>
  entry.type === 'custom' && entry.customType === STATE_TYPE && (entry.data as { version?: unknown } | undefined)?.version === 1;

export const recoverState = (entries: readonly EntryLike[]): Recovered => {
  const snapshot = lastIndexWhere(entries, isSnapshot);
  const state = snapshot < 0 ? emptyState() : structuredClone(entries[snapshot]!.data as SelfCompactState);
  const handoff = state.handoff;
  if (!handoff) return { state, unanswered: false, answered: false };
  const returned = entries.findIndex(entry => entry.type === 'custom_message' && entry.customType === HANDOFF_TYPE
    && (entry.details as { id?: unknown; resumed?: unknown } | undefined)?.id === handoff.id
    && !(entry.details as { resumed?: unknown }).resumed);
  if (returned >= 0) {
    const answered = entries.slice(returned + 1).some(entry => entry.type === 'message' && entry.message?.role === 'assistant');
    return {
      state: handoff.status === 'done' ? state : { ...state, handoff: { ...handoff, status: 'ready' } },
      unanswered: !answered, answered,
    };
  }
  if (handoff.status === 'done') return { state, unanswered: false, answered: false };
  const landed = entries.some(entry => entry.type === 'compaction'
    && (entry.details as { handoffId?: unknown } | undefined)?.handoffId === handoff.id);
  return {
    state: landed ? { ...state, handoff: { ...handoff, status: 'ready' } } : state,
    unanswered: false, answered: false,
  };
};
