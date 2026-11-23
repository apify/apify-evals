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

### What a run gives you

The run's OUTPUT and its last log lines carry one results link per model: the
Langfuse compare view, one row per scenario. Three scores tell the story of a
row:

- **Verdict** (`judge.verdict`): `pass`, `fail`, the suite's wrong-subject
  label (for example `wrong-actor`), or `inconclusive` when the infrastructure
  failed rather than the subject. `judge.overall` is the same as 1/0, and its
  average is the pass rate.
- **Find vs use**: every scenario is one of the two types. A `find` failure
  means the subject was hard to find or presented itself badly; a `use`
  failure means the subject itself was hard to drive. The profile names the
  two for the report (`Found`/`Works` in the Store suite).
- **Fix area** (`judge.fixArea`): the one thing the subject's owner should
  change first, chosen from the profile's list, with a cited tool call.

Click a row to see the session as it happened: one `turn N` per model call
(text, tool calls, tokens), one step per tool call with its arguments and
result (errors in red), and the judge's comment at the bottom listing what
went wrong with evidence.

### Check whether a change helped

1. Run the suite with **Only these subjects** set to the subject you changed
   and **Repeats** set to 3.
2. In the compare view, pick the previous run of that subject as the baseline.
   Rows that flipped are the story.
3. With repeats the judge writes `eval.passAtN` (any repeat passed) and
   `eval.consistency` per scenario, and OUTPUT lists `flaky` scenarios. A 2/3
   to 3/3 move is real; a single 1/3 flip is probably a flaky run.
4. A filtered run never writes run-level scores or the report, so it does not
   move the suite's trend. Only full runs do.

### Compare surfaces and agent skills

The same scenarios can run through different ways of reaching Apify, with or without agent skills. Use this to compare MCP and API, or to test a change to one of them.

