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
selects finished production Apify AI traces from a time window, samples them
and scores each sampled turn against the online rubric
([#269](https://github.com/apify/ai-team/issues/269)). Score writing (#270) is
stacked on top: today the verdicts are computed and counted (`judged`,
`failedToJudge`) but nothing is written to Langfuse.

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
`fromStartTime`). Both queries also pin the `environment`. The coverage query
is

```json
[
    { "type": "datetime", "column": "startTime", "operator": ">=", "value": "<window.start>" },
    { "type": "datetime", "column": "startTime", "operator": "<", "value": "<window.end>" },
    { "type": "stringOptions", "column": "environment", "operator": "any of", "value": ["prod"] },
    { "type": "arrayOptions", "column": "traceTags", "operator": "any of", "value": ["apify-ai"] }
]
```

and the selection query is

```json
[
    { "type": "datetime", "column": "startTime", "operator": ">=", "value": "<window.start>" },
    { "type": "datetime", "column": "startTime", "operator": "<", "value": "<window.end>" },
    { "type": "stringOptions", "column": "environment", "operator": "any of", "value": ["prod"] },
    { "type": "string", "column": "name", "operator": "=", "value": "apify-ai.turn-complete" }
]
```

The `environment` condition is what separates populations. One Langfuse
project holds dev, staging and prod traffic from the same service, emitting
the same span names, so without it local experiments would land in the
production pass rate: over the 14 days to 2026-09-09 the project held `dev`,
`staging` and `sdk-experiment` traffic and no `prod` traffic at all. It
defaults to `prod`; a backfill of staging traffic is `environment: "staging"`.

The selection query carries no tag condition: `traceTags` matches PER
OBSERVATION and the tag sits only on the root AGENT span, so tag AND
completion-span name returns zero rows forever. The agent's
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

**Broken gate.** `tracesInWindow > 0` with `completedTraces == 0` means the
completion span name drifted or emission stopped, not that nothing finished.
(With the contract undeployed the coverage query is 0 too, so the gate does
not fire; that is the idle-window case.) Selecting nothing is correct, but
advancing the checkpoint over such a window would burn it silently and every
run after it, so selection logs a warning, returns `checkpoint: null` and sets
`isGateBroken`: nothing writes the checkpoint and the next run retries the
same window. `main.ts` then calls `Actor.fail()` after writing OUTPUT, so the
run ends FAILED and the ordinary Apify run-status alert covers it instead of a
green run that silently selects nothing forever. Both counters and the flag
are in OUTPUT, so the state is visible without reading the log.

**Ingestion lag.** The selection key is the completion span's own `startTime`,
and the window's upper bound is `now - 33 min`, so the effective tolerance for
late-arriving spans is about 33 minutes: a completion span whose `startTime`
falls in a window already passed by the checkpoint is never selected. That is
far above the observed 1 to 3 min export lag, but it is a hard cliff, not a
degradation. A possible mitigation, deliberately NOT implemented here, is to
checkpoint at `window.end` minus a small overlap so consecutive windows
re-examine their shared edge; that is safe only because #270's score writes
are idempotent, so it belongs with them and not with selection.

**Inputs.** `sampleRate` (default 0.2), `maxItems` (default 100: about a
dollar of judge calls and well under the run timeout at concurrency 4 on a
busy day), `environment` (default `prod`, see above), `windowStart` /
`windowEnd` (ISO 8601 overrides, see above). `judgeModel`, `promptLabel` and
the Langfuse keys apply as in datasetRun mode.

**OUTPUT.** `{mode, environment, window, checkpointWritten, isGateBroken,
tracesInWindow, completedTraces, sampled, judged, failedToJudge,
sampledTraceIds}`.

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
  pagination works; the last page returns `meta: {}` with the cursor absent.
- `traceTags` is not a response field under any `fields` value; only `traceId`
  is needed and it is in `core`.
- `stringOptions environment any of [...]` works, and it is the condition that
  proves the point: those same 3 `apify-ai_search-actors` rows on 2026-09-07
  split 2 `dev` + 1 `staging`, so `["staging"]` returns 1 row and `["prod"]`
  returns 0. The project holds **no** `prod` observations at all in the 14 days
  to 2026-09-09 (468 observations across 98 traces, none of them `prod`), so an
  online run with the default `environment` selects nothing today for that
  reason as well as the undeployed contract.

Still waiting on the trace contract deploy (`feat/trace-contract` in
apify-ai-agent is unmerged) and on a `prod` deployment emitting traces: the
`apify-ai` trace tag, the `apify-ai.turn-complete` span name and the `prod`
environment all return 0 rows today, so the coverage query and the selection
query cannot be exercised against real values yet, only their mechanism.
Until then an online run reports `tracesInWindow: 0, completedTraces: 0`,
which is the idle-window case and not the broken-gate case, so the run stays
green and the checkpoint advances normally.

### Online scoring

Each sampled trace is scored without re-running the agent, in four steps
(`src/online-turn.ts`, `online-render.ts`, `online-schema.ts`, `online-judge.ts`).

**Turn reconstruction.** `GET /api/public/v2/observations?traceId=` with the
`io`, `metadata` and `model` field groups, paginated. The GENERATION
observations carry the whole message array on Langfuse's mapped `input` and
`output` (OTel GenAI shape: `{role, parts:[text | tool_call | tool_call_response]}`),
untruncated; the `metadata["attributes.*"]` bag is never read because its
values are cut at 200 characters. Generations are ordered by `startTime` and
flattened into one list: every step repeats the history so far, so tool calls
are deduped by call id and text messages by role plus content, each keeping
the first observation that carried it as provenance. The last user message is
the prompt, earlier user/assistant text is shown to the judge as context only,
assistant tool calls after the prompt become ordered steps paired with their
results, and the assistant text after the last result is the final answer. A
call is an error when its result carries `isError: true` or arrived as a
Mastra `tool-error` part (what an MCP error becomes in the agent). Trace
metadata (`toolSchemaHash`, `outcome`, `steps`) is read from whichever
observation carries it; the model id from `providedModelName`. A trace with
no GENERATION or no user message cannot be reconstructed and counts as
`failedToJudge`.

**Judge input.** Prompt, context, every tool call with arguments and result,
the final answer and the recorded outcome. Each payload is capped on its own at
4096 characters, head plus tail around `[... N chars omitted ...]`, so one huge
result cannot crowd out the rest. Tool results are included deliberately,
unlike the offline suite: resultUtilization, taskCompletion and errorRecovery
are checks on whether the answer matches what the tools returned.

**`argumentCorrectness` is deterministic.** Every call's arguments are
validated with ajv against the tool's declared input schema. The trace carries
only the agent's `toolSchemaHash`, not the schemas, so the judge fetches
`tools/list` from `https://mcp.apify.com` (streamable HTTP, the Actor's
`APIFY_TOKEN`) once per batch and recomputes the hash with a port of the
agent's algorithm: sha256 over the stable JSON of `[{key, description,
inputSchema}]` sorted by key, where `key` is the Mastra-namespaced
`apify-ai_<mcp tool name>` (the agent's MCP server is named `apify-ai`),
`description` is the MCP description or `''`, and `inputSchema` the raw JSON
Schema. The port is pinned by a test against a hash produced by the agent's
own function. Equal hashes mean the verdict is reproducible (`schemaMatch:
true`); on a mismatch the calls are still validated against the live schemas
and `schemaMatch: false` goes into the comment and metadata. The criterion is
omitted, with a reason, when the turn made no tool calls, when no called tool
has a schema, or when `tools/list` failed for the batch. Failure comments
name the tool, the span and the ajv path and message, never the values.

**LLM criteria.** toolSelection, resultUtilization, errorRecovery,
planEfficiency and taskCompletion (last), then the holistic `agent_judge`
verdict, in one structured call through the OpenRouter proxy. The prompt is
the Langfuse-managed `apify-ai-online-judge`, resolved by `promptLabel` once
per batch and seeded from `DEFAULT_ONLINE_JUDGE_PROMPT` when missing, exactly
as `workflow-judge` is; the criterion descriptions in it are the rubric's,
verbatim. The prompt asks for evidence before each verdict and says the
holistic verdict is a separate judgment, not an AND over the criteria and not
taskCompletion. The reply is parsed strictly (verdict casing normalised;
anything else is an `InvalidJudgeReplyError` and the trace counts as
`failedToJudge`). errorRecovery is omitted whenever the turn has no tool error,
whatever the model said. A judge failure on one trace never aborts the batch.

**Verdicts.** `judgeOnlineTrace()` returns an `OnlineVerdicts`: one entry per
online score name, either `{value: 1|0, comment, evidence}` or
`{omitted: true, reason}`, plus metadata (`rubricName`, `rubricVersion`,
`judgeModel`, `promptVersion`, `judgeImplVersion`, `toolSchemaHash`,
`schemaMatch`, `outcome`, `spanId`). Comments carry the verdict, the failing
criteria (holistic), `schemaMatch` (argumentCorrectness) and a span id, and
quote no user text and no tool payload; the judge's evidence is kept apart
from the comment because it may quote the turn. #270 consumes this value; the
seam is `judgeOnline()` in `main.ts`.

**Judge model.** `judgeModel` defaults to `deepseek/deepseek-v4-flash` in
online mode and stays `anthropic/claude-sonnet-4.6` in datasetRun mode.

## v1 scope notes

- Judges by dataset-run id only; traceIds/filter inputs are planned.
- Judges from the span's conversation JSON; fetching the full session log via
  the span's `fullLogUrl` pointer is future work.
- The halo-audit mode (isolated per-dimension calls with a disagreement
  threshold) from the design record is not built yet.
- Deploy: `scripts/deploy.sh judge` from the repo root (monorepo build).
