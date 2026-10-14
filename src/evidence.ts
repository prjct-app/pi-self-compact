/**
 * An index of the evidence a compaction removes, by entry id.
 *
 * After a compaction the model sees the summary, not the tool output, and it
 * tends to guess instead of looking things up: in measured sessions it asked
 * for paths that do not exist twice as often right after a compaction as
 * 200 calls later. The index tells it what exists and where: the latest state
 * of each file the span touched, and each failed call or command. It is built
 * mechanically from the session branch, and the entries stay in the journal,
 * so any of them can be read back by id.
 *
 * Files are listed for the whole session, at their latest state: the
 * summary is rewritten on every compaction and drops things. In a live test
 * a file read before the first compaction was gone from the summary after the
 * second, and the model then said it had never read a file. Failures are
 * listed for this span only, and successful commands not at all: listing
 * every command measured 3.5k tokens at the median and 49k at worst. The
 * file section replaces Pi's <read-files>/<modified-files> lists in the
 * summary text (the same paths, now with ids); the compaction details keep
 * them for Pi.
 */

export const EVIDENCE_HEADER = '## Evidence index (session entry ids; their full text stays in the session journal)';

type Block = { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Entry = Readonly<{ type: string; id: string; firstKeptEntryId?: string; message?: {
  role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean } }>;

const FILE_TOOLS = new Set(['read', 'edit', 'write']);
const COMMAND_CHARS = 120;
const ERROR_CHARS = 120;

const blocks = (content: unknown): Block[] => Array.isArray(content) ? content.filter(block => block && typeof block === 'object') as Block[] : [];
const text = (content: unknown): string => typeof content === 'string' ? content
  : blocks(content).map(block => block.type === 'text' ? String((block as { text?: unknown }).text ?? '') : '').join('\n');
const oneLine = (value: string, max: number): string => {
  const flat = value.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};
const lineCount = (value: string): number => value ? value.split('\n').length : 0;
const exitCode = (output: string): string | undefined => /exit(?:ed with)? (?:code|status) (-?\d+)/iu.exec(output)?.[1];

type Call = Readonly<{ entryId: string; name: string; args: Record<string, unknown> }>;

/** The span this compaction summarizes: after the previous compaction's kept boundary, before this one. */
const spanStart = (branch: readonly Entry[], cut: number): number => {
  const previous = [...branch.slice(0, cut)].reverse().find(entry => entry.type === 'compaction');
  if (!previous?.firstKeptEntryId) return 0;
  const at = branch.findIndex(entry => entry.id === previous.firstKeptEntryId);
  return at < 0 ? 0 : at;
};

export const evidenceIndex = (branch: readonly Entry[], firstKeptEntryId: string, cwd?: string): string[] => {
  const shown = (path: string): string => cwd && path.startsWith(`${cwd.replace(/\/+$/u, '')}/`) ? path.slice(cwd.replace(/\/+$/u, '').length + 1) : path;
  const found = branch.findIndex(entry => entry.id === firstKeptEntryId);
  const cut = found < 0 ? branch.length : found;
  const start = spanStart(branch, cut);
  const calls = new Map<string, Call>();
  const files = new Map<string, string>();
  const commands = new Map<string, string>();
  const failures: string[] = [];
  branch.slice(0, cut).forEach((entry, index) => {
    const message = entry.type === 'message' ? entry.message : undefined;
    if (message?.role === 'assistant') {
      for (const block of blocks(message.content)) {
        if (block.type === 'toolCall' && block.id && block.name) calls.set(block.id, { entryId: entry.id, name: block.name, args: block.arguments ?? {} });
      }
      return;
    }
    if (message?.role !== 'toolResult' || !message.toolCallId) return;
    const call = calls.get(message.toolCallId);
    if (!call) return;
    const output = text(message.content);
    const path = typeof call.args.path === 'string' ? call.args.path : typeof call.args.file_path === 'string' ? call.args.file_path : undefined;
    if (FILE_TOOLS.has(call.name) && path && !message.isError) {
      files.delete(path);
      files.set(path, call.name === 'read' ? `[${entry.id}] read ${shown(path)} · ${lineCount(output)} lines` : `[${call.entryId}] ${call.name} ${shown(path)}`);
    }
    if (index < start) return;
    if (call.name === 'bash' && typeof call.args.command === 'string') {
      // The latest run of a command decides: a failure fixed later is not listed.
      const command = oneLine(call.args.command, COMMAND_CHARS);
      const code = exitCode(output);
      commands.delete(command);
      if (message.isError) commands.set(command, `[${entry.id}] $ ${command} → failed${code ? ` (exit ${code})` : ''}`);
      return;
    }
    if (message.isError) failures.push(`[${entry.id}] ${call.name}${path ? ` ${shown(path)}` : ''} failed: ${oneLine(output, ERROR_CHARS)}`);
  });
  return [
    ...(files.size ? ['Files touched in this session (latest state):', ...files.values()] : []),
    ...(commands.size ? ['Commands whose latest run failed:', ...commands.values()] : []),
    ...(failures.length ? ['Failed calls in this span:', ...failures] : []),
  ];
};

export const renderEvidence = (lines: readonly string[], reader?: string): string => !lines.length ? ''
  : [EVIDENCE_HEADER, ...(reader ? [`Read any of them with ${reader}.`] : []), ...lines].join('\n');
