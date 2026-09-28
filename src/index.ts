import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import { brand, completer, row, SYMBOL } from '@prjct.app/pi-tui-kit';
import {
  compactNowPrompt, loadPrompt, NOTE_MAX_CHARS, promptDirs, renderTemplate, SYSTEM_POLICY, type TemplateValues,
} from './prompts.ts';
import {
  emptyState, GUIDANCE_TYPE, HANDOFF_TYPE, PHASE_TYPE, recoverState, STATE_TYPE,
  type EntryLike, type Handoff, type SelfCompactState,
} from './state.ts';
import {
  cachedSummaryBlocker, generateCachedSummary, generateSummary, hasCompactionMaterial, keepRecentTokens, modelKey, type RequestSnapshot,
} from './summary.ts';
import {
  DEFAULT_SPECS, formatPct, LEVEL_ORDER, levelFor, loadThresholdFile, resolveThresholds, SPEC_HELP,
  type Level, type ThresholdSpecs, type Thresholds,
} from './thresholds.ts';
import { connectJev, type ConnectJev, type Jev } from './jev.ts';
import { MOMENT_QUESTIONS, momentLine, momentState, verdictOf, type Verdict } from './moment.ts';

/**
 * Self-compact: the agent watches its own context, writes a note_to_self at a
 * clean checkpoint, the session is compacted, and the note comes back verbatim
 * so the run continues without a human. Adapted from
 * disler/self-compact-pi-agent (MIT, Copyright (c) 2026 IndyDevDan).
 *
 * - notice / warning: a transient guidance message rides on each request (the
 *   `context` hook) and is never persisted. Load this package after pi-memory
 *   so the guidance lands after its bounded history.
 * - forced: every tool except self_compact and context_usage is blocked in
 *   `tool_call`; the active tool list is never narrowed, because Pi would
 *   answer "tool not found" before any hook could explain why.
 * - self_compact ends the run, compaction starts once Pi is idle, and the note
 *   returns as the next message. Automatic compaction is left to Pi and to
 *   whatever else is installed (pi-memory cancels it); this is always an
 *   explicit, visible compaction.
 * - The state is journaled, so reload, resume and /tree rebuild the handoff.
 */

export const SELF_COMPACT_TOOL = 'self_compact';
export const CONTEXT_USAGE_TOOL = 'context_usage';
const STATUS_KEY = 'self-compact';
const MAX_AUTO_RETRIES = 3;
const SUMMARY_ATTEMPTS = 2;
/** Unprompted handoff requests per context epoch, so an agent that ignores them cannot loop. */
const MAX_AUTO_REQUESTS = 2;

export type SelfCompactOptions = Readonly<{
  enabled?: boolean;
  /** Threshold specs; CLI flags override them. */
  thresholds?: Partial<ThresholdSpecs>;
  /** Extra directories searched for prompt overrides, before the defaults. */
  promptDirs?: readonly string[];
  /** Injected by the tests; the real one reads the shared TypeSafe key. */
  jev?: ConnectJev;
}>;

type Usage = Readonly<{ tokens: number | null; percent: number | null; window: number }>;

export type SelfCompactController = Readonly<{
  /** Ask the agent to write its note and compact now (reuses a saved note). */
  requestNow(ctx: ExtensionContext): string;
  /** Plain lines describing settings, usage and state; no model turn. */
  describe(ctx: ExtensionContext): readonly string[];
}>;

const levelTag = (level: Level): string =>
  level === 'notice' ? 'NOTICE' : level === 'warning' ? 'WARNING' : level === 'forced' ? 'FORCED' : '';

const handoffTag = (status: Handoff['status']): string =>
  status === 'failed' ? 'COMPACTION FAILED' : status === 'ready' ? 'COMPACTED' : 'COMPACTING';

