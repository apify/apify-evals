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

## v1 scope notes

- Judges by dataset-run id only; traceIds/filter inputs are planned.
- Judges from the span's conversation JSON; fetching the full session log via
  the span's `fullLogUrl` pointer is future work.
- The halo-audit mode (isolated per-dimension calls with a disagreement
  threshold) from the design record is not built yet.
- Deploy: `scripts/deploy.sh judge` from the repo root (monorepo build).
