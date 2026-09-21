@AGENTS.md

# Apify agent evals

Two live Apify Actors plus a shared contract that measure whether AI agents can
find and correctly use Apify surfaces (store Actors first; MCP tools, CLI, SDK
and Apify AI through the same engine). Langfuse (`langfuse.apify.dev`, v4
events-only mode) is where results are read; the Apify Console is the Run
button.

## Layout

- `contract/` — the trace contract (JSON Schemas + ajv), the generic scenario
  metadata, the check language and the pure deterministic check engine
  (`src/checks.ts`). Both Actors depend on it. Tests in `test/`.
- `actors/workflow-runner/` — the **runner**: reads a Langfuse dataset (a
  suite), runs one headless Claude Code session per scenario in parallel,
  emits traces (agent span + per-turn generations + per-tool observations),
  collects evidence (Actor runs, dataset items, reference runs), scores the
  scenario's deterministic checks, then calls the judge. `src/main.ts`
  (inputs, scope, preflight, exit codes), `src/harness.ts` (session, trace,
  evidence), `src/evidence.ts` (extraction, Apify API, reference runs),
  `src/notify.ts` (Slack digest), `src/artifacts.ts` (eval-artifacts store).
- `actors/judge/` — the **judge**: reads the evidence artifact and the full
  session log, asks the model for the rubric, merges deterministic checks and
  model into one verdict (`src/verdict.ts`, tested), writes scores, a trace
  comment and an evaluator observation. `src/profile.ts` loads the suite
  profile's fix areas.
- `scenarios/<suite>/<owner>/<subject>.yaml` — scenario source of truth;
  `profiles/<suite>.yaml` — what a suite tests, tools per skill, fix areas.
  `tools/` syncs scenarios to Langfuse (`npm run scenarios:sync`) and
  validates them (`npm run scenarios:check`). See `scenarios/README.md`.
- `actors/runner/`, `shared/`, `docs/`, `spikes/`, `scenarios/*.md` — the
  legacy markdown-scenario runner (Czech docs). Not part of the live system.

## Conventions

- TypeScript, ES modules, `.js` extensions in relative imports, 4 spaces,
  single quotes, 120 columns (Prettier). Build with `tsc` per workspace.
- Check exit codes when building; do not filter `npm run build` output with
  `grep` and assume success.
- Deploy from the repo root with `scripts/deploy.sh judge` then
  `scripts/deploy.sh workflow-runner` (the judge is called by Actor name).
  Verify with a small cloud run (`subjects` filter, `itemLimit`), then commit
  one logical step at a time.
- Scores the judge writes are append-only and versioned by
  `{rubricVersion, judgeModel, promptVersion, judgeImplVersion}`; bump
  `JUDGE_IMPL_VERSION` when behaviour changes, `RUBRIC_VERSION` when the
  rubric's meaning changes. The prompt lives in Langfuse prompt management
  (`workflow-judge`, label `production`); `DEFAULT_JUDGE_PROMPT` is the seed.
- Never put live values (follower counts, prices) into deterministic checks;
  use structural checks, stable facts or a `reference` run.
- Langfuse dashboards can only slice scores by `userId`, `traceVersion`,
  `traceName`, `name` and categorical `stringValue`; the runner maps
  subject → `userId`, model → `version`, scenario title → `traceName`.

## Score vocabulary

`judge.verdict` (pass / fail / wrong-actor / inconclusive) · `judge.overall`
(1/0) · `judge.fixArea` (profile category) · `judge.disagreement` ·
`eval.found` / `eval.works` · `eval.passAtN` / `eval.consistency` (repeats) ·
`check.<id>` per declared check, `check.all`, `check.infra`,
`check.schemaValidity` · `rubric.<dimension>` (model rubric, maintainers) ·
run-level `pass_rate`, `found_rate`, `works_rate`, `inconclusive_rate`,
`checks_pass_rate`, `judge_disagreement_rate`, `actor_runs_cost_usd`.
