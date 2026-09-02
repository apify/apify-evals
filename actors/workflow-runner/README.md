# Store Actor AI evals

Measures whether AI agents can find and correctly use Apify-maintained Actors.
One Run click (or the daily schedule) runs every scenario through an agent,
judges the results, and gives you one Langfuse link. Store teams use it to see
which of their Actors agents struggle with, what kind of change would help, and
whether a change they made actually helped.

## For store teams

### Where to look

| Question | Open |
| --- | --- |
| How are my Actors doing? What should I fix first? | Your team dashboard: [Google](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/dashboards/cmtjw1c13000rtm077j1xite2) · [Socials](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/dashboards/cmtjw1fua000itx07nt2f5wz5) · [Video](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/dashboards/cmtjw1kln000utm07lh8bar1c) · [all teams](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/dashboards/cmtjw2qz1000xtm075ww703yr) |
| Which scenarios passed in this run? Did my change help? | The results link in the Actor run's OUTPUT (the Langfuse compare view: one row per scenario, pass/fail columns, pick a baseline run to diff) |
| Why did this scenario fail? | Click the row: the trace shows every tool call the agent made, and the judge's comment lists what went wrong with evidence |

Three numbers, in this order:

- **Verdict** (`judge.verdict`: `pass`, `fail`, `wrong-actor`): did the agent complete the scenario's task with real Actor data? `wrong-actor` means it got there with an Actor other than the intended one. The numeric twin `judge.overall` (1/0) is what the dashboards average; its average is the pass rate, the OKR baseline per Actor per model.
- **Found vs Works**: *Found* = discovery scenarios, where the agent had to pick your Actor in store search (checked deterministically by Actor name). *Works* = usage scenarios, where your Actor is pinned and the agent has to drive it. A Found failure belongs to store search and how the Actor presents itself; a Works failure belongs to the Actor.
- **Fix area** (`judge.fixArea`): the one thing the judge thinks the team should change first, with a cited tool call. `input-schema`, `readme-docs`, `output-format`, `error-messages` are yours. `discoverability` is store search. `agent-or-model` means your Actor did its part.

### Check whether a change to your Actor helped

1. Open the Actor in Console, press **Run**. Set **Only these Actors** to your Actor slug (e.g. `crawler-google-places`) and **Repeats** to 3. Leave the rest.
2. Wait a few minutes. The last log line and the OUTPUT record hold the results link.
3. In the compare view, choose the previous run of your Actor as the baseline. Rows that flipped are the story. Three repeats mean a 2/3 → 3/3 move is real, a 1/3 flip is probably a flaky scrape.
4. The team dashboard trend catches up over the next daily runs.

### Add a scenario

Scenarios live in the Langfuse dataset `store-actors`, one item each. Copy an existing item of the same type and edit:

- `input.prompt`: what a user would ask an agent. Discovery prompts end with `Actor: <username/name of the Apify Actor you used>` so the check can read the answer; usage prompts name your Actor.
- `expectedOutput`: one paragraph describing what a correct run looks like. The judge reads it; nothing greps it.
- `metadata`: `actor`, `team`, `skill` (`actor-discovery` or `actor-usage`), `category` (Actor slug), `title` (one line, becomes the trace name), `tools` (MCP allowlist: discovery gets `search-actors`, usage does not), `maxTurns`, `checks` (`contains` the Actor name for discovery; a `regex` on the answer shape for usage).

Keep prompts finishable in about two minutes: cap result counts, no whole-site crawls. Live values (follower counts, prices) go in the judge's prose, never in a deterministic check.

### Reading the numbers honestly

- Every model runs inside the Claude Code harness. "Per model" means "this model inside Claude Code".
- One run is a sample. Compare runs on the same model and judge; use repeats or the dashboard trend before acting.
- The judge is a model. Its fix area is a hint with evidence, not a verdict.

## For maintainers

### What the Actor does

1. Fetches the Langfuse dataset by name, filters by `metadata.category`, repeats items if asked.
2. Runs one isolated headless Claude Code session per item, in parallel inside this Actor run (pool with `concurrency`, per-item timeout). Each session gets hosted `mcp.apify.com` narrowed by `?tools=` (spec D1) and Bash only when the item asks.
3. Each agent span carries the judge-ready conversation JSON (spec D10) validated against `contract/`; full logs and tool-schema snapshots go to the named `eval-artifacts` key-value store with URL + sha256 pointers on the span. Traces are named after the scenario title and tagged `dataset:`, `model:`, `actor:`, `team:`, `skill:`. Because Langfuse dashboards can only group scores by a fixed set of trace attributes (and group `tags` by the whole array), the team-facing slices are also mapped onto them: trace `userId` = Actor (and `sessionId` = Actor, so the Sessions page lists every trace of one Actor), `version` = model; team stays a tag used as the dashboard-level filter. The dashboards' per-Actor and per-model widgets read those.
4. Writes deterministic health gates (`check.contains`, `check.regex`) as item scores, then flushes telemetry.
5. Starts the [Eval Judge](../judge/README.md) (`Actor.call`, env `JUDGE_ACTOR`) on the new run and merges its summary into OUTPUT: `resultsUrl` (compare view), `passRate`, `foundRate`, `worksRate`, `fixAreas`, `scoreboard`, `judgeRunUrl`.

A broken harness fails the item loudly; an agent that ran out of turns or hit the timeout is a scored result, not an error (spec D13/D14).

### Secrets and permissions

Sessions authenticate the LLM through the Apify OpenRouter proxy and MCP through `mcp.apify.com` with the run's own `APIFY_TOKEN`; the proxy speaks the Anthropic wire format and serves non-Anthropic models too. Langfuse keys come from the Actor's environment (`@langfusePublicKey`, `@langfuseSecretKey` Apify secrets); the input fields are overrides for other deployments. `artifactStore` is a resource picker because the run has limited permissions; leaving it empty opens the `eval-artifacts` store by name.

### Deploy and run

```sh
scripts/deploy.sh judge && scripts/deploy.sh workflow-runner   # from the repo root
apify call artogahr/eval-workflow-runner-poc --memory 8192 --timeout 3600 -i '{"datasetName":"store-actors"}'
```

Local runs: `apify run` in this directory with `useOpenRouterProxy: false` (the proxy only accepts tokens from inside Actor runs).

Langfuse here runs v4 in events-only mode: dataset-run read APIs are disabled, use the experiments APIs. The compare view is `.../experiments/results?baseline=<datasetRunId>`.

### Measured on the platform

16 parallel Claude Code sessions in one 8 GB run: 16/16 passed, 15.7 s, peak 2.4 GB, about $0.012 compute; CPU is the limit (1 core per 4 GB, plan 4–8 sessions per core). Per-case Actor fan-out (spec D7) would pay 8–25 s container overhead per case, so the in-process pool replaced it.

### Spec mapping

| Spec decision | Here |
| --- | --- |
| D1 hosted MCP, per-case tools | yes (`metadata.tools` → `?tools=`) |
| D5 one image, harness discriminator | yes (`harness.kind`, adapter registry; only `claude-code` exists) |
| D7 one Actor run per case | replaced by the in-process pool |
| D8 per-case timeout/maxTurns | `metadata.maxTurns`; timeout is run-level |
| D9/D11 judge reads traces, prompt in Langfuse | yes, via the Judge Actor the runner starts |
| D10 conversation JSON on the agent span | yes |
| D13/D14 health vs results | yes |
