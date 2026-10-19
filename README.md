# Apify agent evals

A harness for testing how AI agents handle tools, APIs and services. You
write a task an agent should be able to do, for example "find 10 coffee shops
in Prague with their phone numbers". A real agent (Claude Code or Codex) gets
the task and the tools for it, works through it and answers. Code checks what
happened, a second model reads the session and grades it. After a full run the
judge writes an HTML report per suite to a public store, so the people who fix
things can open it without a login.

Tasks are grouped into suites. A suite says what is under test, which tools
the agent gets, and which categories a failure can fall into. The first suite,
`store-actors`, tests whether agents find and use Apify-maintained Store
Actors. Other suites test MCP servers, the CLI or the SDK; a suite can point at
anything an agent can reach.

How a run works:

1. Scenarios are YAML files in this repo, synced to a Langfuse dataset per
   suite. Langfuse is where runs, sessions and scores are stored.
2. The runner Actor starts one agent session per scenario and records what
   happened: tool calls, Actor runs, results, files the agent wrote.
3. Each scenario lists checks that code can decide, such as which tool ran,
   what input it got and what it returned. The runner scores them.
4. The judge Actor reads the session and the check results, writes a verdict
   and a fix area (the category of the failure, so the owner knows where to
   look), and regenerates the suite's HTML report.

| You want to                                        | Read                                                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| See how the Store Actors are doing                 | the [daily report](https://api.apify.com/v2/key-value-stores/QEr12X3OJMj34ZRnb/records/report-store-actors-latest.html) |
| Understand the numbers, check whether a fix helped | [scenarios/store-actors/README.md](scenarios/store-actors/README.md), the Store suite's own page                        |
| Add or change a scenario                           | [scenarios/README.md](scenarios/README.md) and the `use-apify-evals` skill in `apify/agent-skills-internal`             |
| Add a suite for your own tool or service           | [docs/adding-a-suite.md](docs/adding-a-suite.md)                                                                        |
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
tools/                   scenario check and sync, report CLI, judge calibration
```

Production runs under the `internal-apps` org: `internal-apps/eval-runner` and
`internal-apps/eval-judge` build from `main`. Results are read in Langfuse
(`langfuse.apify.dev`). The Apify Console is the Run button.

`actors/runner/`, `shared/`, `spikes/` and the numbered files in `docs/` are
the original markdown-scenario runner and its build log. They are not part of
the live system.
