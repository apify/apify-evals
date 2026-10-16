# Add a suite

A suite is one part of Apify under test, with its own scenarios, fix areas,
owners and report. The runner, the judge and the report code are shared; a
suite adds a profile and scenarios. `store-actors` is the first suite; this
page is for the next one.

| Piece            | Where                                                   |
| ---------------- | ------------------------------------------------------- |
| Profile          | `profiles/<suite>.yaml`                                 |
| Scenarios        | `scenarios/<suite>/<owner>/<subject>.yaml`              |
| Langfuse dataset | named `<suite>`, created by the sync                    |
| Console task     | on `internal-apps/eval-runner`, input `datasetName`     |
| Report           | `report-<suite>-latest.html` in the public report store |

This page is for scripted tasks against a surface. If what you want to measure
is your own application's live traffic, instrument it with the
[Langfuse skill](https://github.com/langfuse/skills) and use the judge's online
mode, described in the [judge README](../actors/judge/README.md).

## 1. Profile

The profile says what is under test, how the agent is set up per scenario type,
and which fix areas the judge may name. Copy the profile closest to your suite
(`profiles/store-actors.yaml` is the live one; `cli-tasks`, `sdk-tasks` and
`mcp-tools` are stubs). The file name must equal `name`.

```yaml
name: cli-tasks
subjectKind: cli-command # actor | mcp-tool | cli-command | sdk-feature | agent
description: Apify CLI commands driven by an agent through Bash.
skills:
    find: # the prompt does not name the subject
        label: Found # what the report and dashboards call this type
        tools: [] # MCP tool allowlist for mcp.apify.com; [] means no MCP server
        allowBash: true # the agent gets a shell in an empty working directory
        maxTurns: 14
    use: # the prompt names the subject
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

- Keep both scenario types. A `find` failure belongs to how the subject
  presents itself, a `use` failure to the subject. One combined type cannot say
  which team owns the problem.
- Fix areas are what your team will act on. Keep `agent-or-model`.
- `tools` are MCP tools of the Apify MCP server. Discovery usually includes
  `search-actors`, usage does not. An empty list means no MCP server; pair it
  with `allowBash: true`.
- Another MCP server, or agent skills injected into the session, is not on
  `main` yet (branch `feat/notion-mcp-skills`).
- The runner image has Claude Code and Codex. It does not have the Apify CLI,
  so a CLI suite needs it added to `actors/workflow-runner/Dockerfile` first.

The judge image ships `profiles/`. A new or changed profile is live after the
next build from `main`. A dataset whose items name no profile is judged with a
built-in generic profile (fix areas `tool-description`, `tool-schema`,
`tool-output`, `error-messages`, `agent-or-model`), which is enough for a
one-shot run.

## 2. Scenarios

One YAML file per subject under `scenarios/<suite>/<owner>/<subject-slug>.yaml`.
`<owner>` is the team that fixes failures; it is the report's team filter and
the Slack digest recipient. Format, checks and prompt rules:
[scenarios/README.md](../scenarios/README.md).

The `evals-scenario` skill in `apify/agent-skills-internal` writes scenarios
that pass the lint. Ask your agent for scenarios for a subject, then run:

```sh
npm run scenarios:check
```

CI runs the same check on pull requests. Scenarios live in GitHub only. Edits
in the Langfuse UI are overwritten by the next sync.

## 3. Langfuse project

Three projects, pick by how long the results should live:

- **Generic Evals**: one-shot and exploratory runs. Everyone in the org can be
  a member; the keys are in 1Password ("Langfuse Generic Evals"). Nothing here
  is kept or watched.
- **Your own project**: anything recurring, scheduled, or with owners and a
  report. Create it at https://langfuse.apify.dev, create an API key pair, and
  keep the keys in 1Password.
- **Store Actors Evals**: the `store-actors` suite only.

The Actors use the Store project unless you pass keys. For any other project,
set the task inputs `langfusePublicKey` and `langfuseSecretKey` (secret
fields); the runner forwards them to the judge. The judge seeds its prompt
(`workflow-judge`) in a new project on its first run.

Sync writes scenarios into the project the keys belong to:

```sh
LANGFUSE_BASE_URL=https://langfuse.apify.dev LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
    npm run scenarios:sync -- --suite=<suite>
```

`--dry-run` shows what would change. Sync upserts by scenario `id` and archives
items whose file is gone. Never rename an id. For a suite on `main`, a
maintainer runs the sync after merge. For a one-shot run, sync from your branch
with the Generic Evals keys.

## 4. Run it

Create a task on `internal-apps/eval-runner` in Console (or
`apify api POST actor-tasks`). First run:

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

Run options: 8192 MB, 3600 s per model, `concurrency` 6. OUTPUT and the last
log lines carry the results link and the judge run. Then drop `itemLimit`.
Exit code 0 means the run and the judge worked; other codes are listed in the
[runner README](../actors/workflow-runner/README.md).

For a daily run, add a schedule on the task. The Store suite runs at 06:00
Europe/Prague.

### Models

OpenRouter ids through the Apify proxy, no API key. Aliases follow the
provider's current model, which is what the eval is meant to measure.

| Role  | Recommended                       |
| ----- | --------------------------------- |
| Agent | `~anthropic/claude-haiku-latest`  |
| Agent | `~openai/gpt-luna-latest`         |
| Judge | `~anthropic/claude-sonnet-latest` |

The runner records the concrete model behind an alias on every run; the report
marks the day it moved. Pinned ids work too. Keep the judge model fixed across
runs you want to compare.

## 5. Results

- **Report**: `https://api.apify.com/v2/key-value-stores/QEr12X3OJMj34ZRnb/records/report-<suite>-latest.html`.
  The judge regenerates it after every full-scope run. No login. Labels come
  from your profile.
- **Compare view**: the results link in OUTPUT. One row per scenario, pick a
  baseline run. Needs a Langfuse login and project membership.
- **Slack digest**: `notify: true` on the task. Posting needs a webhook in the
  runner's environment (`SLACK_WEBHOOK_URL`, or `SLACK_WEBHOOKS_BY_OWNER` as
  JSON owner to webhook). Ask the maintainers to add yours.

## What needs a maintainer

- Membership in the Store Langfuse project, Slack webhooks, Actor environment
  variables.
- Sync of merged scenarios.
- Engine changes: new check types, another MCP server, agent skills in
  sessions, the Apify CLI in the runner image.

Profile and scenarios are a pull request against this repo.
