/** Items seeded by createDemoDataset when the target dataset does not exist. */
export const DEMO_ITEMS = [
    {
        input: { prompt: 'What is 2+2? Reply with just the number.' },
        expectedOutput: 'The answer is 4, stated plainly.',
        metadata: {
            title: 'Sanity: plain LLM answer with no tools',
            category: 'basic',
            checks: [{ type: 'contains', value: '4' }],
        },
    },
    {
        input: { prompt: 'Use the Bash tool to compute 17*23 and report just the number.' },
        expectedOutput: 'The agent computes 391 with the Bash tool instead of answering from memory.',
        metadata: {
            title: 'Tool use: runs Bash and reports its result',
            category: 'tools',
            allowBash: true,
            checks: [{ type: 'contains', value: '391' }],
        },
    },
    {
        input: {
            prompt: 'Using the Apify tools, search the Apify store for an Instagram scraper and reply with the full name (username/name) of the most popular one.',
        },
        expectedOutput:
            'The agent searches the store and names the most popular Instagram scraper, apify/instagram-scraper.',
        metadata: {
            title: 'MCP: store search finds the flagship Instagram scraper',
            category: 'mcp',
            tools: ['search-actors'],
            maxTurns: 8,
            checks: [{ type: 'contains', value: 'apify/instagram-scraper' }],
        },
    },
];
