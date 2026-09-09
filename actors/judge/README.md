# Eval Judge

Judge Actor for [ai-team#242](https://github.com/apify/ai-team/issues/242) /
[#244](https://github.com/apify/ai-team/issues/244). It grades finished eval
runs from their Langfuse traces and writes the grades back. It never starts
the evaluated agent, which is what makes re-grading history free.

## What it does

1. Takes a **dataset-run id** (the Runner returns it in its OUTPUT).
2. Loads every item of that run and fetches each item's agent span.
3. Runs the deterministic layer: `check.schemaValidity` validates every tool
   call's input against the tool-schema snapshot the agent actually saw
   (fetched by pointer from the `eval-artifacts` store, hash-verified).
4. Runs one structured LLM call per item (via the OpenRouter proxy, on the
   run's own `APIFY_TOKEN`) scoring the 6 rubric dimensions from
   apify-mcp-server#1203: toolSelection, argumentCorrectness,
   resultUtilization, errorRecovery, planEfficiency, taskCompletion.
   Evidence is written before each verdict; taskCompletion is judged last.
5. Writes scores back to Langfuse, append-only, each stamped with the full
   version tuple (rubric, judge model, prompt version, judge impl version).
   `judge.overall` mirrors `judge.taskCompletion` by design.

## Score semantics

- `judge.*` scores are LLM verdicts (1 = pass, 0 = fail), with the judge's
  evidence sentence as the score comment.
- `check.*` scores are deterministic code, not the LLM.
- `not_applicable` verdicts (e.g. errorRecovery on an error-free trace) write
  NO score, so they never pollute aggregates; they are listed in the
  `notApplicable` field of the score metadata.

## Idempotency and versioning

Re-running the judge on an already-judged run writes nothing (items are
skipped when a `judge.overall` score with the same version tuple exists).
`force: true` writes a NEW score set alongside the old one; nothing is ever
mutated, so eras of judging stay comparable. The judge prompt lives in
Langfuse prompt management (`workflow-judge`), is resolved by label once per
batch, and the resolved version is stamped into every score.

## Degraded mode (historical traces)

Traces from before the trace contract (no `contractVersion` on the span) and
contract-invalid spans are still judged, from their conversation JSON alone:
schema-validity becomes not_applicable and score metadata carries
`contractVersion: "none"` (or `"invalid"`), so degraded grades are filterable.

## How to run

```sh
apify call <account>/eval-judge --memory 1024 --timeout 900 -i '{
    "datasetRunId": "<from the Runner OUTPUT>",
    "langfuseBaseUrl": "https://langfuse.apify.dev",
    "langfusePublicKey": "pk-lf-...",
    "langfuseSecretKey": "sk-lf-..."
}'
```

OUTPUT: `{items, judged, passed, skippedAlreadyJudged, skippedNoTrace, errors, degraded, version}`.

## Online mode: rubric and score configs

Online evals ([ai-team#249](https://github.com/apify/ai-team/issues/249)) judge
production `apify-ai-turn` traces with a second rubric, kept apart from the
offline `judge.*` scores above. This branch defines the rubric and the score
schema only ([#268](https://github.com/apify/ai-team/issues/268)); selection
(#267), scoring (#269), score writing (#270) and scheduling (#271) stack on it.

### The rubric

`ONLINE_RUBRIC` in `src/rubric.ts` is `{ name: 'apify-ai-turn', version: 1 }`
with six criteria, each judged independently as PASS or FAIL and each carrying
a one-paragraph description that the judge prompt, this README and the score
configs share:

| Criterion             | Passes when                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `toolSelection`       | Every tool and Actor choice is defensible for the task; nothing unnecessary was called.       |
| `argumentCorrectness` | Tool inputs are well-formed, taken from the conversation, and do what the task asks.          |
| `resultUtilization`   | The answer is faithful to the retrieved data: nothing invented, nothing important ignored.    |
| `taskCompletion`      | The user got what they asked for, grounded in retrieved data. Honest failure still fails.     |
| `errorRecovery`       | Errors were noticed, adapted to and reported plainly. Not scored when no tool error occurred. |
| `planEfficiency`      | The step count is proportionate: no loops, duplicated work or detours.                        |

The holistic verdict is a separate judgment over the whole turn (#269). It is
not a computed AND over the criteria and, unlike the offline `judge.overall`,
not a copy of `taskCompletion`; the rubric object deliberately has no
"overall = X" rule.

### Score names and semantics

`onlineScoreNames()` derives the names from the rubric, so the two cannot drift:

- `agent_judge`: the holistic verdict.
- `agent_judge_<criterion>`: one per criterion, e.g. `agent_judge_taskCompletion`.

All online scores are BOOLEAN (1 = pass, 0 = fail), so `avg` over any of them
in a Langfuse view is that score's pass rate with no further arithmetic, and a
pass-rate alert (#271) is a plain threshold. Langfuse caps score config names
at 35 characters and restricts the charset; `src/rubric.ts` asserts both at
import time and the tests pin them, so a bad rename fails before it reaches
Langfuse.

### Score configs

One BOOLEAN score config per name, with the rubric description and version as
its description. Score configs in Langfuse can be archived but never deleted:
a wrong name or data type stays in the project forever and keeps showing up in
the annotation UI. That is why the schema is fixed here, before anything
writes a score, and why the create script never creates a config whose name
already exists, even when the existing one looks wrong.

`scripts/create-score-configs.ts` is idempotent: it lists the project's score
configs (`GET /api/public/score-configs`, paginated), creates only the missing
ones (`POST /api/public/score-configs`, `dataType: BOOLEAN`) and prints a
table of `created` / `existing` / `CONFLICT` rows. A same-name config with
another data type, or an archived one, is a conflict: nothing is created for
that name and the script exits 1 so a human can decide in the Langfuse UI.
The planning logic (`planScoreConfigs` in `src/score-configs.ts`) is pure and
unit-tested; the script is the I/O around it.

Run it once per Langfuse project, from the repo root, with that project's keys
(it runs the TypeScript source via `tsx`, no build needed):

```sh
LANGFUSE_BASE_URL=https://langfuse.apify.dev \
LANGFUSE_PUBLIC_KEY=pk-lf-... \
LANGFUSE_SECRET_KEY=sk-lf-... \
npm run create-score-configs --workspace actors/judge
```

Tests: `npm test --workspace actors/judge` (vitest, `test/`). The build
tsconfig covers `src/` only; `npm run typecheck --workspace actors/judge`
type-checks `src/`, `scripts/` and `test/` together (`tsconfig.check.json`,
no emit).

## Online mode (production traces)

`mode: "online"` ([ai-team#267](https://github.com/apify/ai-team/issues/267))
selects finished production Apify AI traces from a time window and samples
them for scoring. Selection is built; scoring (#269) and score writing (#270)
are stacked on top and today the run judges nothing (`judged` is 0).

**Window.** `[checkpoint ?? now-24h, now - 33 min)`. The upper bound is
`now - requestTimeoutMs - exportLag`: apify-ai-agent's `server.requestTimeoutMs`
is 30 min, so any turn that started before that point has finished, and 3 min
(the conservative end of the observed 1 to 3 min Langfuse export lag) lets its
completion span land. An empty or inverted window selects nothing and leaves
the checkpoint alone.

**Checkpoint.** The window's upper bound is written to the Actor's default
key-value store under `ONLINE_CHECKPOINT` as
`{upperBound, runId, writtenAt}` after selection succeeds, so the next run
starts where this one stopped and a missed run backfills. A run that fails
before selection completes does not move it, and neither does a run whose
completion gate looks broken (see below). Setting `windowStart` or
`windowEnd` skips the checkpoint entirely (neither read nor written), so a
backfill or debugging run never rewinds production. `selectTraces()` returns
the record it would write as `checkpoint` (null when it wrote nothing); #270
must stop writing it inside selection and write that record behind the
score-write step, otherwise a process death during scoring loses the window's
sample.

**Selection.** Two paged queries against
`GET /api/public/v2/observations` (the instance runs Langfuse v4 in
`events_only` mode, so there is no trace API). Both bounds of the window are
always inside `filter`, because a `startTime` condition there REPLACES the
`fromStartTime` / `toStartTime` query params rather than intersecting with
them (live-verified: a `<`-only filter returned rows from two weeks before
`fromStartTime`). The coverage query is

```json
[
    { "type": "datetime", "column": "startTime", "operator": ">=", "value": "<window.start>" },
    { "type": "datetime", "column": "startTime", "operator": "<", "value": "<window.end>" },
    { "type": "arrayOptions", "column": "traceTags", "operator": "any of", "value": ["apify-ai"] }
]
```

and the selection query is

```json
[
    { "type": "datetime", "column": "startTime", "operator": ">=", "value": "<window.start>" },
    { "type": "datetime", "column": "startTime", "operator": "<", "value": "<window.end>" },
    { "type": "string", "column": "name", "operator": "=", "value": "apify-ai.turn-complete" }
]
```

The selection query carries no tag condition: `traceTags` matches PER
OBSERVATION and the tag sits only on the root AGENT span, so tag AND
completion-span name returns zero rows forever. The span name is unique to
this service, which is the whole selectivity that is needed. The agent's
`completed: 'true'` trace metadata is deliberately not in the filter either:
it is set on every span of that name, so it adds no selectivity, and whether
trace metadata is matchable on the observation `metadata` column is unproven.

The two counters are independent, not nested:

- `tracesInWindow` is a coverage counter: distinct traces whose ROOT span
  starts in the window. It can legitimately differ from `completedTraces` in
  both directions, so a gap is not loss. A turn whose root started before the
  window but completed inside it appears only in `completedTraces`; a turn
  whose root started at the end of the window but completes after it appears
  only in `tracesInWindow`.
- `completedTraces` is the selection: traces whose completion span starts in
  the window. The completion span's own start time is the selection key, and
  the two id sets are deliberately NOT intersected, since intersecting them
  would drop every turn of the first kind.

A trace with no completion signal is not finished and is never judged. The
completed ids are Fisher-Yates shuffled, `ceil(sampleRate * n)` are taken,
then the result is truncated to `maxItems`; shuffling first keeps a capped
sample unbiased.

**Broken gate.** `tracesInWindow > 0` with `completedTraces == 0` is the
signature of the trace contract not being deployed, or of the completion span
name drifting, not of unfinished traffic. Selecting nothing is correct, but
advancing the checkpoint over such a window would burn it silently and every
run after it, so selection logs a warning AND returns `checkpoint: null`:
nothing writes the checkpoint and the next run retries the same window. Both
counters are in the run's OUTPUT, so the state is visible without reading the
log.

**Inputs.** `sampleRate` (default 0.2), `maxItems` (default 100: about a
dollar of judge calls and well under the run timeout at concurrency 4 on a
busy day), `windowStart` / `windowEnd` (ISO 8601 overrides, see above).
`judgeModel`, `promptLabel` and the Langfuse keys apply as in datasetRun mode.

**OUTPUT.** `{mode, window, checkpointWritten, tracesInWindow, completedTraces,
sampled, judged, failedToJudge, sampledTraceIds}`.

### Verified live 2026-09-09

Checked against `langfuse.apify.dev` (project "Apify AI Agent") on
`GET /api/public/v2/observations`, read-only:

- `arrayOptions traceTags any of [...]` matches per OBSERVATION, and the tag is
  present only on the root AGENT span
  (`metadata["attributes.langfuse.trace.tags"]`). Over 14 days the tag filter
  never returned a non-root row.
- Consequently a tag AND child-span-name filter returns 0 rows even when the
  trace has both: on 2026-09-07, tag `user` gave 3 rows (all AGENT, 3 traces),
  name `apify-ai_search-actors` gave 3 rows (all TOOL, 3 traces), and the two
  together gave 0. The two id sets shared only 1 of 3 traces, which is also
  why the sets are not intersected.
- A `startTime` condition inside `filter` replaces `fromStartTime` /
  `toStartTime` entirely; they are ignored, not intersected. The `datetime`
  operators `>=`, `>`, `<`, `<=` behave as named with the expected
  inclusive/exclusive semantics; `=` and `!=` are a 400.
- `limit=1000` is the exact maximum (1001 is a 400), and `meta.cursor`
  pagination works and is null on the last page.
- `traceTags` is not a response field under any `fields` value; only `traceId`
  is needed and it is in `core`.

Still waiting on the trace contract deploy (`feat/trace-contract` in
apify-ai-agent is unmerged): the `apify-ai` trace tag and the
`apify-ai.turn-complete` span name both return 0 rows today, so the coverage
query and the selection query cannot be exercised against real values yet,
only their mechanism. Until then an online run reports
`tracesInWindow: 0, completedTraces: 0` on production traffic, which is the
empty-window case and not the broken-gate case, so the checkpoint advances
normally.

## v1 scope notes

- Judges by dataset-run id only; traceIds/filter inputs are planned.
- Judges from the span's conversation JSON; fetching the full session log via
  the span's `fullLogUrl` pointer is future work.
- The halo-audit mode (isolated per-dimension calls with a disagreement
  threshold) from the design record is not built yet.
- Deploy: `scripts/deploy.sh judge` from the repo root (monorepo build).
