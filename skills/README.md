# Agent skills

Skills the runner can inject into an agent session, in Claude Code's format
(`<name>/SKILL.md` plus supporting files). This repo holds no copy: the runner
downloads [apify/agent-skills](https://github.com/apify/agent-skills) once per
run at the commit pinned in `actors/workflow-runner/src/skills.ts`
(`DEFAULT_SKILLS_REF`). A run without skills downloads nothing.

A suite lists the skills it may use in `profiles/<suite>.yaml` under
`agentSkills`; a run picks which of them each experiment gets with the
`skillSets` input (`none`, `a`, `a+b`, ...) or enumerates every subset with
`skillCombinations`. Skill sets multiply with surfaces (`surfaces/`):
`surfaces: [mcp, cli]` and `skillSets: [none, apify-ultimate-scraper]` give
four experiments per model.

The runner copies the chosen skills into the session's working directory
(`.claude/skills/`) and starts Claude Code with `--setting-sources project`, so
the developer's personal skills never leak into a "no skills" variant. The
agent span records `agentSkills` (requested) and `skillsLoaded` (what Claude
Code reported at init), the run metadata records `skillsSource` (repo, ref,
commit), and the trace is tagged `skills:<label>`.

## Where the skills come from

The first match wins:

1. The run's `skillsRef` input (`apify/agent-skills#my-branch`, or
   `owner/repo#ref:path`): test a skill change before it is merged. A branch
   or tag is resolved to a commit, and the run records it.
2. The `SKILLS_DIR` environment variable: a local directory with
   `<name>/SKILL.md`, to try a skill before it is pushed (local runs).
3. `DEFAULT_SKILLS_REF`: the pinned commit.

An unknown skill name fails the run before any session starts.
`scenarios:check` only checks that `agentSkills` entries are skill names.

To take a new version of the skills, change the commit in
`DEFAULT_SKILLS_REF`. Use a full 40-character commit: the runner then skips
the GitHub API call (60 unauthenticated calls per hour per IP). Deploy the
runner, then compare against a run on the old commit.

## Skills at the pinned commit

`d522584` (2026-10-08): `apify-ultimate-scraper`, `apify-actor-development`,
`apify-actorization`, `apify-integration-development`, and
`apify-generate-output-schema` (deprecated upstream; do not add it to a
profile).

Note: `apify-ultimate-scraper` drives the Apify CLI (`apify actors search`,
`apify actors call --json`). On the `mcp` surface the agent has no Bash, so
the skill describes tools it does not have; that mismatch is part of what the
surface x skill matrix measures (fix area `skill-instructions`).
