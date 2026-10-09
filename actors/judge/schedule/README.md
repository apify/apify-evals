# Online evals schedule

Two request bodies run the judge in online mode once a day
([ai-team#271](https://github.com/apify/ai-team/issues/271)):

- `online-task.json` is the Apify Task: the online input, the run options and
  the Langfuse keys of the "Apify AI Agent" project. It is a request body for
  [`POST /v2/actor-tasks`](https://docs.apify.com/api/v2/actor-tasks-post).
- `online-daily.json` is the Apify Schedule that runs that Task. It is a
  request body for [`POST /v2/schedules`](https://docs.apify.com/api/v2/schedules-post).

The schedule runs a Task, not the Actor, because the keys must differ from the
Actor's. The Actor env keys belong to "MCP Agent Evals", the dataset-run
project: the workflow runner starts the judge without keys, so they must stay
there. Online mode reads and scores production traces in "Apify AI Agent". A
schedule action has only a plain JSON string as input, so it cannot hold
secrets; a Task input keeps `langfusePublicKey` and `langfuseSecretKey`
encrypted (they are `isSecret` in the input schema).

Only placeholders are committed (Actor id, Task id, keys). Nothing in this
directory is applied automatically: creating the Task and the schedule is a
one-off manual step, documented here so the running configuration is
reviewable in git.

**Status: not yet created** (as of this branch).

## What it runs

| Field                         | Value                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cronExpression`              | `0 6 * * *` (`timezone: UTC`)                                                                                                                                  | The window is `[checkpoint, now - 33 min)`, so the run at 06:00 judges everything that completed up to 05:27 UTC and the previous day's traffic is closed. 06:00 UTC is 07:00/08:00 in Prague: the run finishes and the Langfuse alert can evaluate before the team's working day starts, so a regression from yesterday is on Slack in the morning. The exact hour is not load-bearing: the checkpoint makes consecutive windows contiguous whatever the cron time. This works because the checkpoint is in the named key-value store `apify-ai-online-state` of the account that runs the Actor, not in the run's default store, which is new for every run.                                                                                                                                                                                               |
| `isExclusive`                 | `true`                                                                                                                                                         | If a run is still going when the next tick fires, the platform skips the tick instead of starting a second run. Two concurrent runs would both read the same checkpoint and judge the same window twice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Task `input`                  | `mode: online`, `environment: prod`, `sampleRate: 0.2`, `maxItems: 100`, `judgeModel: deepseek/deepseek-v4-flash`, `promptLabel: production`, `concurrency: 4` | These are the online-mode defaults (#267, #269). They are repeated in the Task so the committed Task body, not the current build's defaults, is the record of what production runs, and so a default change in code does not silently change the scheduled run. `environment: prod` in particular: it is what separates the populations sharing one Langfuse project, and the Task should record that the daily run scores production traffic only rather than inheriting whatever the build defaults to. The Task input also sets `langfuseBaseUrl`, `langfuseProject: Apify AI Agent` and the two keys; see Secrets.                                                                                                                                                                                                                                       |
| Task `options.timeoutSecs`    | `10800`                                                                                                                                                        | Worst case per trace is 3 attempts x 120 s plus two 2 s retry sleeps = 364 s (`MAX_ATTEMPTS`, `ATTEMPT_TIMEOUT_MS`, `RETRY_SLEEP_MS` in `src/llm.ts`). 100 sampled traces at concurrency 4 is 25 waves x 364 s = 152 min, before the per-trace observation fetch and the MCP `tools/list` fetch #269 adds. Three hours covers it; the next tick is 21 h later so a timeout never collides with it. A TIMED-OUT run does not advance the checkpoint: #270 writes it only after the window's rollup is in Langfuse, so the next tick reads the old checkpoint from the named store `apify-ai-online-state`, re-reads the same window and retries the sample with no manual step. The retry is cheap: each trace's scores are written as soon as it is judged, so the traces finished before the timeout are already in Langfuse and the pre-filter skips them. |
| Task `options.memoryMbytes`   | `1024`                                                                                                                                                         | Same as the documented `apify call --memory 1024` in the Actor README. The judge is I/O bound (Langfuse and LLM calls); 1 GB is headroom for holding up to 100 reconstructed turns in memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Task `options.build`          | `latest`                                                                                                                                                       | `.actor/actor.json` has `buildTag: latest`; `scripts/deploy.sh judge` publishes to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Task `options.restartOnError` | `false`                                                                                                                                                        | A crash must end as a FAILED run so the run-status alert below fires. Recovery is automatic: the checkpoint moves only after the window's scores and rollup succeed (#270), so a run that dies at any point leaves it where it was and the next tick judges the same window again. That retry is cheap because score writes are idempotent and the pre-filter spends no LLM calls on traces already judged. The `windowStart` / `windowEnd` overrides are for deliberate backfills, not for recovery. To inspect or reset the checkpoint, open Console > Storage > Key-value stores > `apify-ai-online-state`, record `ONLINE_CHECKPOINT-prod`.                                                                                                                                                                                                              |
| `notifications.email`         | `true`                                                                                                                                                         | The platform's own email when a scheduled action fails to start (misconfigured Task id, or the Task's Actor or build). The default, kept explicit. The field is in the JS client type and in the response schema but not in the documented POST request body, so if the API answers 400 on it, drop the field: the default is on anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Cost per run at the defaults is about a dollar of judge calls (see the Actor
README, `maxItems`).

## Secrets the run needs

The Langfuse keys of the "Apify AI Agent" project go into the Task input, not
into the Actor environment:

| Task input          | Value                                           |
| ------------------- | ----------------------------------------------- |
| `langfusePublicKey` | the Apify AI Agent project's `pk-lf-...` key    |
| `langfuseSecretKey` | the Apify AI Agent project's `sk-lf-...` key    |
| `langfuseBaseUrl`   | `https://langfuse.apify.dev` (in the Task body) |
| `langfuseProject`   | `Apify AI Agent` (in the Task body)             |

Do not change the Actor's `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`
environment variables. They are the dataset-run project's keys, and the
workflow runner depends on them. If the Task input loses its keys, the judge
falls back to them; online mode then fails at start with "The Langfuse keys
belong to project "MCP Agent Evals" ..., expected "Apify AI Agent"" instead of
reading or scoring the wrong project. The check uses
`GET /api/public/projects`, before any other Langfuse call
(`src/online-project.ts`).

`APIFY_TOKEN` is injected by the platform into every run and is what the judge
uses for the OpenRouter proxy and artifact reads; nothing to configure. There is
no OpenRouter key.

## Create the Task and the schedule

Prerequisites: the Actor is deployed (`scripts/deploy.sh judge` from the repo
root) and has been run at least once by hand, which the platform requires
before an Actor can be scheduled. Do not put real ids or keys into the
committed files; they are account-specific or secret. Then:

1. Find the Actor id (the Task takes an id, not a `user~name` handle):

    ```sh
    curl -s -H "Authorization: Bearer $APIFY_TOKEN" \
        "https://api.apify.com/v2/acts/<username>~eval-judge" | jq -r .data.id
    ```

2. Create the Task from a local copy of `online-task.json` with the `actId`
   placeholder filled in. Leave the key placeholders as they are, so the
   keys never pass through a shell or a file:

    ```sh
    curl -s -X POST "https://api.apify.com/v2/actor-tasks" \
        -H "Authorization: Bearer $APIFY_TOKEN" \
        -H "Content-Type: application/json" \
        --data @online-task.local.json | jq -r .data.id
    ```

    The `name` must be unique in the account.

3. Set the keys in the Console: Tasks > `apify-ai-online-evals` > Input >
   **Langfuse public key** and **Langfuse secret key**, from the 1Password
   item of the Apify AI Agent Langfuse project, then **Save**. The Console
   stores secret fields encrypted. (The docs state this for the input editor
   and for API runs, not for task input sent to `POST /v2/actor-tasks`, so
   the API is not used for the keys.)

4. Run the Task once by hand (**Start**). Its log shows
   `Langfuse project: Apify AI Agent (<id>)`, and OUTPUT has the window and
   counters. A wrong key fails here, not on the first scheduled tick.

5. Put the Task id into a local copy of `online-daily.json` in place of the
   `actorTaskId` placeholder and create the schedule:

    ```sh
    curl -s -X POST "https://api.apify.com/v2/schedules" \
        -H "Authorization: Bearer $APIFY_TOKEN" \
        -H "Content-Type: application/json" \
        --data @online-daily.local.json | jq .data.id
    ```

    A `201` with the schedule object means it is live and enabled. The `name`
    must be unique in the account (the API rejects a duplicate name); to
    change a live schedule, `PUT /v2/schedules/<id>` with the same body. To
    change the input or run options, edit the Task (Console, or
    `PUT /v2/actor-tasks/<id>`), and keep `online-task.json` in step.

The action has no `input`, so the run uses the Task input as saved. The
`RUN_ACTOR_TASK` field names (`actorTaskId`, optional `input`) are from the
`ScheduleActionRunActorTask` type of `apify-client` 2.23 and the response
example of `POST /v2/schedules`; the request-body section of that docs page
repeats the `RUN_ACTOR` fields for the Task action. The Apify CLI (1.x) has no
`schedules` command, hence curl. The equivalent with the JS client is
`client.tasks().create(task)` and `client.schedules().create(schedule)`.

## Failed-run alert (the no-data fallback)

The Langfuse alert in `../monitors/agent-judge-pass-rate.md` watches the pass
rate. A judge that never runs writes no scores, and Langfuse's no-data handling
covers that case only after a delay, so also set the platform's own alert on the
Task so a dead run is reported immediately, from the platform that knows it
died:

- Console: Tasks > `apify-ai-online-evals` > **Monitoring** > **Alerts** > add
  alert. The alert goes on the TASK, not on the `eval-judge` Actor: the
  workflow runner calls the same Actor in `datasetRun` mode for the offline
  suites, and an Actor-level alert would also report every offline failure and
  timeout in this channel. Apify monitoring is available on "any Actor or saved
  task", and a task-level alert covers only that task's runs (the notification
  then names the task).
- Condition: **Alert, when run status is one of following**: `FAILED`,
  `TIMED-OUT`, `ABORTED`.
- Notification: Slack (workspace connected under Settings > Integrations),
  channel `<#apify-ai-evals or the team's alert channel>`; optionally email.

Together with the schedule's `restartOnError: false` this means: run died,
Slack knows within a minute. A run that is SUCCEEDED but judged nothing shows up
as `sampled: 0` in its OUTPUT and as a missing `rollup-YYYY-MM-DD` dataset item
(#270); that is the case only the Langfuse no-data mode catches.
