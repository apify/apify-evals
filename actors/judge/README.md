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

## Scope notes

- Judges by dataset-run id only; judging from the span's conversation JSON, not the full log.
- The halo-audit mode (isolated per-dimension calls) from the design record is not built.
- Deploy: `scripts/deploy.sh judge` from the repo root.
