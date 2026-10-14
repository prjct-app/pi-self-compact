/**
 * The user's own messages, carried verbatim through every compaction.
 *
 * Each compaction merges the previous summary, so a constraint the user
 * stated once is paraphrased again on every pass until it falls out. In a
 * measured session it was gone after 21 compactions, and the agent then did
 * what it forbade. The ledger is not model-written: it is read from the
 * session branch, which keeps every entry, so it does not drift and it
 * recovers even after a compaction that lacked it.
 */

/** Longer messages (pasted logs, traces) keep this many characters and point at their entry. */
export const LEDGER_MESSAGE_CHARS = 2_000;
export const LEDGER_HEADER = '## User messages, verbatim (carried across compactions; newest last)';

export type LedgerItem = Readonly<{ entryId: string; timestamp: string; text: string; truncatedChars: number }>;

type BranchEntry = Readonly<{ type: string; id: string; timestamp?: string; message?: { role?: string; content?: unknown } }>;

const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(block => {
    const { type, text } = (block ?? {}) as { type?: string; text?: unknown };
    return type === 'text' ? String(text ?? '') : type === 'image' ? '[image]' : '';
  }).filter(Boolean).join('\n') : '';

/**
 * Every user message on the branch before the first kept entry. Messages from
 * the kept entry on stay verbatim in the context. When that entry is not on
 * the branch, every user message is carried: a duplicate costs less than a
 * lost instruction.
 */
export const collectLedger = (branch: readonly BranchEntry[], firstKeptEntryId: string): LedgerItem[] => {
  const cut = branch.findIndex(entry => entry.id === firstKeptEntryId);
  return (cut < 0 ? branch : branch.slice(0, cut)).flatMap(entry => {
    if (entry.type !== 'message' || entry.message?.role !== 'user') return [];
    const full = textOf(entry.message.content).trim();
    if (!full) return [];
    const text = full.slice(0, LEDGER_MESSAGE_CHARS);
    return [{ entryId: entry.id, timestamp: entry.timestamp ?? '', text, truncatedChars: full.length - text.length }];
  });
};

const stamp = (timestamp: string): string => timestamp.slice(0, 16).replace('T', ' ');

export const renderLedger = (items: readonly LedgerItem[]): string => !items.length ? '' : [
  LEDGER_HEADER,
  ...items.map(item => `[${stamp(item.timestamp)} · ${item.entryId}] ${item.text}${item.truncatedChars
    ? ` … [+${item.truncatedChars.toLocaleString('en-US')} chars; full text in session entry ${item.entryId}]` : ''}`),
].join('\n');

const FILE_BLOCK = /\n*<(?:read|modified)-files>/u;

/** Removes a carried ledger, so a summarizer is not asked to merge it and a summary never holds two. */
export const stripLedger = (summary: string): string => {
  const at = summary.indexOf(LEDGER_HEADER);
  if (at < 0) return summary;
  const rest = summary.slice(at);
  const end = rest.search(FILE_BLOCK);
  return `${summary.slice(0, at).trimEnd()}${end < 0 ? '' : `\n\n${rest.slice(end).trimStart()}`}`;
};

/** The summary with the ledger placed after the prose and before Pi's file lists. */
export const withLedger = (summary: string, items: readonly LedgerItem[]): string => {
  const clean = stripLedger(summary);
  const ledger = renderLedger(items);
  if (!ledger) return clean;
  const at = clean.search(FILE_BLOCK);
  return at < 0 ? `${clean.trimEnd()}\n\n${ledger}`
    : `${clean.slice(0, at).trimEnd()}\n\n${ledger}\n\n${clean.slice(at).trimStart()}`;
};

export const ledgerDetails = (items: readonly LedgerItem[]) => ({
  messages: items.length,
  characters: items.reduce((sum, item) => sum + item.text.length, 0),
});
