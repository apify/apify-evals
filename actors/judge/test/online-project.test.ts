import { describe, expect, it } from 'vitest';

import {
    assertOnlineProject,
    DEFAULT_ONLINE_PROJECT,
    type LangfuseProject,
    langfuseProjectFetcher,
} from '../src/online-project.js';

const EVALS: LangfuseProject = { id: 'cmshkde21000krg07shb46d8g', name: 'MCP Agent Evals' };
const AGENT: LangfuseProject = { id: 'cm-agent-project', name: 'Apify AI Agent' };

function projects(...list: LangfuseProject[]) {
    let calls = 0;
    const fetchProjects = async () => {
        calls++;
        return list;
    };
    return { fetchProjects, calls: () => calls };
}

describe('assertOnlineProject', () => {
    it('defaults to the Apify AI Agent project', () => {
        expect(DEFAULT_ONLINE_PROJECT).toBe('Apify AI Agent');
    });

    it('rejects the dataset-run project the Actor env keys point at', async () => {
        const { fetchProjects } = projects(EVALS);
        await expect(assertOnlineProject(fetchProjects, DEFAULT_ONLINE_PROJECT)).rejects.toThrow(
            /"MCP Agent Evals" \(cmshkde21000krg07shb46d8g\).*expected "Apify AI Agent"/,
        );
    });

    it('accepts the expected project by name and returns it', async () => {
        const { fetchProjects, calls } = projects(AGENT);
        await expect(assertOnlineProject(fetchProjects, 'Apify AI Agent')).resolves.toEqual(AGENT);
        expect(calls()).toBe(1);
    });

    it('accepts the expected project by id', async () => {
        const { fetchProjects } = projects(AGENT);
        await expect(assertOnlineProject(fetchProjects, 'cm-agent-project')).resolves.toEqual(AGENT);
    });

    it('fails when the keys resolve to no project', async () => {
        const { fetchProjects } = projects();
        await expect(assertOnlineProject(fetchProjects, DEFAULT_ONLINE_PROJECT)).rejects.toThrow(/no project/);
    });

    it('fails when the keys resolve to more than one project', async () => {
        const { fetchProjects } = projects(AGENT, EVALS);
        await expect(assertOnlineProject(fetchProjects, DEFAULT_ONLINE_PROJECT)).rejects.toThrow(/2 projects/);
    });

    it('fails on an empty expected project instead of accepting any', async () => {
        const { fetchProjects } = projects(AGENT);
        await expect(assertOnlineProject(fetchProjects, ' ')).rejects.toThrow(/langfuseProject/);
    });
});

describe('langfuseProjectFetcher', () => {
    it('reads id and name from GET /api/public/projects', async () => {
        const fetchProjects = langfuseProjectFetcher({
            api: { projects: { get: async () => ({ data: [{ ...AGENT, metadata: {}, retentionDays: null }] }) } },
        });
        expect(await fetchProjects()).toEqual([AGENT]);
    });
});
