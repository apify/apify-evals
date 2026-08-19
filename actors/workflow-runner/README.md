# Workflow Runner (PoC)

PoC for [ai-team#238](https://github.com/apify/ai-team/issues/238), built for the
19 Aug evals meeting. It implements the Runner Actor from the "Workflow evals on
Apify actors" spec, with one deliberate difference (D7, see below).

## What it does

1. Fetches a dataset from Langfuse by name and filters items by category.
2. Runs one isolated headless Claude Code session per item, in parallel inside
   this one Actor run (concurrency-limited pool, per-item timeout).
3. Each session gets only the tools its scenario allows: hosted `mcp.apify.com`
   with a per-case `?tools=` list (spec D1), plus Bash when the item asks.
4. Each agent span carries the judge-ready conversation as JSON (spec D10), so
   the Judge Actor can grade or re-grade any trace later.
5. Flushes OpenTelemetry, then returns the **dataset-run id and URL** in the
   Actor OUTPUT (the judge handoff from #238).

A broken harness fails the item loudly; an agent that ran out of turns or hit
the timeout is a scored eval result, not an error (spec D13/D14).

## No external secrets

Sessions authenticate the LLM through the Apify OpenRouter proxy
(`openrouter.apify.actor`) and MCP through `mcp.apify.com`, both with the run's
own `APIFY_TOKEN`. The proxy speaks the Anthropic wire format, so Claude Code
works unmodified, and it serves non-Anthropic models too (verified with
`openai/gpt-5-mini`), so multi-model runs need only a model id change. The only
real secrets are the Langfuse keys.

## How to demo (cloud)

```sh
apify push --dir actors/workflow-runner
apify call <your-account>/eval-workflow-runner-poc --memory 4096 --timeout 900 -i '{
    "createDemoDataset": true,
    "langfuseBaseUrl": "https://langfuse.apify.dev",
    "langfusePublicKey": "pk-lf-...",
    "langfuseSecretKey": "sk-lf-...",
    "harness": { "kind": "claude-code", "model": "anthropic/claude-haiku-4.5" },
    "concurrency": 3
}'
```

Then find the results: open the run's **Storage → Key-value store → OUTPUT**
record and click `datasetRunUrl`. That page is the Langfuse dataset run: one
row per item with input, output, expected output, and deterministic scores;
each row links to its trace, whose `agent` span carries the full conversation
(every tool call and result) plus metrics.

Dataset item anatomy: `metadata.title` says what the item tests in one line;
`expectedOutput` is judge-facing prose describing what a correct run looks
like (the future Judge Actor's reference, never grepped); deterministic
health-gate checks are declared explicitly as `metadata.checks`, e.g.
`[{ "type": "contains", "value": "apify/instagram-scraper" }]` or
`[{ "type": "regex", "value": "\\d[\\d,]{5,}" }]`. Items with no checks get
no deterministic score and wait for the judge.

Do not confuse the ids: the "Dataset ID" the Apify CLI prints is the Actor's
own output storage on the Apify platform; the Langfuse run id only lives in
the OUTPUT record. In the Langfuse UI, runs are listed by name
(`<experiment> - <timestamp>`), not by id.

`createDemoDataset` seeds a 3-item dataset (plain question, Bash tool use,
real MCP store search) on first run; point `datasetName` at a real dataset
afterwards.

Local runs work too (`apify run` in this directory): set
`useOpenRouterProxy: false` to use your own Claude login, since the proxy only
accepts tokens presented from inside Actor runs.

### Already verified against langfuse.apify.dev (19 Aug)

- Demo dataset run, 3/3 passed, 14.4s suite:
  [runner-poc run](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/datasets/cmszvaq8k001ito07e3anyb54/runs/368efaae35ad9c69)
- Real store-team scenarios (`store-actors-poc`
  [dataset](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/datasets/cmszvukvv0022qm074ma5va54/items),
  [latest run](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/datasets/cmszvukvv0022qm074ma5va54/runs/ddca0391daa26da7)):
    - **`ig-creator-engagement-nasa`, `matches-pattern = 1`**: "how engaged is
      @nasa's audience vs their follower count", actor pinned to
      `apify/instagram-scraper`, no search tool. The agent read the input
      schema, fired profile and posts runs in parallel with correct inputs,
      waited on the in-progress run, fetched items with field projection, and
      computed the engagement rate (~0.39%).
      [Trace](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/traces/b96e86adcfa3b3cf0b6350fb7c798371?observation=7edb354d91498218)
    - **`ig-scrape-3-posts-nasa`, `contains-expected = 0` three runs in a
      row**: "get the 3 most recent posts from @nasa", agent chooses the
      actor. It behaves correctly every time (searches, reads the schema,
      sensible input) but consistently picks `apify/instagram-post-scraper`
      over the flagship, because store search ranks it first for "Instagram
      posts". Also observed: that actor returned 2 of 3 requested posts on
      one run and 3 of 3 on others, so result-shorting is flaky. Whether the
      flagship _should_ win this query is an open store-team decision the
      scenario deliberately forces.
      [Trace](https://langfuse.apify.dev/project/cmshkde21000krg07shb46d8g/traces/6b544ee1fd8f9b0210c0db0c3feb47a5?observation=0c2cf20617d1ef0d)

Note for the Judge Actor: this Langfuse deployment runs v4 in events-only
mode, so the legacy dataset-run read APIs are disabled; fetch traces and run
items through the v4 experiments APIs.

## Measured on the platform (18-19 Aug)

- 16 parallel Claude Code sessions in one 8GB run: 16/16 passed, suite 15.7s,
  peak memory 2.4GB, ~$0.012 compute. Per-case Actor fan-out pays 8-25s
  container overhead per case instead.
- CPU is the limit: 1 core per 4GB; plan 4-8 sessions per core.
- Containers allow no nested namespaces; session isolation is process +
  workspace dir, and Actor-run boundaries are the only hard wall.

## Spec mapping

| Spec decision                           | Here                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D1 hosted MCP, per-case tools           | yes (`metadata.tools` → `?tools=`)                                                                          |
| D5 one image, harness discriminator     | yes (`harness.kind`, adapter registry)                                                                      |
| D7 one Actor run per case               | **replaced** by an in-process pool (numbers above); per-case fan-out can return as an opt-in execution mode |
| D8 per-case timeout/maxTurns            | yes (`metadata.maxTurns`; timeout is run-level input for now)                                               |
| D10 conversation JSON on the agent span | yes                                                                                                         |
| D13/D14 health vs results               | yes                                                                                                         |
| Judge (D9, D11)                         | out of scope; this Actor never scores beyond a deterministic health-gate check                              |

## PoC scope notes

- Plain JavaScript; a TypeScript port to match repo conventions belongs to the
  real integration, not the PoC.
- The Dockerfile is self-contained (build context = this directory), so
  `apify push --dir actors/workflow-runner` works without the monorepo
  `dockerContextDir` setup the existing runner uses.
- Only the `claude-code` adapter exists. Codex/OpenCode adapters are expected
  to work through the proxy (OpenAI-compatible) but are untested.
