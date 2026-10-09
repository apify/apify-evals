/**
 * Online-mode project guard. Langfuse keys are project-scoped, and the judge
 * serves two projects on one instance: dataset runs live in "MCP Agent Evals",
 * production apify-ai traces in "Apify AI Agent". The Actor's env keys point at
 * the first (the workflow runner starts the judge without keys), so an online
 * run that falls back to them would select from, and write scores and the
 * rollup into, the wrong project without any error. `assertOnlineProject()`
 * runs before any other Langfuse call and fails the run instead.
 *
 * Pure apart from the injected fetcher; `langfuseProjectFetcher()` is the
 * production adapter.
 */

/** The project production apify-ai traces are exported to. A name rather than
 * an id: it is what the person filling in a Task sees in the Langfuse UI, and
 * it differs from the dataset-run project's name, which is the mix-up to catch.
 * An id is accepted too, for a check that survives a rename. */
export const DEFAULT_ONLINE_PROJECT = 'Apify AI Agent';

export interface LangfuseProject {
    id: string;
    name: string;
}

/** `GET /api/public/projects`: with project keys it returns exactly the keys' project. */
export type ProjectFetcher = () => Promise<LangfuseProject[]>;

/** Resolve the project of the configured keys and return it when its id or name equals `expected`; throw otherwise. */
export async function assertOnlineProject(fetchProjects: ProjectFetcher, expected: string): Promise<LangfuseProject> {
    const want = expected.trim();
    if (!want) throw new Error('langfuseProject is empty: set the expected Langfuse project name or id');
    const found = await fetchProjects();
    if (found.length !== 1) {
        const what = found.length === 0 ? 'no project' : `${found.length} projects`;
        throw new Error(`The Langfuse keys resolve to ${what}; expected one project-scoped key pair for "${want}"`);
    }
    const [project] = found;
    if (project.id !== want && project.name !== want) {
        throw new Error(
            `The Langfuse keys belong to project "${project.name}" (${project.id}), expected "${want}". ` +
                "Online mode reads and scores production traces; pass that project's keys as the " +
                'langfusePublicKey and langfuseSecretKey inputs (the Actor env keys are the dataset-run project).',
        );
    }
    return project;
}

interface ProjectsApi {
    api: { projects: { get(): Promise<unknown> } };
}

export function langfuseProjectFetcher(langfuse: ProjectsApi): ProjectFetcher {
    return async () => {
        const res = (await langfuse.api.projects.get()) as { data?: LangfuseProject[] };
        return (res.data ?? []).map(({ id, name }) => ({ id, name }));
    };
}
