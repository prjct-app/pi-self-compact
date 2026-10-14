/**
 * The files the whole session read and changed, for the summary's
 * <read-files>/<modified-files> lists.
 *
 * Pi carries these lists forward only from its own compactions; a summary an
 * extension wrote is skipped. So after a cache-shared compaction the next
 * summary listed only its own span: in a live test a file read before the
 * first compaction was gone after the second, and the model then said it had
 * never read a file. The lists are rebuilt from the session branch instead.
 */

type FileOps = Readonly<{ read: Set<string>; written: Set<string>; edited: Set<string> }>;
type Entry = Readonly<{ type: string; id: string; message?: { role?: string; content?: unknown } }>;

export const branchFileOps = (branch: readonly Entry[], firstKeptEntryId: string, current?: FileOps): FileOps => {
  const found = branch.findIndex(entry => entry.id === firstKeptEntryId);
  const ops = { read: new Set(current?.read ?? []), written: new Set(current?.written ?? []), edited: new Set(current?.edited ?? []) };
  for (const entry of branch.slice(0, found < 0 ? branch.length : found)) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content as { type?: string; name?: string; arguments?: { path?: unknown } }[]) {
      const path = block?.arguments?.path;
      if (block?.type !== 'toolCall' || typeof path !== 'string') continue;
      if (block.name === 'read') ops.read.add(path);
      else if (block.name === 'write') ops.written.add(path);
      else if (block.name === 'edit') ops.edited.add(path);
    }
  }
  return ops;
};
