# Scenarios

Scenarios are the questions the evals ask. They live here as YAML, one file per
subject under test, and are synced to a Langfuse dataset per suite:

```
scenarios/<suite>/<owner>/<subject-slug>.yaml   →   Langfuse dataset "<suite>"
profiles/<suite>.yaml                             →   what is under test, tools per skill, fix areas
```

The repo is the source of truth. Edit here, open a PR, then run
`npm run scenarios:sync` (or let CI do it). Edits made in the Langfuse UI are
overwritten by the next sync.

## Write a scenario

```yaml
subject: compass/crawler-google-places        # the thing under test (Actor id for the store suite)
scenarios:
  - id: crawler-google-places-use-prague-coffee   # stable, lowercase, dashes; never rename (history hangs off it)
    skill: use                                     # find = the agent must discover the subject; use = subject is pinned
    title: "Usage: pinned Google Maps scraper, place search with contact fields"
    prompt: |
      Using the compass/crawler-google-places Actor, find 10 highly-rated coffee shops in Prague
      with name, address, phone number, and rating. Report how many you retrieved and the top one.
    expected: |
      The agent runs the pinned Actor with a sensible search string, Prague as location and a
      10-place cap, and reports real names, addresses, phone numbers and ratings from the data.
    checks:
      - { id: shape, type: answer.regex, value: '\+?\d[\d ()-]{7,}' }
```

You write five things: `id`, `skill`, `prompt`, `expected`, `checks`. The sync
derives the rest from the folder and the profile: `owner` from the folder name,
`subject`, `tools` and `maxTurns` from the skill, and for `find` scenarios the
trailer line the checks rely on (`Actor: <username/name ...>`). Optional per
scenario: `title`, `maxTurns`, `timeoutSecs`, `tools`, `allowBash`,
`appendSuffix: false`, `notes` (for humans, never shown to the judge), `tags`,
`reference`.

### Titles are chart labels

`title` is what Langfuse shows as the trace name and the only per-scenario label
charts can use, so keep it short and uniform: `<actor short name> / find|use /
<two-or-three-word topic>`, under 60 characters (the lint rejects longer). Put
the descriptive sentence ("finds the reviews scraper, not the places scraper")
in `notes`, which humans see and the judge never does.

### Two scenario types per subject, always

- **find**: the prompt does not name the subject; the agent gets the search
  tool. A failure means the subject is hard to find or presents itself badly
  (store search, name, description). Dashboards call this **Found**.
- **use**: the prompt names the subject; no search tool. A failure means the
  subject itself is hard for an agent (input schema, README, output, errors).
  Dashboards call this **Works**.

One combined scenario cannot tell you which team owns the problem; two can.

### Keep it finishable in two minutes

Cap result counts ("10 places", "5 posts"). No whole-site crawls, no "all
reviews". For subjects that only make sense at scale, test configuration
comprehension instead: ask for the right input and check `apify.input`, not the
crawl. `npm run scenarios:check` warns about unbounded or time-anchored prompts.

### `expected` is for the judge

One paragraph describing what a correct run looks like: which subject, which
mode, what a grounded answer contains. It is never grepped. Live values
(follower counts, prices) do not belong in deterministic checks; put them in
`expected` as prose, or use a `reference` run.

## Checks

Every check has an `id` (its score is `check.<id>`), a `type`, and optionally
`severity: warn` (shown, never gates the verdict). A failed `fail`-severity
check makes the verdict `fail` even when the judge liked the answer.

| type | asserts | fields |
| --- | --- | --- |
| `answer.contains` | the final answer contains a string (case-insensitive) | `value` |
| `answer.regex` | the final answer matches | `value` |
| `answer.grounded` | numbers in the answer appear in the subject's output | `minDigits` (4), `tolerancePct` (1), `ignoreFromPrompt` (true) |
| `subject.used` | which subject the agent actually called (from tool calls) | `value` or `pattern`, `allowOthers` |
| `apify.run` | the Actor runs the agent triggered | `status` (SUCCEEDED), `maxRuns` |
| `apify.input` | the input the agent built | `path` + `op` (`equals`, `notEquals`, `lte`, `gte`, `in`, `regex`, `exists`) + `value`, or `required: [...]` |
| `apify.items` | the run's dataset items | `count: {min,max}`, `requiredFields`, `field`+`op`+`value` (every item), `jsonSchema`, `field`+`set: {mode: equals|superset|intersects, value: [...]}` |
| `tool.called` | a tool was called (CLI / SDK suites) | `name`, `inputRegex`, `min` |
| `workspace.file` | a file exists in the agent's workspace (SDK suite) | `path` glob, `jsonSchema` |
| `reference` | compare against a fresh run of the subject made by the eval | see below |

`contains` and `regex` still work as aliases of `answer.contains` / `answer.regex`.

### Fresh ground truth: `reference`

For live values, let the eval run the subject itself and compare with tolerance:

```yaml
    reference:
      input: { directUrls: ["https://www.instagram.com/nasa/"], resultsType: details, resultsLimit: 1 }
      maxSecs: 120
      cacheKey: nasa-profile            # one reference run per experiment, shared by repeats
      compare:
        - { answerRegex: 'followers?[^0-9]{0,20}([\d,]+)', field: followersCount, tolerance: 0.02 }
```

Reference runs cost Actor compute; use them only where structural checks and
stable facts cannot do the job.

## Three ways to avoid stale ground truth

1. **Structural**: counts, required fields, ranges, schema, input predicates. Stable forever.
2. **Stable facts**: historical items with fixed ids (a post from a fixed date has a fixed shortcode). `apify.items` with `set` or `op: equals`.
3. **Reference run**: live values against a run the eval makes at judge time, with tolerance.

## Commands

```sh
npm run scenarios:check              # validate all suites (CI runs this)
npm run scenarios:sync -- --dry-run  # what would change in Langfuse
npm run scenarios:sync               # upsert; archives items whose file is gone
```

Sync needs `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` in the environment.
