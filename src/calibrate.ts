import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Per-model compaction thresholds, measured on this machine's own sessions.
 *
 * Models degrade at different context sizes: measured on real sessions, one
 * model's failed edits (the edit text did not match the file, so the model
 * believed something false) went from 6% under 100k to 14-21% above it, while
 * others stayed flat to 200k. A fixed threshold is wrong for one or the other,
 * and a table of model ids would not know the models a user actually runs.
 * So the journals are scanned incrementally, failed edits are counted per
 * model and context size, and the threshold is the start of the first band
 * where they rise clearly and stay up. No band, no data: Pi's own threshold.
 */

export const BAND = 50_000;
const BASELINE_BELOW = 100_000;
const MIN_BAND_EDITS = 40;
const MIN_BASELINE_EDITS = 60;
const RISE = 1.5;
const RISE_POINTS = 0.03;
const SLICE_MS = 12;
const MISMATCH = /(could not find|oldText|not found in|no match|did not match|must match exactly)/iu;

type Band = { edits: number; failed: number };
export type Calibration = Readonly<{ v: 1; files: Readonly<Record<string, number>>; models: Readonly<Record<string, Readonly<Record<string, Band>>>> }>;
export const EMPTY_CALIBRATION: Calibration = { v: 1, files: {}, models: {} };

export const calibrationPath = (agentDir: string): string => join(agentDir, 'self-compact', 'calibration.json');

export const loadCalibration = async (path: string): Promise<Calibration> => {
  const value = await readFile(path, 'utf8').then(text => JSON.parse(text) as Calibration, () => undefined);
  return value?.v === 1 && value.files && value.models ? value : EMPTY_CALIBRATION;
};

/**
 * The context size from which this model's failed edits rise at least 1.5x
 * (and 3 points) over its own rate below 100k, in two consecutive bands (or
 * the last band with data), or undefined when there is no such rise or too
 * little data.
 */
export const thresholdFor = (bands: Readonly<Record<string, Band>> | undefined): number | undefined => {
  if (!bands) return undefined;
  const rows = Object.entries(bands).map(([start, band]) => ({ start: Number(start), ...band })).sort((a, b) => a.start - b.start);
  const base = rows.filter(row => row.start < BASELINE_BELOW).reduce((sum, row) => ({ edits: sum.edits + row.edits, failed: sum.failed + row.failed }), { edits: 0, failed: 0 });
  if (base.edits < MIN_BASELINE_EDITS) return undefined;
  const baseline = base.failed / base.edits;
  const high = (row: { edits: number; failed: number }) => row.edits >= MIN_BAND_EDITS
    && row.failed / row.edits >= Math.max(baseline * RISE, baseline + RISE_POINTS);
  const candidates = rows.filter(row => row.start >= BASELINE_BELOW && row.edits >= MIN_BAND_EDITS);
  const found = candidates.find((row, index) => high(row) && (index === candidates.length - 1 || high(candidates[index + 1]!)));
  return found?.start;
};

const pause = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

type Counter = Record<string, Record<string, Band>>;
const bump = (models: Counter, model: string, band: number, failed: boolean): void => {
  const bands = models[model] ?? (models[model] = {});
  const row = bands[String(band)] ?? (bands[String(band)] = { edits: 0, failed: 0 });
  row.edits += 1;
  if (failed) row.failed += 1;
};

const CHUNK = 8 * 1024 * 1024;

/** Counts the edits in the complete lines of one journal after `offset`. Returns the new offset. */
const scanJournal = async (path: string, offset: number, models: Counter): Promise<number> => {
  const size = (await stat(path).catch(() => undefined))?.size ?? 0;
  if (size < offset) return 0;
  if (size === offset) return offset;
  const handle = await open(path, 'r');
  try {
    const calls = new Map<string, { model: string; band: number }>();
    const state = { position: offset, done: offset, pending: '' };
    const clock = { started: performance.now() };
    while (state.position < size) {
      const buffer = Buffer.alloc(Math.min(CHUNK, size - state.position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.position);
      if (!bytesRead) break;
      state.position += bytesRead;
      const text = state.pending + buffer.toString('utf8', 0, bytesRead);
      const end = text.lastIndexOf('\n');
      if (end < 0) { state.pending = text; continue; }
      state.pending = text.slice(end + 1);
      state.done = state.position - Buffer.byteLength(state.pending);
      for (const line of text.slice(0, end).split('\n')) {
        if (performance.now() - clock.started > SLICE_MS) { await pause(); clock.started = performance.now(); }
        if (!line.includes('"edit"')) continue;
        const entry = (() => { try { return JSON.parse(line) as { type?: string; message?: any }; } catch { return undefined; } })();
        const message = entry?.type === 'message' ? entry.message : undefined;
        if (message?.role === 'assistant' && message.provider && message.model) {
          const usage = message.usage ?? {};
          const context = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          if (!context) continue;
          for (const block of message.content ?? []) {
            if (block?.type === 'toolCall' && block.name === 'edit' && block.id) calls.set(block.id, { model: `${message.provider}/${message.model}`, band: Math.floor(context / BAND) * BAND });
          }
        } else if (message?.role === 'toolResult' && calls.has(message.toolCallId)) {
          const call = calls.get(message.toolCallId)!;
          const output = (message.content ?? []).map((block: { text?: string }) => block?.text ?? '').join('').slice(0, 600);
          bump(models, call.model, call.band, Boolean(message.isError) && MISMATCH.test(output));
        }
      }
    }
    return state.done;
  } finally {
    await handle.close();
  }
};

const journals = async (root: string): Promise<string[]> => {
  const top = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(top.map(async entry => entry.isDirectory()
    ? (await readdir(join(root, entry.name)).catch(() => [] as string[])).filter(name => name.endsWith('.jsonl')).map(name => join(root, entry.name, name))
    : entry.name.endsWith('.jsonl') ? [join(root, entry.name)] : []));
  return nested.flat();
};

/**
 * Brings the calibration up to date with whatever the journals gained since
 * the last scan. One process at a time (a lock directory that expires);
 * returns the calibration as it stands.
 */
export const updateCalibration = async (agentDir: string, sessionsRoot = join(agentDir, 'sessions'), now = Date.now()): Promise<Calibration> => {
  const path = calibrationPath(agentDir);
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const held = await stat(lock).then(info => now - info.mtimeMs < 10 * 60_000, () => false);
  if (held) return loadCalibration(path);
  if (!(await mkdir(lock).then(() => true, () => false))) return loadCalibration(path);
  try {
    const current = await loadCalibration(path);
    const models = JSON.parse(JSON.stringify(current.models)) as Counter;
    const files: Record<string, number> = { ...current.files };
    for (const journal of await journals(sessionsRoot)) {
      files[journal] = await scanJournal(journal, files[journal] ?? 0, models).catch(() => files[journal] ?? 0);
    }
    const next: Calibration = { v: 1, files, models };
    await writeFile(`${path}.tmp`, JSON.stringify(next));
    await rename(`${path}.tmp`, path);
    return next;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
};
