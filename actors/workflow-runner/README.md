# Eval runner

Runs every scenario of a suite through an AI agent, one isolated session per
scenario, in parallel inside one Actor run. It records what the agent did
(tool calls, Actor runs, results, files), scores the scenario's deterministic
checks, then starts the [judge](../judge/README.md), which grades each session
and regenerates the suite's HTML report. One Run click, or a schedule, gives
you one Langfuse results link per model.

## Suites

A suite is one thing under test with its own scenarios, fix areas, owners and
report. The runner takes the suite's dataset name (`datasetName`) and the
Langfuse keys of the project it lives in; everything else has defaults.
[docs/adding-a-suite.md](../../docs/adding-a-suite.md) walks through adding
one.

The live example is `store-actors`: 30 Apify-maintained Store Actors, two
scenarios each, run every morning. Its daily report is at
https://api.apify.com/v2/key-value-stores/QEr12X3OJMj34ZRnb/records/report-store-actors-latest.html
and its own page for the Store teams is
[scenarios/store-actors/README.md](../../scenarios/store-actors/README.md).

## Results

### Deterministic checks and verdicts

Each scenario can declare checks that are decided by code, not by the judge: which Actor was actually called, the input the agent built, how many items the run produced and which fields they have, whether the numbers in the answer exist in the Actor output, and comparisons against a fresh reference run. See [scenarios/README.md](../../scenarios/README.md). A failed check makes the verdict `fail` even if the judge liked the answer; an infrastructure failure (Actor run failed, MCP exposed no tools, timeout) makes it `inconclusive` and is not charged to anyone.

### Reading the numbers honestly

- Models run inside the selected harness, Claude Code by default or Codex. Compare the same model and harness; Codex run names include `codex`.
- One run is a sample. Compare runs on the same model and judge; use repeats or the dashboard trend before acting.
- The judge is a model. Its fix area is a hint with evidence, not a verdict.

## For maintainers

### What the Actor does

1. Fetches the Langfuse dataset by name, filters by `metadata.category`, repeats items if asked.
2. Runs one isolated headless session in the selected harness per item, in parallel inside this Actor run (pool with `concurrency`, per-item timeout). Each session gets hosted `mcp.apify.com` narrowed by `?tools=` (spec D1) and, for Claude Code, Bash only when the item asks.
3. Under the agent span, the session is replayed as child observations for humans: a generation per model turn (text, tool calls, token usage when the harness exposes per-call counts) and a tool observation per tool call (arguments, result up to 20 kB, ERROR level on tool errors), timed from stdout arrival. The agent span itself carries the judge-ready conversation JSON (spec D10) validated against `contract/`; full logs and tool-schema snapshots go to the named `eval-artifacts` key-value store with URL + sha256 pointers on the span. Traces are named after the scenario title and tagged `dataset:`, `model:`, `actor:`, `team:`, `skill:`. Because Langfuse dashboards can only group scores by a fixed set of trace attributes (and group `tags` by the whole array), the team-facing slices are also mapped onto them: trace `userId` = Actor (and `sessionId` = Actor, so the Sessions page lists every trace of one Actor), `version` = model; team stays a tag used as the dashboard-level filter. The dashboards' per-Actor and per-model widgets read those.
4. Collects **evidence** from the full tool results (the Actor runs the agent triggered with run ids, status, dataset ids and the input the agent built; tool calls; dataset items fetched from the Apify API, capped at 1000; an optional reference run of the subject Actor for fresh ground truth; for Bash-enabled scenarios also every shell command the agent ran, Actor run ids found in its output, and a snapshot of the files it left in its working directory, capped at 300 files with small text files inline) and runs the scenario's deterministic checks against it (`contract/src/checks.ts`). Writes one `check.<id>` score per check onto the experiment item, plus `check.all` and `check.infra`, freezes the evidence and check results as `evidence-<traceId>.json` in `eval-artifacts`, and links `call-actor` observations to the Console run and dataset.
5. Starts the [Eval Judge](../judge/README.md) (`Actor.call`, env `JUDGE_ACTOR`) on the new run and merges its summary into OUTPUT: `resultsUrl` (compare view), `passRate`, `foundRate`, `worksRate`, `fixAreas`, `scoreboard`, `judgeRunUrl`.

