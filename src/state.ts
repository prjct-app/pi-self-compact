/**
 * The project state: what a long session carries instead of a summary of a
 * summary.
 *
 * Rewriting the summary on every compaction loses things on every pass. In a
 * replay of three real sessions (61 compactions) only 24-26% of the user's
 * early rules survived. Here the model edits the state item by item after each
 * run (add, update, resolve), and nothing is regenerated, so nothing drifts:
 * in the same replay 67-87% survived and no rule was invented. Rules quote the
 * user's own message, copied by the host from the session branch. Resolved
 * items are dropped from the rendering only; they stay in the journal.
 */

export const STATE_ENTRY = 'self-compact-state';
export const STATE_HEADER = '## Project state (edited item by item; older history stays in the session journal)';
/** Past this rendered size the model reviews the state and closes what no longer matters. */
export const REVIEW_CHARS = 24_000;
const QUOTE_CHARS = 1_500;
const PREVIEW_CHARS = 300;

export type ItemKind = 'rule' | 'decision' | 'open' | 'fact';
const KINDS: readonly ItemKind[] = ['rule', 'decision', 'open', 'fact'];
export type Item = Readonly<{ id: string; kind: ItemKind; text: string; source?: string; at: string; resolved?: string }>;
export type ProjectState = Readonly<{ v: 1; items: readonly Item[]; next: number; through?: string }>;

export const EMPTY_STATE: ProjectState = { v: 1, items: [], next: 1 };

type Entry = Readonly<{ type: string; id: string; timestamp?: string; customType?: string; data?: unknown;
  message?: { role?: string; content?: unknown } }>;

const isState = (value: unknown): value is ProjectState => !!value && typeof value === 'object'
  && (value as ProjectState).v === 1 && Array.isArray((value as ProjectState).items) && typeof (value as ProjectState).next === 'number';

/** The latest state saved on this branch. */
export const restoreState = (branch: readonly Entry[]): ProjectState => {
  const saved = [...branch].reverse().find(entry => entry.type === 'custom' && entry.customType === STATE_ENTRY && isState(entry.data));
  return saved ? saved.data as ProjectState : EMPTY_STATE;
};

const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(block => (block as { type?: string; text?: unknown })?.type === 'text' ? String((block as { text?: unknown }).text ?? '') : '').join('\n') : '';

/** The user's own messages on the branch, by entry id. */
export const userMessages = (branch: readonly Entry[]): Map<string, string> => new Map(branch.flatMap(entry =>
  entry.type === 'message' && entry.message?.role === 'user' ? [[entry.id, textOf(entry.message.content).trim()] as [string, string]] : []));

/** A user message is quoted when it is the user's words, not a pasted skill or log. */
const quotable = (text: string | undefined): string | undefined =>
  text && text.length <= QUOTE_CHARS && !text.startsWith('<skill') ? text : undefined;

/** The entries since the state was last updated: what the next fold covers. */
export const unfolded = <E extends Entry>(branch: readonly E[], state: ProjectState, until?: string): E[] => {
  const from = state.through ? branch.findIndex(entry => entry.id === state.through) + 1 : 0;
  const to = until ? branch.findIndex(entry => entry.id === until) : -1;
  return branch.slice(Math.max(0, from), to < 0 ? branch.length : to);
};

const live = (state: ProjectState) => state.items.filter(item => !item.resolved);

/** The state as the model reads it when editing: live items, rules with the start of the user's words. */
const stateForModel = (state: ProjectState, users: ReadonlyMap<string, string>) => JSON.stringify(live(state).map(item => ({
  id: item.id, kind: item.kind, at: item.at.slice(0, 10),
  text: item.kind === 'rule' && item.source ? `${item.text} [user message ${item.source}: "${(users.get(item.source) ?? '').slice(0, PREVIEW_CHARS)}"]` : item.text,
})));

export const FOLD_PROMPT = `You maintain the project state of this long-running session. The state is what the session carries into later work; older turns will leave the context. Return only a JSON array of edits for what happened since the state was last updated:
- {"op":"add","kind":"rule"|"decision"|"open"|"fact","text":"...","source":"<user message id>"}: "rule" is a standing instruction, constraint, prohibition, preference or authorization; when it comes from a user message, give that message's id as "source" (the host copies the user's exact words) and keep "text" to a short gloss. "decision" is a choice with its reason. "open" is unfinished work. "fact" is an identifier later work needs (PR numbers, branches, URLs, ticket ids, environment facts).
- {"op":"resolve","id":"<item id>","reason":"..."}: open work that is done, or a rule, decision or fact that was explicitly replaced or no longer holds, only when the conversation shows it.
- {"op":"update","id":"<item id>","text":"..."}
Record only what will matter later, never routine progress. Do not repeat what the state already holds. Write plain, complete sentences. Return [] when nothing changes.`;

