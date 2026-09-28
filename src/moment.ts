import type { JevAnswer } from './jev.ts';

/**
 * Whether now is a good moment to compact. Numbers stay in code (the token
 * lines); Jev only judges the work: did the request move on, did the last
 * turn finish something, is an edit half done. Adapted from Level 7 of
 * disler/ten-levels-of-jev (MIT).
 */
export const MOMENT_QUESTIONS = {
  switched_gears: {
    type: 'noul' as const,
    instructions: 'Is `current_request` a different task from `previous_requests`?',
    criteria: {
      true: 'A new feature, a different file area, a different goal, or an unrelated question',
      false: 'The same task continuing, a follow up, a fix to what was just done',
    },
  },
  at_boundary: {
    type: 'noul' as const,
    instructions: 'Did `recent_turn` finish a unit of work?',
    criteria: {
      true: 'Tests passed, a commit was made, a summary was given, or a question was asked of the user',
      false: 'Mid task, more steps clearly remain',
    },
  },
  mid_operation: {
    type: 'noul' as const,
    instructions: 'Is the agent in the middle of a multi step edit whose partial state only exists in the conversation?',
    criteria: {
      true: 'Half applied changes, a plan being executed step by step, an unfinished refactor',
      false: 'A clean point, nothing half done',
    },
  },
};

/**
 * - moved_on: the request changed and the last turn finished: the old context is dead weight.
 * - clean: the last turn finished something and nothing is half done.
 * - busy: an edit is half applied; compacting now would lose it.
 * - continuing: none of the above.
 */
export type Verdict = 'moved_on' | 'clean' | 'busy' | 'continuing';

export type MomentState = Readonly<{
  current_request: string;
  previous_requests: readonly string[];
  recent_turn: string;
  tools_this_turn: readonly string[];
}>;

const noulOf = (answer: JevAnswer | undefined): number | undefined => answer?.type === 'noul' ? answer.noul : undefined;

export const verdictOf = (answers: Readonly<Record<string, JevAnswer>>): Verdict | undefined => {
  const switched = noulOf(answers.switched_gears);
  const boundary = noulOf(answers.at_boundary);
  const busy = noulOf(answers.mid_operation);
  if (switched === undefined || boundary === undefined || busy === undefined) return undefined;
  if (busy > 0.6) return 'busy';
  if (busy >= 0.4 || boundary <= 0.6) return 'continuing';
  return switched > 0.7 ? 'moved_on' : 'clean';
};

type Entry = Readonly<{ type: string; message?: Readonly<{ role?: string; content?: unknown }> }>;

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';

/**
 * What Jev reads, built in code from the branch since the last compaction:
 * the requests, clipped, and the last turn's prose and tools. Never the
 * tool results: they are the bulk of the context and say nothing about intent.
 */
export const momentState = (branch: readonly Entry[]): MomentState | undefined => {
  const cut = branch.map(entry => entry.type).lastIndexOf('compaction');
  const messages = branch.slice(cut + 1).flatMap(entry => entry.type === 'message' && entry.message ? [entry.message] : []);
  const requests = messages.filter(message => message.role === 'user').map(message => textOf(message.content).trim()).filter(Boolean);
  const current = requests.at(-1);
  if (!current || requests.length < 2) return undefined;
  const lastUser = messages.map(message => message.role).lastIndexOf('user');
  const turn = messages.slice(lastUser + 1).filter(message => message.role === 'assistant');
  const tools = [...new Set(turn.flatMap(message => Array.isArray(message.content)
    ? message.content.flatMap(part => part?.type === 'toolCall' && typeof part.name === 'string' ? [part.name] : []) : []))];
  const prose = turn.map(message => textOf(message.content)).filter(Boolean).at(-1) ?? '';
  return {
    current_request: clip(current, 600),
    previous_requests: requests.slice(-6, -1).map(request => clip(request, 200)),
    recent_turn: clip(prose || `(tool calls only: ${tools.join(', ') || 'none'})`, 600),
    tools_this_turn: tools.slice(0, 20),
  };
};

/** One extra line for the warning guidance, only when it changes what the agent should do. */
export const momentLine = (verdict: Verdict | undefined): string | undefined =>
  verdict === 'clean' || verdict === 'moved_on'
    ? 'This is a clean checkpoint: the last turn finished a unit of work and nothing is half done. Write your note_to_self and call self_compact now, before the hard cutoff interrupts a multi-step edit.'
    : undefined;
