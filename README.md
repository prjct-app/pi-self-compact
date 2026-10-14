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

When the cache-shared summary cannot run, Pi's own summarizer is called through the session's model registry with the same choice to make. If that fails as well, Pi compacts on its own path, and the next compaction offers the messages again.

Each compaction entry records `details.selfCompact`: `summary` is `"cache-shared"` (with `input` and `cacheRead`) or `"native"`, and `ledger` holds the kept message and character counts, whether the model chose (`selected: "model"`) or everything was kept (`"all"`), and the cumulative `dropped` ids. Entries without it are Pi's own summary.

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