- **Surfaces** (`surfaces` input): `mcp` (the Apify MCP server, the default) and `api` (curl, jq and WebFetch against `api.apify.com`). Each name is a file in [`surfaces/`](../../surfaces). Add a file to compare a variant, for example a staging MCP server (`mcpUrl`).
- **Skill sets** (`skillSets` input): `none`, `apify-ultimate-scraper`, or names joined with `+`. The runner downloads them from [apify/agent-skills](https://github.com/apify/agent-skills) at the commit pinned in `src/skills.ts` (`DEFAULT_SKILLS_REF`); `skillsRef` takes another ref. See [`skills/README.md`](../../skills/README.md). `skillCombinations` runs every subset of the suite's `agentSkills`.
- Every model × surface × skill set is its own experiment run, named for example `store-actors · haiku-4.5 · surface:api · skills:apify-ultimate-scraper · …`. Open the compare view and put two of them side by side. OUTPUT `variants` lists every combination with its pass rate, best first.
- The agent is not blocked from other surfaces. The span records `surfacesUsed`, and the `surface.used` check (default severity `warn`) says when the agent left the configured surface.
- A run with more than one surface or skill set is a comparison run. Its experiments stay out of the suite's daily report, which tracks the suite's normal setup. The Slack digest compares each variant only with the previous run of the same model, surface and skill set.

To test a change before release:

| You changed     | Run with                                                                     |
| --------------- | ---------------------------------------------------------------------------- |
| An agent skill  | `skillSets: ["none", "<skill>"]`, `skillsRef: "apify/agent-skills#<branch>"` |
| The MCP server  | a surface file with `mcpUrl` set to your server, next to `mcp`               |
| The API or docs | `surfaces: ["api"]` before and after the change                              |

Start small: filter to a few subjects and use `repeats: 3`. `maxSessions` (default 400) refuses a run that would start more sessions than that.

### Deterministic checks and verdicts

Each scenario can declare checks that are decided by code, not by the judge: which Actor was actually called, the input the agent built, how many items the run produced and which fields they have, whether the numbers in the answer exist in the Actor output, and comparisons against a fresh reference run. See [scenarios/README.md](../../scenarios/README.md). A failed check makes the verdict `fail` even if the judge liked the answer; an infrastructure failure (Actor run failed, MCP exposed no tools, timeout) makes it `inconclusive` and is not charged to anyone.

### Reading the numbers honestly

- Models run inside the selected harness: Claude Code by default, Codex or OpenCode. Compare the same model and harness; Codex and OpenCode run names include `codex` or `opencode`.
- Compare surfaces and skill sets on the same model, scenarios and judge. Runs on a surface other than `mcp` have trace `version` = `<model> · <surface>`, so per-model dashboard widgets keep them apart.
- One run is a sample. Compare runs on the same model and judge; use repeats or the dashboard trend before acting.
- The judge is a model. Its fix area is a hint with evidence, not a verdict.

## For maintainers

### What the Actor does

1. Fetches the Langfuse dataset by name, filters by `metadata.category`, repeats items if asked.
2. Runs one isolated headless session in the selected harness per item, in parallel inside this Actor run (pool with `concurrency`, per-item timeout). The session is built from the surface (`surfaces/<name>.yaml`): on `mcp` it gets hosted `mcp.apify.com` narrowed by `?tools=` (spec D1) and, for Claude Code, Bash only when the item asks; on `api` it gets no MCP server, Bash, WebFetch and `APIFY_TOKEN`. Injected agent skills go into the session's working directory, and Claude Code reads only that directory's settings (`--setting-sources project`).
3. Under the agent span, the session is replayed as child observations for humans: a generation per model turn (text, tool calls, token usage when the harness exposes per-call counts) and a tool observation per tool call (arguments, result up to 20 kB, ERROR level on tool errors), timed from stdout arrival. The agent span itself carries the judge-ready conversation JSON (spec D10) validated against `contract/`; full logs and tool-schema snapshots go to the named `eval-artifacts` key-value store with URL + sha256 pointers on the span. Traces are named after the scenario title and tagged `dataset:`, `model:`, `actor:`, `team:`, `skill:`, `skills:`, `surface:`. Because Langfuse dashboards can only group scores by a fixed set of trace attributes (and group `tags` by the whole array), the team-facing slices are also mapped onto them: trace `userId` = Actor (and `sessionId` = Actor, so the Sessions page lists every trace of one Actor), `version` = model; team stays a tag used as the dashboard-level filter. The dashboards' per-Actor and per-model widgets read those.
4. Collects **evidence** from the full tool results (the Actor runs the agent triggered with run ids, status, dataset ids and the input the agent built; tool calls; dataset items fetched from the Apify API, capped at 1000; an optional reference run of the subject Actor for fresh ground truth; for Bash-enabled scenarios also every shell command the agent ran, Actor run ids found in its output, and a snapshot of the files it left in its working directory, capped at 300 files with small text files inline). On every surface, Actor runs come from MCP results, from Console and API run URLs and run objects in Bash and WebFetch output, and, for raw HTTP, from the session marker that each session's curl puts in its user agent (runs that `run-sync-get-dataset-items` started print no run id). The input of each run is read from its `INPUT` record, so `apify.input` checks work on every surface and runs the scenario's deterministic checks against it (`contract/src/checks.ts`). Writes one `check.<id>` score per check onto the experiment item, plus `check.all` and `check.infra`, freezes the evidence and check results as `evidence-<traceId>.json` in `eval-artifacts`, and links `call-actor` observations to the Console run and dataset.
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

The top-level `model` or `models` input overrides the model in `harness`; scenario `metadata.maxTurns` overrides the harness turn budget. A `models` entry can name its own harness, so one run can carry both: `["~anthropic/claude-haiku-latest", {"model": "~openai/gpt-luna-latest", "harness": "codex"}]`. OpenAI models are refused on Claude Code: through the Anthropic-format proxy they send every tool call with an empty `input` and run out of turns (#44). Codex uses the same per-skill MCP allowlists, evidence, deterministic checks, judge, and trace observations. Its experiment name includes `codex` unless you supply `runName`.

The image pins Codex CLI to `0.154.0`. Each session has a temporary `CODEX_HOME`, an empty working directory, shell tools disabled, and a read-only sandbox with approvals disabled; the allowlisted MCP tools are pre-approved (`default_tools_approval_mode = "approve"`), because Codex would otherwise reject every non-read-only tool call such as `call-actor` under a `never` approval policy. `apply_patch` remains advertised by Codex but writes are denied by the sandbox. Codex does not support the `allowBash` scenarios; use Claude Code for CLI evaluations. The run token is passed in the child environment for the model provider and MCP bearer authentication; it is not written to the generated config. Local runs with `useOpenRouterProxy: false` reuse only the developer's file-backed Codex login and need a model id accepted by that login, such as `gpt-5-mini`. Other local MCP servers and user configuration are not loaded.

Codex has no `--max-turns` option. The adapter counts tool-call rounds and stops after the last allowed round returns, retaining its evidence as a scored result. Parallel calls count as one round. This can leave the final answer unfinished, and event delivery can race the next call, so the limit is not an exact billing cap. The per-item timeout covers MCP probes, the optional restart, and the session; it kills the child process group. Timeouts, truncated logs, startup failures, crashes, and unparseable sessions remain infrastructure failures. A failed MCP startup or a server exposing zero allowed tools gets up to three retries, each after the wait the server asked for (`retryAfter`) or one second. Because Codex does not publish a tools/list event, the adapter obtains the tool count from a separate probe of the same URL and requires Codex's own MCP initialization to succeed.

Codex JSONL reports token usage for the entire user turn, including all model calls. The adapter stores those totals in session metrics and adds generation usage only for a session with one generation. It does not distribute totals across inferred model calls. Cost and child peak RSS are unavailable for this adapter. Reasoning items appear in generation text when the CLI emits them.

Local checks verified authenticated MCP calls, the event format, and shell/write restrictions. The orchestrating cloud probe verified `/api/v1/responses` with an Actor run token. An end-to-end cloud run is still needed to verify the built image, Codex's streaming model requests through the proxy, and the resulting Langfuse trace, evidence artifacts, and check scores.

#### OpenCode

OpenCode runs any model that OpenRouter serves, through the proxy's OpenAI-compatible endpoint, with no API key other than the run token: `{"model": "google/gemini-3.8-flash", "harness": "opencode"}`, the same for `x-ai/...`, `moonshotai/...`, `z-ai/...`, `minimax/...`, Anthropic and OpenAI ids, and moving aliases such as `~anthropic/claude-haiku-latest`. It supports skill sets and the `api` surface; it supports only the Apify MCP server (not a profile's own `mcp`). Its experiment name includes `opencode`.

The image pins OpenCode 2.2.6 (`@opencode/cli`; the `opencode-ai` npm package is the older 1.x line). Each session is two processes in a throwaway directory: `opencode serve` holds the agent and its MCP connection, and `opencode run --server ... --format json` sends the prompt on stdin and prints the session. The adapter starts the session only after `GET /api/mcp` reports the server `connected`, because `opencode run` on its own waits at most 2 seconds for MCP and would then start without the tools. A failed or never-connected MCP server gets up to three restarts, as for Codex. The MCP tool count comes from the server's own `mcp connected ... tools=N` log line. If OpenCode drops part of the generated config (it logs a `configuration normalization diagnostic` and goes on), the session is a broken harness, also when the line appears only after the session.

Isolation: `HOME`, `TMPDIR`, the XDG directories, `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` point into the session directory. Project config discovery is off (`OPENCODE_DISABLE_PROJECT_CONFIG=1`); without it OpenCode reads `opencode.json`, `.opencode/`, `.agents/`, `.claude/` and `AGENTS.md` in the working directory and every directory above it, up to `/`. Autoupdate, models.dev fetches, free models and `.claude` reading are off too, and the child gets only the variables it needs. OpenCode always reads its managed config, which no setting turns off: `/etc/opencode` on Linux (absent in the image), and `/Library/Application Support/opencode` and the MDM preferences `ai.opencode.managed` on macOS. What ships inside the binary stays: the built-in skills (`opencode`, `report`, `browser`) and the built-in tools the permission list allows.

Secrets: the proxy key reaches OpenCode as `OPENCODE_EVAL_LLM_KEY` and MCP secrets as `OPENCODE_EVAL_MCP_<VAR>`, referenced from the config, so the config file holds no token and the agent's shell has no `APIFY_TOKEN` that the Apify CLI, SDK or a `curl` example would pick up. `APIFY_TOKEN` is in the agent's environment only when the surface sets it (the `api` surface does), as for Claude Code.

Tools: the config denies every tool, then allows `read`, `glob`, `grep` and `skill` in every arm (the same set with and without injected skills, so an agent can read a skill's reference files), the scenario's MCP tools (`apify_*` with the `?tools=` filter), `shell` (and `external_directory`) only when the scenario allows Bash, and `webfetch` only when the surface adds it. Denied tools (`edit`, `write`, `question`, `subagent`, `websearch`, Code Mode `execute`, `experimental_image_generate`) are not offered to the model. MCP Code Mode is off (`codemode: false`), so the agent calls MCP tools directly, as in the other harnesses; Code Mode's `fetch` would also give it web access. Tool calls are stored under Claude Code names (`mcp__apify__call-actor`, `Bash`, `WebFetch`, `Read`, `Skill`), so checks, evidence and the judge read them unchanged; a call is identified by its assistant message and call id, because some providers reuse one call id in every step. Skills go to `$OPENCODE_CONFIG_DIR/skills/<name>` in the session home, and the permission list lets `read` open that directory; the skill tool returns the SKILL.md body. Metrics record `skillsLoaded` (injected skills OpenCode listed in `GET /api/skill`) and `skillsUsed` (skills the agent loaded with the skill tool).

Temp files: each session has its own `TMPDIR` inside the session directory, the same in every arm. OpenCode's system prompt points the agent at `$TMPDIR/opencode`. Files there are not part of the workspace snapshot (only the working directory is), the same as files a Claude Code agent writes to `/tmp`; they are deleted with the session.

Turn limit: `maxTurns` becomes the agent's `steps` plus one. OpenCode runs the step after the limit with tools disabled and a "maximum steps reached" message that asks for a summary. Claude Code has no such step: at `--max-turns` it stops, and the runner records the last answer the agent gave before. So for OpenCode the forced step is kept out of the scored result: its text is not the final answer and not in the conversation the judge reads (it stays in the raw log and in the trace generation, marked `[Forced answer after the step limit, not scored]`), and tool calls OpenCode refused in that step are dropped from the evidence. A session that reaches that step is scored as `error_max_turns`. `--title eval` skips the extra model call that names the session.

Usage and health: token usage is per step (`input` without cache reads, `output` plus reasoning, cache reads and writes); cost is not available, because OpenCode has no prices for the proxy's models. `peakChildRssMb` is the peak memory of the server and the client together (Linux only). A session needs about 450 MB (measured 420 MB for both processes), so use at most 8 sessions per 4 GB of Actor memory. OpenCode retries transport errors without limit; a session that times out while the provider is still failing (retries after the last finished step) is a broken harness (`error_provider`), not an agent result. A non-retryable provider error (HTTP 400, 403) ends the session at once as a broken harness. For a local smoke test against another OpenAI-compatible endpoint, set `OPENCODE_EVAL_BASE_URL` (for example a mock server); it is ignored on the Apify platform, and without it every session uses the proxy, also with `useOpenRouterProxy: false`.

### Run health and exit codes

The run status reports system health, never scenario results (spec D14). Exit 0: ran and judged. 10: fewer than `healthThreshold` of the sessions completed. 11: the judge Actor failed. 12: no scenario matched the filters. 13: telemetry flush failed. 14: preflight failed (the MCP server returned no tools, the API rejected the token, or the LLM proxy did not answer). 15: the run would start more sessions than `maxSessions`. Schedules and tasks get Apify's failure notifications for free.

### Secrets and permissions

Sessions authenticate the LLM through the Apify OpenRouter proxy and MCP through `mcp.apify.com` with the run's own `APIFY_TOKEN`; API sessions get the same token as `APIFY_TOKEN` in their environment, and every filled secret is redacted from stored stderr; Claude Code uses its Anthropic wire format, Codex uses the Responses API, and OpenCode uses chat completions (`/api/v1/chat/completions`). All accept OpenRouter model ids. Langfuse keys come from the Actor's environment (`@langfusePublicKey`, `@langfuseSecretKey` Apify secrets); the input fields are overrides for another Langfuse project, and when any is set the runner passes the resolved set to the judge so both Actors use the same project. `artifactStore` is a resource picker; leaving it empty uses `ARTIFACT_STORE_ID` from the environment, which points at the named `eval-artifacts` store.

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

| Spec decision                                 | Here                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| D1 hosted MCP, per-case tools                 | yes (`metadata.tools` → `?tools=`)                                         |
| D5 one image, harness discriminator           | yes (`harness.kind`, adapter registry; `claude-code`, `codex`, `opencode`) |
| D7 one Actor run per case                     | replaced by the in-process pool                                            |
| D8 per-case timeout/maxTurns                  | `metadata.maxTurns`; timeout is run-level                                  |
| D9/D11 judge reads traces, prompt in Langfuse | yes, via the Judge Actor the runner starts                                 |
| D10 conversation JSON on the agent span       | yes                                                                        |
| D13/D14 health vs results                     | yes                                                                        |
