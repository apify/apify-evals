/**
 * Agent skills as an eval variable.
 *
 * A skill is a directory `skills/<name>/SKILL.md` (Claude Code's format) in
 * this repo, copied into the image. A run names one or more *skill sets*; each
 * set becomes its own experiment so the compare view answers "which skills
 * help": `none` (the bare harness), `a`, `a+b`, ... With `skillCombinations`
 * the runner enumerates every subset of the suite's `agentSkills`.
 *
 * Injection: the chosen skills are copied into the throwaway session
 * directory as project skills (`<cwd>/.claude/skills/<name>`), and the
 * session is started with `--setting-sources project` so nothing from the
 * developer's own `~/.claude/skills` leaks into a "no skills" variant.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const NO_SKILLS = 'none';
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `"none"` / `""` → []; `"a+b"` → ['a', 'b'] (sorted, unique). */
export function parseSkillSet(label: string): string[] {
    const trimmed = label.trim();
    if (trimmed === '' || trimmed === NO_SKILLS) return [];
    const names = trimmed
        .split('+')
        .map((n) => n.trim())
        .filter(Boolean);
    for (const n of names) {
        if (!NAME_RE.test(n)) throw new Error(`Invalid skill name "${n}" in skill set "${label}"`);
    }
    return [...new Set(names)].sort();
}

export function skillSetLabel(set: string[]): string {
    return set.length === 0 ? NO_SKILLS : [...set].sort().join('+');
}

/** Every subset of `names`, smallest first, then alphabetical; `[]` first. */
export function expandSkillCombinations(names: string[]): string[][] {
    const unique = [...new Set(names)].sort();
    const sets: string[][] = [];
    for (let mask = 0; mask < 1 << unique.length; mask++) {
        sets.push(unique.filter((_, i) => mask & (1 << i)));
    }
    return sets.sort((a, b) => a.length - b.length || skillSetLabel(a).localeCompare(skillSetLabel(b)));
}

/**
 * The skill sets a run covers. Explicit `skillSets` win; with
 * `skillCombinations` the names mentioned in them (or, when none are given,
 * the suite's own `agentSkills`) are expanded into every subset. No input at
 * all means one variant: no skills, the behaviour before skills existed.
 */
export function resolveSkillSets(
    input: { skillSets?: string[]; skillCombinations?: boolean },
    suiteSkills: string[],
): string[][] {
    const explicit = (input.skillSets ?? []).map(parseSkillSet);
    if (input.skillCombinations) {
        const pool = explicit.length > 0 ? explicit.flat() : suiteSkills;
        return expandSkillCombinations(pool);
    }
    if (explicit.length === 0) return [[]];
    const seen = new Set<string>();
    return explicit.filter((set) => {
        const label = skillSetLabel(set);
        if (seen.has(label)) return false;
        seen.add(label);
        return true;
    });
}

/** Where the repo's `skills/` directory is: the image sets SKILLS_DIR; a local
 * run finds it two levels above the Actor directory. */
export function skillsRoot(env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
    if (env.SKILLS_DIR) return resolve(env.SKILLS_DIR);
    for (const candidate of [join(cwd, 'skills'), join(cwd, '..', '..', 'skills')]) {
        if (existsSync(candidate)) return resolve(candidate);
    }
    return join(cwd, 'skills');
}

export function availableSkills(root: string): string[] {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
        .map((d) => d.name)
        .sort();
}

/** Fail fast on a typo: a missing skill would otherwise silently become "no skills". */
export function assertSkillsExist(sets: string[][], root: string): void {
    const have = new Set(availableSkills(root));
    const missing = [...new Set(sets.flat())].filter((n) => !have.has(n));
    if (missing.length > 0) {
        throw new Error(
            `Unknown skill(s) ${missing.join(', ')}; available in ${root}: ${[...have].join(', ') || '(none)'}`,
        );
    }
}

/** Copy the skill set into the session directory as project skills. */
export function installSkills(home: string, set: string[], root: string): void {
    if (set.length === 0) return;
    const target = join(home, '.claude', 'skills');
    mkdirSync(target, { recursive: true });
    for (const name of set) {
        const src = join(root, name);
        if (!existsSync(join(src, 'SKILL.md'))) throw new Error(`Skill "${name}" has no SKILL.md under ${root}`);
        cpSync(src, join(target, name), { recursive: true });
    }
}
