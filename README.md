# @prjct.app/pi-self-compact

A Pi extension for long, autonomous runs. The agent watches its own context, writes a `note_to_self` at a clean checkpoint, the session is compacted, and the exact note comes back as the next message, so the run continues without a human.

Adapted from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

For the local checkout used by this workspace:

```sh
cd /Users/jj/Apps/pi
./install-local.sh pi-self-compact
```

The script builds `~/.pi/agent/builds/pi-self-compact`. Add `builds/pi-self-compact` to the Pi package list **after** `builds/pi-memory` and restart Pi. The order matters: Pi runs `context` handlers in load order, and the guidance must follow pi-memory's bounded history.

## How a cycle works

| Line | Default | Flag | What the agent gets | Tools |
| --- | --- | --- | --- | --- |
| notice | 100k tokens (≤ 50% of the window) | `--compact-soft-at` | a heads-up with live numbers | all |
| warning | 150k (≤ 65%) | `--compact-at` | "write your note and compact soon" | all |
| hard cutoff | warning + 30k (≤ 80%) | `--compact-buffer` | "compact now" | only `self_compact` and `context_usage` |

Lines are absolute because context rot follows tokens, not window share; on a small window the defaults clamp to the fractions shown. Flags take tokens (`270000`, `100k`, `1.5m`) or percentages (`20%`); explicit lines are capped at 90% of the window and must keep notice < warning.

To keep lines across sessions, put a `thresholds.json` in `<cwd>/.pi/self-compact/` or `~/.pi/agent/self-compact/` (the project file wins; flags still override it):

```json
{ "softAt": "200k", "at": "220k", "buffer": "20k" }
```

Any key can be left out. A file that does not parse, or has an unknown key, disables self-compact and reports why; it never falls back silently. `/self-compact` shows where the lines came from.

1. Guidance rides on each request as a transient message and is never persisted. Each crossing prints it once in the transcript.
2. `self_compact(note_to_self)` saves the note (1–24,000 chars) and ends the run. It refuses, without locking, when the session still fits inside Pi's `keepRecentTokens`.
3. Once Pi is idle the session is compacted with a structured summary prompt that leaves the note to the note. The summary request extends the last session request, so the provider serves the shared prefix from its prompt cache; Pi's own `compact()` with the history replayed as text is the fallback. List `pi-self-compact` last in `packages` so it reuses the provider body after other extensions rewrite it.
4. The note returns byte for byte as the next message and starts the next turn. Tools unlock.

Nobody has to prompt it. When a run stops at or past the warning line (a finished turn, or a session resumed there), the extension asks the agent to write its note and compact, at most twice per cycle so an agent that ignores it cannot loop. Each crossing and each handoff prints one line in the transcript; expand it to see the exact guidance or note the model receives.

### The moment (Jev)

Token lines say how full the context is, not whether now is a good time. With a TypeSafe key (`TYPESAFE_API_KEY`, or the OS keyring entry pi-qa and pi-memory share), each turn that ends between the notice line and the hard cutoff asks [Jev](https://typesafe.ai) three yes/no questions in one call: did the request switch tasks, did the last turn finish a unit of work, is a multi-step edit half done. The call is never awaited and reads only the requests and the last turn's prose, never tool results.

- Past the notice line, a finished run whose request moved on is asked to hand off right away instead of carrying the old work to the warning line. Once per context.
- At the warning line, a clean checkpoint adds one sentence to the guidance: compact now, before the hard cutoff lands in the middle of an edit.
- A half-done edit never triggers anything. Below the notice line, without a key, or on any Jev error, self-compact runs on its token lines alone.

A failed summary keeps the note and the lock and retries (up to three times, then `/self-compact now` or `/compact`). Reload, resume and `/tree` rebuild the handoff from the session journal. Automatic compaction is left alone: with pi-memory installed it stays cancelled; a plain `/compact` keeps Pi's prompt.

## Commands and tools

| | |
|---|---|
| `/self-compact` | usage, lines, lock state, cycles and the pending note |
| `/self-compact now` | ask the agent to write its note and compact now (reuses a saved note) |
| `--no-self-compact` | off for this session |
| `context_usage()` | the agent's own gauge as JSON |
| `self_compact(note_to_self)` | the handoff |

The footer belongs to p-ui; the phase is published as the `self-compact` extension status (`ctx 55.1% WARNING`). Subagent children (`PI_SUBAGENTS_CHILD=1`) never install the extension.

## Prompts

Each prompt can be replaced by a Markdown file in `<cwd>/.pi/self-compact/` or `~/.pi/agent/self-compact/`, read fresh on every use. An empty or unreadable override is reported, never silently ignored.

| File | Used for |
|---|---|
| `SOFT.md` | notice guidance |
| `WARNING.md` | warning guidance |
| `FORCED.md` | hard-cutoff guidance |
| `SUMMARY.md` | summary system prompt (`--compact-prompt` replaces it literally) |

Placeholders: `{{used_tokens}}`, `{{used_percent}}`, `{{context_window}}`, `{{soft_tokens}}`, `{{soft_percent}}`, `{{warning_tokens}}`, `{{warning_percent}}`, `{{forced_tokens}}`, `{{forced_percent}}`, `{{remaining_to_forced}}`, `{{cycle}}`, `{{note_max_chars}}`.

## Limits

- Usage is Pi's estimate. One huge tool result can jump past a line before the lock engages; the next call is still blocked.
- The lock stops new tool calls; calls already running finish.
- Summary quality is model quality. The note is never replaced by the summary.

## Development

```sh
npm run check
npm test
npm run check:package
```
