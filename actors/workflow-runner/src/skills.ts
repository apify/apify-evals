/**
 * Agent skills as an eval variable.
 *
 * A skill is a directory `<name>/SKILL.md` (Claude Code's format) in
 * apify/agent-skills, downloaded once per run at a pinned commit
 * (DEFAULT_SKILLS_REF) or at the run's `skillsRef`; this repo holds no copy.
 * A run names one or more *skill sets*; each
 * set becomes its own experiment so the compare view answers "which skills
 * help": `none` (the bare harness), `a`, `a+b`, ... With `skillCombinations`
 * the runner enumerates every subset of the suite's `agentSkills`.
 *
 * Injection: the chosen skills are copied into the throwaway session
 * directory as project skills (`<cwd>/.claude/skills/<name>`), and the
 * session is started with `--setting-sources project` so nothing from the
 * developer's own `~/.claude/skills` leaks into a "no skills" variant.
 */
import { execFile as execFileCb } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

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

/**
 * The skills a run injects when its `skillsRef` input is empty. A full commit,
 * so every run gets the same files and no GitHub API call is needed. Change
 * the commit to take a new version of the skills (see skills/README.md).
 */
export const DEFAULT_SKILLS_REF = 'apify/agent-skills#d522584df6d01746d76b0c674f375cc7d48a838f';

export interface SkillsSource {
    /** `owner/repo`, or `local` for SKILLS_DIR. */
    repo: string;
    /** The ref asked for, or the directory for SKILLS_DIR. */
    ref: string;
    /** The commit the skills came from, or `local` for SKILLS_DIR. */
    commit: string;
    /** The directory that holds the skills, ready to be used as the skills root. */
    root: string;
}

/**
 * The skills a run uses, first match wins: the `skillsRef` input (test a skill
 * branch), SKILLS_DIR (a local directory, to try a skill before it is pushed),
 * DEFAULT_SKILLS_REF. A run with no skills in any set downloads nothing and
 * gets null. Unknown skill names fail here, before any session starts.
 */
export async function loadRunSkills(
    sets: string[][],
    skillsRef: string | undefined,
    env: Record<string, string | undefined> = process.env,
    fetchRef: (spec: string) => Promise<SkillsSource> = fetchSkillsRef,
): Promise<SkillsSource | null> {
    if (sets.every((set) => set.length === 0)) return null;
    let source: SkillsSource;
    if (skillsRef?.trim()) {
        source = await fetchRef(skillsRef.trim());
    } else if (env.SKILLS_DIR) {
        const root = resolve(env.SKILLS_DIR);
        source = { repo: 'local', ref: root, commit: 'local', root };
    } else {
        source = await fetchRef(DEFAULT_SKILLS_REF);
    }
    assertSkillsExist(sets, source.root);
    return source;
}

const SKILLS_REF_RE = /^([\w.-]+)\/([\w.-]+)#([\w./-]+?)(?::([\w./-]+))?$/;

/** `apify/agent-skills#my-branch` or `owner/repo#ref:path/to/skills` (path defaults to `skills`). */
export function parseSkillsRef(spec: string): { owner: string; repo: string; ref: string; path: string } {
    const m = spec.trim().match(SKILLS_REF_RE);
    if (!m) throw new Error(`Invalid skillsRef "${spec}"; expected owner/repo#ref or owner/repo#ref:path`);
    return { owner: m[1], repo: m[2], ref: m[3], path: m[4] ?? 'skills' };
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * Download skills from a public GitHub ref once per run. A branch or tag is
 * resolved to a commit first, and the run records it; a full commit skips
 * that GitHub API call (60 unauthenticated calls per hour per IP).
 */
export async function fetchSkillsRef(
    spec: string,
    dir = mkdtempSync(join(tmpdir(), 'skills-ref-')),
): Promise<SkillsSource> {
    const { owner, repo, ref, path } = parseSkillsRef(spec);
    const commit = COMMIT_RE.test(ref) ? ref : await resolveCommit(owner, repo, ref, spec);
    const tarball = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${commit}`, {
        signal: AbortSignal.timeout(120_000),
    });
    if (!tarball.ok) throw new Error(`skillsRef ${spec}: tarball download returned HTTP ${tarball.status}`);
    const archive = join(dir, 'source.tar.gz');
    writeFileSync(archive, Buffer.from(await tarball.arrayBuffer()));
    const out = join(dir, 'source');
    mkdirSync(out);
    await execFile('tar', ['-xzf', archive, '-C', out, '--strip-components=1'], { timeout: 60_000 });
    const root = join(out, path);
    if (availableSkills(root).length === 0) throw new Error(`skillsRef ${spec}: no <name>/SKILL.md under ${path}`);
    return { repo: `${owner}/${repo}`, ref, commit, root };
}

async function resolveCommit(owner: string, repo: string, ref: string, spec: string): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`skillsRef ${spec}: GitHub returned HTTP ${res.status} for the ref`);
    const commit = ((await res.json()) as { sha?: string }).sha;
    if (!commit) throw new Error(`skillsRef ${spec}: no commit for the ref`);
    return commit;
}