export const REVIEW_PROMPT = `The project state of this long-running session has grown. Review it and return only a JSON array of edits that keep what later work needs:
- {"op":"resolve","id":"...","reason":"..."} for open work the state shows done or abandoned, facts that are stale or superseded by a newer item, decisions replaced by later ones, and duplicates (keep the newest).
- {"op":"update","id":"...","text":"..."} to merge near-duplicates into one item.
Never resolve or reword a rule: rules change only when the user replaces them. Resolved items stay in the session journal, so closing an item loses nothing. Return [] if everything still matters.`;

/** The fold request: the instructions, the current state, and the user's messages in the span by id. */
export const foldTask = (state: ProjectState, users: ReadonlyMap<string, string>, span: readonly Entry[], transcript = ''): string => {
  const asked = span.filter(entry => entry.type === 'message' && entry.message?.role === 'user')
    .map(entry => `- ${entry.id}: ${(users.get(entry.id) ?? '').slice(0, 600).replace(/\s+/gu, ' ')}`);
  return [FOLD_PROMPT, '', 'Current state:', stateForModel(state, users),
    ...(asked.length ? ['', 'User messages since the last update (by id):', ...asked] : []),
    ...(transcript ? ['', '<transcript>', transcript, '</transcript>'] : ['', 'Fold the part of the conversation above that came after the last update.']),
  ].join('\n');
};

export const reviewTask = (state: ProjectState, users: ReadonlyMap<string, string>): string =>
  `${REVIEW_PROMPT}\n\nState:\n${stateForModel(state, users)}`;

type Op = Readonly<{ op?: unknown; kind?: unknown; text?: unknown; source?: unknown; id?: unknown; reason?: unknown }>;

export const parseOps = (text: string): Op[] => {
  const start = text.indexOf('['); const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('No JSON array in the state edit.');
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(value)) throw new Error('The state edit is not an array.');
  return value.filter(op => op && typeof op === 'object') as Op[];
};

/** Applies the model's edits. Unknown ids and malformed edits are ignored; a review never touches rules. */
export const applyOps = (state: ProjectState, ops: readonly Op[], at: string, users: ReadonlyMap<string, string>, review = false): ProjectState =>
  ops.reduce<ProjectState>((current, op) => {
    if (op.op === 'add' && !review && KINDS.includes(op.kind as ItemKind) && typeof op.text === 'string' && op.text.trim()) {
      const source = typeof op.source === 'string' && users.has(op.source) ? op.source : undefined;
      const item: Item = { id: `s${current.next}`, kind: op.kind as ItemKind, text: op.text.trim(), at, ...(source ? { source } : {}) };
      return { ...current, items: [...current.items, item], next: current.next + 1 };
    }
    const target = current.items.find(item => item.id === op.id && !item.resolved);
    if (!target || (review && target.kind === 'rule')) return current;
    const replace = (next: Item) => ({ ...current, items: current.items.map(item => item.id === target.id ? next : item) });
    if (op.op === 'resolve') return replace({ ...target, resolved: typeof op.reason === 'string' && op.reason ? op.reason : 'resolved' });
    if (op.op === 'update' && typeof op.text === 'string' && op.text.trim()) return replace({ ...target, text: op.text.trim() });
    return current;
  }, state);

/** The state as the agent reads it after a compaction. */
export const renderState = (state: ProjectState, users: ReadonlyMap<string, string>): string => {
  const items = live(state);
  const section = (title: string, kind: ItemKind) => {
    const rows = items.filter(item => item.kind === kind).map(item => {
      const words = item.kind === 'rule' ? quotable(item.source ? users.get(item.source) : undefined) : undefined;
      return words
        ? `- [${item.id} · ${item.at.slice(0, 10)} · user message ${item.source}] "${words}"${item.text ? ` (${item.text})` : ''}`
        : `- [${item.id} · ${item.at.slice(0, 10)}] ${item.text}`;
    });
    return rows.length ? [`### ${title}`, ...rows].join('\n') : '';
  };
  const body = [section('Rules and constraints', 'rule'), section('Decisions', 'decision'), section('Open work', 'open'), section('Facts', 'fact')].filter(Boolean);
  return body.length ? [STATE_HEADER, ...body].join('\n\n') : '';
};

export const stateDetails = (state: ProjectState, rendered: string) => ({
  items: live(state).length,
  rules: live(state).filter(item => item.kind === 'rule').length,
  characters: rendered.length,
});
