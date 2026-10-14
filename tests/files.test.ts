import assert from 'node:assert/strict';
import { test } from 'node:test';
import { branchFileOps } from '../src/files.ts';

const call = (id: string, name: string, path: string) => ({ type: 'message', id, message: { role: 'assistant', content: [{ type: 'toolCall', id: `c-${id}`, name, arguments: { path } }] } });

test('file lists cover the whole session, not only the span being compacted', () => {
  const branch: any[] = [
    call('a1', 'read', 'config.env.txt'), call('a2', 'edit', 'src/a.ts'),
    { type: 'compaction', id: 'k1', firstKeptEntryId: 'a3', details: { selfCompact: { summary: 'cache-shared' } } },
    call('a3', 'write', 'src/b.ts'), call('a4', 'read', 'src/a.ts'),
    { type: 'compaction', id: 'k2', firstKeptEntryId: 'a5' },
    { type: 'message', id: 'a5', message: { role: 'user', content: 'sigue' } }, call('a6', 'read', 'kept.ts'),
  ];
  const span = { read: new Set(['src/a.ts']), written: new Set<string>(), edited: new Set<string>() };
  const ops = branchFileOps(branch, 'a5', span);
  assert.deepEqual([...ops.read].sort(), ['config.env.txt', 'src/a.ts'], 'a file read before an earlier compaction stays listed; kept entries are not counted');
  assert.deepEqual([...ops.edited], ['src/a.ts'], 'a file edited and later read is still modified');
  assert.deepEqual([...ops.written], ['src/b.ts']);
});
