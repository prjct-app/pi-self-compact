# @prjct.app/pi-self-compact

[![pi-self-compact — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-self-compact/main/docs/cover.png)](https://pi.dev)

Pi decides when to compact and how much recent history stays verbatim. This extension only writes the summary, and writes it from the session's own cached request instead of replaying the history as text:

- **Cheaper.** The provider bills the shared prefix as cached input. Measured on Codex: about 10.7k uncached input tokens per compaction, against about 72k for Pi's replayed summary.
- **Better input.** The summarizer reads every tool result whole; Pi's replay cuts each one to 2,000 characters.

It adds nothing to the context: no tool, no guidance messages, no notes, no locks, no commands. When the cached summary cannot run (overflow recovery, a model change since the last request, a stale snapshot, a provider error), Pi's own summarizer writes it.

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

## Your messages survive every compaction

Each compaction merges the previous summary, so in a session that compacts twenty times a rule stated on day one is paraphrased twenty times. In one measured session it was gone after 21 compactions, and the agent then did what it forbade. So every summary is followed by the user's own messages, verbatim:

```
## User messages, verbatim (carried across compactions; newest last)
[2026-09-28 05:19 · 64606b1e] continua con el remplazo de supabase
[2026-09-28 05:19 · 7a1c03f2] <first 2,000 characters> … [+12,345 chars; full text in session entry 7a1c03f2]
```

- Not model-written: the list is rebuilt from the session branch, which Pi never shortens, so it cannot drift and it recovers after any compaction that lacked it.
- Only `user` messages before the kept history. Team and tool messages stay in the summary.
- Messages over 2,000 characters (pasted logs) keep their start and point at their entry id; the full text stays in the session journal.
- No total or count limit. Measured on 73 real sessions with 3+ compactions: median ~1k tokens, largest ~8k, all of it in the cached prefix after the compaction.

When the cache-shared summary cannot run, Pi's own summarizer is called through the session's model registry so that summary carries the ledger too. If that fails as well, Pi compacts on its own path and the next compaction restores the ledger.

Each compaction entry records `details.selfCompact`: `summary` is `"cache-shared"` (with `input` and `cacheRead`) or `"native"`, and `ledger` holds the message and character counts. Entries without it are Pi's own summary.

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
