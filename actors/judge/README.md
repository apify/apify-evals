# Eval Judge

Grades finished eval runs from their Langfuse traces and writes the grades
back. **You normally never run this yourself**: the
[Store Actor AI evals](../workflow-runner/README.md) runner starts it after
every run. Run it directly only to re-grade an old run with a new judge model
or prompt version. It never starts the evaluated agent, which is what makes
re-grading history free.

## What it writes to Langfuse

Per scenario, on the experiment-item observation (so the Experiments compare
view and dashboards can read them):

- `judge.verdict` (`pass` / `fail` / `wrong-actor`): the per-scenario result in words, for reading the compare view. `wrong-actor` = a discovery scenario where the agent completed the task with an Actor other than the intended one.
- `judge.overall` (1/0): the same result as a number so dashboards can average it. Comment starts with `PASS:` or `FAIL:` and the evidence.
- `judge.fixArea` (category): `input-schema` · `readme-docs` · `output-format` · `error-messages` · `discoverability` · `agent-or-model` · `none`, with the cited tool call as comment.
- `judge.toolSelection`, `judge.argumentCorrectness`, `judge.resultUtilization`, `judge.errorRecovery`, `judge.planEfficiency`, `judge.taskCompletion` (1/0): the rubric from apify-mcp-server#1203. `not_applicable` writes no score.
- `check.schemaValidity` (1/0): every Actor input validates against the tool schema the agent saw (hash-verified snapshot from `eval-artifacts`).
- A trace comment on every failed scenario listing the failed dimensions with evidence.

Per run (subject = the dataset run): `pass_rate`, `found_rate`, `works_rate`.

Every score carries the version tuple `{rubricVersion, judgeModel, promptVersion, judgeImplVersion}` plus `datasetRunId` and `experimentItemId`.

## Idempotency and versioning

Re-running on an already-judged run writes nothing: an item is skipped when a
`judge.overall` score with the same version tuple exists. `force: true` writes
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
