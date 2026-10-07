---
name: apify-notion
description: >
  Find, verify and cite information in Apify's Notion workspace through the Notion MCP.
  Use whenever someone asks where something is documented, how a process works, what a
  policy says, who owns a page or topic, whether a page is still current, or asks to
  search Notion, look up OKRs, benefits, onboarding, travel, office, meeting notes or team
  docs. Also use when a Notion URL is pasted with a question about its trustworthiness or
  position.
---

# Apify Notion

Apify is on the Notion Plus plan. Search is keyword-only, capped at 25 results, and
the workspace holds thousands of duplicate-titled and outdated pages while a cleanup
moves them into a new structure. This skill exists to land on the right page fast and to
say how much to trust it.

## Speed budget

Common path: **one** search, **one** fetch to verify. Hard cap: six tool calls before
answering with what you have. Never run a search you cannot justify.

## Workflow

1. **Classify** the question: *known document* (user names it) · *fuzzy topic* ·
   *enumerate rows* of a database · *ownership or currency* ("who owns X", "is this
   still current").
2. **Search.** `notion-search`, 2–4 content words, `page_size` 25,
   `max_highlight_length` 0 unless you need snippets, one question per call. Scope with
   `page_url` to the index page of the area when you know the neighbourhood
   (`references/workspace-map.md`). Try a second phrasing before moving on. If the
   connector reports `ai_search` as available, use it for fuzzy topics; never depend on
   it, because it comes and goes with the plan.
3. **Pick candidates.** Prefer pages under an area index page over personal workspaces,
   working files and anything under Archive. When two results share a title, keep both
   until step 4 decides.
4. **Verify** the top one or two candidates with `notion-fetch`: take freshness from
   `page_last_edited_at`, check `<ancestor-path>` for Archive or a team's working area,
   look for a newer sibling with the same title, and read the ownership block if the page
   has one (`references/ownership-block.md`).
5. **Answer.** Link the page. One clause of confidence, grounded in what you saw: the
   last-edited date, the location, the ownership block when present. If two pages
   conflict, say so and name both. Do not describe a missing ownership block as a
   defect; most pages do not have one yet. For "who owns X" when no block exists, say
   that no owner is recorded, then point to the team behind the area index page the page
   sits under (People for Work @ Apify, IT & Security for its subtree, and so on) as the
   place to ask.
6. **Absence.** Never say "there is no page about X" until `references/absence-protocol.md`
   has run.

## Standing rules

- A page with a *current* ownership block (Last reviewed within Review interval) beats
  any page without one for "what is current" and "who owns" questions. Blocks are being
  rolled out; treat their absence as neutral, not as a warning.
- Archive [Temporary], the Permanent Archive, titles starting `[RETENTION]` or
  `[ARCHIVED]`, and pages under a team's working-files area are non-answers for currency
  questions. Cite them as history only when history is asked for.
- Dedupe by page id, never by URL. Results of type `block` (an inline database, a
  section) belong to their parent page; results titled `‣` are database rows named by a
  mention and are rarely the answer.
- Results may come back semantic rather than keyword (`"type": "ai_search"`) while the
  plan allows it. Phrase queries as topics either way; check `notion-fetch` id `self`
  once per session if you need to know which mode you are in.
- Search result `timestamp` is last-edited. The `created_date_range` filter is created.
  Never present one as the other.
- Never quote the fetch "as of" header as freshness; it is a cache and can be months off.
- Before relying on a connector parameter, check `references/tools.md`; what works on
  Plus has changed more than once. When in doubt, `notion-fetch` the id `self` lists the
  tools available right now.
- Never edit workspace pages from this skill.

## References

- `references/tools.md` — Notion MCP tool mapping and plan gates (dated)
- `references/workspace-map.md` — area index pages, teamspaces, corpus landmines (dated)
- `references/ownership-block.md` — the ownership callout and how to read it
- `references/absence-protocol.md` — how to establish that something does not exist
