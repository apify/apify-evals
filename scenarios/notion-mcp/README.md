# notion-mcp suite

Measures whether an agent can drive the Notion MCP server, and whether Notion's
agent skills help. Profile: `profiles/notion-mcp.yaml` (open-source
`@notionhq/notion-mcp-server` over stdio, `NOTION_TOKEN` from the runner env).

## What the scenarios test

The suite follows the `apify-notion` skill's domain: find, verify and cite
pages in **Apify's own Notion workspace** (travel policy, benefits, onboarding,
OKRs, IT & Security, the "All meeting notes" database), plus the absence
protocol (parental leave, SOC 2). Everything is read-only; a `readOnly` check
fails any scenario that calls a write tool. Ground truth is structural: which
tools were called, how many (the skill's six-call budget is a `warn` check), a
page URL in the answer, and the judge's reading of `expected`. The integration
behind `NOTION_TOKEN` must be shared with the General teamspace pages.

## Comparing skill variants

```
skillSets: ["none", "notion-research-documentation", "notion-knowledge-capture+notion-research-documentation"]
```

or `skillCombinations: true` for every subset of the profile's `agentSkills`
(16 experiments with four skills; filter with `subjects` first). Each variant
is one Langfuse dataset run named `… · skills:<label> · …`; the Actor OUTPUT
lists `variants` sorted by pass rate.
