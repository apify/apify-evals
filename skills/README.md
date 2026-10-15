# Agent skills

Skills the runner can inject into an agent session, one directory per skill in
Claude Code's format (`<name>/SKILL.md` plus supporting files). A suite lists
the skills it may use in `profiles/<suite>.yaml` under `agentSkills`; a run
picks which of them each experiment gets with the `skillSets` input (`none`,
`a`, `a+b`, ...) or enumerates every subset with `skillCombinations`. Skill
sets multiply with surfaces (`surfaces/`): `surfaces: [mcp, cli]` and
`skillSets: [none, apify-ultimate-scraper]` give four experiments per model.

The runner copies the chosen skills into the session's working directory
(`.claude/skills/`) and starts Claude Code with `--setting-sources project`, so
the developer's personal skills never leak into a "no skills" variant. The
agent span records `agentSkills` (requested) and `skillsLoaded` (what Claude
Code reported at init), and the trace is tagged `skills:<label>`.

To test a skill change before it is merged, give the run `skillsRef`
(`apify/agent-skills#my-branch`). The runner downloads that ref once, uses it
instead of the skills below, and records the commit in the run metadata.

## Vendored skills

| Skill                           | Source                                                                                      | Commit                 |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------- |
| `apify-ultimate-scraper`        | [apify/agent-skills](https://github.com/apify/agent-skills) `skills/apify-ultimate-scraper` | `d522584` (2026-10-08) |
| `apify-actor-development`       | same repo, `skills/apify-actor-development`                                                 | `d522584`              |
| `apify-actorization`            | same repo, `skills/apify-actorization`                                                      | `d522584`              |
| `apify-integration-development` | same repo, `skills/apify-integration-development`                                           | `d522584`              |

`apify-generate-output-schema` is left out: upstream marks it deprecated.
Directory names equal the `name` in each skill's frontmatter. Re-vendor by
copying the upstream directories over these and updating the commit column.

Note: `apify-ultimate-scraper` drives the Apify CLI (`apify actors search`,
`apify actors call --json`). On the `mcp` surface the agent has no Bash, so
the skill describes tools it does not have; that mismatch is part of what the
surface x skill matrix measures (fix area `skill-instructions`).
