/**
 * The user's own messages that still apply, carried verbatim through every
 * compaction.
 *
 * Each compaction merges the previous summary, so a constraint the user
 * stated once is paraphrased again on every pass until it falls out. In a
 * measured session it was gone after 21 compactions, and the agent then did
 * what it forbade. Carrying every message forever has the opposite problem:
 * finished tasks and "continue" stay in the context for weeks.
 *
 * So the summarizer (the session's own model) chooses which messages still
 * apply, by id, and the host copies their text from the session branch. The
 * model decides relevance; it never rewrites the words. A message it drops
 * stays in the journal, searchable, and is not offered again.
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
export const collectLedger = (branch: readonly BranchEntry[], firstKeptEntryId: string, dropped: ReadonlySet<string> = new Set()): LedgerItem[] => {
  const cut = branch.findIndex(entry => entry.id === firstKeptEntryId);
  return (cut < 0 ? branch : branch.slice(0, cut)).flatMap(entry => {
    if (entry.type !== 'message' || entry.message?.role !== 'user' || dropped.has(entry.id)) return [];
    const full = textOf(entry.message.content).trim();
    // An expanded skill is the skill's text, not the user's words; it stays loadable on its own.
    if (!full || full.startsWith('<skill')) return [];
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

type CompactionEntry = Readonly<{ type: string; details?: unknown }>;

/** Messages an earlier compaction judged no longer applicable; they are not offered again. */
export const droppedBefore = (branch: readonly CompactionEntry[]): Set<string> => {
  const latest = [...branch].reverse().find(entry => entry.type === 'compaction'
    && Array.isArray((entry.details as { selfCompact?: { ledger?: { dropped?: unknown } } } | undefined)?.selfCompact?.ledger?.dropped));
  const ids = (latest?.details as { selfCompact: { ledger: { dropped: unknown[] } } } | undefined)?.selfCompact.ledger.dropped ?? [];
  return new Set(ids.filter((id): id is string => typeof id === 'string'));
};

const KEEP = /<keep-user-messages>([\s\S]*?)<\/keep-user-messages>/u;
const PREVIEW_CHARS = 300;

/** What the summarizer is asked to add: the candidates by id, and one line naming those that still apply. */
export const selectionInstructions = (candidates: readonly LedgerItem[]): string => !candidates.length ? '' : [
  'The user\'s own messages from the part being summarized, by id (start of each message):',
  ...candidates.map(item => `- ${item.entryId}: ${item.text.slice(0, PREVIEW_CHARS).replace(/\s+/gu, ' ')}${item.text.length > PREVIEW_CHARS || item.truncatedChars ? ' …' : ''}`),
  'After the summary, end with exactly one line: <keep-user-messages>ids separated by spaces</keep-user-messages>. '
    + 'List the messages whose words still apply: the active goal, standing rules, constraints, preferences, authorizations, '
    + 'and corrections not superseded. Leave out messages about work that is finished or replaced, and purely conversational ones '
    + '("continue", "ok", a pasted log already handled). When unsure whether one still applies, keep it. '
    + 'The host copies the kept messages verbatim after your summary; do not copy them yourself.',
].join('\n');

export type Selection = Readonly<{ summary: string; items: LedgerItem[]; selected: 'model' | 'all'; dropped: string[] }>;

/**
 * Applies the summarizer's choice. Without a readable choice every candidate
 * is kept: a missing line must never lose an instruction.
 */
export const applySelection = (summary: string, candidates: readonly LedgerItem[], previouslyDropped: ReadonlySet<string>): Selection => {
  const match = KEEP.exec(summary);
  const clean = match ? `${summary.slice(0, match.index)}${summary.slice(match.index + match[0].length)}`.replace(/\n{3,}/gu, '\n\n').trim() : summary;
  if (!match) return { summary: clean, items: [...candidates], selected: 'all', dropped: [...previouslyDropped] };
  const named = new Set(match[1]!.match(/[A-Za-z0-9_-]+/gu) ?? []);
  const items = candidates.filter(item => named.has(item.entryId));
  const dropped = [...new Set([...previouslyDropped, ...candidates.filter(item => !named.has(item.entryId)).map(item => item.entryId)])];
  return { summary: clean, items, selected: 'model', dropped };
};

export const ledgerDetails = (selection: Pick<Selection, 'items' | 'selected' | 'dropped'>) => ({
  messages: selection.items.length,
  characters: selection.items.reduce((sum, item) => sum + item.text.length, 0),
  selected: selection.selected,
  dropped: selection.dropped,
});
