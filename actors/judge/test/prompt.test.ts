import { describe, expect, it } from 'vitest';

import { type PromptApi, resolveOrSeedPrompt } from '../src/prompt.js';

function fakeLangfuse(getResult: () => Promise<{ version: number; prompt: unknown }>) {
    const created: unknown[] = [];
    const langfuse: PromptApi = {
        prompt: {
            get: getResult,
            create: async (body) => {
                created.push(body);
                return { version: 1, prompt: body.prompt };
            },
        },
    };
    return { langfuse, created };
}

const args = { name: 'apify-ai-online-judge', label: 'production', defaultPrompt: 'DEFAULT {{turn}}' };

describe('resolveOrSeedPrompt', () => {
    it('returns the labelled version when it exists and creates nothing', async () => {
        const { langfuse, created } = fakeLangfuse(async () => ({ version: 7, prompt: 'EDITED {{turn}}' }));
        expect(await resolveOrSeedPrompt(langfuse, args)).toEqual({ version: 7, template: 'EDITED {{turn}}' });
        expect(created).toEqual([]);
    });

    it('seeds the default under the label on a 404 or a not-found message', async () => {
        for (const err of [Object.assign(new Error('boom'), { statusCode: 404 }), new Error('Prompt not found')]) {
            const { langfuse, created } = fakeLangfuse(async () => {
                throw err;
            });
            expect(await resolveOrSeedPrompt(langfuse, args)).toEqual({ version: 1, template: 'DEFAULT {{turn}}' });
            expect(created).toEqual([
                { name: 'apify-ai-online-judge', type: 'text', prompt: 'DEFAULT {{turn}}', labels: ['production'] },
            ]);
        }
    });

    it('rethrows any other failure without creating a prompt version', async () => {
        const { langfuse, created } = fakeLangfuse(async () => {
            throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
        });
        await expect(resolveOrSeedPrompt(langfuse, args)).rejects.toThrow('unauthorized');
        expect(created).toEqual([]);
    });
});
