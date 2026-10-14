# @prjct.app/pi-self-compact

[![pi-self-compact — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-self-compact/main/docs/cover.png)](https://pi.dev)

Pi decides when to compact and how much recent history stays verbatim. This extension only writes the summary, and writes it from the session's own cached request instead of replaying the history as text:

- **Cheaper.** The provider bills the shared prefix as cached input. Measured on Codex: about 10.7k uncached input tokens per compaction, against about 72k for Pi's replayed summary.
- **Better input.** The summarizer reads every tool result whole; Pi's replay cuts each one to 2,000 characters.

It adds no tool, no guidance messages, no locks and no commands; the project state reaches the model only as the compaction summary. When the cached summary cannot run (overflow recovery, a model change since the last request, a stale snapshot, a provider error), Pi's own summarizer writes it.

Adapted from [disler/self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent) (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Install

```sh
pi install npm:@prjct.app/pi-self-compact
```

List `pi-self-compact` last in `packages`, so it reuses the provider body after other extensions rewrite it.

## Settings

Compaction is configured in Pi's `settings.json` (see Pi's `docs/compaction.md`):

```json
{
  "compaction": {
    "reserveTokens": 40000,
    "keepRecentTokens": 60000
  }
}
```

`reserveTokens` sets when Pi compacts (`contextWindow - reserveTokens`: about 232k on a 272k window). `keepRecentTokens` is the recent history kept verbatim; everything before it is replaced by the summary.

## The summary is a project state, not a summary of a summary

Long sessions compact many times, and rewriting the summary on each pass loses things on each pass. So the session keeps a **project state** instead, and a compaction renders it:

- **Updated after each run, item by item.** When a run ends, the model returns edits (`add`, `update`, `resolve`) for rules, decisions, open work and facts. Nothing is regenerated, so nothing drifts. The update extends the session's cached request in the background while the user reads the answer. Runs woken by a small message (a team wake) are folded together with the next one.
- **Rules in the user's words.** A rule points at the user message it came from, and the host copies that message verbatim (expanded skills and pasted logs are not quoted).
- **Kept small.** Past about 24,000 characters the model reviews the state and closes what is done, stale or duplicated. A review never touches rules: they change only when the user replaces them. Resolved items stay in the saved state and the journal.
- **Stored as a custom entry** (`self-compact-state`), never sent to the model as a message. Sessions that predate the state start from their last compaction summary.
- **Fallback.** If the state cannot be updated (no model answer, malformed edits), the compaction writes a summary followed by the user's messages that still apply, as described below.

- **The current request survives.** When a compaction cuts the user's latest message out of the kept history (a cut in the middle of a task), that message goes into the summary verbatim. Without it, a live test lost the task and the agent answered "Entendido." instead of the result.

## When to compact: calibrated per model, on every machine

Models degrade at different context sizes, so one threshold is wrong for some of them, and a table of model ids would not know the models a user actually runs. pi-self-compact measures it on each machine's own sessions:

- The session journals are scanned incrementally in the background (8 s for 2.4 GB the first time, 0.1 s after that) into failed edits (the edit text did not match the file) per model and 50k context band. Counts live in `<agent dir>/self-compact/calibration.json`.
- A model's threshold is the start of the first band from 100k where failed edits rise at least 1.5x and 3 points over its own rate below 100k, and stay up in the next band. With too little data (fewer than 60 edits below 100k, or 40 in a band) or no such rise, nothing changes and Pi's own threshold applies.
- At a turn boundary past the threshold, the state is brought up to date and proposed as the compaction through Pi's `turn_end` / `agent_before_settle` boundaries, keeping Pi's `keepRecentTokens`. It is skipped when the kept history would still be most of the context, so a tail of huge tool results cannot trigger it twice.
- Pi's own trigger (`compaction.reserveTokens`, per-model overrides in settings) still applies as before; the calibrated threshold only ever compacts earlier, never later.

On the author's sessions this found MiniMax-M3 degrading from 200k (failed edits 13% → 19% → 30%) and left the models without a clear rise on Pi's threshold. In a live test with a calibrated threshold of 100k, the context went from 114k to 10k in the middle of a task, the agent finished the task and restated the user's rule.

Measured by replaying three real long sessions (21, 23 and 17 compactions; the final context answered 26 fixed questions three times, including rules never stated and files never touched):

| | Summary chain | Summary + kept user messages | Project state |
|---|---|---|---|
| Real early rules remembered | 24–26% | 54–57% | 67–87% |
| Rules never stated, answered as real | 3–8% | 0% | 0% |
| Real files remembered | 93–100% | 100% | 99% |

Folding only at compaction time (spans of ~200k tokens) remembered 50% of the rules; folding after each run is what makes the difference.

## Your messages that still apply survive every compaction

Each compaction merges the previous summary, so in a session that compacts twenty times a rule stated on day one is paraphrased twenty times. In one measured session it was gone after 21 compactions, and the agent then did what it forbade. Carrying every message forever is the opposite problem: finished tasks and "continue" would ride along for weeks.

So the summarizer, the session's own model, is shown the user's messages by id and ends its summary with one line naming those that still apply (`<keep-user-messages>…</keep-user-messages>`). The host removes that line and appends the chosen messages verbatim, copied from the session branch:

```
## User messages, verbatim (carried across compactions; newest last)
[2026-10-14 07:02 · e7e259a3] Regla permanente para todo este proyecto: nunca hagas push ni deploy sin mi autorización…
```

- The model decides relevance; it never rewrites the words.
- A dropped message is not offered again. It stays in the session journal, and pi-memory's `memory_context` reads it by id.
- Without a readable keep line every candidate is carried, so a malformed summary never loses an instruction. An explicit empty line is respected.
- Messages over 2,000 characters keep their start and point at their entry id.
- In a live test (standing rule, a task that was finished, "continua", a second task, two compactions) the model kept only the standing rule both times, and the agent restated it exactly afterwards.

## File lists for the whole session

Pi carries `<read-files>`/`<modified-files>` forward only from its own compactions and skips summaries an extension wrote. So after a cache-shared compaction the next summary listed only its own span: in a live test a file read before the first compaction was gone after the second, and the model said it had never read a file. The lists are now rebuilt from the session branch, so every file the session read or changed stays listed, and a file edited and later read still counts as modified.

## Measured on real sessions

The compaction chains of three real long sessions (21, 23 and 17 compactions) were replayed with Pi's summarizer, once as published and once with the ledger. Each final context then answered 26 fixed questions, three times: the user's real early rules mixed with rules never stated, and files really changed mixed with files of the same repo never touched.

| | Published | With the ledger |
|---|---|---|
| Real rules remembered | 24% (13/54) | 54% (29/54) |
| Real files remembered | 97% (70/72) | 100% (72/72) |
| Rules never stated, answered as real | 3% (1/36) | 0% (0/36) |
| Files never touched, answered as real | 0% | 0% |
| Final context size | | +3–15% |

"Preservar las pantallas, no sustituirlas por vistas simplificadas" was "unknown" three times out of three as published and "yes" three times with the ledger. One rule went the other way (a Supabase constraint the ledger did not keep). An earlier variant that also listed an evidence index by entry id was dropped: it cost up to 10k tokens and lost "modified" for files read after an edit (82% of files remembered).

When the cache-shared summary cannot run, Pi's own summarizer is called through the session's model registry with the same choice to make. If that fails as well, Pi compacts on its own path, and the next compaction offers the messages again.

Each compaction entry records `details.selfCompact`: `summary` is `"state"` (with the live `items`, `rules` and `characters`), `"cache-shared"` (with `input` and `cacheRead`) or `"native"`, and `ledger` holds the kept message and character counts, whether the model chose (`selected: "model"`) or everything was kept (`"all"`), and the cumulative `dropped` ids. Entries without it are Pi's own summary.

The summary preserves the active objective, user corrections, constraints, completed
and pending work, execution evidence, live jobs and next actions. Incomplete or
tool-calling summaries are rejected so Pi can use its native compaction path.
Summary requests disable tool choice through Pi's provider-neutral API while
preserving the tool declarations, transcript, model and active reasoning level.
Configured thinking budgets and Pi's effective per-model history retention are preserved too.
Responses payloads also retain opaque reasoning. The summary budget is up to 32,768 tokens, bounded by model output
limits and available context headroom. Outbound data uses pi-secrets protection.

## Development

```sh
npm run check
npm test
npm run check:package
```
