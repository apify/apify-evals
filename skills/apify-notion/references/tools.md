# Notion MCP tools — mapping and plan gates

Verified on 2026-09-07 against the Claude Notion connector on the Apify workspace
(Plus plan). Re-verify with `notion-fetch` id `self`, which lists `current_tool_access`.

**Plan drift warning (2026-10-01):** the connector currently reports every tool as
available, including `ai_search`, unlimited `query_data_sources` and meeting notes. Apify
has decided to stay on Plus, so this is most likely a Business trial that will end. Use
the extra tools when `self` says they are available, but never build an answer path that
needs them; the Plus column below is the baseline that always works.

| Job | Tool | Works on Plus | Business-gated (do not use) |
|---|---|---|---|
| Keyword search | `notion-search` | `query`, `page_size` (≤50, results cap ~25), `max_highlight_length`, `page_url` (page + descendants), `teamspace_id` (one), `data_source_url`, `created_by_user_ids`, `created_date_range`, `query_type: "user"` | `title_only`, `last_edited_date_range`, `edited_by_user_ids`, `content_status`, `teamspace_ids` (multi), `sort` other than relevance (a `sort: last_edited` call failed 2026-09-06) |
| Semantic search | `notion-ai-search` | — | Entire tool: `plan_required` |
| Read a page | `notion-fetch` | `<ancestor-path>` (root first; empty = root), child `<page>`/`<database>` links, `page_last_edited_at`, `<data-source>` with `collection://` URL | — |
| Rows of a database | `notion-query-data-sources` | rows mode with structured `filter` + `sort` works (verified 2026-09-07, Plus) | SQL mode / multi-source |
| Teamspaces, users | `notion-get-teams`, `notion-get-users` | yes | — |
| Meeting notes | `notion-query-meeting-notes` | `not_enabled` | — |
| Own sidebar | `notion-list-{recent,favorite,shared,private}-pages` | user-scoped only | — |

Behaviours to remember:

- Results carry `timestamp` = last edited. Titles with `‣` are database rows named by a
  user mention: real pages, useless titles.
- `page_url` scoping can return the anchor page itself.
- `notion-fetch` "as of" header is a render cache, days to months off either way.
  `page_last_edited_at` in the metadata is the truth.
- Deep pages sometimes return a partial `<ancestor-path>`; cross-check with the parent.
- Very large pages (50 KB and more, such as the Travel policy) exceed the response limit
  and the fetch result is saved to a file instead. Do not re-fetch. Read the file in
  slices: the `<ancestor-path>` sits in the first ~1.5 KB, and the JSON tail carries
  `path`, `page_last_edited_at` and `verification`. A `head -c 2000` and a `tail -c 600`
  are enough to verify a candidate.
- `verification.state` in fetch metadata is `unverified` for practically every page on
  Plus (verification is a Business feature). Do not read it as a trust signal.
