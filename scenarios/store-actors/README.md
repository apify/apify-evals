# Store Actors suite

The `store-actors` suite tests whether AI agents find and correctly use
Apify-maintained Store Actors through the Apify MCP server: 30 Actors, two
scenarios each, run every morning. This page is for the Store teams who own
those Actors. How the harness works and how to add another suite is in the
[runner README](../../actors/workflow-runner/README.md) and
[docs/adding-a-suite.md](../../docs/adding-a-suite.md).

## Where to look

| Question                                                | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is wrong with my Actors right now, in plain words? | The daily report: https://api.apify.com/v2/key-value-stores/QEr12X3OJMj34ZRnb/records/report-store-actors-latest.html (no login; regenerated after every scheduled run with a 28-day window; dated copies as `report-store-actors-<YYYY-MM-DD>.html` in the same store; add `#team=google` etc. for one team)                                                                                                                                                                                                                                                                                 |
| How are my Actors doing? What should I fix first?       | Your team dashboard: [Google](https://langfuse.apify.dev/project/cmubaf44p00apvl07mmocug5q/dashboards/cmubasimw00d1vl07ollq5uvb) · [Socials](https://langfuse.apify.dev/project/cmubaf44p00apvl07mmocug5q/dashboards/cmubasi8q00cyvl076b6lgv8g) · [Video](https://langfuse.apify.dev/project/cmubaf44p00apvl07mmocug5q/dashboards/cmubashv300cpu407lrfz1rff) · [Universe](https://langfuse.apify.dev/project/cmubaf44p00apvl07mmocug5q/dashboards/cmubasj0d00csu407q8v67pdr) · [all teams](https://langfuse.apify.dev/project/cmubaf44p00apvl07mmocug5q/dashboards/cmubashd000cvvl07r1tjrgas) |
| Which scenarios passed in this run? Did my change help? | The results link in the Actor run's OUTPUT (the Langfuse compare view: one row per scenario, pass/fail columns, pick a baseline run to diff)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Why did this scenario fail?                             | Click the row: the trace shows the flow as it happened, one `turn N` per model call (text, tool calls, tokens) and one `search-actors` / `call-actor` / `get-dataset-items` step per tool call with its arguments and result (errors in red), plus the judge's comment listing what went wrong with evidence                                                                                                                                                                                                                                                                                  |

Three numbers, in this order:

- **Verdict** (`judge.verdict`: `pass`, `fail`, `wrong-actor`, `inconclusive`): did the agent complete the scenario's task with real Actor data and pass every deterministic check? `wrong-actor` means it used an Actor other than the intended one (read from its tool calls). `inconclusive` means infrastructure failed, not the Actor. The numeric twin `judge.overall` (1/0) is what the dashboards average; its average is the pass rate, the OKR baseline per Actor per model.
- **Found vs Works**: _Found_ = discovery scenarios, where the agent had to pick your Actor in store search (checked deterministically by Actor name). _Works_ = usage scenarios, where your Actor is pinned and the agent has to drive it. A Found failure belongs to store search and how the Actor presents itself; a Works failure belongs to the Actor.
- **Fix area** (`judge.fixArea`): the one thing the judge thinks the team should change first, with a cited tool call. `input-schema`, `readme-docs`, `output-format`, `error-messages` are yours. `discoverability` is store search. `agent-or-model` means your Actor did its part.

## Check whether a change to your Actor helped

1. Open the Actor in Console, press **Run**. Set **Only these subjects** to your Actor (e.g. `compass/crawler-google-places`) or **Only these owners** to your team, and **Repeats** to 3. Leave the rest.
2. Wait a few minutes. The last log lines and the OUTPUT record hold the results link. The run is named `store-actors · <model> · subject:<actor> · ×3 · <time> · web` so you find it in the experiments list.
3. In the compare view, choose the previous run of your Actor as the baseline. Rows that flipped are the story. With repeats the judge writes `eval.passAtN` (any repeat passed) and `eval.consistency` per scenario, and OUTPUT lists `flaky` scenarios; a 2/3 → 3/3 move is real, a 1/3 flip is probably a flaky scrape.
4. Filtered runs do not move the OKR trend (no run-level scores); the daily full run does. The team dashboard catches up over the next daily runs.

## Add or change a scenario

Store scenarios live in this repo under `scenarios/store-actors/<team>/<actor>.yaml`,
two per Actor: discovery (the prompt does not name the Actor) and usage (it
does). Open a pull request; CI runs the scenario check; the AI team syncs
merged files into the Langfuse dataset. Edits made in the Langfuse UI are
overwritten by the next sync. Other suites follow the same shape under their
own folder; see [docs/adding-a-suite.md](../../docs/adding-a-suite.md).

Format, prompt rules and check types: [scenarios/README.md](../README.md).
The `use-apify-evals` skill in `apify/agent-skills-internal` writes a file that
passes the check.

## Langfuse access

Each suite has its own HTML report, and reports need no login. Trace links,
the compare view and the dashboards are in Langfuse. Request access to the
Langfuse organization in #apify-request-access, then sign in at
https://langfuse.apify.dev with your Apify Google account.

## Models

The daily run uses OpenRouter aliases: `~anthropic/claude-haiku-latest` and
`~openai/gpt-luna-latest` for the agent, `~anthropic/claude-sonnet-latest` for
the judge. An alias always points at the provider's current model of that
class, so when a new Haiku ships the alias follows without anyone changing the
input. The report shows the day that happened and the model before and after;
the curves can shift on that day without any Actor change. Manual runs accept
any OpenRouter id. Compare runs on the same model.
