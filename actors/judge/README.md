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

## Scope notes

- Judges by dataset-run id only; judging from the span's conversation JSON, not the full log.
- The halo-audit mode (isolated per-dimension calls) from the design record is not built.
- Deploy: `scripts/deploy.sh judge` from the repo root.
