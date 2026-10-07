# Ownership block

**Rollout status (2026-10-01):** phase 3 of the cleanup, not started yet; a crawl of
8,165 pages across all area index pages found none. The first 50 priority pages are
listed on the cleanup plan. Until blocks are common, their absence says nothing about a
page. When one is present, it is the strongest currency signal you have.

The 2026 cleanup marks every official page with a callout at the top of the page:

```
👤 Owner: @Person
   Last reviewed: 2026-07-13
   Review at least every: 3 months
```

## How to read it

- **Current** when today ≤ Last reviewed + Review interval. Otherwise **overdue**.
- Missing `Review at least every` means 6 months.
- A page with a current block outranks any page without one for "what is current".
- An overdue block still beats no block: it names who to ask.
- Owner may be a user mention or plain text. Report the name as written.

## Accepted formats (the crawler parses the same)

- Callout within the first three top-level blocks of the page. Icon 👤 is the canonical form; a callout with another icon but the same labels still counts, mention the odd icon only if it matters.
- Labels `Owner:` and `Last reviewed:` required; `Review at least every:` optional.
- The lines may be separated with Enter (Notion stores them as child blocks of the callout) or with Shift+Enter (one block). Both are read.
- Dates: `YYYY-MM-DD` preferred; `D.M.YYYY` and `D/M/YYYY` accepted.
- Interval: `N months` or `N weeks`.

## When you see a page without one

Say so in the answer. If the page is the only candidate, still answer, with the
`page_last_edited_at` date as the freshness signal and "no owner recorded".
