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

