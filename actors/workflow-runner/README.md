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

Then open the `datasetRunUrl` from the run OUTPUT in Langfuse: the dataset run,
one trace per item with the full agent conversation, and a deterministic
`contains-expected` score per item. `createDemoDataset` seeds a 3-item dataset
(plain question, Bash tool use, real MCP store search) on first run; point
`datasetName` at a real dataset afterwards.

Local runs work too (`apify run` in this directory): set
`useOpenRouterProxy: false` to use your own Claude login, since the proxy only
accepts tokens presented from inside Actor runs.

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