export const installSelfCompact = (pi: ExtensionAPI, options: SelfCompactOptions = {}): SelfCompactController | undefined => {
  // Subagent children run bounded, delegated work; their parent owns compaction.
  if (options.enabled === false || process.env.PI_SUBAGENTS_CHILD === '1') return undefined;

  pi.registerFlag('compact-soft-at', { description: `self-compact notice line (default ${DEFAULT_SPECS.softAt}). ${SPEC_HELP}`, type: 'string' });
  pi.registerFlag('compact-at', { description: `self-compact warning line (default ${DEFAULT_SPECS.at}).`, type: 'string' });
  pi.registerFlag('compact-buffer', { description: `Allowance above --compact-at before other tools are blocked (default ${DEFAULT_SPECS.buffer}; 0 blocks at the warning).`, type: 'string' });
  pi.registerFlag('compact-prompt', { description: 'Literal text that replaces the self-compact summary system prompt.', type: 'string' });
  pi.registerFlag('no-self-compact', { description: 'Disable self-compact for this session.', type: 'boolean' });

  const R = {
    disabled: false,
    specs: { ...DEFAULT_SPECS, ...options.thresholds } as ThresholdSpecs,
    fromDefaults: true,
    compactPrompt: undefined as string | undefined,
    error: undefined as string | undefined,
    /** A thresholds.json that exists but was rejected; disables self-compact like a bad flag. */
    fileError: undefined as string | undefined,
    /** Where the lines came from, for /self-compact status. */
    specSource: 'defaults',
    thresholds: undefined as Thresholds | undefined,
    dirs: [] as readonly string[],
    usage: { tokens: null, percent: null, window: 0 } as Usage,
    level: 'unknown' as Level,
    state: emptyState(),
    /** Bumps on every compaction and session start so deferred work and announcements re-arm. */
    epoch: 0,
    announced: 'idle' as Level,
    inFlight: false,
    lastError: undefined as string | undefined,
    autoRequests: 0,
    /** Context size the last compaction started from, for the one-line handoff summary. */
    tokensBefore: undefined as number | undefined,
    alive: true,
    timers: new Map<string, ReturnType<typeof setTimeout>>(),
    promptErrors: new Set<string>(),
    /** The last session request as sent, so the summary can extend its cached prefix. */
    snapshot: undefined as RequestSnapshot | undefined,
    /** Jev, looked up the first time a line is crossed; undefined inside means no key. */
    jev: undefined as Promise<Jev | undefined> | undefined,
    /** Finished turns; a verdict only counts for the turn it judged. */
    turns: 0,
    moment: undefined as { epoch: number; turn: number; verdict: Verdict } | undefined,
    judging: false,
    /** The epoch an early handoff was already asked in: once per context is enough. */
    movedOnAsked: -1,
  };

  const flag = (name: string): string | undefined => {
    const value = pi.getFlag(name);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const active = (): boolean => !R.disabled && !R.error && R.thresholds !== undefined;
  const pending = (): Handoff | undefined => R.state.handoff && R.state.handoff.status !== 'done' ? R.state.handoff : undefined;
  const save = (next: Partial<SelfCompactState>): void => {
    R.state = { ...R.state, ...next };
    pi.appendEntry(STATE_TYPE, structuredClone(R.state));
  };
  const notify = (ctx: ExtensionContext, message: string, type: 'info' | 'warning' | 'error' = 'info'): void => {
    if (!ctx.hasUI || (type === 'info' && ctx.mode === 'tui')) return;
    try { ctx.ui.notify(message, type); } catch { /* UI only. */ }
  };
  const clearTimers = (): void => {
    for (const timer of R.timers.values()) clearTimeout(timer);
    R.timers.clear();
  };
  /** Runs only if the session epoch is unchanged and the runtime is alive. */
  const defer = (key: string, delayMs: number, run: () => void): void => {
    const existing = R.timers.get(key);
    if (existing) clearTimeout(existing);
    const epoch = R.epoch;
    R.timers.set(key, setTimeout(() => {
      R.timers.delete(key);
      if (R.alive && epoch === R.epoch) run();
    }, delayMs));
  };

  const loadSettings = (ctx: ExtensionContext): void => {
    R.fileError = undefined;
    R.disabled = pi.getFlag('no-self-compact') === true;
    const soft = flag('compact-soft-at');
    const at = flag('compact-at');
    const buffer = flag('compact-buffer');
    R.compactPrompt = flag('compact-prompt');
    R.dirs = [...(options.promptDirs ?? []), ...promptDirs(ctx.cwd)];
    const file = (() => {
      try { return loadThresholdFile(R.dirs); } catch (error) {
        R.fileError = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    })();
    R.specs = { ...DEFAULT_SPECS, ...options.thresholds, ...file?.specs, ...(soft ? { softAt: soft } : {}), ...(at ? { at } : {}), ...(buffer ? { buffer } : {}) };
    R.fromDefaults = !soft && !at && !buffer && !options.thresholds && !file;
    R.specSource = soft || at || buffer ? 'flags' : file ? file.path : options.thresholds ? 'options' : 'defaults';
  };

  const resolve = (ctx: ExtensionContext): void => {
    const resolution = resolveThresholds(R.specs, ctx.model?.contextWindow ?? 0, R.fromDefaults);
    R.thresholds = resolution.ok && !R.fileError ? resolution.thresholds : undefined;
    // A missing window is not a settings error: the guard simply waits for a model that reports one.
    R.error = R.fileError ?? (resolution.ok || !ctx.model?.contextWindow ? undefined : resolution.error);
    if (R.error) notify(ctx, `self-compact disabled: ${R.error}`, 'error');
  };

  const measure = (ctx: ExtensionContext): Usage => {
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
    const tokens = usage?.tokens ?? null;
    const percent = usage?.percent ?? (tokens !== null && window > 0 ? tokens / window * 100 : null);
    return { tokens, percent, window };
  };

  const values = (): TemplateValues => {
    const t = R.thresholds;
    const tokens = R.usage.tokens ?? 0;
    const fmt = (value: number): string => value.toLocaleString('en-US');
    return {
      used_tokens: fmt(tokens), used_percent: formatPct(R.usage.percent), context_window: fmt(R.usage.window),
      soft_tokens: fmt(t?.softTokens ?? 0), soft_percent: formatPct(t?.softPct),
      warning_tokens: fmt(t?.warnTokens ?? 0), warning_percent: formatPct(t?.warnPct),
      forced_tokens: fmt(t?.forcedTokens ?? 0), forced_percent: formatPct(t?.forcedPct),
      remaining_to_forced: fmt(Math.max(0, (t?.forcedTokens ?? 0) - tokens)),
      cycle: R.state.cycle, note_max_chars: NOTE_MAX_CHARS,
    };
  };

  const guidance = (level: Level): string =>
    renderTemplate(loadPrompt(level === 'notice' ? 'soft' : level === 'forced' ? 'forced' : 'warning', R.dirs).text, values());

  const statusText = (): string | undefined => {
    if (R.error) return 'ctx self-compact off';
    const handoff = pending();
    const tag = handoff ? handoffTag(handoff.status) : levelTag(R.level);
    return tag ? `ctx ${formatPct(R.usage.percent)} ${tag}` : undefined;
  };

  const refresh = (ctx: ExtensionContext): void => {
    // Hosts may start a session before a model is chosen; resolve on first sight of a window.
    if (!R.thresholds && !R.error && ctx.model?.contextWindow) resolve(ctx);
    R.usage = measure(ctx);
    R.level = levelFor(R.usage.tokens, R.thresholds);
    if (ctx.hasUI) try { ctx.ui.setStatus(STATUS_KEY, statusText()); } catch { /* UI only. */ }
  };

  /**
   * False when Pi would answer "Nothing to compact": the session still fits in
   * keepRecentTokens. Locking or asking for a note would strand the agent.
   */
  const compactable = (ctx: ExtensionContext): boolean =>
    hasCompactionMaterial(ctx.sessionManager.getBranch(), keepRecentTokens(ctx.cwd));

  /** Records crossings (shown once in the TUI) and engages the forced lock. */
  const track = (ctx: ExtensionContext): void => {
    refresh(ctx);
    if (!active() || R.level === 'unknown' || R.level === 'idle') return;
    if (R.level === 'forced' && !R.state.locked && !pending() && compactable(ctx)) save({ locked: true });
    if (LEVEL_ORDER[R.level] <= LEVEL_ORDER[R.announced]) return;
    R.announced = R.level;
    const text = (() => {
      try { return guidance(R.level); } catch { return undefined; }
    })();
    pi.appendEntry(PHASE_TYPE, { level: R.level, tokens: R.usage.tokens, percent: R.usage.percent, text, at: Date.now() });
    if (ctx.mode !== 'tui') {
      notify(ctx, `self-compact: ${levelTag(R.level).toLowerCase()} line crossed at ${formatPct(R.usage.percent)}`,
        R.level === 'forced' ? 'error' : R.level === 'warning' ? 'warning' : 'info');
    }
  };

  const deliver = (ctx: ExtensionContext): void => {
    const handoff = R.state.handoff;
    if (!R.alive || handoff?.status !== 'ready') return;
    if (!ctx.isIdle()) {
      if (!R.timers.has('deliver')) defer('deliver', 25, () => deliver(ctx));
      return;
    }
    // The content is exactly the saved note; the header lives in the renderer.
    pi.sendMessage({ customType: HANDOFF_TYPE, content: handoff.note, display: true,
      details: { id: handoff.id, cycle: R.state.cycle, note: handoff.note, tokensBefore: R.tokensBefore } }, { triggerTurn: true });
  };

  const startCompaction = (ctx: ExtensionContext, trigger: string): void => {
    const handoff = R.state.handoff;
    if (R.inFlight || !handoff || (handoff.status !== 'pending' && handoff.status !== 'failed')) return;
    R.inFlight = true;
    save({ handoff: { ...handoff, status: 'compacting' } });
    notify(ctx, `self-compact: compacting (${trigger}, note ${handoff.note.length} chars)…`);
    refresh(ctx);
    ctx.compact({ onComplete: () => { R.inFlight = false; }, onError: () => { R.inFlight = false; } });
  };

  /**
   * At the warning line or past it, an idle agent is asked to hand off on its
   * own: the person never has to type anything for the run to compact.
   */
  const requestHandoff = (ctx: ExtensionContext, followUp: boolean, movedOn = false): void => {
    if (!active() || pending() || R.autoRequests >= MAX_AUTO_REQUESTS) return;
    const level: Level = R.state.locked ? 'forced' : R.level;
    const early = movedOn && level === 'notice';
    if ((level !== 'warning' && level !== 'forced' && !early) || !compactable(ctx)) return;
    R.autoRequests += 1;
    pi.sendMessage({ customType: GUIDANCE_TYPE, content: compactNowPrompt(), display: true,
      details: { level, percent: R.usage.percent, auto: true, ...(early ? { movedOn: true } : {}) } },
    followUp ? { triggerTurn: true, deliverAs: 'followUp' } : { triggerTurn: true });
  };

  /** Jev's verdict on the turn that just ended, while it is still about this context. */
  const fresh = (): Verdict | undefined =>
    R.moment && R.moment.epoch === R.epoch && R.moment.turn === R.turns ? R.moment.verdict : undefined;

  /**
   * Past the notice line, a finished run whose request moved on hands off
   * early: the old context would otherwise ride on every later turn until the
   * warning line. Below the notice line nothing is asked at all.
   */
  const handoffIfMovedOn = (ctx: ExtensionContext): void => {
    if (R.level !== 'notice' || fresh() !== 'moved_on' || R.movedOnAsked === R.epoch) return;
    R.movedOnAsked = R.epoch;
    requestHandoff(ctx, true, true);
  };

  /**
   * After a turn, between the notice line and the hard cutoff: one Jev call,
   * never awaited. The verdict lands on the next request or, when the run has
   * already ended, acts then. No key, a timeout or an error: nothing changes.
   */
  const judge = (ctx: ExtensionContext): void => {
    if (!active() || pending() || R.state.locked || R.judging || (R.level !== 'notice' && R.level !== 'warning')) return;
    const state = (() => {
      try { return compactable(ctx) ? momentState(ctx.sessionManager.getBranch() as unknown as Parameters<typeof momentState>[0]) : undefined; } catch { return undefined; }
    })();
    if (!state) return;
    R.jev ??= (options.jev ?? connectJev)();
    R.judging = true;
    const epoch = R.epoch;
    const turn = R.turns;
    void R.jev
      .then(jev => jev ? jev(state, MOMENT_QUESTIONS) : undefined)
      .then(answers => {
        const verdict = answers ? verdictOf(answers) : undefined;
        if (!verdict || !R.alive || epoch !== R.epoch) return;
        R.moment = { epoch, turn, verdict };
        if (turn === R.turns && ctx.isIdle()) handoffIfMovedOn(ctx);
      })
      .catch(() => undefined)
      .finally(() => { R.judging = false; });
  };

  const usageView = (ctx: ExtensionContext) => {
    refresh(ctx);
    const t = R.thresholds;
    const tokens = R.usage.tokens;
    const round = (value: number | null | undefined): number | null =>
      value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(1));
    const handoff = pending();
    return {
      used_tokens: tokens, used_percent: round(R.usage.percent), context_window: R.usage.window, level: R.level,
      thresholds: t ? {
        notice: { tokens: t.softTokens, percent: round(t.softPct) },
        warning: { tokens: t.warnTokens, percent: round(t.warnPct) },
        hard_cutoff: { tokens: t.forcedTokens, percent: round(t.forcedPct) },
      } : null,
      tokens_until_warning: t && tokens !== null ? Math.max(0, t.warnTokens - tokens) : null,
      tokens_until_hard_cutoff: t && tokens !== null ? Math.max(0, t.forcedTokens - tokens) : null,
      tools_locked: R.state.locked,
      pending_note: handoff ? { status: handoff.status, chars: handoff.note.length } : null,
      compaction_cycles: R.state.cycle,
      settings_error: R.error ?? null,
    };
  };

  pi.registerTool({
    name: CONTEXT_USAGE_TOOL,
    label: 'Context Usage',
    description: `${SYSTEM_POLICY}\n\nYour own context usage as JSON: used tokens and percent, the window, the self-compact level, the notice, warning and hard-cutoff lines, and the tokens left before each. You cannot see these numbers otherwise. Call it when deciding something (after a compaction, before a large read, when judging whether to call ${SELF_COMPACT_TOOL}); a message arrives on its own when a line is crossed.`,
    promptSnippet: 'Show your context usage and the self-compact thresholds as JSON',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const view = usageView(ctx);
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }], details: view };
    },
    renderCall(_args, theme, context) {
      return context?.isPartial !== false ? row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'CTX', target: 'usage', meta: 'reading…' }) : new Container();
    },
    renderResult(result, _options, theme) {
      const view = result.details as ReturnType<typeof usageView> | undefined;
      const meta = view ? `${view.used_tokens?.toLocaleString('en-US') ?? '?'} tokens · ${view.used_percent ?? '?'}% · ${view.level}` : '';
      return row(theme, { symbol: SYMBOL.ok, tone: 'success', verb: 'CTX', target: 'usage', meta });
    },
  });

  pi.registerTool({
    name: SELF_COMPACT_TOOL,
    label: 'Self Compact',
    description: `Hand off to yourself across a context compaction. note_to_self (1-${NOTE_MAX_CHARS} chars) holds the goal, DONE work with exact file paths and commands, IN PROGRESS state, key decisions, verified test results, and the exact NEXT ACTION as the last line. Call it alone in a tool batch: the note is saved, this run ends, the context is compacted once you are idle, and the note is returned verbatim so you continue from NEXT ACTION. At the hard cutoff every other tool is blocked until this succeeds.`,
    promptSnippet: 'Compact your own context: save a note_to_self; after compaction the note comes back verbatim',
    promptGuidelines: [
      `Call ${SELF_COMPACT_TOOL} alone in a tool batch when a [self-compact · …] message asks you to, or at a clean checkpoint when context is high.`,
      `A ${SELF_COMPACT_TOOL} note_to_self ends with the exact NEXT ACTION and never lists finished work as pending.`,
    ],
    parameters: Type.Object({
      note_to_self: Type.String({ description: `Your handoff note (1-${NOTE_MAX_CHARS} chars), ending with the exact NEXT ACTION.` }),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error('Self-compaction cancelled before saving the note.');
      if (R.disabled) throw new Error('self-compact is disabled for this session (--no-self-compact).');
      if (R.error) throw new Error(`self-compact is disabled because its settings were rejected: ${R.error}`);
      // The note is kept byte for byte; only the checks look at the trimmed form.
      const raw = typeof params.note_to_self === 'string' ? params.note_to_self : '';
      if (!raw.trim()) throw new Error('note_to_self must not be blank. Write the goal, DONE work, IN PROGRESS state, decisions, test results and the NEXT ACTION.');
      if (raw.length > NOTE_MAX_CHARS) throw new Error(`note_to_self has ${raw.length} characters; the limit is ${NOTE_MAX_CHARS}. Shorten it and call ${SELF_COMPACT_TOOL} again.`);
      const existing = pending();
      if (existing?.status === 'compacting' || existing?.status === 'ready') throw new Error('Compaction is already in progress for the saved note.');
      if (!compactable(ctx)) {
        refresh(ctx);
        throw new Error(`Nothing to compact yet: Pi keeps the newest ${keepRecentTokens(ctx.cwd).toLocaleString('en-US')} tokens untouched and this session does not reach past them (context ${R.usage.tokens?.toLocaleString('en-US') ?? '?'} tokens). No note was saved and no tool is blocked. Keep working.`);
      }
      if (existing && existing.note.trim() !== raw.trim()) {
        throw new Error(`A note is already saved (${existing.note.length} chars). Retry ${SELF_COMPACT_TOOL} with that saved note verbatim.`);
      }
      const note = existing ? existing.note : raw;
      const handoff: Handoff = { id: existing?.id ?? randomUUID(), note, status: 'pending', attempts: 0, savedAt: Date.now() };
      R.lastError = undefined;
      save({ handoff, locked: true });
      refresh(ctx);
      return {
        content: [{ type: 'text', text: `Note saved (${note.length} chars). Every other tool is blocked until compaction succeeds. Stop now: compaction runs when this turn ends and your note will be returned verbatim.` }],
        details: { handoffId: handoff.id, noteChars: note.length, cycle: R.state.cycle + 1, note, usedTokens: R.usage.tokens, usedPercent: R.usage.percent },
        terminate: true,
      };
    },
    renderCall(args, theme, context) {
      const chars = typeof args?.note_to_self === 'string' ? args.note_to_self.length : 0;
      return context?.isPartial !== false
        ? row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'CTX', target: 'self-compact', meta: `note ${chars.toLocaleString('en-US')} chars` })
        : new Container();
    },
    renderResult(result, { expanded }, theme, context) {
      const details = result.details as { noteChars?: number; usedTokens?: number | null; usedPercent?: number | null; note?: string } | undefined;
      const failed = Boolean(context?.isError);
      const first = result.content[0];
      const head = row(theme, {
        symbol: failed ? SYMBOL.error : SYMBOL.ok, tone: failed ? 'error' : 'success', verb: 'CTX', target: 'self-compact',
        meta: failed ? (first?.type === 'text' ? first.text.replace(/\s+/gu, ' ').slice(0, 160) : 'failed')
          : `note ${(details?.noteChars ?? 0).toLocaleString('en-US')} chars saved at ${formatPct(details?.usedPercent)} · compacting when idle`,
      });
      if (!expanded || !details?.note) return head;
      const container = new Container();
      container.addChild(head);
      container.addChild(new Text(theme.fg('dim', details.note), 2, 0));
      return container;
    },
  });

  // One summary line; expanding it shows the note exactly as the agent received it.
  pi.registerMessageRenderer(HANDOFF_TYPE, (message, options, theme) => {
    const details = message.details as { cycle?: number; note?: string; resumed?: boolean; tokensBefore?: number } | undefined;
    const note = details?.note ?? (typeof message.content === 'string' ? message.content : '');
    const from = details?.tokensBefore ? ` from ${details.tokensBefore.toLocaleString('en-US')} tokens` : '';
    const line = theme.fg('success', `${SYMBOL.ok} self-compact · compacted${from} · cycle ${details?.cycle ?? '?'}`)
      + theme.fg('dim', details?.resumed ? ' · resuming from the saved note' : ` · note returned to the agent (${note.length.toLocaleString('en-US')} chars)`);
    return new Text(options.expanded ? `${line}\n${theme.fg('text', note)}` : line, options.outputPad ?? 1, 0);
  });

  const toneOf = (level: Level): 'error' | 'warning' | 'accent' => level === 'forced' ? 'error' : level === 'warning' ? 'warning' : 'accent';
  const phaseLine = (level: Level, percent: number | null | undefined): string => `self-compact · ${level === 'notice' ? 'notice' : levelTag(level)} at ${formatPct(percent)} · ${
    level === 'forced' ? 'tools locked, compacting automatically' : level === 'warning' ? 'compacting at the next checkpoint' : 'heads-up only'}`;

  // One line per crossing; expanded shows the exact guidance the model receives.
  pi.registerEntryRenderer(PHASE_TYPE, (entry, options, theme) => {
    const data = entry.data as { level?: Level; percent?: number | null; text?: string } | undefined;
    const level = data?.level ?? 'notice';
    const line = theme.fg(toneOf(level), phaseLine(level, data?.percent));
    return new Text(options.expanded && data?.text ? `${line}\n${theme.fg('dim', data.text.trim())}` : line, 0, 0);
  });

  pi.registerMessageRenderer(GUIDANCE_TYPE, (message, options, theme) => {
    const details = message.details as { level?: Level; percent?: number | null; movedOn?: boolean } | undefined;
    const level = details?.level ?? 'warning';
    const why = details?.movedOn ? ' · the task moved on' : '';
    const line = theme.fg(toneOf(level), `self-compact · ${levelTag(level)} at ${formatPct(details?.percent)}${why} · asked the agent to write its note and compact`);
    const content = typeof message.content === 'string' ? message.content : '';
    return new Text(options.expanded ? `${line}\n${theme.fg('dim', content)}` : line, options.outputPad ?? 1, 0);
  });

  const recover = (reason: string, ctx: ExtensionContext): void => {
    clearTimers();
    R.snapshot = undefined;
    R.alive = true;
    R.epoch += 1;
    R.announced = 'idle';
    R.inFlight = false;
    R.autoRequests = 0;
    R.promptErrors.clear();
    loadSettings(ctx);
    resolve(ctx);
    const recovered = recoverState(ctx.sessionManager.getBranch() as unknown as readonly EntryLike[]);
    R.state = recovered.state;
    const handoff = R.state.handoff;
    if (handoff && recovered.unanswered && !R.disabled) {
      // Crash between journaling the note and the model's answer: resume without a user prompt.
      save({ handoff: { ...handoff, status: 'done' }, locked: false });
      notify(ctx, `self-compact: the returned note was never answered before ${reason}; resuming from it.`, 'warning');
      defer('recover', 500, () => {
        if (!ctx.isIdle()) return;
        pi.sendMessage({ customType: HANDOFF_TYPE, display: false,
          content: `Continue from your saved note_to_self above (self-compact cycle ${R.state.cycle}). Perform only its unfinished NEXT ACTION.`,
          details: { id: handoff.id, cycle: R.state.cycle, note: handoff.note, resumed: true } }, { triggerTurn: true });
      });
    } else if (handoff?.status === 'ready') {
      save({ handoff: recovered.answered ? { ...handoff, status: 'done' } : handoff, locked: false });
      if (!recovered.answered) deliver(ctx);
    } else if (handoff && handoff.status !== 'done') {
      const interrupted = handoff.status === 'compacting';
      save({ locked: !R.disabled, handoff: { ...handoff, status: interrupted ? 'failed' : handoff.status, attempts: 0,
        ...(interrupted ? { error: 'Compaction was interrupted (session reloaded).' } : {}) } });
      notify(ctx, `self-compact: restored a saved note (${handoff.note.length} chars, ${reason}). Tools stay locked until compaction succeeds.`, 'warning');
      defer('recover', 500, () => { if (ctx.isIdle()) startCompaction(ctx, `recovery after ${reason}`); });
    } else if (R.state.locked && R.disabled) {
      save({ locked: false });
    }
    track(ctx);
    // A session resumed at or past the warning line hands off without waiting for a prompt.
    if (!pending() && !recovered.unanswered) defer('auto', 500, () => { if (ctx.isIdle()) requestHandoff(ctx, false); });
  };

  pi.on('session_start', async (event, ctx) => recover(event.reason, ctx));
  pi.on('session_tree', async (_event, ctx) => recover('tree', ctx));
  pi.on('session_shutdown', async () => {
    R.alive = false;
    R.epoch += 1;
    clearTimers();
  });
  pi.on('model_select', async (_event, ctx) => {
    resolve(ctx);
    track(ctx);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    track(ctx);
    // The policy rides on the context_usage tool description: a per-turn system
    // prompt is dropped on automated turns and flipped the cached prefix.
    return undefined;
  });

  pi.on('context', async (event, ctx) => {
    track(ctx);
    if (!active() || pending()) return undefined;
    const level: Level = R.state.locked ? 'forced' : R.level;
    if (level === 'unknown' || level === 'idle' || !compactable(ctx)) return undefined;
    const text = (() => {
      try {
        return guidance(level);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!R.promptErrors.has(message)) {
          R.promptErrors.add(message);
          notify(ctx, message, 'warning');
        }
        return undefined;
      }
    })();
    if (!text) return undefined;
    // At the warning line a clean checkpoint is worth saying out loud; elsewhere the guidance is unchanged.
    const moment = level === 'warning' ? momentLine(fresh()) : undefined;
    const content = moment ? `${text}\n\n${moment}` : text;
    return { messages: [...event.messages, { role: 'custom' as const, customType: GUIDANCE_TYPE, content, display: false, timestamp: Date.now() }] };
  });

  // Runs after every `context` handler, so the snapshot matches the request byte for byte
  // (Pi 0.87+; older hosts never fire it and keep the replayed-text summary).
  (pi.on as (event: string, handler: (event: { messages: readonly unknown[] }, ctx: ExtensionContext) => Promise<undefined>) => void)(
    'context_with_system', async (event, ctx) => {
      R.snapshot = ctx.model ? { model: modelKey(ctx.model), messages: event.messages, tail: [] } : undefined;
      return undefined;
    });

  // The provider body as sent: Pi builds tool schemas on the session path that the
  // transcript alone does not reproduce, so the summary reuses this body as its prefix.
  // Handlers after this one still rewrite it; list self-compact last among packages.
  pi.on('before_provider_request', async event => {
    if (R.snapshot && !R.snapshot.payload) R.snapshot = { ...R.snapshot, payload: event.payload };
    return undefined;
  });

  pi.on('message_end', async (event, ctx) => {
    if (R.snapshot) R.snapshot = { ...R.snapshot, tail: [...R.snapshot.tail, event.message] };
    if (event.message.role === 'assistant') {
      track(ctx);
      return;
    }
    const handoff = R.state.handoff;
    if (event.message.role !== 'custom' || event.message.customType !== HANDOFF_TYPE || handoff?.status !== 'ready') return;
    if ((event.message.details as { id?: unknown } | undefined)?.id !== handoff.id) return;
    // Pi journaled the verbatim note: the handoff is complete.
    save({ handoff: { ...handoff, status: 'done' }, locked: false });
    refresh(ctx);
  });

  pi.on('tool_call', async (event, ctx) => {
    track(ctx);
    if (!active() || event.toolName === SELF_COMPACT_TOOL || event.toolName === CONTEXT_USAGE_TOOL) return undefined;
    // Pi preflights a batch sequentially before running it, so a sibling of
    // self_compact in the same assistant message is blocked and ends the run.
    const branch = ctx.sessionManager.getBranch();
    const latest = [...branch].reverse().find(entry => entry.type === 'message' && entry.message.role === 'assistant');
    const calls = latest?.type === 'message' && latest.message.role === 'assistant'
      ? latest.message.content.flatMap(block => block.type === 'toolCall' ? [block] : []) : [];
    const handsOff = calls.some(call => call.name === SELF_COMPACT_TOOL && typeof call.arguments?.note_to_self === 'string'
      && call.arguments.note_to_self.trim().length > 0 && call.arguments.note_to_self.length <= NOTE_MAX_CHARS);
    if (handsOff && calls.some(call => call.id === event.toolCallId)) {
      return { block: true, terminate: true, reason: `Tool "${event.toolName}" is blocked: ${SELF_COMPACT_TOOL} is in this tool batch, so the run ends here. Wait for the handoff.` };
    }
    if (!R.state.locked) return undefined;
    const handoff = R.state.handoff;
    const why = handoff?.status === 'pending' || handoff?.status === 'compacting'
      ? `a ${SELF_COMPACT_TOOL} note is saved and compaction is ${handoff.status}`
      : handoff?.status === 'failed'
        ? `the last compaction failed (${handoff.error ?? 'unknown error'}) and the saved note is kept`
        : `context is at ${formatPct(R.usage.percent)} (${R.usage.tokens?.toLocaleString('en-US') ?? '?'} tokens), past the hard cutoff of ${R.thresholds?.forcedTokens.toLocaleString('en-US') ?? '?'} tokens`;
    return { block: true, reason: `Tool "${event.toolName}" is blocked by self-compact: ${why}. Every tool except ${SELF_COMPACT_TOOL} is blocked until compaction succeeds. Write your note_to_self and call ${SELF_COMPACT_TOOL} now.` };
  });

  pi.on('turn_end', async (_event, ctx) => {
    R.turns += 1;
    track(ctx);
    judge(ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    track(ctx);
    // The run stopped at or past the warning line: a clean checkpoint, so hand off now.
    requestHandoff(ctx, true);
    // Or before it, when Jev already said the work moved on (a verdict still in flight acts on arrival).
    handoffIfMovedOn(ctx);
  });

  pi.on('agent_settled', async (_event, ctx) => {
    if (!R.alive) return;
    refresh(ctx);
    const handoff = R.state.handoff;
    // A verdict that landed while the run was winding down acts now that it is idle.
    if (active() && !pending() && ctx.isIdle()) handoffIfMovedOn(ctx);
    if (!active() || !handoff || !ctx.isIdle()) return;
    if (handoff.status === 'ready') deliver(ctx);
    else if (handoff.status === 'pending') startCompaction(ctx, 'agent idle');
    else if (handoff.status === 'failed' && handoff.attempts < MAX_AUTO_RETRIES && R.lastError) startCompaction(ctx, 'retry after failure');
  });

  // Only a manual compaction with a saved note uses the self-compact summary;
  // automatic compaction and a plain /compact keep Pi's own.
  pi.on('session_before_compact', async (event, ctx) => {
    const handoff = pending();
    if (event.reason !== 'manual' || !handoff || !active()) return undefined;
    R.lastError = undefined;
    const prompt = (() => {
      if (R.compactPrompt) return { text: R.compactPrompt, source: '--compact-prompt' };
      try { return loadPrompt('summary', R.dirs); } catch (error) {
        R.lastError = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    })();
    if (!prompt) {
      notify(ctx, `self-compact: ${R.lastError}`, 'error');
      return { cancel: true };
    }
    const errors: string[] = [];
    // First choice extends the cached session request; replaying the history as text
    // (billed in full) is the fallback when that cannot run or fails.
    const blocker = cachedSummaryBlocker(event, ctx, R.snapshot, R.usage.tokens);
    const snapshot = blocker ? undefined : R.snapshot;
    if (snapshot) {
      try {
        const result = await generateCachedSummary(event, ctx, prompt, snapshot);
        return { compaction: { ...result, details: {
          ...result.details,
          handoffId: handoff.id,
          selfCompact: { cycle: R.state.cycle + 1, promptSource: prompt.source, noteChars: handoff.note.length, truncatedInput: false, attempt: 1,
            summary: 'cache-shared', input: result.usage.input, cacheRead: result.usage.cacheRead },
        } } };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        if (event.signal.aborted) return { cancel: true };
      }
    }
    const fallback = blocker ?? `cache-shared summary failed: ${errors.at(-1) ?? 'unknown error'}`;
    for (const attempt of Array.from({ length: SUMMARY_ATTEMPTS }, (_, index) => index + 1)) {
      if (event.signal.aborted) return { cancel: true };
      try {
        const { result, truncatedInput } = await generateSummary(event, ctx, prompt);
        return { compaction: { ...result, details: {
          ...(result.details as Record<string, unknown> | undefined),
          handoffId: handoff.id,
          selfCompact: { cycle: R.state.cycle + 1, promptSource: prompt.source, noteChars: handoff.note.length, truncatedInput, attempt,
            summary: 'replayed', fallback, input: result.usage?.input, cacheRead: result.usage?.cacheRead },
        } } };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        if (event.signal.aborted) return { cancel: true };
      }
    }
    R.lastError = `Summary generation failed after ${SUMMARY_ATTEMPTS} attempts: ${errors.at(-1) ?? 'unknown error'}`;
    notify(ctx, `self-compact: ${R.lastError}`, 'error');
    return { cancel: true };
  });

  pi.on('session_compact', async (event, ctx) => {
    R.snapshot = undefined;
    R.epoch += 1;
    R.announced = 'idle';
    R.inFlight = false;
    R.autoRequests = 0;
    R.tokensBefore = event.compactionEntry?.tokensBefore;
    const handoff = pending();
    if (handoff) {
      save({ cycle: R.state.cycle + 1, handoff: { ...handoff, status: 'ready', error: undefined }, locked: false });
      notify(ctx, `self-compact: compaction ${event.reason} succeeded (cycle ${R.state.cycle}); returning the note.`);
      deliver(ctx);
    } else if (R.state.locked) {
      // Context shrank another way (a plain /compact): release the forced lock.
      save({ locked: false });
    }
    refresh(ctx);
  });

  pi.on('session_compact_failed', async (event, ctx) => {
    if (event.reason !== 'manual' && event.aborted) return;
    R.inFlight = false;
    if (!R.alive) return;
    const handoff = R.state.handoff;
    if (!handoff || (handoff.status !== 'compacting' && handoff.status !== 'pending')) {
      refresh(ctx);
      return;
    }
    const ours = R.lastError !== undefined;
    const failed: Handoff = { ...handoff, status: 'failed', attempts: handoff.attempts + 1,
      error: R.lastError ?? event.errorMessage ?? (event.aborted ? 'compaction was cancelled' : 'compaction failed') };
    save({ handoff: failed, locked: true });
    refresh(ctx);
    if ((ours || !event.aborted) && failed.attempts < MAX_AUTO_RETRIES) {
      notify(ctx, `self-compact: compaction failed (attempt ${failed.attempts}): ${failed.error}. Note kept, tools stay locked, retrying.`, 'warning');
      defer('retry', 2_000 * failed.attempts, () => {
        if (R.state.handoff?.status === 'failed' && ctx.isIdle()) startCompaction(ctx, `auto-retry ${failed.attempts + 1}`);
      });
    } else {
      notify(ctx, `self-compact: compaction ${event.aborted && !ours ? 'cancelled' : 'failed'} (attempt ${failed.attempts}): ${failed.error}. Note kept and tools stay locked. Run /self-compact now or /compact to retry.`, 'error');
    }
  });

  const controller: SelfCompactController = {
    requestNow(ctx) {
      if (R.disabled) return 'self-compact is disabled for this session (--no-self-compact).';
      if (R.error) return `self-compact settings were rejected: ${R.error}`;
      const handoff = pending();
      if (handoff?.status === 'compacting' || handoff?.status === 'ready') return 'Compaction is already in progress.';
      const saved = handoff?.status === 'pending' || handoff?.status === 'failed' ? handoff.note : undefined;
      if (ctx.isIdle()) pi.sendUserMessage(compactNowPrompt(saved));
      else pi.sendUserMessage(compactNowPrompt(saved), { deliverAs: 'steer' });
      return saved ? 'Asked the agent to compact now with its saved note.' : 'Asked the agent to write its note and compact now.';
    },
    describe(ctx) {
      refresh(ctx);
      const t = R.thresholds;
      const handoff = R.state.handoff;
      const fmt = (value: number): string => value.toLocaleString('en-US');
      return [
        `state ${R.disabled ? 'disabled' : R.error ? `rejected: ${R.error}` : t ? 'active' : 'waiting for a model window'}`,
        `usage ${R.usage.tokens === null ? 'unknown' : `${fmt(R.usage.tokens)} tokens (${formatPct(R.usage.percent)})`} of ${fmt(R.usage.window)}`,
        t ? `lines notice ${fmt(t.softTokens)} · warning ${fmt(t.warnTokens)} · cutoff ${fmt(t.forcedTokens)}${t.clamped ? ' (clamped to window)' : ''} · from ${R.specSource}` : `lines ${R.specs.softAt} / ${R.specs.at} / +${R.specs.buffer} · from ${R.specSource}`,
        `level ${R.level} · tools ${R.state.locked ? 'LOCKED' : 'unlocked'} · cycles ${R.state.cycle}`,
        ...(handoff ? [`note ${handoff.status} · ${fmt(handoff.note.length)} chars${handoff.error ? ` · ${handoff.error}` : ''}`] : []),
      ];
    },
  };

  pi.registerCommand('self-compact', {
    description: brand('context thresholds and handoff: status | now'),
    getArgumentCompletions: completer([
      { value: 'status', description: 'show usage, thresholds, lock and pending note' },
      { value: 'now', description: 'ask the agent to write its note_to_self and compact now' },
    ]),
    handler: async (args, ctx) => {
      const word = args.trim().toLowerCase();
      if (word && word !== 'status' && word !== 'now') {
        ctx.ui.notify('Usage: /self-compact [status|now]', 'warning');
        return;
      }
      const lines = word === 'now' ? [controller.requestNow(ctx)] : ['self-compact', ...controller.describe(ctx)];
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  return controller;
};

export default function selfCompact(pi: ExtensionAPI): void {
  installSelfCompact(pi);
}
