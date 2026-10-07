# Establishing that something does not exist

One empty search proves nothing. Before saying "there is no page about X":

1. `notion-search` unscoped with a specific phrasing (2–4 content words).
2. `notion-search` unscoped with a broader or alternative phrasing (a synonym, the
   parent topic, or the English and Czech term when both are plausible).
3. `notion-search` scoped with `page_url` to the area index page where X would plausibly
   live (`references/workspace-map.md`). Try a second area if two are plausible.
4. If the answer matters (policy, security, legal): `notion-fetch` that area page and read
   its child links from that single fetch; do not fetch further.

Call budget: 2 unscoped searches + up to 2 scoped searches + at most 1 fetch = five, within
the six-call cap. Stop as soon as a hit appears; most absence checks end at step 2.

Worked example: "Do we have a SOC 2 page?" looked like a gap after one search and turned
out to be richly documented under IT & Security. Inversely, "parental leave policy" is a
real gap as of October 2026: only a line in the time-off policy, claimable as missing
only after all four steps.

Phrase the result honestly: "I found nothing under Work @ Apify, Company or unscoped
search for 'parental leave' or 'maternity leave'. Either it does not exist or it is not
shared with search." Then name who would know (the team behind the area index page).
