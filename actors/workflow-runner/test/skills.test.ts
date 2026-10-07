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
    skillsRoot,
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

    it('resolves the repo skills directory from SKILLS_DIR first', () => {
        expect(skillsRoot({ SKILLS_DIR: root })).toBe(root);
        expect(skillsRoot({}, join(root, 'alpha'))).toBe(join(root, 'alpha', 'skills'));
    });

    it('finds the vendored Notion skills in this repo', () => {
        const repoRoot = skillsRoot({}, join(import.meta.dirname, '..'));
        expect(availableSkills(repoRoot)).toContain('notion-research-documentation');
    });
});
