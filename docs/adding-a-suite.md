# Add a suite

A suite is one thing under test, with its own scenarios, failure categories,
owners and report. The thing can be anything an agent can reach: Apify Store
Actors, an MCP server, a CLI, an SDK. The runner, the judge and the report code
are shared. A suite adds two things: a profile, which is a YAML file saying how
the agent is set up and what a failure can mean, and the scenarios.
`store-actors` is the first suite; this page is for the next one.

| Piece            | Where                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Profile          | `profiles/<suite>.yaml`                                                     |
| Scenarios        | `scenarios/<suite>/<owner>/<subject>.yaml`                                  |
| Langfuse dataset | named `<suite>`, created by the sync                                        |
| Console task     | a saved run configuration of `internal-apps/eval-runner` with `datasetName` |
| Report           | `report-<suite>-latest.html` in the public report store                     |

This page is for scripted tasks. If what you want to measure is your own
application's live traffic, instrument it with the
[Langfuse skill](https://github.com/langfuse/skills) and use the judge's online
mode, described in the [judge README](../actors/judge/README.md).

## 1. Profile

Copy the profile closest to your suite. `profiles/store-actors.yaml` is the one
in daily use; `cli-tasks`, `sdk-tasks` and `mcp-tools` are templates that have
not run yet. The file name must equal `name`.

The agent reaches Apify through the Apify MCP server (`mcp.apify.com`), which
exposes tools such as `search-actors` and `call-actor`. `tools` lists which of
those tools the agent may call in a scenario of that type. `maxTurns` is how
many model turns the agent gets; a scenario that runs out of turns is scored as
a failure, not as an error.

```yaml
name: cli-tasks
subjectKind: cli-command # actor | mcp-tool | cli-command | sdk-feature | agent
description: Apify CLI commands driven by an agent through Bash.
skills:
    find: # the prompt does not name the subject; the agent has to pick it
        label: Found # what the report and dashboards call this scenario type
        tools: [] # Apify MCP tools the agent may call; [] means no MCP server
        allowBash: true # the agent gets a shell in an empty working directory
        maxTurns: 14
    use: # the prompt names the subject; the agent has to drive it correctly
        label: Works
        tools: []
        allowBash: true
        maxTurns: 12
wrongSubjectLabel: wrong-command # verdict when the agent used another subject
fixAreas: # the judge picks one per failure
    - { id: command-help, owner: subject, description: 'The --help text did not explain the command or flag.' }
    - { id: error-messages, owner: subject, description: The CLI error did not say how to recover. }
    - { id: docs, owner: docs, description: The agent needed docs.apify.com and they were missing or wrong. }
    - { id: agent-or-model, owner: none, description: The CLI did its part. }
evidence: [apify-runs-from-cli]
```

- Keep both scenario types. A `find` failure means the subject is hard to
  find or presents itself badly; a `use` failure means the subject itself is
  hard for an agent. One combined type cannot say which team owns the problem.
- Fix areas are the categories your team will act on. Keep `agent-or-model`
  for failures that are the agent's own fault.
- An empty `tools` list means no MCP server at all; pair it with
  `allowBash: true` so the agent has something to act with.
- Pointing the agent at another MCP server, or giving it agent skills, is not
  on `main` yet (branch `feat/notion-mcp-skills`).
- The runner image has Claude Code and Codex. It does not have the Apify CLI,
  so a CLI suite needs it added to `actors/workflow-runner/Dockerfile` first.

The judge image ships `profiles/`. A new or changed profile is live after the
next build from `main`. A dataset whose items name no profile is judged with a
built-in generic profile (fix areas `tool-description`, `tool-schema`,
`tool-output`, `error-messages`, `agent-or-model`), which is enough for a
one-off run.

## 2. Scenarios

One YAML file per subject under `scenarios/<suite>/<owner>/<subject-slug>.yaml`.
The subject is the thing a scenario tests, such as one Actor or one tool.
`<owner>` is the team that fixes failures; it is the team filter in the report
and the recipient of the Slack digest. Format, checks and prompt rules:
[scenarios/README.md](../scenarios/README.md).

The `use-apify-evals` skill in `apify/agent-skills-internal` writes scenarios
that pass the check. Ask your agent for scenarios for a subject, then run:

```sh
npm run scenarios:check
```

It validates every scenario file and prints problems and warnings. CI runs the
same check on pull requests. Scenarios live in GitHub only. Edits made in the
Langfuse UI are overwritten by the next sync.

## 3. Langfuse project

Results go to a Langfuse project. Use one project per thing under test, so a
team's dashboards and access stay separate from everyone else's.

1. Request access to the Langfuse organization in #apify-request-access, then
   sign in at https://langfuse.apify.dev with your Apify Google account.
2. Create a project for your suite, or use one your team already owns.
3. Create an API key pair under the project's settings and keep it in 1Password.

Pass the keys on every run as the task inputs `langfusePublicKey` and
`langfuseSecretKey` (secret fields, encrypted on the run). The runner passes
them on to the judge, so both write to the same project. The judge creates its
grading prompt (`workflow-judge`) in a new project on its first run.

For a one-off run that nobody needs to keep, the Generic Evals project exists
as a sandbox; its keys are in 1Password ("Langfuse Generic Evals").

Sync copies scenarios into the project the keys belong to:

```sh
LANGFUSE_BASE_URL=https://langfuse.apify.dev LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
    npm run scenarios:sync -- --suite=<suite>
```

`--dry-run` shows what would change. Sync matches scenarios by `id` and
archives items whose file is gone, so never rename an id. For a suite on
`main`, the AI team runs the sync after merge. For a one-off run, sync from
your branch with the sandbox keys.

## 4. Run it

Create a task on `internal-apps/eval-runner` in Console (or with
`apify api POST actor-tasks`). A task is a saved input plus run options, so a
team can press Run without filling the form again. First run:

```json
{
    "datasetName": "<suite>",
    "itemLimit": 2,
    "models": ["~anthropic/claude-haiku-latest"],
    "judgeModel": "~anthropic/claude-sonnet-latest",
    "langfusePublicKey": "pk-lf-...",
    "langfuseSecretKey": "sk-lf-..."
}
```

`itemLimit: 2` runs only two scenarios, enough to see that the setup works
before spending on the whole suite. Run options: 8192 MB, 3600 s per model,
`concurrency` 6. When the run ends, OUTPUT and the last log lines hold the
results link and the judge run. Then remove `itemLimit`. Exit code 0 means the
run and the judge worked; the other codes are listed in the
[runner README](../actors/workflow-runner/README.md).

For a daily run, add a schedule on the task. The Store suite runs at 06:00
Europe/Prague.

### Models

Model names are OpenRouter ids, sent through the Apify proxy, so no API key is
needed. An alias such as `~anthropic/claude-haiku-latest` always points at the
provider's current model of that class; when a new Haiku ships, the alias
follows without anyone changing the input. That is the point: the eval should
measure the agents people use today.

| Role  | Recommended                       |
| ----- | --------------------------------- |
| Agent | `~anthropic/claude-haiku-latest`  |
| Agent | `~openai/gpt-luna-latest`         |
| Judge | `~anthropic/claude-sonnet-latest` |

The runner records which concrete model answered on every run, and the report
marks the day an alias moved. Pinned ids such as `anthropic/claude-haiku-4.5`
work too. Keep the judge model fixed across runs you want to compare.

## 5. Results

### The report

After every run over the whole suite, the judge builds an HTML report from the
experiment data in Langfuse and writes it to a public Apify key-value store:

```
https://api.apify.com/v2/key-value-stores/QEr12X3OJMj34ZRnb/records/report-<suite>-latest.html
```

`<suite>` is your dataset name. The judge also keeps a dated copy next to it
(`report-<suite>-<YYYY-MM-DD>.html`) and the JSON it was rendered from. Nobody
needs a login to open the link, which is what makes it the page to share with
the people who fix things.

What decides whether the report exists and what it shows:

- Only a full run regenerates it. A run with `itemLimit`, `subjects` or `owners`
  set is a filtered run and leaves the report alone.
- It covers the last 28 days of full runs, one result per scenario and day.
- The labels (what `find` and `use` are called, the fix areas) come from your
  profile. A dataset without a profile gets the generic ones.
- The store belongs to the org judge. A judge deployed elsewhere writes to its
  own `REPORT_STORE_ID`, or skips the report with a warning when that is unset.

### Compare view and Slack

- **Compare view**: the results link in OUTPUT opens Langfuse with one row per
  scenario and its pass or fail. Pick an older run as the baseline to see
  which rows changed. Needs a Langfuse login and membership in the project.
- **Slack digest**: `notify: true` on the task posts one message per owner
  after the run. It needs a webhook in the runner's environment
  (`SLACK_WEBHOOK_URL`, or `SLACK_WEBHOOKS_BY_OWNER` as JSON mapping owner to
  webhook). Ask the AI team to add yours.

## What needs the AI team

- Membership in the Langfuse organization, Slack webhooks, Actor environment
  variables.
- Sync of merged scenarios.
- Engine changes: new check types, another MCP server, agent skills in
  sessions, the Apify CLI in the runner image.

Profile and scenarios are a pull request against this repo.
