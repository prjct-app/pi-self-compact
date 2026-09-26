# Changelog

## Unreleased

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
