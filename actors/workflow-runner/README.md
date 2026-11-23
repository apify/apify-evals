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

- Models run inside the selected harness, Claude Code by default or Codex. Compare the same model and harness; Codex run names include `codex`.
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

The image pins Codex CLI to `0.162.1`. Each session has a temporary `CODEX_HOME`, an empty working directory, the shell tool (`exec_command` and `write_stdin`; not a login shell; none of the runner's environment, only Codex's own variables, `HOME` = the session home and `PATH=/usr/local/bin:/usr/bin:/bin`; off Apify the directories of the runner's own `node` and `apify` are appended, the same for every variant), and a read-only sandbox with approvals disabled; the allowlisted MCP tools are pre-approved (`default_tools_approval_mode = "approve"`), because Codex would otherwise reject every non-read-only tool call such as `call-actor` under a `never` approval policy. `apply_patch` remains advertised by Codex but writes are denied by the sandbox. The sandbox also blocks the network for shell commands, so `curl` fails and the `api` surface does not work on Codex. Codex does not support the `allowBash` scenarios; use Claude Code for CLI evaluations. The run token is passed in the child environment for the model provider and MCP bearer authentication; it is not written to the generated config. Local runs with `useOpenRouterProxy: false` reuse only the developer's file-backed Codex login and need a model id accepted by that login, such as `gpt-5-mini`. Other local MCP servers and user configuration are not loaded. **A local Codex session gives the agent a shell that can read every file the developer can** (the sandbox only stops writes and network). The login file is linked into the session's `CODEX_HOME`, where the shell can read it; the adapter redacts its token values (and `APIFY_TOKEN`) from the log, trace and evidence, and logs a warning, but it cannot redact other files the agent chooses to print. Run local Codex sessions only on a machine whose files may end up in Langfuse.

Codex runs skill sets. The adapter copies a skill set into `$HOME/.agents/skills` of the session (Codex's user skills directory; the session HOME is also its `CODEX_HOME`). Codex lists each skill's name, description and `SKILL.md` path in the prompt, but not the body: the agent reads `SKILL.md` and its references with the shell tool. Every variant, the no-skills one included, has the same `config.toml` and tools, so the variants differ only in the skill files. Shell commands appear in the trace as `Bash` tool calls and count toward the turn budget. The session metrics record as `skillsLoaded` the injected skills Codex loaded (installed, and not named in a Codex `failed to load skill` error, which go to `skillsFailed`; a session whose injected skills did not all load is a harness error, `error_skills`, so a skills variant never runs as a no-skills one), and as `skillsRead` the skills whose `SKILL.md` body a successful command printed (the first two non-empty lines after the frontmatter of the installed file, as printed or behind `nl -ba` or `cat -n` line numbers; `ls`, `test -f`, `head -3`, `grep ^name:` or a failed `cat` do not count). The trace records each shell command as the agent wrote it, without Codex's `/bin/zsh -c '...'` wrapper. Every Codex session also lists Codex's bundled system skills (`imagegen`, `openai-docs`, `skill-creator`, `skill-installer`), as Codex does for its users; Claude Code sessions likewise keep Claude Code's bundled skills (`--setting-sources project` keeps them and drops the user's `~/.claude` skills, settings and plugins).

On Linux the Codex sandbox is bubblewrap, which needs unprivileged user namespaces. Where the container forbids them (Docker's default seccomp profile does), every shell command fails with `bwrap: No permissions to create a new namespace`. The preflight runs one command in the sandbox and fails the run with that reason, so no Codex session runs with a broken shell.

Known limitation: the surface classifier (`contract/src/surfaces.ts`) reads only the command text. A shell command that only searches files for `apify` or `api.apify.com` (`grep -rn apify ~/.agents/skills`) counts as `cli` or `api` use, and so does a `curl` to the API that the sandbox blocked. On Codex, where the agent reads skills with the shell, `surfacesUsed` can therefore name a surface the agent did not reach.

**Measurement change.** From the deploy of this change, Codex sessions have the shell tool in every variant, and the Codex turn budget counts model calls (below) instead of tool rounds rebuilt from events. Both change the Codex numbers, so the daily Codex series breaks on the deploy day: compare Codex results only within the days before it or within the days after it. Claude Code sessions are unchanged; they already had their bundled skills.

Codex has no `--max-turns` option. Through the Apify proxy, each session starts a model relay on `127.0.0.1` (a random port) and points Codex's provider `base_url` at it. The relay passes every request to the proxy unchanged (headers and the run token included; it logs nothing) and streams the response back as it arrives. It counts only agent turns: a `POST /responses` whose `x-codex-turn-metadata` header has `request_kind` `turn`, once its stream reaches `response.completed`. Context compaction and other non-turn requests pass through uncounted (`modelRequestsUncounted`), as Claude Code does not count compaction toward `--max-turns`; a request without a readable kind counts as a turn and is recorded in `modelRequestsUnlabelled`. A failed request that Codex retries is not a second call, and a turn still streaming holds its place in the budget, so two parallel requests cannot both take the last one. The rule matches Claude Code's `--max-turns`: a session may make at most `maxTurns` model calls, each of which may ask for any number of tool calls (parallel or not); the tool calls of the last allowed call still run. When Codex asks for call `maxTurns + 1`, the relay refuses it (HTTP 400, which Codex does not retry) and the adapter stops the session as `error_max_turns`, keeping everything so far as a scored result. A model that is still working after `maxTurns` calls therefore ends without a final answer, as on Claude Code. `numTurns` is the relay's count of model calls and `toolRounds` the count of those that asked for tools (`turnCounting: model-calls`); the trace's grouping of events into generations is for display only. Upstream errors reach Codex as the proxy sent them, an unreachable proxy as HTTP 502; the relay closes with the session. A relay that cannot start (`EMFILE`, `EADDRNOTAVAIL`) ends that session as a harness error (`error_session`). A local login (`useOpenRouterProxy: false`) talks to OpenAI directly, without a relay, so the adapter falls back to counting rounds from event order (`turnCounting: item-order`): calls started together are one round and a call that starts after one of them returned opens the next. This is approximate: Codex reports parallel calls one after another, and a command that never ends (`tail -f`) holds its round open, so later calls can join it. `write_stdin` and refused escalation requests emit no event and are not counted in the fallback. On a stop the adapter also kills the commands the shell started in their own session. The per-item timeout covers MCP probes, the optional restart, and the session; it kills the child process group. Timeouts, truncated logs, startup failures, crashes, and unparseable sessions remain infrastructure failures. A failed MCP startup or a server exposing zero allowed tools gets up to three retries, each after the wait the server asked for (`retryAfter`) or one second. Because Codex does not publish a tools/list event, the adapter obtains the tool count from a separate probe of the same URL and requires Codex's own MCP initialization to succeed.

Codex JSONL reports token usage for the entire user turn, including all model calls. The adapter stores those totals in session metrics and adds generation usage only for a session with one generation. It does not distribute totals across inferred model calls. Cost and child peak RSS are unavailable for this adapter. Reasoning items appear in generation text when the CLI emits them.

Local checks verified authenticated MCP calls, the event format, and shell/write restrictions. The orchestrating cloud probe verified `/api/v1/responses` with an Actor run token. An end-to-end cloud run is still needed to verify the built image, Codex's streaming model requests through the proxy, and the resulting Langfuse trace, evidence artifacts, and check scores.

### Run health and exit codes

The run status reports system health, never scenario results (spec D14). Exit 0: ran and judged. 10: fewer than `healthThreshold` of the sessions completed. 11: the judge Actor failed. 12: no scenario matched the filters. 13: telemetry flush failed. 14: preflight failed (the MCP server returned no tools, the API rejected the token, or the LLM proxy did not answer). 15: the run would start more sessions than `maxSessions`. Schedules and tasks get Apify's failure notifications for free.

### Secrets and permissions

Sessions authenticate the LLM through the Apify OpenRouter proxy and MCP through `mcp.apify.com` with the run's own `APIFY_TOKEN`; API sessions get the same token as `APIFY_TOKEN` in their environment, and every filled secret is redacted from stored stderr; Claude Code uses its Anthropic wire format, while Codex uses the Responses API. Both accept OpenRouter model ids. Langfuse keys come from the Actor's environment (`@langfusePublicKey`, `@langfuseSecretKey` Apify secrets); the input fields are overrides for another Langfuse project, and when any is set the runner passes the resolved set to the judge so both Actors use the same project. `artifactStore` is a resource picker; leaving it empty uses `ARTIFACT_STORE_ID` from the environment, which points at the named `eval-artifacts` store.

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
