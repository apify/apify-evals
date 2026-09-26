# Eval Judge

Grades finished eval runs from their Langfuse traces and writes the grades
back. **You normally never run this yourself**: the
[Store Actor AI evals](../workflow-runner/README.md) runner starts it after
every run. Run it directly only to re-grade an old run with a new judge model
or prompt version. It never starts the evaluated agent, which is what makes
re-grading history free.

## What it writes to Langfuse

The judge merges two sources into one verdict: the **deterministic checks**
the runner ran against its evidence snapshot (which Actor was used, the input
the agent built, the dataset the run produced, grounding of the answer) and
the **model's rubric** over the full session log. Deterministic evidence wins:
a failed check is a `fail` even when the model liked the answer; an
infrastructure failure (Actor run `FAILED`, session timeout) is `inconclusive`
and is not charged to the team.

Per scenario, on the experiment-item observation (so the Experiments compare
view and dashboards can read them):

- `judge.verdict` (`pass` / `fail` / `wrong-actor` / `inconclusive`): the result in words. `wrong-actor` = the agent used an Actor other than the intended one (from tool calls, not answer text).
- `judge.overall` (1/0): the same as a number for averages; not written for `inconclusive`.
- `judge.fixArea` (category from the suite profile): what the subject's team should change first. Forced by a failed check when there is one (`apify.input` → `input-schema`, `apify.items` / `reference` → `output-format`, `subject.used` → `discoverability` on find scenarios), else the model's choice.
- `judge.disagreement` (1/0): the model and the checks disagreed on pass/fail. A judge-quality signal, trended on the overview dashboard.
- `eval.found` / `eval.works` (1/0): the Found / Works split per scenario type.
- `eval.passAtN` / `eval.consistency`: when a run repeats scenarios, any-repeat-passed and majority agreement per scenario; OUTPUT lists the `flaky` ones.
- `rubric.toolSelection`, `rubric.argumentCorrectness`, `rubric.resultUtilization`, `rubric.errorRecovery`, `rubric.planEfficiency`, `rubric.taskCompletion` (1/0): the model's rubric from apify-mcp-server#1203, maintainer-facing. `not_applicable` writes no score.
- `check.schemaValidity` (1/0): every Actor input validates against the tool schema the agent saw (from the evidence's full inputs).
- A trace comment on every non-pass scenario listing the reasons with evidence.
- A `judge` evaluator observation under the experiment item, with the prompt the model saw (facts, conversation) as input and its structured reply as output, plus token usage, so the judge's reasoning is readable in the trace.

Per run (subject = the dataset run), only for full-scope runs (`writeRunScores`): `pass_rate`, `found_rate`, `works_rate`, `inconclusive_rate`, `checks_pass_rate`, `judge_disagreement_rate`, `actor_runs_cost_usd`. Filtered team runs skip them so they never move the OKR trend.

Every score carries the version tuple `{rubricVersion, judgeModel, promptVersion, judgeImplVersion}` plus `datasetRunId`, `experimentItemId`, `verdict`, `fixAreaSource` and where the evidence came from.

### What the model sees

A **facts block** first: scenario type, intended subject, the Actor runs the agent triggered with status and item counts, the tools called, every deterministic check with PASS/FAIL and its comment, infrastructure problems. Then the conversation rebuilt from the **full session log** (8 kB previews instead of 2 kB), the final answer, the six rubric dimensions and the profile's fix-area list. The reply is requested as structured JSON (`response_format`), with a brace-scan fallback.

## Idempotency and versioning

Re-running on an already-judged run writes nothing: an item is skipped when a
`judge.verdict` score with the same version tuple exists. `force: true` writes
a new score set alongside the old one; nothing is ever mutated. The prompt is
`workflow-judge` in Langfuse prompt management, resolved by label
(`production`) once per batch; the resolved version is stamped into every
score. Bump `RUBRIC_VERSION` in `core.ts` when the rubric's meaning changes.

## Degraded mode

Traces without a `contractVersion` (pre-contract) or with an invalid span are
judged from their conversation JSON alone; schema validity becomes
`not_applicable` and score metadata carries `contractVersion: "none"` or
`"invalid"`.

## Run directly (re-grading)

```sh
apify call artogahr/eval-judge --memory 1024 --timeout 1800 -i '{
    "datasetRunId": "<Langfuse experiment id, from the runner OUTPUT>",
    "judgeModel": "anthropic/claude-sonnet-4.6",
    "force": true
}'
```

Langfuse keys come from the Actor's environment; `artifactStore` is the
`eval-artifacts` store picker (read access for snapshots and logs).

OUTPUT: `{datasetRunId, items, judged, passed, passRate, foundRate, worksRate, fixAreas, skippedAlreadyJudged, skippedNoTrace, errors, degraded, version, scoreboard}`; `SCOREBOARD` is the same per-Actor table as markdown.

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
| `planEfficiency`      | The number of tool calls is proportionate: no loops, duplicated work or detours.              |

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

Verified live against the Apify AI Agent project on 2026-09-09: `GET
/api/public/score-configs` is served in `events_only` mode, and the project has
zero score configs, so the first run of the script creates all seven with no
conflicts. Scores written without a config are accepted (BOOLEAN values read
back as JSON `true` / `false`), which is why the configs exist for the UI and
the `avg` views, not as a precondition for writing.

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
selects finished production Apify AI traces from a time window, samples them,
scores each sampled turn against the online rubric
([#269](https://github.com/apify/ai-team/issues/269)) and writes every verdict
to Langfuse twice, idempotently, plus a daily rollup
([#270](https://github.com/apify/ai-team/issues/270), see "Online score
writing" below).

**Window.** `[checkpoint ?? now-24h, now - 33 min)`. The upper bound is
`now - requestTimeoutMs - exportLag`: apify-ai-agent's `server.requestTimeoutMs`
is 30 min, so any turn that started before that point has finished, and 3 min
(the conservative end of the observed 1 to 3 min Langfuse export lag) lets its
completion span land. An empty or inverted window selects nothing and leaves
the checkpoint alone.

**Checkpoint.** The window's upper bound is written to the Actor's default
key-value store under `ONLINE_CHECKPOINT` as
`{upperBound, runId, writtenAt}`, so the next run starts where this one
stopped and a missed run backfills. `selectTraces()` computes the record and
returns it as `checkpoint`; the online flow passes `writeCheckpoint: false`
and writes it only after the window's scores and rollup are in Langfuse
(`finishOnlineRun()`), so a run that dies anywhere before that point is
retried over the same window instead of losing its sample. A run whose
completion gate looks broken (see below) returns `checkpoint: null`, so
nothing moves it and the next run retries the same window. Setting
`windowStart` or `windowEnd` skips the checkpoint entirely (neither read nor
written, `checkpoint: null`), so a backfill or debugging run never rewinds
production.

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
`windowEnd` (ISO 8601 overrides, see above; give them an explicit offset,
`2026-09-01T00:00:00Z`, because a string without one is parsed as the Actor's
local time). `judgeModel`, `promptLabel` and the Langfuse keys apply as in
datasetRun mode.

**OUTPUT.** `{mode, environment, window, checkpointWritten, isGateBroken,
tracesInWindow, completedTraces, sampled, scoresSkipped, judged,
failedToJudge, metadataMissing, scoresWritten, failedToWrite, rollupItemId,
sampledTraceIds}`. `scoresSkipped` counts sampled traces already judged under
this version (not judged again); `scoresWritten` and `failedToWrite` count
traces, not individual scores.

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
`io`, `metadata` and `model` field groups, `expandMetadata` for the one
metadata key that can exceed the endpoint's 200-character default truncation,
paginated. The shape it reads is what apify-ai-agent's exporter writes (Mastra
1.61 with `@mastra/otel-exporter` 1.3.9):

- the turn's `chat <model>` GENERATION, child of the root `invoke_agent` AGENT
  span, covering the whole agentic loop: `input` is the message array captured
  before the first step (system prompts, memory, the user message) as a JSON
  string in the OTel GenAI shape `{role, parts:[{type:'text', content}]}`,
  `output` is the final `{text}` as one assistant text part, untruncated. No
  `tool_call` parts appear on it;
- a SECOND `chat` GENERATION, also a child of the root, for Memory's thread
  title and compaction (a haiku model). It is not part of the turn: its input
  is a summarisation prompt whose user message is the transcript, and its
  output is the title. It is excluded and counted as `excludedGenerations`;
- one TOOL observation (`mcp_tool_call` span) per tool call, child of the turn
  GENERATION: `input` is the arguments as a JSON string, `output` the result as
  a JSON string, both untruncated, the namespaced tool key as the observation
  name and under `attributes.gen_ai.tool.name`, the model's call id under
  `attributes.gen_ai.tool.call.id`;
- trace metadata (`toolSchemaHash`, `outcome`, `steps`) serialised as the
  attribute `mastra.metadata.langfuse`, a JSON string.

The prompt (last user message), the earlier conversation (the last 10 texts,
shown as context only, with a count of what was dropped) and the final answer
come from the turn GENERATION; the steps are the TOOL observations in
`startTime` order, each citing its observation id, with the tool name stripped
of the `apify-ai_` namespace.

**One TOOL observation is one step.** The export carries no link from a tool
call back to the model step that requested it, so N calls the model issued in
parallel within one model step appear as N steps, and the step count is a count
of tool calls rather than of model turns. `planEfficiency` is worded that way.
Calls that share a start millisecond are ordered by observation id, which is
stable but arbitrary.

**Which generation is the turn's.** The GENERATIONs whose top-level
`sessionId` is non-empty: the turn's spans carry the thread id, Memory's
title/compaction generation is exported with an empty one and no thread
metadata at all. Fallbacks for a trace where none carries a session: the
generation that parents the TOOL spans, else the earliest. Without this the
memory generation could become the judged turn, making the title prompt the
question, the generated title the answer, and its span id the one every
comment cites.

A call is an error when the observation has `level: ERROR`, a `statusMessage`,
or an output carrying `isError: true`, an `error*` type, or a serialised error
(`{name:'Error', domain, category, id:'TOOL_EXECUTION_FAILED', cause}`, the live
shape) - the last one so a tool that reports failure without throwing still
counts. That last read demands `name`, `domain`, `category` and an `id` or
`cause` together, all of which the eight live MastraErrors carry, so a scraped
record that happens to hold `name` and `id` is not mistaken for a failure.
Arguments and result come from the mapped `input`/`output`, falling back to
`attributes.gen_ai.tool.call.arguments` / `.result`; a call with neither keeps
no arguments at all, and `argumentCorrectness` skips it instead of failing it
(absent arguments are missing evidence, not wrong arguments). Parsing
`tool_call` / `tool_call_response` parts out of GENERATION messages is kept
only as a fallback for a trace with no TOOL observation. Trace metadata is
read from every observation at three candidate locations in order (a top-level
key, a nested `langfuse` object, the `attributes.mastra.metadata.langfuse` JSON
string); when none yields anything the turn's outcome is unknown, its hash
null, and the run counts it in `metadataMissing` and logs a warning. The model
id comes from the `model` field the endpoint returns (the SDK documents it as
`providedModelName`), then from `attributes.gen_ai.response.model`. A trace
with no GENERATION or no user message cannot be reconstructed and counts as
`failedToJudge`.

**Confirmed live 2026-09-09** against staging Langfuse, on three traces with
tool calls (`98ee3c06...`, `4d43c3b8...`, `88bceef8...`) plus eight ERROR-level
TOOL observations. The rows are in `test/fixtures/live-trace.ts` as the endpoint
returned them, except that long string payloads are cut at a
`[... trimmed for the fixture ...]` marker and the error row drops the
`resourceAttributes.process.*` / `.host.*` families; the fixture's own docstrings
list every departure.

- The turn `chat` GENERATION output carries no `tool_call` parts: it is one
  assistant text part.
- A trace carries one or two GENERATIONs: the turn's sonnet one always, and a
  later haiku one for the thread title when Memory names or compacts the thread
  (three of the four traces sampled from 2026-09-04 have only the turn's). The
  empty-`sessionId` rule separated them wherever both were present.
- TOOL observations have `input` and `output` populated and untruncated
  (`{"keywords":"Google Maps reviews"}` and a 9441-character result), with
  `attributes.gen_ai.tool.call.id` = `tooluse_...` and
  `attributes.gen_ai.tool.name` = `apify-ai_search-actors`.
- A failed tool call is `level: 'ERROR'` with an EMPTY `statusMessage`, and its
  `output` is the serialised MastraError. There is no `attributes.error.*`, no
  `exception.*` and no `attributes.success` anywhere, so the `success === false`
  read was dropped.
- `sessionId` and `userId` are top-level observation fields, and the model
  arrives as `model`, not `providedModelName`.
- `expandMetadata` is accepted by the endpoint and forwarded by the SDK.

**Not yet verifiable.** The trace-contract metadata path
(`attributes.mastra.metadata.langfuse`, and with it `outcome`,
`toolSchemaHash` and the `apify-ai` tag the selection filters on) cannot be
observed because apify-ai-agent's `feat/trace-contract` is undeployed: every
current trace reconstructs with `metadataFound: false`. The attribute NAME is
evidenced though - every other `tracingOptions.metadata.<key>` does arrive as
`attributes.mastra.metadata.<key>` on the live root span (`userId`,
`threadId`, `runId`, `resourceId`, `callerOrigin`). All three read paths are
kept until the contract deploys, and `metadataMissing` in OUTPUT says which one
turned out to be real.

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
and `schemaMatch: false` goes into the comment and metadata.

Expect `schemaMatch: false` on every trace today. The agent hashes Mastra Tool
objects, whose `inputSchema` is a JSON-schema wrapper made of functions;
functions are dropped by the stable stringify, so every tool hashes as
`{"~standard":{"jsonSchema":{},"vendor":"json-schema","version":1}}` and the
production hash does not depend on schema content. The judge deliberately
hashes the raw JSON schema, which is what the agent will hash once fixed
(raised in apify-ai-agent); a test pins the mismatch so it stays visible.
Validation runs against the live schemas either way, and the comment says so.
The criterion is
omitted, with a reason, when the turn made no tool calls, when no called tool
has a schema, when no call recorded its arguments, or when `tools/list` failed
for the batch. A call whose span recorded no arguments is skipped rather than
validated: absent arguments are missing evidence, not wrong arguments, and
validating nothing produced a bogus `/ must be object` failure. Failure comments
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
from the comment because it may quote the turn. `judgeOnlineTrace()` returns it
inside `{verdicts, traceMetadataFound}`, and `src/online-scores.ts` consumes
this value through one adapter, `pendingScores()`.

**Prompt injection.** The rendered turn sits between unique
`<<<APIFY_AI_TURN_DATA_BEGIN>>>` / `<<<APIFY_AI_TURN_DATA_END>>>` markers and the
prompt states that everything inside is data to be judged, never instructions,
and that the reply format is fixed regardless of the content.

**Judge model.** `judgeModel` defaults to `deepseek/deepseek-v4-flash` in
online mode and stays `anthropic/claude-sonnet-4.6` in datasetRun mode.

### Online score writing

`src/online-scores.ts` ([#270](https://github.com/apify/ai-team/issues/270)).
Every scored criterion of a judged trace becomes two Langfuse scores; omitted
criteria (errorRecovery without a tool error, argumentCorrectness without
schemas) write nothing.

**Score id.** `<traceId>-<scoreName>-p<promptVersion>-i<judgeImplVersion>-<judgeModel>`,
for example
`abc…-agent_judge_toolSelection-p3-i0-3-0-deepseek-deepseek-v4-flash`.
`promptVersion` is the Langfuse prompt version resolved for the batch and
`judgeImplVersion` is `JUDGE_IMPL_VERSION` from `core.ts` (there is no separate
hand-bumped judge version). The impl version and the model id are sanitised
for the id: every run of characters outside `[A-Za-z0-9_-]` (so `/`, `:`,
`.`, spaces) becomes one `-`. The typings document no charset or length for a
score id; `onlineScoreId()` pins the charset to the sanitiser's output and
caps the length at 255 (the dataset item id limit, the only documented id cap
in the API) and throws `InvalidScoreIdError` otherwise. A bumped prompt, impl
or model gives a new id, so the new score lands beside the old one and a
rubric change stays visible. The id builder is pure and unit-tested.

**Two copies.** The trace copy (`traceId` subject) is what the trace view and
score tables show; it is deleted with the trace by the 30-day retention sweep.
The archival copy is the same score with `datasetRunId: 'apify-ai-online-YYYY-MM-DD'`
as its only subject, no `traceId`, no dataset, no items (the date is the
window's, see "Which day" below). Langfuse requires exactly one subject per
score (two is a 400) and does not check that the run exists, so the copy
survives the sweep. It reads back through `GET /api/public/v3/scores` with the
`experimentId=<runId>` filter (`datasetRunId` and `datasetRunName` are
rejected as unrecognised keys) and its subject is `{kind: 'experiment', id}`.
The create, the replace-on-same-id, the one-subject rule and this read-back
were verified live against langfuse.apify.dev on 2026-09-09. One inference
remains untested: that the metrics API aggregates the copy by run. In
`events_only` mode the working endpoint is `GET /api/public/v2/metrics`
(`/api/public/metrics` is 404); its `scores-boolean` view accepts the
`experimentId` / `datasetRunId` dimensions and does aggregate real
experiment-subject scores by run, but whether scores under a run that does not
exist as a dataset run are dropped by a join is the open question. Its id carries the suffix
`-run`; with the trace copy's id it would be deduplicated away. Both copies
are `dataType: BOOLEAN`, carry the verdict comment and the score metadata
(`rubricName`, `rubricVersion`, `judgeModel`, `promptVersion`,
`judgeImplVersion`, `toolSchemaHash`, `schemaMatch`, `outcome`, `spanId`).
The judge's evidence goes into the trace copy's metadata only: it may quote
the user, and the archival copy outlives the trace's retention. `source` is
not set: the endpoint defaults to `API`, refuses `EVAL` with a 400 naming
`API`/`ANNOTATION` as the allowed values, and `ANNOTATION` additionally
requires a `configId`, so `API` is the only usable source here.

**Timestamp caveat.** `CreateScoreRequest` has no timestamp field, and the
SDK's batched ingestion path (`langfuse.score.create`) stamps the event with
`new Date()` itself, so neither copy can be pinned to the trace's own time:
both carry the write time. Langfuse's scores table is a ReplacingMergeTree
ordered by `(project, toDate(timestamp), name, id)`, so a same-day write with
the same id REPLACES the existing row: idempotent when the content is the
same, and under `force` it overwrites the verdict in place rather than adding
one. A write on a later UTC day with the same id is a second row. The
pre-filter below is what prevents that; the one path it does not cover is a
trace whose writes died halfway and is retried after UTC midnight: that trace
then has two rows per criterion (one per day), and its run copies land under
the window's run id either way, because the run id is keyed on the window,
not on the write time. Rare, partial-write path only.

**Which day.** Run ids (`apify-ai-online-YYYY-MM-DD`) and rollup items
(`rollup-YYYY-MM-DD`) are keyed on the UTC date of the WINDOW START, not of
the write, so a backfill of last week (`windowStart`/`windowEnd` overrides)
lands on last week's days and does not inflate today's counters. For the
checkpoint-driven daily run this shifts the label by one day relative to the
write: a run at about 06:00 UTC on day D has the window
`[D-1 ~05:27, D 05:27)`, so its run copies and rollup are keyed `D-1` and are
written at about 06:0x on day D. A monitor (#271) that expects "the run copy
for today written at ~06:0x" must read it as "the run copy for D-1 written at
~06:0x on D". The window start, not `now`, was chosen because the label should
name the traffic being judged, and a backfill that lands on today would make
today's pass rate a mix of two weeks. Two more facts for a monitor's filters
(verified live 2026-09-09): BOOLEAN scores read back with `value: true` /
`value: false` (JSON booleans, not 1/0), and every score lands in the
environment `default`, whatever environment the judged trace is in.

**Idempotency.** Before judging, the sampled trace ids are checked against
`GET /api/public/v3/scores` (`name=agent_judge`, `fields=details,subject`, in
chunks of 50 trace ids): a trace whose holistic score has the same
`promptVersion`, `judgeImplVersion` and `judgeModel` in its metadata is
skipped and counted in `scoresSkipped`, so a re-run over the same window
spends nothing on the LLM and writes nothing. `force: true` judges and writes
everything anyway (a same-day repeat replaces the rows in place, see the
timestamp caveat). The holistic trace copy is written LAST for each trace: a
trace whose writes died halfway carries no marker, so the next run redoes it,
and on the same day the ids replace the rows already there.

**Daily rollup.** One dataset item per UTC day of the window start,
`rollup-YYYY-MM-DD` in the dataset `apify-ai-online-rollups`.
`POST /api/public/v2/datasets` is called on every run: it is idempotent by
name in practice (verified live 2026-09-09: an existing name returns the same
dataset id, `createdAt` preserved). WARNING: no public API deletes a dataset,
so `ROLLUP_DATASET_NAME` is permanent once the first run creates it; the
constant is pinned by a test, and renaming it means an orphaned empty dataset
in the project forever. A dataset item POST with an existing id replaces the
whole document (verified live). `input` is
`{date, sampleRate, maxItems}`; `metadata` is the rollup: `passes` and `n` per
score name, counted over the traces whose scores were actually WRITTEN
(omitted criteria are not counted), `passRate` (`passes / n`, null when n is 0;
the same number `avg` gives over the day's scores), the coverage counters
`{tracesInWindow, completedTraces, sampled, judged, failedToJudge,
scoresWritten, failedToWrite}` and `runs`. `judged` minus `scoresWritten` is
the number of verdicts that never reached Langfuse. Several runs on one day
merge: the existing item is read (`datasetItems.get`, 404 means none), counts
and coverage are summed and the rates recomputed; an existing item that is not
a rollup is replaced with a warning. A run that sampled and judged nothing
(empty window, or no completed traces) writes no rollup, so `runs` counts only
runs that had work. A retry over the SAME window (after a failed rollup or an
all-failed batch) sums `tracesInWindow`, `completedTraces` and `sampled` a
second time; `n` and `passes` stay exact because the retry writes only traces
the pre-filter did not skip. The arithmetic (`computeRollup`, `mergeRollup`)
is pure and tested. Datasets and dataset items work in `events_only` mode
(verified live 2026-09-09); only the dataset-RUN lookups are refused there.

**Ordering and failure.** `finishOnlineRun()`: scores, then rollup, then
checkpoint. A failed score write for SOME traces is logged, counted in
`failedToWrite` (OUTPUT and rollup coverage) and does not stop the batch or
hold the checkpoint back: each is one sampled item of many, and holding the
window would re-sample and re-judge the rest for nothing; the rollup counts
only the traces that were written. A batch whose writes ALL failed (Langfuse
down, subject rejected) is a failure, not a success: no rollup, the checkpoint
is NOT written and the run exits non-zero (`AllScoreWritesFailedError` via
`Actor.fail`), otherwise the window and its LLM spend would be lost silently.
The judge-side twin is handled the same way: when every trace given to the
judge failed to judge (`sampled - scoresSkipped > 0` and `judged === 0`, the
signature of a systematic judge failure such as the model or the prompt being
broken), nothing is rolled up, the checkpoint is NOT written and the run fails with
`AllJudgementsFailedError`, so a broken judge holds the window instead of
advancing past it with nothing scored. A failed rollup is handled the same way
(logged, no checkpoint, non-zero exit). In every case the schedule shows a
failed run and the window is retried; the retry
is safe because of the pre-filter and the id replacement. Note that the
retry's rollup covers only the traces written in the retry: the scores are the
source of truth, the rollup a convenience for alerting.

**What a re-run does.** Same window, same versions: selection samples again,
the pre-filter drops every already-judged trace, new picks (if any) are
judged and written, the rollup gains one run, the checkpoint moves. Same
window after a prompt, impl or model bump: everything is judged again and the
new scores land beside the old ones under new ids.

## Scope notes

- Judges by dataset-run id only; judging from the span's conversation JSON, not the full log.
- The halo-audit mode (isolated per-dimension calls) from the design record is not built.
- Deploy: `scripts/deploy.sh judge` from the repo root.
