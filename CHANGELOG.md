# Changelog

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
