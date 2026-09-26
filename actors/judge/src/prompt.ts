import { log } from 'apify';

/** The slice of LangfuseClient the resolver needs; a fake in tests. */
export interface PromptApi {
    prompt: {
        get(name: string, options: { label: string; type: 'text' }): Promise<{ version: number; prompt: unknown }>;
        create(body: {
            name: string;
            type: 'text';
            prompt: string;
            labels: string[];
        }): Promise<{ version: number; prompt: unknown }>;
    };
}

export interface ResolvedPrompt {
    version: number;
    template: string;
}

function isNotFound(err: unknown): boolean {
    return (
        (err as { statusCode?: number })?.statusCode === 404 || /not found/i.test(String((err as Error)?.message ?? ''))
    );
}

/**
 * Resolve a judge prompt by label ONCE per batch and stamp that exact version
 * into every score: never judge mid-batch off a mutable label. Seeds the
 * default ONLY on not-found; any other failure (network, auth) must not create
 * a surprise new labelled prompt version. Shared by the datasetRun
 * (`workflow-judge`) and online (`apify-ai-online-judge`) modes.
 */
export async function resolveOrSeedPrompt(
    langfuse: PromptApi,
    { name, label, defaultPrompt }: { name: string; label: string; defaultPrompt: string },
): Promise<ResolvedPrompt> {
    try {
        const existing = await langfuse.prompt.get(name, { label, type: 'text' });
        return { version: existing.version, template: existing.prompt as string };
    } catch (err) {
        if (!isNotFound(err)) throw err;
        log.info(`Judge prompt "${name}" not found, seeding the default`);
        const created = await langfuse.prompt.create({ name, type: 'text', prompt: defaultPrompt, labels: [label] });
        return { version: created.version, template: created.prompt as string };
    }
}
