## [0.5.0](https://github.com/prjct-app/pi-self-compact/compare/v0.4.2...v0.5.0) (2026-10-14)

### Features

* carry the user's messages verbatim across compactions ([ffc1df2](https://github.com/prjct-app/pi-self-compact/commit/ffc1df2f086af96108b44286c9212d8e435dca17))
* index the session's evidence by entry id in every summary ([18c5fdc](https://github.com/prjct-app/pi-self-compact/commit/18c5fdc5259352a54389903914c9a82e97d694e4))
* the summarizer chooses which user messages still apply ([6fbccf7](https://github.com/prjct-app/pi-self-compact/commit/6fbccf7a75592e9f39b0e8c5b22e615b2bd20605))

### Bug Fixes

* carry session file lists; drop the evidence index ([aae473a](https://github.com/prjct-app/pi-self-compact/commit/aae473a5753cee97df123196e787f6fb60f74b55))
* never carry an expanded skill as a user message ([0a64d7f](https://github.com/prjct-app/pi-self-compact/commit/0a64d7f2bf68f838368c4594e1a845f593505d43))

## Unreleased

- Rebuild `<read-files>`/`<modified-files>` from the session branch: Pi skips the lists of summaries an extension wrote, so after a cache-shared compaction earlier files vanished and the model denied having read them.
- Replayed on three real sessions (61 compactions): real rules remembered went from 24% to 54%, files from 97% to 100%, rules never stated answered as real from 3% to 0%; the final context grew 3–15%.
- Carry the user's messages that still apply verbatim after every compaction summary. The summarizer names them by id in a `<keep-user-messages>` line, which the host removes; the text is copied from the session branch, never model-written. Dropped messages are not offered again and stay in the journal. Without a readable line every candidate is kept. Messages over 2,000 characters keep their start and their entry id.
- Why: each summary merges the previous one, so a rule stated once was paraphrased on every pass. In a measured 21-compaction session "no sustituir pantallas por vistas simplificadas" was gone from the final summary and the agent shipped placeholder pages.
- When the cache-shared summary cannot run, call Pi's summarizer through the session model registry (outbound data guarded, carried ledger removed from the previous summary) so those compactions carry the ledger too. A failure still leaves Pi's own compaction in charge. `details.selfCompact.summary` is `"cache-shared"` or `"native"`.

## 0.4.2 (2026-10-07)

- Extract summary text through the public Pi contentText helper. The active model, reasoning budget and summary validation are unchanged. Requires pi-ai 1.0.4 or newer.

- Preserve configured thinking budgets when generating a summary.
- Use Pi's effective compaction preparation for recent-history retention, including per-model overrides, without rereading a different settings scope.

- Disable summary tool calls through Pi's provider-neutral option for Anthropic, Chat Completions and Responses, preserving the transcript, tool declarations, model and reasoning level.
- Add offline provider-adapter regressions for summary options and stale context metadata clamping output to one token. No compaction thresholds or model limits are changed.

## 0.4.1 (2026-10-06)

- Reject incomplete and tool-calling summaries and fall back to native Pi compaction.
- Preserve active goals, user steering, constraints, evidence and live job state in the summary prompt.
- Disable tool choice for Responses summaries while preserving opaque reasoning.
- Use a model-bounded summary output budget and the published outbound privacy guard.

# Changelog

## 0.4.0

- Breaking: only the compaction summary is left. The `self_compact` tool, `note_to_self`, the notice, warning and hard-cutoff messages, the tool lock, the Jev moment, `thresholds.json`, prompt overrides, flags and `/self-compact` are gone. Pi decides when to compact (`compaction.reserveTokens`) and what stays verbatim (`compaction.keepRecentTokens`).
- Why: from 2026-10-03 to 10-05, 52 compactions took 220 `self_compact` calls (162 rejected by the 12,000-character cap) and 10.4% of all model output. Each retry squeezed the note further until words ran together ("SpanishJJ, English spacedteams"), and that shorthand was the only thing the model read verbatim after a compaction, so it spread to later notes and team messages.
- Every compaction Pi starts (threshold or `/compact`) now gets the cache-shared summary; overflow recovery and any failure fall back to Pi's own summary.

## 0.3.0

- With a TypeSafe key, Jev judges the moment after each turn past the notice line (task switched, unit finished, edit half done), without waiting on it. A finished run that moved on hands off early; at the warning line a clean checkpoint is told to compact now. A half-done edit never triggers anything; no key or any error keeps the token lines alone.
- `thresholds.json` in `.pi/self-compact/` (project) or `~/.pi/agent/self-compact/` (global) sets persistent lines; flags still win. A bad file disables self-compact with the reason, and `/self-compact` shows where the lines came from.
- The global override directory follows `PI_CODING_AGENT_DIR`.
- The summary extends the last session request (same provider body, same session id, one extra message) instead of replaying the history as text, so the provider bills the shared prefix as cached input. Measured on Codex: 48,000 of 49,417 input tokens cached, against 0 before. Falls back to the replayed summary on overflow, a model change, a stale snapshot or an error. List `pi-self-compact` last in `packages` so it sees the body after other extensions rewrite it.
- One summary request per compaction, split turns included.
- The compaction entry records `summary` (`cache-shared` or `replayed`), `input` and `cacheRead`.

## 0.2.1

- The returned note renders as one line (`✓ self-compact · compacted from 200,833 tokens · cycle 1 · note returned to the agent`); expand it to read the note.

## 0.2.0

- Hand off automatically: an idle run at or past the warning line, including a session resumed there, is asked to write its note and compact (at most twice per cycle).
- Threshold crossings print one line; the full guidance shows when expanded.

## 0.1.0

- Notice, warning and hard-cutoff lines (100k / 150k / +30k tokens, clamped to 50 / 65 / 80% of small windows), set with `--compact-soft-at`, `--compact-at` and `--compact-buffer`.
- `self_compact(note_to_self)` saves the note, ends the run, compacts once Pi is idle, and returns the note verbatim as the next message.
- `context_usage` returns the agent's own usage and lines as JSON.
- Transient guidance per request, never persisted; a static system-prompt line keeps the cached prefix stable.
- Forced lock in `tool_call`; siblings of `self_compact` in the same batch end the run.
- Structured summary through Pi's `compact()`, with retries, and journaled recovery across reload, resume and `/tree`.
- `/self-compact [status|now]`, `--no-self-compact`, prompt overrides in `.pi/self-compact/`, off in subagent children.