A broken harness fails the item loudly; an agent that ran out of turns or hit the timeout is a scored result, not an error (spec D13/D14).

### Harnesses

The default is `claude-code`. To run the same scenarios with Codex, set the advanced **Harness override** input:

```json
{
    "harness": {
        "kind": "codex",
        "model": "openai/gpt-5-mini",
        "maxTurns": 12
    }
}
```

The top-level `model` or `models` input overrides the model in `harness`; scenario `metadata.maxTurns` overrides the harness turn budget. Codex uses the same per-skill MCP allowlists, evidence, deterministic checks, judge, and trace observations. Its experiment name includes `codex` unless you supply `runName`.

The image pins Codex CLI to `0.154.0`. Each session has a temporary `CODEX_HOME`, an empty working directory, shell tools disabled, and a read-only sandbox with approvals disabled; the allowlisted MCP tools are pre-approved (`default_tools_approval_mode = "approve"`), because Codex would otherwise reject every non-read-only tool call such as `call-actor` under a `never` approval policy. `apply_patch` remains advertised by Codex but writes are denied by the sandbox. Codex does not support the `allowBash` scenarios; use Claude Code for CLI evaluations. The run token is passed in the child environment for the model provider and MCP bearer authentication; it is not written to the generated config. Local runs with `useOpenRouterProxy: false` reuse only the developer's file-backed Codex login and need a model id accepted by that login, such as `gpt-5-mini`. Other local MCP servers and user configuration are not loaded.

Codex has no `--max-turns` option. The adapter counts tool-call rounds and stops after the last allowed round returns, retaining its evidence as a scored result. Parallel calls count as one round. This can leave the final answer unfinished, and event delivery can race the next call, so the limit is not an exact billing cap. The per-item timeout covers MCP probes, the optional restart, and the session; it kills the child process group. Timeouts, truncated logs, startup failures, crashes, and unparseable sessions remain infrastructure failures. A failed MCP startup or a server exposing zero allowed tools gets one retry. Because Codex does not publish a tools/list event, the adapter obtains the tool count from a separate probe of the same URL and requires Codex's own MCP initialization to succeed.

Codex JSONL reports token usage for the entire user turn, including all model calls. The adapter stores those totals in session metrics and adds generation usage only for a session with one generation. It does not distribute totals across inferred model calls. Cost and child peak RSS are unavailable for this adapter. Reasoning items appear in generation text when the CLI emits them.

Local checks verified authenticated MCP calls, the event format, and shell/write restrictions. The orchestrating cloud probe verified `/api/v1/responses` with an Actor run token. An end-to-end cloud run is still needed to verify the built image, Codex's streaming model requests through the proxy, and the resulting Langfuse trace, evidence artifacts, and check scores.

### Run health and exit codes

The run status reports system health, never scenario results (spec D14). Exit 0: ran and judged. 10: fewer than `healthThreshold` of the sessions completed. 11: the judge Actor failed. 12: no scenario matched the filters. 13: telemetry flush failed. 14: preflight failed (MCP server returned no tools or the LLM proxy did not answer). Schedules and tasks get Apify's failure notifications for free.

### Secrets and permissions

Sessions authenticate the LLM through the Apify OpenRouter proxy and MCP through `mcp.apify.com` with the run's own `APIFY_TOKEN`; Claude Code uses its Anthropic wire format, while Codex uses the Responses API. Both accept OpenRouter model ids. Langfuse keys come from the Actor's environment (`@langfusePublicKey`, `@langfuseSecretKey` Apify secrets); the input fields are overrides for another Langfuse project, and when any is set the runner passes the resolved set to the judge so both Actors use the same project. `artifactStore` is a resource picker; leaving it empty uses `ARTIFACT_STORE_ID` from the environment, which points at the named `eval-artifacts` store.

