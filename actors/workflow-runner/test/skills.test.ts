import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
    assertSkillsExist,
    availableSkills,
    expandSkillCombinations,
    installSkills,
    parseSkillSet,
    resolveSkillSets,
    skillSetLabel,
    loadRunSkills,
    parseSkillsRef,
    DEFAULT_SKILLS_REF,
    type SkillsSource,
} from '../src/skills.js';

const root = mkdtempSync(join(tmpdir(), 'skills-test-'));
for (const name of ['alpha', 'beta']) {
    mkdirSync(join(root, name, 'reference'), { recursive: true });
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nbody of ${name}\n`);
    writeFileSync(join(root, name, 'reference', 'notes.md'), 'supporting file');
}
mkdirSync(join(root, 'not-a-skill'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('parseSkillSet / skillSetLabel', () => {
    it('treats none and the empty string as no skills', () => {
        expect(parseSkillSet('none')).toEqual([]);
        expect(parseSkillSet('  ')).toEqual([]);
        expect(skillSetLabel([])).toBe('none');
    });

    it('splits on +, trims, dedupes and sorts', () => {
        expect(parseSkillSet('beta + alpha+beta')).toEqual(['alpha', 'beta']);
        expect(skillSetLabel(['beta', 'alpha'])).toBe('alpha+beta');
    });

    it('rejects names that are not lowercase slugs', () => {
        expect(() => parseSkillSet('Alpha')).toThrow(/Invalid skill name/);
        expect(() => parseSkillSet('a b')).toThrow(/Invalid skill name/);
    });
});

describe('expandSkillCombinations', () => {
    it('lists every subset, none first, then by size and name', () => {
        expect(expandSkillCombinations(['b', 'a']).map(skillSetLabel)).toEqual(['none', 'a', 'b', 'a+b']);
        expect(expandSkillCombinations(['x', 'y', 'z'])).toHaveLength(8);
        expect(expandSkillCombinations([])).toEqual([[]]);
    });
});

describe('resolveSkillSets', () => {
    it('defaults to one variant without skills', () => {
        expect(resolveSkillSets({}, ['alpha'])).toEqual([[]]);
    });

    it('keeps explicit sets in order and drops duplicates', () => {
        expect(resolveSkillSets({ skillSets: ['alpha', 'none', 'alpha', 'beta+alpha'] }, [])).toEqual([
            ['alpha'],
            [],
            ['alpha', 'beta'],
        ]);
    });

    it('expands the suite skills when combinations are asked for without explicit sets', () => {
        expect(resolveSkillSets({ skillCombinations: true }, ['beta', 'alpha']).map(skillSetLabel)).toEqual([
            'none',
            'alpha',
            'beta',
            'alpha+beta',
        ]);
    });

    it('expands only the mentioned skills when both are given', () => {
        expect(resolveSkillSets({ skillCombinations: true, skillSets: ['alpha'] }, ['alpha', 'beta'])).toEqual([
            [],
            ['alpha'],
        ]);
    });
});

describe('skills on disk', () => {
    it('lists directories that hold a SKILL.md', () => {
        expect(availableSkills(root)).toEqual(['alpha', 'beta']);
        expect(availableSkills(join(root, 'missing'))).toEqual([]);
    });

    it('fails fast on an unknown skill name', () => {
        expect(() => assertSkillsExist([['alpha'], ['gamma']], root)).toThrow(/Unknown skill\(s\) gamma/);
        expect(() => assertSkillsExist([['alpha', 'beta']], root)).not.toThrow();
    });

    it('copies the whole skill directory into the session as project skills', () => {
        const home = mkdtempSync(join(tmpdir(), 'skills-home-'));
        try {
            installSkills(home, ['alpha'], root);
            expect(readFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain(
                'body of alpha',
            );
            expect(existsSync(join(home, '.claude', 'skills', 'alpha', 'reference', 'notes.md'))).toBe(true);
            expect(existsSync(join(home, '.claude', 'skills', 'beta'))).toBe(false);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it('does nothing for the no-skills variant', () => {
        const home = mkdtempSync(join(tmpdir(), 'skills-home-'));
        try {
            installSkills(home, [], root);
            expect(existsSync(join(home, '.claude'))).toBe(false);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe('parseSkillsRef', () => {
    it('reads owner/repo#ref with an optional path', () => {
        expect(parseSkillsRef('apify/agent-skills#main')).toEqual({
            owner: 'apify',
            repo: 'agent-skills',
            ref: 'main',
            path: 'skills',
        });
        expect(parseSkillsRef('apify/agent-skills#feat/new-skill:plugins/skills')).toEqual({
            owner: 'apify',
            repo: 'agent-skills',
            ref: 'feat/new-skill',
            path: 'plugins/skills',
        });
    });

    it('rejects anything else', () => {
        expect(() => parseSkillsRef('agent-skills')).toThrow(/Invalid skillsRef/);
        expect(() => parseSkillsRef('apify/agent-skills')).toThrow(/Invalid skillsRef/);
        expect(() => parseSkillsRef('apify/agent-skills#main; rm -rf /')).toThrow(/Invalid skillsRef/);
    });
});

describe('loadRunSkills', () => {
    const fetched: string[] = [];
    const fetchRef = async (spec: string): Promise<SkillsSource> => {
        fetched.push(spec);
        return { repo: 'apify/agent-skills', ref: spec.split('#')[1], commit: 'c'.repeat(40), root };
    };

    it('downloads nothing for a run without skills', async () => {
        fetched.length = 0;
        expect(await loadRunSkills([[]], 'apify/agent-skills#main', {}, fetchRef)).toBeNull();
        expect(fetched).toEqual([]);
    });

    it('takes the pinned commit by default', async () => {
        fetched.length = 0;
        const source = await loadRunSkills([[], ['alpha']], undefined, {}, fetchRef);
        expect(fetched).toEqual([DEFAULT_SKILLS_REF]);
        expect(source?.root).toBe(root);
    });

    it('prefers skillsRef, then SKILLS_DIR', async () => {
        fetched.length = 0;
        await loadRunSkills([['alpha']], ' apify/agent-skills#my-branch ', { SKILLS_DIR: '/nowhere' }, fetchRef);
        expect(fetched).toEqual(['apify/agent-skills#my-branch']);

        fetched.length = 0;
        const local = await loadRunSkills([['beta']], '', { SKILLS_DIR: root }, fetchRef);
        expect(fetched).toEqual([]);
        expect(local).toEqual({ repo: 'local', ref: root, commit: 'local', root });
    });

    it('fails on a skill the source does not have', async () => {
        await expect(loadRunSkills([['gamma']], undefined, {}, fetchRef)).rejects.toThrow(/Unknown skill\(s\) gamma/);
    });

    it('pins a full commit, so the default needs no GitHub API call', () => {
        expect(parseSkillsRef(DEFAULT_SKILLS_REF).ref).toMatch(/^[0-9a-f]{40}$/);
    });
});
