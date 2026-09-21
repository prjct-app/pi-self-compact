/**
 * Self-compact thresholds. Adapted from disler/self-compact-pi-agent
 * (MIT, Copyright (c) 2026 IndyDevDan).
 *
 * Each line is a token count (`270000`, `100k`, `1.5m`) or a percentage of the
 * model window (`20%`). Context rot follows tokens, not window share, so the
 * defaults are absolute and only clamp down on small windows.
 */

export type ThresholdSpecs = Readonly<{
  /** --compact-soft-at: notice line, awareness only. */
  softAt: string;
  /** --compact-at: warning line, write the note and compact soon. */
  at: string;
  /** --compact-buffer: allowance above the warning before every other tool is blocked. */
  buffer: string;
}>;

export const DEFAULT_SPECS: ThresholdSpecs = { softAt: '100k', at: '150k', buffer: '30k' };

/** Default lines never sit above these window fractions, so a 128k model still has room to work. */
export const DEFAULT_CAPS = { soft: 0.5, warn: 0.65, forced: 0.8 } as const;

/** No line, default or explicit, sits above this window fraction. */
export const HARD_CAP_FRACTION = 0.9;

export type Level = 'unknown' | 'idle' | 'notice' | 'warning' | 'forced';

export const LEVEL_ORDER: Readonly<Record<Level, number>> = { unknown: -1, idle: 0, notice: 1, warning: 2, forced: 3 };

export type Spec = Readonly<{ kind: 'tokens' | 'percent'; value: number; raw: string }>;

export const SPEC_HELP = 'Use whole tokens (270000), k/m suffixes (100k, 1.5m), or a percentage (20%).';

export const parseSpec = (raw: string, label: string): Spec => {
  const text = raw.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(k|m|%)?$/iu.exec(text);
  if (!match) throw new Error(`Invalid ${label}: "${text}". ${SPEC_HELP}`);
  const value = Number(match[1]);
  const suffix = (match[2] ?? '').toLowerCase();
  if (suffix === '%') {
    if (value > 100) throw new Error(`Invalid ${label}: "${text}" is above 100%.`);
    return { kind: 'percent', value, raw: text };
  }
  if (!suffix && !Number.isInteger(value)) throw new Error(`Invalid ${label}: "${text}" must be a whole token count. ${SPEC_HELP}`);
  const scale = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  return { kind: 'tokens', value: Math.round(value * scale), raw: text };
};

export type Thresholds = Readonly<{
  window: number;
  softTokens: number;
  warnTokens: number;
  forcedTokens: number;
  softPct: number;
  warnPct: number;
  forcedPct: number;
  /** True when a default line was lowered to fit the window. */
  clamped: boolean;
}>;

export type Resolution = Readonly<{ ok: true; thresholds: Thresholds } | { ok: false; error: string }>;

/**
 * forced = min(warning + buffer, cap). Explicit settings that break
 * soft < warning <= forced are rejected; defaults are clamped instead.
 */
export const resolveThresholds = (specs: ThresholdSpecs, window: number, fromDefaults: boolean): Resolution => {
  try {
    if (!Number.isSafeInteger(window) || window <= 0) return { ok: false, error: 'The active model does not report a context window.' };
    const soft = parseSpec(specs.softAt, '--compact-soft-at');
    const warn = parseSpec(specs.at, '--compact-at');
    const buffer = parseSpec(specs.buffer, '--compact-buffer');
    const tokens = (spec: Spec): number => spec.kind === 'percent' ? Math.floor(spec.value / 100 * window) : spec.value;
    const hardCap = Math.floor(HARD_CAP_FRACTION * window);
    const caps = fromDefaults
      ? { soft: Math.floor(DEFAULT_CAPS.soft * window), warn: Math.floor(DEFAULT_CAPS.warn * window), forced: Math.floor(DEFAULT_CAPS.forced * window) }
      : { soft: hardCap, warn: hardCap, forced: hardCap };
    const rawSoft = tokens(soft);
    const rawWarn = tokens(warn);
    const rawForced = rawWarn + tokens(buffer);
    if (!fromDefaults && rawWarn > hardCap) {
      return { ok: false, error: `--compact-at (${warn.raw}) is above the ${HARD_CAP_FRACTION * 100}% cap of a ${window}-token window.` };
    }
    if (!fromDefaults && rawSoft >= rawWarn) {
      return { ok: false, error: `--compact-soft-at (${soft.raw}) must be below --compact-at (${warn.raw}).` };
    }
    const softTokens = Math.min(rawSoft, caps.soft);
    const warnTokens = Math.min(rawWarn, caps.warn);
    const forcedTokens = Math.min(rawForced, caps.forced);
    const pct = (value: number): number => value / window * 100;
    return { ok: true, thresholds: {
      window, softTokens, warnTokens, forcedTokens,
      softPct: pct(softTokens), warnPct: pct(warnTokens), forcedPct: pct(forcedTokens),
      clamped: softTokens !== rawSoft || warnTokens !== rawWarn || forcedTokens !== rawForced,
    } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export const levelFor = (tokens: number | null, thresholds: Thresholds | undefined): Level => {
  if (tokens === null || !thresholds) return 'unknown';
  if (tokens >= thresholds.forcedTokens) return 'forced';
  if (tokens >= thresholds.warnTokens) return 'warning';
  if (tokens >= thresholds.softTokens) return 'notice';
  return 'idle';
};

export const formatPct = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? '?%' : `${value.toFixed(1)}%`;