Both Actors must run with **full permissions** (Actor settings → Permissions, or `apify api PUT actors/<id> -d '{"actorPermissionLevel":"FULL_PERMISSIONS"}'`). A new Actor defaults to limited permissions, and a limited run token cannot start other Actors or create tasks, so every MCP call the agent makes fails with `insufficient-permissions` and the runner cannot open the named store. It is a one-time setting per Actor; it survives every `apify push`.

### Standing up a new deployment

Order matters: the runner calls the judge by name and both read the same store and secrets.

1. `apify login` as the account that will own the Actors, then store the two Langfuse secrets locally so `apify push` uploads them: `apify secrets add langfusePublicKey <pk>` and `apify secrets add langfuseSecretKey <sk>`. `LANGFUSE_BASE_URL` is plain text in both `actor.json` files.
2. Create the artifact store once, `apify key-value-stores create eval-artifacts`, and put its id into `ARTIFACT_STORE_ID` in both `actor.json` files.
3. Deploy the judge, then the runner: `scripts/deploy.sh judge && scripts/deploy.sh workflow-runner`. Set `JUDGE_ACTOR` in the runner's `actor.json` to `<account>/<judge name>` before pushing if the account or name differs from the defaults.
4. Set both Actors to full permissions (see above). Verify with one small run: `apify call <account>/<runner> --memory 8192 --timeout 3600 -i '{"datasetName":"store-actors","subjects":["compass/crawler-google-places"],"itemLimit":1}'` and open the `resultsUrl` from OUTPUT.
5. Recreate the schedule and the team tasks. The daily schedule is `0 6 * * *` Europe/Prague, action `RUN_ACTOR` on the runner with input `{"datasetName":"store-actors"}` and run options 8192 MB, 3600 s; create it with `apify api POST schedules -d '<json>'`. The team tasks (`store-evals-google`, `store-evals-socials`, `store-evals-video`) are the same input plus `"owners":["google"]` and so on; create them with `apify api POST actor-tasks -d '<json>'`. Scenarios are synced from the repo with `npm run scenarios:sync` and need only the Langfuse keys, not the Actors.
6. Switch the old account's schedule off so the suite runs once a day, not twice.

### Deploy and run

Production runs under the `internal-apps` org: `internal-apps/eval-runner` and `internal-apps/eval-judge` build from this repository (`https://github.com/apify/apify-evals#main:actors/<folder>`), so a Console "Build" pulls `main`. `scripts/deploy.sh` pushes a local checkout to whichever account the CLI is logged in as; use it for a personal copy or a test.

```sh
scripts/deploy.sh judge && scripts/deploy.sh workflow-runner   # from the repo root
apify call internal-apps/eval-runner --memory 8192 --timeout 3600 -i '{"datasetName":"store-actors"}'
```

Local runs: `apify run` in this directory with `useOpenRouterProxy: false` (the proxy only accepts tokens from inside Actor runs).

Langfuse here runs v4 in events-only mode: dataset-run read APIs are disabled, use the experiments APIs. The compare view is `.../experiments/results?baseline=<datasetRunId>`.

### Measured on the platform

16 parallel Claude Code sessions in one 8 GB run: 16/16 passed, 15.7 s, peak 2.4 GB, about $0.012 compute; CPU is the limit (1 core per 4 GB, plan 4–8 sessions per core). Per-case Actor fan-out (spec D7) would pay 8–25 s container overhead per case, so the in-process pool replaced it.

### Spec mapping

| Spec decision                                 | Here                                                              |
| --------------------------------------------- | ----------------------------------------------------------------- |
| D1 hosted MCP, per-case tools                 | yes (`metadata.tools` → `?tools=`)                                |
| D5 one image, harness discriminator           | yes (`harness.kind`, adapter registry; `claude-code` and `codex`) |
| D7 one Actor run per case                     | replaced by the in-process pool                                   |
| D8 per-case timeout/maxTurns                  | `metadata.maxTurns`; timeout is run-level                         |
| D9/D11 judge reads traces, prompt in Langfuse | yes, via the Judge Actor the runner starts                        |
| D10 conversation JSON on the agent span       | yes                                                               |
| D13/D14 health vs results                     | yes                                                               |
