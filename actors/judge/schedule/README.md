# Online evals schedule

`online-daily.json` is the Apify Schedule that runs the judge in online mode once
a day ([ai-team#271](https://github.com/apify/ai-team/issues/271)). It is a
complete request body for
[`POST /v2/schedules`](https://docs.apify.com/api/v2/schedules-post); only the
`actorId` placeholder has to be filled in. Nothing in this directory is applied
automatically: creating the schedule is a one-off manual step, documented here so
the running configuration is reviewable in git.

**Status: not yet created** (as of this branch).

## What it runs

| Field                       | Value                                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cronExpression`            | `0 6 * * *` (`timezone: UTC`)                                                                                                                                  | The window is `[checkpoint, now - 33 min)`, so the run at 06:00 judges everything that completed up to 05:27 UTC and the previous day's traffic is closed. 06:00 UTC is 07:00/08:00 in Prague: the run finishes and the Langfuse alert can evaluate before the team's working day starts, so a regression from yesterday is on Slack in the morning. The exact hour is not load-bearing: the checkpoint makes consecutive windows contiguous whatever the cron time.                                                                                      |
| `isExclusive`               | `true`                                                                                                                                                         | If a run is still going when the next tick fires, the platform skips the tick instead of starting a second run. Two concurrent runs would both read the same checkpoint and judge the same window twice.                                                                                                                                                                                                                                                                                                                                                  |
| `runInput.body`             | `mode: online`, `environment: prod`, `sampleRate: 0.2`, `maxItems: 100`, `judgeModel: deepseek/deepseek-v4-flash`, `promptLabel: production`, `concurrency: 4` | These are the online-mode defaults (#267, #269). They are repeated here so the schedule, not the current build's defaults, is the record of what production runs, and so a default change in code does not silently change the scheduled run. `environment: prod` in particular: it is what separates the populations sharing one Langfuse project, and the schedule should record that the daily run scores production traffic only rather than inheriting whatever the build defaults to. `body` is a JSON string, as the API requires.                 |
| `runOptions.timeoutSecs`    | `7200`                                                                                                                                                         | Worst case per trace is 2 attempts x 120 s plus a 2 s retry sleep = 242 s (`src/llm.ts`). 100 sampled traces at concurrency 4 is 25 waves x 242 s = 100.8 min, before the per-trace observation fetch and the MCP `tools/list` fetch #269 adds. Two hours covers it; the next tick is 22 h later so a timeout never collides with it. A TIMED-OUT run does not advance the checkpoint: #270 writes it only after the window's scores and rollup are in Langfuse, so the next tick re-reads the same window and the sample is retried with no manual step. |
| `runOptions.memoryMbytes`   | `1024`                                                                                                                                                         | Same as the documented `apify call --memory 1024` in the Actor README. The judge is I/O bound (Langfuse and LLM calls); 1 GB is headroom for holding up to 100 reconstructed turns in memory.                                                                                                                                                                                                                                                                                                                                                             |
| `runOptions.build`          | `latest`                                                                                                                                                       | `.actor/actor.json` has `buildTag: latest`; `scripts/deploy.sh judge` publishes to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `runOptions.restartOnError` | `false`                                                                                                                                                        | A crash must end as a FAILED run so the run-status alert below fires. Recovery is automatic: the checkpoint moves only after the window's scores and rollup succeed (#270), so a run that dies at any point leaves it where it was and the next tick judges the same window again. That retry is cheap because score writes are idempotent and the pre-filter spends no LLM calls on traces already judged. The `windowStart` / `windowEnd` overrides are for deliberate backfills, not for recovery.                                                     |
| `notifications.email`       | `true`                                                                                                                                                         | The platform's own email when a scheduled action fails to start (misconfigured Actor id or build). The default, kept explicit. The field is in the JS client type and in the response schema but not in the documented POST request body, so if the API answers 400 on it, drop the field: the default is on anyway.                                                                                                                                                                                                                                      |

Cost per run at the defaults is about a dollar of judge calls (see the Actor
README, `maxItems`).

## Secrets the run needs

The schedule body carries no credentials. Set these on the Actor
(Console: Actor > Settings > Environment variables, tick **Secret**), where
`main.ts` reads them as the fallback for the unset `langfuse*` inputs:

| Variable              | Value                                  |
| --------------------- | -------------------------------------- |
| `LANGFUSE_BASE_URL`   | `https://langfuse.apify.dev`           |
| `LANGFUSE_PUBLIC_KEY` | the project's `pk-lf-...` key          |
| `LANGFUSE_SECRET_KEY` | the project's `sk-lf-...` key (secret) |

`APIFY_TOKEN` is injected by the platform into every run and is what the judge
uses for the OpenRouter proxy and artifact reads; nothing to configure. There is
no OpenRouter key.

## Create the schedule

Prerequisites: the Actor is deployed (`scripts/deploy.sh judge` from the repo
root) and has been run at least once by hand, which the platform requires
before an Actor can be scheduled. Then:

1. Find the Actor id (the schedule takes an id, not a `user~name` handle):

    ```sh
    curl -s -H "Authorization: Bearer $APIFY_TOKEN" \
        "https://api.apify.com/v2/acts/<username>~eval-judge" | jq -r .data.id
    ```

2. Put it into `online-daily.json` in place of the `actorId` placeholder (do not
   commit the id; it is account-specific) and create the schedule:

    ```sh
    curl -s -X POST "https://api.apify.com/v2/schedules" \
        -H "Authorization: Bearer $APIFY_TOKEN" \
        -H "Content-Type: application/json" \
        --data @actors/judge/schedule/online-daily.json | jq .data.id
    ```

    A `201` with the schedule object means it is live and enabled. The `name`
    must be unique in the account (the API rejects a duplicate name); to
    change a live schedule, `PUT /v2/schedules/<id>` with the same body.

The Apify CLI (1.x) has no `schedules` command, hence curl. The equivalent with
the JS client is `new ApifyClient({ token }).schedules().create(body)`, whose
`ScheduleCreateOrUpdateData` type matches the file field for field.

## Failed-run alert (the no-data fallback)

The Langfuse alert in `../monitors/agent-judge-pass-rate.md` watches the pass
rate. A judge that never runs writes no scores, and Langfuse's no-data handling
covers that case only after a delay, so also set the platform's own alert on the
Actor so a dead run is reported immediately, from the platform that knows it
died:

- Console: Actor `eval-judge` > **Monitoring** > **Alerts** > add alert.
- Condition: **Alert, when run status is one of following**: `FAILED`,
  `TIMED-OUT`, `ABORTED`.
- Notification: Slack (workspace connected under Settings > Integrations),
  channel `<#apify-ai-evals or the team's alert channel>`; optionally email.

Together with the schedule's `restartOnError: false` this means: run died,
Slack knows within a minute. A run that is SUCCEEDED but judged nothing shows up
as `sampled: 0` in its OUTPUT and as a missing `rollup-YYYY-MM-DD` dataset item
(#270); that is the case only the Langfuse no-data mode catches.
