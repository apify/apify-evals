# Handoff: Notion MCP with and without skills

Branch `feat/notion-mcp-skills`. Written 2026-10-07 for Vojtěch and his agents.
Everything below is in the repo; this page says what is done, what is blocked,
and the exact steps to finish.

## Goal

Answer one question with data: which combination of agent skills makes an
agent most effective at Notion tasks through the Notion MCP server. The
candidate skills are `apify-notion` (yours, from
`apify/apify-claude-code-workspace` branch `skill/apify-notion`) and the four
official Notion skills. "None" is the baseline.

## What is done

- The runner Actor can evaluate any MCP server, not only Apify's. A suite
  profile declares the server (`mcp:` in `profiles/<suite>.yaml`); secrets are
  `${VAR}` placeholders filled from the runner environment.
- Skills are an eval axis. Input `skillSets` (`none`, `apify-notion`,
  `a+b`, ...) or `skillCombinations: true` runs one Langfuse experiment per
  skill set, so the compare view shows them side by side. The Actor OUTPUT has
  a `variants` table sorted by pass rate and a `bestVariant`.
- Suite `notion-mcp`: `profiles/notion-mcp.yaml` and ten read-only scenarios
  in `scenarios/notion-mcp/notion/` built around the `apify-notion` workflow
  (find, verify, cite; absence protocol). The dataset is already synced to
  Langfuse.
- Skills vendored under `skills/`: `apify-notion` (commit ff5a570) and the
  four `notion-*` skills from makenotion (commit 9847f2a). `skills/README.md`
  has provenance.
- All builds and tests pass (contract, tools, runner, judge). A local smoke
  session confirmed: the stdio Notion server connects with 24 tools, an
  injected skill loads, personal skills stay out.

Read `scenarios/README.md` (section "Suites on other MCP servers") and
`skills/README.md` before changing anything.

## What is blocked, and by what

1. **The integration sees nothing.** The token in 1Password ("Notion shared
   token", vault Private, field password) belongs to the internal integration
   **Skill testing** in the Apify Technologies workspace. It authenticates
   (`/v1/users/me` is 200) but `/v1/search` returns zero objects: no page is
   connected to it. Connect these pages in Notion (⋯ → Connections → Skill
   testing); sharing a root shares its subtree:
   Apify Wiki, Work @ Apify, Operations, Product & engineering, GTM,
   Archive [Temporary], and the "All meeting notes" database if it sits
   elsewhere. The ids are in `skills/apify-notion/references/workspace-map.md`.
2. **Hosted vs open-source server.** `apify-notion` and the Notion skills were
   written for Notion's hosted connector (`notion-search`, `notion-fetch`,
   `page_url` scoping, ancestor paths). The hosted server is OAuth-only, so
   the suite drives the open-source `@notionhq/notion-mcp-server` over stdio,
   whose tools are `API-post-search`, `API-retrieve-page-markdown`, ... and
   lack `page_url` scoping. Scenario checks accept both tool-name families.
   Expect the skill to look worse than it is on the open-source server; the
   judge's `skill-instructions` fix area is where that shows up. The profile
   header documents the one-block swap to the hosted server with an OAuth
   access token in `NOTION_MCP_TOKEN`, if you can obtain one.

## Steps to finish

1. Connect the pages above to the Skill testing integration. Verify:

    ```sh
    set -a; source .env; set +a   # .env holds NOTION_TOKEN=..., gitignored
    curl -s -H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" -d '{"query":"travel policy","page_size":5}' \
      https://api.notion.com/v1/search | jq '.results | length'
    ```

    Anything above 0 means the suite can run.

2. Local smoke run (two scenarios, two variants). The input is prepared in
   `actors/workflow-runner/storage/key_value_stores/default/INPUT.json`:

    ```sh
    set -a; source .env; set +a
    npm -w actors/workflow-runner run start:dev
    ```

    Needs `LANGFUSE_*` and `APIFY_TOKEN` in the environment (or `apify login`).
    Read the results link printed at the end; check in Langfuse that the
    `agent` span metadata shows `mcpServer: notion`, `agentSkills` and
    `skillsLoaded: ["apify-notion"]` for the skill variant.

3. Deploy. The runner's actor.json references the secret `@notionToken`:

    ```sh
    apify secrets add notionToken "$NOTION_TOKEN"
    scripts/deploy.sh judge
    scripts/deploy.sh workflow-runner
    ```

4. Cloud run of the full matrix. Input:

    ```json
    { "datasetName": "notion-mcp", "skillCombinations": true, "repeats": 3, "concurrency": 4 }
    ```

    Five skills give 32 variants × 10 scenarios × 3 repeats; start with
    `"skillSets": ["none", "apify-notion"]` and `"repeats": 3` to get the
    headline number cheaply, then widen. Results: the Langfuse compare view
    (one dataset run per variant, named `notion-mcp · haiku-4.5 · skills:<set> · …`),
    and `variants` in the Actor OUTPUT.

5. Read failures by fix area. `skill-instructions` means the skill misled the
   agent (likely the hosted-vs-open-source tool-name mismatch);
   `tool-selection` means the bare server did; `agent-or-model` is noise.

## Decisions you may want to revisit

- **Scenario ground truth is structural**, not content-based: which tools
  were called, call budget (six, `warn`), a `notion.so` URL in the answer,
  read-only guard, and the judge's reading of `expected`. Add
  `answer.contains` checks with real page titles once you see what the
  workspace returns; never put live values (dates, counts) in checks.
- **`tools: ['*']`** gives the agent every Notion tool. Narrow a scenario with
  its own `tools:` list if you want to test a single tool's usability.
- **maxTurns** is 14 (find) and 12 (use). The skill's own budget is six tool
  calls; the budget check is `warn` so it informs without failing.
- **Model**: default Haiku 4.5 for cost. Add `"models": ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.6"]`
  to see whether skills matter more for the smaller model.

## Where things are

| What                                                              | Path                                    |
| ----------------------------------------------------------------- | --------------------------------------- |
| MCP server resolution, allowedTools, tools/list                   | `actors/workflow-runner/src/mcp.ts`     |
| Skill sets, combinations, injection                               | `actors/workflow-runner/src/skills.ts`  |
| Session wiring (`--setting-sources project`, mcp.json, redaction) | `actors/workflow-runner/src/harness.ts` |
| Model × skill-set loop, `variants` output                         | `actors/workflow-runner/src/main.ts`    |
| Suite profile (server, agentSkills, fix areas)                    | `profiles/notion-mcp.yaml`              |
| Scenarios and fixture notes                                       | `scenarios/notion-mcp/`                 |
| Vendored skills and provenance                                    | `skills/`                               |
| `tool.called` with `max` and name alternation                     | `contract/src/checks.ts`                |
| Judge: profile `forcedFixAreas`                                   | `actors/judge/src/profile.ts`           |

Tests: `npm test` at the root; `npm run scenarios:check` validates the YAML;
`npm run scenarios:sync -- --suite=notion-mcp` after editing scenarios.
