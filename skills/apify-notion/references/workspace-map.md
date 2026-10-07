# Apify Notion workspace map

Verified on 2026-10-01 against the live workspace. The 2026 Notion cleanup is still
moving pages (phase 2 of 5: archiving); check the date before trusting ids.

## Structure since September 2026

Everything company-wide lives in the **General** teamspace, split into area index pages.
Each is a root: scope a search to one with `page_url` when you know the area.

| Area index page | ID | What lives there |
|---|---|---|
| Apify Wiki | `c91aa8d3-0687-40bd-a02b-ef2df67689a9` | Company-wide: Welcome on board, Company (policies, OKRs), FAQs, How-tos, product launches, AI tools and help center, US Mission, IT & Security, Contractor management |
| Work @ Apify | `2b1f3995-0a22-8046-a32b-d598c6348d2f` | People: onboarding, benefits, vacations, performance, compensation guide, hiring, offices, buddy program, org chart |
| Operations | `fbf14a7e-d2a4-49ed-bd0e-440594ad44c0` | Legal, Finance, merch |
| Product & engineering | `3d7f3995-0a22-809c-8bc4-e7a3798bf94d` | Product groups (Creators, Integrators), Engineering, Product, Design, Data, Partnerships, Store, Web Automation |
| GTM | `3d7f3995-0a22-8000-acbf-e9dbdf2fa029` | Marketing (incl. GTM Engine, SEO), Sales, Customer Success |
| RevOps | `368f3995-0a22-8167-b763-f55b40bd6d0c` | HubSpot knowledge base, RevOps projects and team |
| Archive [Temporary] | `2ea33646-59f0-4be9-9c5f-ca94922c0931` | Pages awaiting permanent archive; non-answers for currency questions |

Sub-hubs worth scoping to directly:

| Sub-hub | ID | Under |
|---|---|---|
| IT & Security | `2a1f3995-0a22-804c-b963-eeef88d77185` | Apify Wiki |
| Company (policies, OKRs, routines) | `454b559f-5498-4f01-b96f-1d28ea12c251` | Apify Wiki |
| AI tools and help center | `3b6f3995-0a22-80a9-b540-e186bfb521fb` | Apify Wiki |
| Legal | `f5d7a1ac-4c1b-4abb-b8f5-2470f7e87e44` | Operations |
| Finance | `d7435210-3415-4387-9d83-8f320fbabf29` | Operations |
| Engineering | `be5d2b9b-a696-4b61-839d-e9b61e52ff16` | Product & engineering |
| Marketing | `7ba1f49b-5629-419d-949f-4ed10b075b39` | GTM |

Personal workspaces and "Personal workspaces" sub-areas under GTM/Marketing hold drafts;
prefer the area page over them.

## Teamspaces (`notion-get-teams`, 2026-09-06)

| Name | ID | Notes |
|---|---|---|
| General | `91eba3ee-2ade-47c7-8982-bae5762f37d4` | All company content, including OKRs |
| 🧓🏽 Senior team | `2acf3995-0a22-8135-abf0-00423439cd0e` | Not where OKRs live |
| Archive | `3caf3995-0a22-8128-9768-0042e1c3d94e` | Locked Permanent Archive, invisible to search |
| My workspace | `9c352fa7-ea39-472c-bdf8-81d198a21514` | Personal |

Some pages still live in no teamspace and are invisible to any `teamspace_id` call;
when a teamspace-scoped search misses, repeat it unscoped.

## Recurring lookups with known routes

- Travel policy, benefits, office, onboarding, compensation guide: unscoped keyword
  search, canonical page ranks first; all now sit under Work @ Apify or Apify Wiki.
- OKRs: Apify Wiki / Company / Objectives and Key Results hub; the hub names the current
  quarter. A Senior-scoped search returns the wrong OKRs.
- Meeting notes: the "All meeting notes" database (thousands of rows, bot-fed). Enumerate
  with `notion-query-data-sources`, do not search page by page.
- "Who owns X" / "current status of Y": the measured weak spot (0.60 in August). Scope
  the search to the owning area, check for a newer sibling, read the ownership block if
  present, and say when ownership is not recorded.

## Corpus landmines

- Thousands of pages share a title (~3,300 groups in August). Never stop at the first hit
  for a currency question.
- Superseded pages keep their inbound links (OKRs Q2/2026 with 36 links versus 2 for the
  current quarter; an archived brand book with 35). A well-linked page is not therefore
  current.
- Untitled container pages sit between some roots and their areas; breadcrumbs are not
  reliable names.
- Very large pages exceed the fetch limit; the ancestor path is in the first ~1.5 KB.
