# Apify agent evals

A test harness for AI agents using Apify. You describe a task an agent
should be able to do with some part of Apify (an Actor, an MCP tool, a CLI
command, an SDK feature). The harness runs a real agent on it, checks the
outcome by code, has a model grade the session, and reports what went wrong
and who should fix it.

Tasks are grouped into suites. Each suite says what is under test and what a
failure means, and gets its own report. The first suite, `store-actors`,
tests whether agents find and use Apify-maintained Store Actors. Suites for
MCP tools, the CLI and the SDK use the same engine.

How it works:

1. Scenarios are YAML in this repo, synced to a Langfuse dataset per suite.
2. The runner Actor runs one agent session per scenario (Claude Code or
   Codex, any OpenRouter model) and collects evidence: tool calls, Actor runs,
   results, files.
3. Deterministic checks declared in the scenario decide what code can decide.
4. The judge Actor reads the session and the checks, writes a verdict and a
   fix area to Langfuse, and regenerates the suite's HTML report.

| You want to                                        | Read                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| See how the Store Actors are doing                 | the [daily report](https://api.apify.com/v2/key-value-stores/QEr12X3OJMj34ZRnb/records/report-store-actors-latest.html) |
| Understand the numbers, check whether a fix helped | [Store Actor AI evals](actors/workflow-runner/README.md), "For store teams"                                             |
| Add or change a scenario                           | [scenarios/README.md](scenarios/README.md) and the `evals-scenario` skill in `apify/agent-skills-internal`              |
| Add a suite for your own surface                   | [docs/adding-a-suite.md](docs/adding-a-suite.md)                                                                        |
| Query results from an agent                        | the [Langfuse skill](https://github.com/langfuse/skills)                                                                |
| Change the engine                                  | [CLAUDE.md](CLAUDE.md)                                                                                                  |

## Layout

```
contract/                trace contract, check language, deterministic check engine
actors/workflow-runner/  the runner: one agent session per scenario, evidence, checks
actors/judge/            the judge: model grading, scores, trace comments, the report
report/                  the HTML report (data layer + browser client)
scenarios/<suite>/       scenario source of truth, synced to Langfuse
profiles/<suite>.yaml    what a suite tests, tools per skill, fix areas
tools/                   scenario lint and sync, report CLI, judge calibration
```

Production runs under the `internal-apps` org: `internal-apps/eval-runner` and
`internal-apps/eval-judge` build from `main`. Results are read in Langfuse
(`langfuse.apify.dev`). The Apify Console is the Run button.

`actors/runner/`, `shared/`, `spikes/` and the numbered files in `docs/` are
the original markdown-scenario runner and its build log. They are not part of
the live system.
