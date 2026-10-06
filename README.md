# @prjct.app/pi-self-compact

[![pi-self-compact — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-self-compact/main/docs/cover.png)](https://pi.dev)

Pi decides when to compact and how much recent history stays verbatim. This extension only writes the summary, and writes it from the session's own cached request instead of replaying the history as text:

- **Cheaper.** The provider bills the shared prefix as cached input. Measured on Codex: about 10.7k uncached input tokens per compaction, against about 72k for Pi's replayed summary.
- **Better input.** The summarizer reads every tool result whole; Pi's replay cuts each one to 2,000 characters.

It adds nothing to the context: no tool, no guidance messages, no notes, no locks, no commands. When the cached summary cannot run (overflow recovery, a model change since the last request, a stale snapshot, a provider error), Pi writes its own summary.

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

Each compaction entry records `details.selfCompact` with `summary: "cache-shared"`, `input` and `cacheRead`. Entries without it are Pi's own summary.

The summary preserves the active objective, user corrections, constraints, completed
and pending work, execution evidence, live jobs and next actions. Incomplete or
tool-calling summaries are rejected so Pi can use its native compaction path.
Responses payloads disable tool choice for summarization and retain opaque
reasoning. The summary budget is up to 32,768 tokens, bounded by model output
limits and available context headroom. Outbound data uses pi-secrets protection.

## Development

```sh
npm run check
npm test
npm run check:package
```
