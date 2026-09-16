import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadProfile } from '../src/profiles.js';
import { lintPrompt, loadSuite } from '../src/scenario-format.js';

const root = join(import.meta.dirname, '..', '..');

describe('store-actors scenario files', () => {
    const suite = loadSuite(root, 'store-actors');

    it('load without errors', () => {
        const errors = suite.problems.filter((p) => !p.includes(': warning: '));
        expect(errors).toEqual([]);
        expect(suite.items.length).toBeGreaterThanOrEqual(18);
    });

    it('keep the original Langfuse item ids so history stays attached', () => {
        const ids = suite.items.map((i) => i.id);
        expect(ids).toContain('instagram-scraper-discovery-nasa-posts');
        expect(ids).toContain('crawler-google-places-usage-prague-coffee');
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('derive tools, maxTurns, identity and the discovery trailer from the profile', () => {
        const find = suite.items.find((i) => i.id === 'tripadvisor-discovery-barcelona-attractions')!;
        expect(find.metadata.skill).toBe('find');
        expect(find.metadata.tools).toContain('search-actors');
        expect(find.metadata.maxTurns).toBe(14);
        expect(find.input.prompt).toMatch(/Actor: <username\/name of the Apify Actor you used>$/);
        expect(find.metadata.subject).toEqual({ kind: 'actor', id: 'maxcopell/tripadvisor' });
        expect(find.metadata.owner).toBe('google');
        expect(find.metadata.actor).toBe('maxcopell/tripadvisor');
        expect(find.metadata.category).toBe('tripadvisor');

        const use = suite.items.find((i) => i.id === 'tripadvisor-usage-rome-restaurants')!;
        expect(use.metadata.tools).not.toContain('search-actors');
        expect(use.metadata.maxTurns).toBe(12);
        expect(use.input.prompt).not.toMatch(/Actor: </);
    });

    it('respect appendSuffix: false and per-scenario maxTurns', () => {
        const ig = suite.items.find((i) => i.id === 'instagram-scraper-discovery-nasa-posts')!;
        expect(ig.input.prompt).toMatch(/Posts: <number of posts you retrieved>$/);
        const eng = suite.items.find((i) => i.id === 'instagram-scraper-usage-engagement-nasa')!;
        expect(eng.metadata.maxTurns).toBe(16);
    });

    it('give every check an id', () => {
        for (const item of suite.items) {
            for (const c of item.metadata.checks ?? []) expect((c as { id?: string }).id).toBeTruthy();
        }
    });
});

describe('profiles', () => {
    it('load every stub profile', () => {
        for (const name of ['store-actors', 'mcp-tools', 'cli-tasks', 'sdk-tasks', 'apify-ai']) {
            const p = loadProfile(root, name);
            expect(p.fixAreas.some((f) => f.id === 'agent-or-model')).toBe(true);
        }
    });
});

describe('lintPrompt', () => {
    it('flags unbounded and time-anchored prompts', () => {
        expect(lintPrompt('Get all posts from the page today')).toHaveLength(3);
        expect(lintPrompt('Get the 5 most recent posts in the last month')).toEqual([]);
    });
});
