# Agent skills

Skills the runner can inject into an agent session, one directory per skill in
Claude Code's format (`<name>/SKILL.md` plus supporting files). A suite lists
the skills it may use in `profiles/<suite>.yaml` under `agentSkills`; a run
picks which of them each experiment gets with the `skillSets` input (`none`,
`a`, `a+b`, ...) or enumerates every subset with `skillCombinations`.

The runner copies the chosen skills into the session's project directory
(`.claude/skills/`) and starts Claude Code with `--setting-sources project`, so
the developer's personal skills never leak into a "no skills" variant. The
agent span records `agentSkills` (requested) and `skillsLoaded` (what Claude
Code reported at init), and the trace is tagged `skills:<label>`.

## Vendored skills

| Skill                           | Source                                                                                                                                                                        | Commit                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `apify-notion`                  | [apify/apify-claude-code-workspace](https://github.com/apify/apify-claude-code-workspace/tree/skill/apify-notion) `.claude/skills/apify-notion` (branch `skill/apify-notion`) | `ff5a570` (2026-10-01) |
| `notion-knowledge-capture`      | [makenotion/claude-code-notion-plugin](https://github.com/makenotion/claude-code-notion-plugin) `skills/notion/knowledge-capture`                                             | `9847f2a` (2026-01-22) |
| `notion-meeting-intelligence`   | same repo, `skills/notion/meeting-intelligence`                                                                                                                               | `9847f2a`              |
| `notion-research-documentation` | same repo, `skills/notion/research-documentation`                                                                                                                             | `9847f2a`              |
| `notion-spec-to-implementation` | same repo, `skills/notion/spec-to-implementation`                                                                                                                             | `9847f2a`              |

Directory names equal the `name` in each skill's frontmatter. Re-vendor by
copying the upstream directories over these and updating the commit column.
The upstream repository publishes no LICENSE file; the skills are vendored
here for internal evaluation only.

Note: all of these skills were written against Notion's hosted MCP server
(`notion-search`, `notion-fetch`, `page_url` scoping, ancestor paths). The
`notion-mcp` suite drives the open-source `@notionhq/notion-mcp-server` by
default, whose tools are named `API-post-search`, `API-retrieve-a-page`, ...
and lack some of those parameters. Scenario checks accept both tool names; the
mismatch itself is part of what the suite measures (fix area
`skill-instructions`). See the profile for how to point the suite at the hosted
server with an OAuth token instead.
