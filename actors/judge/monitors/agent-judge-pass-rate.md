# Langfuse alert: `agent_judge` pass rate

**Status: not yet created.** Langfuse alerts (the feature the issue calls
Monitors; the UI renamed it to Alerts, the URL is still `/monitors` and the
webhook payload keeps `monitorId`) have no public API, so this file is the
configuration to enter by hand in the Langfuse UI and the record to diff against
when someone changes it there. Issue:
[ai-team#271](https://github.com/apify/ai-team/issues/271).

Everything below is checked against the Langfuse docs page
[Alerts](https://langfuse.com/docs/observability/features/alerts) (fetched
2026-09-08; the field names are quoted from it) and the changelog
[Track and alert on boolean scores](https://langfuse.com/changelog/2026-07-21-boolean-score-dashboards-monitors).
Self-hosted availability is Langfuse v4+; `langfuse.apify.dev` runs v4.

## What it watches

`agent_judge` is the holistic BOOLEAN verdict the judge writes on every sampled
production turn (1 = pass, 0 = fail; `src/rubric.ts`). Per the docs, "for
Boolean scores, the average value is the share of scores that are `true`", so
`avg` of `agent_judge` over a window is the pass rate with no arithmetic in the
alert. The judge runs daily at 06:00 UTC (`../schedule/online-daily.json`) and
writes up to 100 verdicts per run.

## Configuration to enter

Project: the Langfuse project the judge writes to. UI path: project > **Alerts**
(`https://langfuse.apify.dev/project/<projectId>/monitors`) > **New Alert**.

### 1. Metric

| Field           | Value                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data source** | `Scores (boolean)` (the issue calls it the `scores-boolean` view; the docs' webhook example shows only `"view": "observations"`, so the exact string for this source is unverified)                                                                  |
| **Metric**      | `avg` of the score value                                                                                                                                                                                                                             |
| **Filters**     | score name `=` `agent_judge`. Add nothing else at first. If the filter UI offers a score `source` column, do NOT restrict it: the judge writes with `source: API` (#270). Do not filter on Boolean value, that would collapse the average to 1 or 0. |

Note on double counting: #270 writes each verdict twice, once attached to the
trace (timestamp pinned to the trace's own timestamp) and once to the invented
dataset run `apify-ai-online-YYYY-MM-DD` (timestamp is the write time). Both
copies carry the same value, so the pass rate is unchanged; only the count is
doubled. If the alert UI can distinguish trace-attached from run-attached
scores, prefer the run-attached copy: its write-time timestamp keeps a whole
daily batch inside one window, while the trace-pinned copy of a 24 h window is
spread across the previous day and partly ages out of a 1-day lookback. Verify
in the UI which columns the `Scores (boolean)` filter exposes; this is the one
part of the configuration the docs do not spell out.

### 2. Alert conditions

| Field                 | Value                                               |
| --------------------- | --------------------------------------------------- |
| **Operator**          | `<`                                                 |
| **Alert threshold**   | `0.6` (pass rate below 60% sets severity `ALERT`)   |
| **Warning threshold** | `0.8` (pass rate below 80% sets severity `WARNING`) |
| **Window**            | `1 day`                                             |

One alert carries both thresholds: the docs define **Alert threshold**
(required) and **Warning threshold** (optional, "crossing this value before the
alert threshold sets severity to WARNING"), so this is a single alert with two
thresholds, not two alerts.

The thresholds are deliberately loose. There is no baseline yet for what the
judge says about production turns, and an LLM judge on a 20% sample of a
variable day has real noise. Tighten both once a couple of weeks of
`rollup-YYYY-MM-DD` items (#270) show the normal range; the numbers to move are
only these two fields.

Evaluation cadence: the docs say a saved alert "becomes ACTIVE immediately and
schedules its first evaluation" and do not expose a frequency setting. If the
editor offers one, hourly is enough: the data changes once a day.

### 3. Advanced settings

| Field                | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No-data handling** | `Notify after sustained NO_DATA`, set the delay to 6 h (or the nearest offered value; the docs list no values). This is the "silently dead Actor" case: the judge did not run, or ran and sampled nothing, so no `agent_judge` score landed in the 1-day window. The default `Treat missing data as 0` would also fire, but as an `ALERT` reading "pass rate 0", which is a lie about the agent; `NO_DATA` names the actual problem. The 6 h delay keeps a slow or late run (the schedule allows 2 h, and the platform may delay a tick) from paging; a run that is 6 h late is a dead run. `Show severity NO_DATA` records but never notifies, so it does not satisfy the issue. See the flicker note below before changing either setting. |
| **Renotify**         | `Off`. One Slack message per severity transition (breach and recovery) is enough for a daily signal; repeated pings would be noise while the same day's sample stays below the line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Daily NO_DATA flicker: the data arrives once a day, so a 1-day window empties out every morning. The trace-pinned copies of yesterday's batch (timestamps up to 05:27 UTC) have all aged out of the window by about 05:27, and the run-attached copies (written at roughly 06:0x) leave at about 06:0x the next day, minutes before the next run writes new ones. Every day there is a short NO_DATA gap of minutes to at most about an hour if the run is slow. That gap is why the sustained delay must stay well above it (do not go below roughly 2 h) and why `Treat missing data as 0` is wrong here: it would fire an `ALERT` every morning.

No-data has a backstop outside Langfuse, documented in
`../schedule/README.md`: the Apify run-status alert (`FAILED`, `TIMED-OUT`,
`ABORTED` to Slack) fires within a minute of the run dying, and a SUCCEEDED run
that judged nothing is visible as `sampled: 0` in its OUTPUT and a missing
`rollup-YYYY-MM-DD` dataset item.

### 4. Notification channel

Alerts notify through **Automations**. Create one first (project >
**Automations** > **Create Automation**): event source `Alert`, action `Slack`,
channel `<#apify-ai-evals or the team's alert channel>`, name
`slack-apify-ai-evals`. The Slack workspace must be connected to the Langfuse
project beforehand (project Settings > Integrations > Slack). Then select that
automation in the **Automations** panel of the alert editor. The docs note that
after 5 consecutive delivery failures Langfuse disables the automation's
trigger; re-enable it from the Automations page.

### 5. Name and tags

| Field    | Value                                                  |
| -------- | ------------------------------------------------------ |
| **Name** | `apify-ai online evals: agent_judge pass rate (1 day)` |
| **Tags** | `apify-ai`, `online-evals`                             |

## Severity semantics once live

| Severity  | Meaning for us                                                                       |
| --------- | ------------------------------------------------------------------------------------ |
| `OK`      | Pass rate at or above 0.8 over the last day.                                         |
| `WARNING` | Below 0.8: look at the failing criteria in the day's rollup before the next run.     |
| `ALERT`   | Below 0.6: treat as a regression of the agent or the toolset until shown otherwise.  |
| `NO_DATA` | No verdicts in a day: the judge is dead, check the Apify run and the schedule first. |

## Planned second alert: `agent_judge_argumentCorrectness`

Not created yet either; add it after the first one has a baseline. Same
configuration as above with the filter score name `=`
`agent_judge_argumentCorrectness` and its own name
(`apify-ai online evals: argumentCorrectness pass rate (1 day)`).

Why this criterion and not the others: `argumentCorrectness` is the one
criterion judged deterministically (#269), by validating every tool call's
arguments against the declared input schema, reproducible through the trace's
`toolSchemaHash`. A drop in it is a real regression in the agent or a changed
tool schema, not judge noise, so it can carry a tighter threshold than the
holistic verdict and can be trusted to page. The remaining
`agent_judge_<criterion>` scores are LLM verdicts like `agent_judge`; watch them
on a dashboard (same `Scores (boolean)` source, one `avg` widget per name), not
as alerts, until the holistic alert has proven itself.
