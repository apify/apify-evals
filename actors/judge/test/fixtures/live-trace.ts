import type { TraceObservation } from '../../src/online-turn.js';

/**
 * Real observation rows, re-fetched from staging Langfuse on 2026-09-09
 * (project "Apify AI Agent", exporter `@mastra/otel-exporter` 1.3.9) with
 * `GET /api/public/v2/observations?traceId=...&fields=core,basic,io,metadata,model`.
 * Every field name, every metadata key and the full nesting of the payloads are
 * as the endpoint returned them, so a change in what the exporter writes shows
 * up here as a failing test rather than as a wrong score in production.
 *
 * What is NOT verbatim, and only this:
 *
 * - Four long text parts of the GENERATION inputs are cut at a
 *   `[... trimmed for the fixture ...]` marker, and what precedes the marker is
 *   the live prefix character for character: the sonnet turn's two system
 *   prompts (live 4189 and 2087 characters) and both parts of the haiku
 *   title/compaction prompt (live 497 and 578). The user message and both
 *   `output` strings are untouched.
 * - The TOOL result keeps all five top-level keys and the first of its five
 *   actor objects in full, with the other four replaced by one marker string in
 *   the `actors` array, so `count` reads 5 while `actors` holds one object plus
 *   the marker (live: 9441 characters of JSON, five actors of 13 fields each).
 * - Nothing else is dropped. In particular the eight non-`attributes.*` metadata
 *   keys the endpoint returns on every row (`callerOrigin`, `scope.*`,
 *   `resourceAttributes.*`) are kept as they arrive, in the order they arrive.
 *
 * The trace has four observations: the root AGENT span, the turn's sonnet
 * GENERATION, its one TOOL call, and Memory's haiku GENERATION for the thread
 * title, which carries an empty `sessionId` and must never be judged.
 */
export const LIVE_TRACE_ID = '98ee3c06f85a1f49bdeb20d68a7d8da7';

/** The user message of the live turn, verbatim. */
export const LIVE_PROMPT =
    'Use the search-actors tool once to find an Apify Actor that scrapes Google Maps reviews, then answer in one sentence naming it.';

/** The assistant text of the live turn, verbatim. */
export const LIVE_FINAL_TEXT =
    'The best Actor for scraping Google Maps reviews is **Google Maps Reviews Scraper** by Compass (`compass/Google-Maps-Reviews-Scraper`), given its huge user base (55K+ users) and top rating (4.85★).';

/** The title Memory's haiku generation produced: what a wrong generation pick would report as the answer. */
export const LIVE_TITLE = 'Google Maps Reviews Scraper by Compass';

export const liveTraceObservations: TraceObservation[] = [
    {
        id: '68b017dfbba069e1',
        type: 'AGENT',
        name: 'invoke_agent Apify AI Agent',
        startTime: '2026-09-07T14:11:56.460Z',
        parentObservationId: null,
        sessionId: 'verify-23a-staging-1788790315',
        level: 'DEFAULT',
        statusMessage: '',
        model: '',
        input: null,
        output: null,
        metadata: {
            callerOrigin: '/verify-23a',
            'scope.version': '1.3.9',
            'scope.name': '@mastra/otel-exporter',
            'resourceAttributes.telemetry.sdk.language': 'nodejs',
            'resourceAttributes.telemetry.sdk.version': '1.3.9',
            'resourceAttributes.telemetry.sdk.name': '@mastra/otel-exporter',
            'resourceAttributes.service.version': '1.61.0',
            'resourceAttributes.service.name': 'apify-ai-agent',
            'attributes.langfuse.trace.tags': ['user'],
            'attributes.langfuse.user.id': '3HrEAI1deXup5QSmp',
            'attributes.langfuse.session.id': 'verify-23a-staging-1788790315',
            'attributes.langfuse.release': '82798ceaf9',
            'attributes.langfuse.environment': 'staging',
            'attributes.mastra.tags': ['user'],
            'attributes.mastra.metadata.resourceId': '3HrEAI1deXup5QSmp',
            'attributes.mastra.metadata.runId': '4cc6c776-650f-4790-bdd0-40e362c04bb8',
            'attributes.mastra.metadata.callerOrigin': '/verify-23a',
            'attributes.mastra.metadata.userId': '3HrEAI1deXup5QSmp',
            'attributes.mastra.metadata.threadId': 'verify-23a-staging-1788790315',
            'attributes.gen_ai.tool.definitions': [
                'apify-ai_search-actors',
                'apify-ai_fetch-actor-details',
                'apify-ai_call-actor',
                'apify-ai_get-actor-run',
                'apify-ai_get-dataset-items',
                'apify-ai_get-key-value-store-record',
                'apify-ai_abort-actor-run',
                'apify-ai_search-apify-docs',
                'apify-ai_fetch-apify-docs',
                'apify-ai_report-problem',
                'apify-ai_apify--rag-web-browser',
                'apify-ai_apify--web-fetch',
                'updateWorkingMemory',
                'mastra_workspace_read_file',
                'mastra_workspace_write_file',
                'mastra_workspace_edit_file',
                'mastra_workspace_list_files',
                'mastra_workspace_delete',
                'mastra_workspace_file_stat',
                'mastra_workspace_mkdir',
                'mastra_workspace_grep',
                'mastra_workspace_execute_command',
                'mastra_workspace_lsp_inspect',
            ],
            'attributes.gen_ai.conversation.id': 'verify-23a-staging-1788790315',
            'attributes.gen_ai.agent.name': 'Apify AI Agent',
            'attributes.gen_ai.agent.id': 'apifyAiAgent',
            'attributes.mastra.agent_run.output': {
                text: 'The best Actor for scraping Google Maps reviews is **Google Maps Reviews Scraper** by Compass (`compass/Google-Maps-Reviews-Scraper`), given its huge user base (55K+ users) and top rating (4.85★).',
                files: [],
            },
            'attributes.mastra.agent_run.input': [
                {
                    role: 'user',
                    content:
                        'Use the search-actors tool once to find an Apify Actor that scrapes Google Maps reviews, then answer in one sentence naming it.',
                },
            ],
            'attributes.mastra.span.type': 'agent_run',
            'attributes.gen_ai.operation.name': 'invoke_agent',
        },
    },
    {
        id: '3b7c8647974abea2',
        type: 'GENERATION',
        name: 'chat us.anthropic.claude-sonnet-5',
        startTime: '2026-09-07T14:11:56.532Z',
        parentObservationId: '68b017dfbba069e1',
        sessionId: 'verify-23a-staging-1788790315',
        level: 'DEFAULT',
        statusMessage: '',
        model: 'us.anthropic.claude-sonnet-5',
        input: '[{"role":"system","parts":[{"type":"text","content":"# Apify Assistant\\n\\nYou are a helpful Apify assistant with tools called **Actors**.\\n\\nYour g [... trimmed for the fixture ...]"}]},{"role":"system","parts":[{"type":"text","content":"WORKING_MEMORY_SYSTEM_INSTRUCTION:\\nStore and update any conversation-relevant information  [... trimmed for the fixture ...]"}]},{"role":"user","parts":[{"type":"text","content":"Use the search-actors tool once to find an Apify Actor that scrapes Google Maps reviews, then answer in one sentence naming it."}]}]',
        output: '[{"role":"assistant","parts":[{"type":"text","content":"The best Actor for scraping Google Maps reviews is **Google Maps Reviews Scraper** by Compass (`compass/Google-Maps-Reviews-Scraper`), given its huge user base (55K+ users) and top rating (4.85★)."}]}]',
        metadata: {
            callerOrigin: '/verify-23a',
            'scope.version': '1.3.9',
            'scope.name': '@mastra/otel-exporter',
            'resourceAttributes.telemetry.sdk.language': 'nodejs',
            'resourceAttributes.telemetry.sdk.version': '1.3.9',
            'resourceAttributes.telemetry.sdk.name': '@mastra/otel-exporter',
            'resourceAttributes.service.version': '1.61.0',
            'resourceAttributes.service.name': 'apify-ai-agent',
            'attributes.langfuse.user.id': '3HrEAI1deXup5QSmp',
            'attributes.langfuse.session.id': 'verify-23a-staging-1788790315',
            'attributes.langfuse.release': '82798ceaf9',
            'attributes.langfuse.environment': 'staging',
            'attributes.mastra.metadata.resourceId': '3HrEAI1deXup5QSmp',
            'attributes.mastra.metadata.runId': '4cc6c776-650f-4790-bdd0-40e362c04bb8',
            'attributes.mastra.metadata.callerOrigin': '/verify-23a',
            'attributes.mastra.metadata.userId': '3HrEAI1deXup5QSmp',
            'attributes.mastra.metadata.threadId': 'verify-23a-staging-1788790315',
            'attributes.gen_ai.conversation.id': 'verify-23a-staging-1788790315',
            'attributes.gen_ai.response.id': '8f2642aa-4fa5-4aec-bdeb-3b1c5d018d20',
            'attributes.gen_ai.response.model': 'us.anthropic.claude-sonnet-5',
            'attributes.gen_ai.response.finish_reasons': ['stop'],
            'attributes.mastra.completion_start_time': '2026-09-07T14:11:58.877Z',
            'attributes.gen_ai.agent.name': 'Apify AI Agent',
            'attributes.gen_ai.agent.id': 'apifyAiAgent',
            'attributes.gen_ai.usage.cache_creation.input_tokens': 17657,
            'attributes.gen_ai.usage.cache_read.input_tokens': 17657,
            'attributes.gen_ai.usage.output_tokens': 148,
            'attributes.gen_ai.usage.input_tokens': 40192,
            'attributes.gen_ai.provider.name': 'aws.bedrock',
            'attributes.gen_ai.request.model': 'us.anthropic.claude-sonnet-5',
            'attributes.mastra.span.type': 'model_generation',
            'attributes.gen_ai.operation.name': 'chat',
        },
    },
    {
        id: '6f10b5aeb816f8fe',
        type: 'TOOL',
        name: 'apify-ai_search-actors',
        startTime: '2026-09-07T14:11:58.890Z',
        parentObservationId: '3b7c8647974abea2',
        sessionId: 'verify-23a-staging-1788790315',
        level: 'DEFAULT',
        statusMessage: '',
        model: '',
        input: '{"keywords":"Google Maps reviews"}',
        output: '{"actors":[{"title":"Google Maps Reviews Scraper","url":"https://apify.com/compass/Google-Maps-Reviews-Scraper","id":"Xb8osYTtOjlsgI6k9","fullName":"compass/Google-Maps-Reviews-Scraper","pictureUrl":"https://images.apifyusercontent.com/UH3iYjKerv4UxQLJXw8CKXWlmfOI3biiZMLIAdR4ZHs/rs:fill:76:76/cb:1/aHR0cHM6Ly9hcGlmeS1pbWFnZS11cGxvYWRzLXByb2QuczMuYW1hem9uYXdzLmNvbS9YYjhvc1lUdE9qbHNnSTZrOS9mNkwzdm1LaGd6aXVZYXljZi1Hb29nbGVfTWFwc19SZXZpZXdzX1NjcmFwZXIucG5n.webp","developer":{"username":"compass","isOfficialApify":true,"url":"https://apify.com/compass"},"description":"Extract all reviews of Google Maps places using place URLs. Get review text, published date, response from owner, review URL, and reviewer\'s details. Download scraped data, run the scraper via API, schedule and monitor runs or integrate with other tools.","categories":["Travel"],"pricing":{"model":"PAY_PER_EVENT","events":[{"title":"Scraped review","description":"Cost per individual review scraped.","priceUsd":0.0006},{"title":"Actor Start","description":"Charged when the Actor starts running. Number of events charged depends on Actor memory (one event per GB, minimum one event).","priceUsd":5e-05}],"pricingNote":"Prices shown are for FREE tier. Higher tiers may offer lower prices — use fetch-actor-details to see the full pricing table."},"stats":{"totalUsers":55244,"monthlyUsers":6500,"bookmarks":750},"rating":{"average":4.85,"count":198},"isDeprecated":false,"inputFields":{"type":"object","properties":{"startUrls":{"type":"array"},"placeIds":{"type":"array"},"maxReviews":{"type":"integer"},"reviewsSort":{"type":"string"},"reviewsStartDate":{"type":"string"},"reviewsFilterString":{"type":"string"},"language":{"type":"string"},"reviewsOrigin":{"type":"string"},"personalData":{"type":"boolean"}}}},"[... 4 more actors trimmed for the fixture ...]"],"query":"Google Maps reviews","count":5,"userTier":"FREE","instructions":"If you need more detailed information about any of these Actors, including their input\\nschemas and usage instructions, use the fetch-actor-details tool with the\\nspecific Actor name.\\nIMPORTANT: You MUST always do a second search with broader, more generic keywords\\n(e.g., just the platform name like \\"TikTok\\" instead of \\"TikTok posts\\") to make sure\\nyou haven\'t missed a better Actor."}',
        metadata: {
            callerOrigin: '/verify-23a',
            'scope.version': '1.3.9',
            'scope.name': '@mastra/otel-exporter',
            'resourceAttributes.telemetry.sdk.language': 'nodejs',
            'resourceAttributes.telemetry.sdk.version': '1.3.9',
            'resourceAttributes.telemetry.sdk.name': '@mastra/otel-exporter',
            'resourceAttributes.service.version': '1.61.0',
            'resourceAttributes.service.name': 'apify-ai-agent',
            'attributes.langfuse.user.id': '3HrEAI1deXup5QSmp',
            'attributes.langfuse.session.id': 'verify-23a-staging-1788790315',
            'attributes.langfuse.release': '82798ceaf9',
            'attributes.langfuse.environment': 'staging',
            'attributes.mastra.metadata.resourceId': '3HrEAI1deXup5QSmp',
            'attributes.mastra.metadata.runId': '4cc6c776-650f-4790-bdd0-40e362c04bb8',
            'attributes.mastra.metadata.callerOrigin': '/verify-23a',
            'attributes.mastra.metadata.userId': '3HrEAI1deXup5QSmp',
            'attributes.mastra.metadata.threadId': 'verify-23a-staging-1788790315',
            'attributes.gen_ai.conversation.id': 'verify-23a-staging-1788790315',
            'attributes.server.address': 'apify-ai',
            'attributes.gen_ai.tool.call.id': 'tooluse_zdCncYypAAoOJpXKvbeZa7',
            'attributes.gen_ai.tool.name': 'apify-ai_search-actors',
            'attributes.mastra.span.type': 'mcp_tool_call',
            'attributes.gen_ai.operation.name': 'execute_tool',
        },
    },
    {
        id: '54515107f579acc9',
        type: 'GENERATION',
        name: 'chat us.anthropic.claude-haiku-4-5-20251001-v1:0',
        startTime: '2026-09-07T14:12:01.957Z',
        parentObservationId: '68b017dfbba069e1',
        sessionId: '',
        level: 'DEFAULT',
        statusMessage: '',
        model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        input: '[{"role":"system","parts":[{"type":"text","content":"Write a title for this conversation, taken from the user\'s request.\\n\\n- The input is a transcript, its lines prefixed with \\"User:\\" and \\"Assistant:\\".\\n- Output the title and nothing else — no preamble, n [... trimmed for the fixture ...]"}]},{"role":"user","parts":[{"type":"text","content":"User: Use the search-actors tool once to find an Apify Actor that scrapes Google Maps reviews, then answer in one sentence naming it.\\nTool Result apify-ai_search-actors: {\\"actors\\":[{\\"title\\":\\"Google Ma [... trimmed for the fixture ...]"}]}]',
        output: '[{"role":"assistant","parts":[{"type":"text","content":"Google Maps Reviews Scraper by Compass"}]}]',
        metadata: {
            callerOrigin: '/verify-23a',
            'scope.version': '1.3.9',
            'scope.name': '@mastra/otel-exporter',
            'resourceAttributes.telemetry.sdk.language': 'nodejs',
            'resourceAttributes.telemetry.sdk.version': '1.3.9',
            'resourceAttributes.telemetry.sdk.name': '@mastra/otel-exporter',
            'resourceAttributes.service.version': '1.61.0',
            'resourceAttributes.service.name': 'apify-ai-agent',
            'attributes.langfuse.user.id': '3HrEAI1deXup5QSmp',
            'attributes.langfuse.release': '82798ceaf9',
            'attributes.langfuse.environment': 'staging',
            'attributes.mastra.metadata.callerOrigin': '/verify-23a',
            'attributes.mastra.metadata.userId': '3HrEAI1deXup5QSmp',
            'attributes.gen_ai.response.id': 'af592a66-0a6f-434e-8171-bdf9a1511973',
            'attributes.gen_ai.response.model': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
            'attributes.gen_ai.response.finish_reasons': ['stop'],
            'attributes.mastra.completion_start_time': '2026-09-07T14:12:02.816Z',
            'attributes.gen_ai.agent.name': 'Apify AI Agent',
            'attributes.gen_ai.agent.id': 'apifyAiAgent',
            'attributes.gen_ai.usage.cache_creation.input_tokens': 0,
            'attributes.gen_ai.usage.cache_read.input_tokens': 0,
            'attributes.gen_ai.usage.output_tokens': 12,
            'attributes.gen_ai.usage.input_tokens': 307,
            'attributes.gen_ai.provider.name': 'aws.bedrock',
            'attributes.gen_ai.request.model': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
            'attributes.mastra.span.type': 'model_generation',
            'attributes.gen_ai.operation.name': 'chat',
        },
    },
];

/**
 * A real failed tool call (`level: 'ERROR'`, empty `statusMessage`) whose
 * `output` is the serialised MastraError the agent's MCP wrapper throws,
 * re-fetched on 2026-09-09 from trace `b536ce2dd11bb13306d57cc5189c179e`. From
 * an older local eval run through the Langfuse SDK, so its metadata bag has no
 * `gen_ai.tool.*` keys: that also pins the observation-name and observation-id
 * fallbacks.
 *
 * Not verbatim, and only this: `cause.message` (live 27136 characters) and
 * `details.errorMessage` (live 29564 characters) are cut at the marker, and the
 * `resourceAttributes.process.*` and `resourceAttributes.host.*` metadata
 * families are dropped because they describe the laptop that ran the eval
 * (paths, pid, host id) and say nothing about the export shape. The remaining
 * six non-`attributes.*` keys are kept.
 */
export const liveErrorToolObservation: TraceObservation = {
    id: '213c7831fdb4b795',
    type: 'TOOL',
    name: 'call-actor',
    startTime: '2026-08-27T10:34:37.735Z',
    parentObservationId: '6f697c64728b2f42',
    sessionId: '',
    level: 'ERROR',
    statusMessage: '',
    model: '',
    input: '{"actor":"compass/crawler-google-places","input":{"searchStringsArray":["best restaurants in Prague"],"maxCrawledPlacesPerSearch":20,"language":"en","placeMinimumStars":"4"},"waitSecs":45}',
    output: '{"name":"Error","cause":{"message":"Input validation failed for Actor \'compass/crawler-google-places\'. Please ensure your input matches the Actor\'s input schema.\\nInput schema:\\n```json\\n{\\" [... trimmed for the fixture ...]","domain":"MCP","category":"THIRD_PARTY","code":"MCP_CLIENT_TOOL_EXECUTION_FAILED","details":{"toolName":"call-actor","serverName":"apify"}},"id":"TOOL_EXECUTION_FAILED","domain":"TOOL","category":"USER","details":{"errorMessage":"[... trimmed for the fixture ...]","argsJson":"{\\"actor\\":\\"compass/crawler-google-places\\",\\"input\\":{\\"searchStringsArray\\":[\\"best restaurants in Prague\\"],\\"maxCrawledPlacesPerSearch\\":20,\\"language\\":\\"en\\",\\"placeMinimumStars\\":\\"4\\"},\\"waitSecs\\":45}","model":"global.anthropic.claude-sonnet-4-6"}}',
    metadata: {
        isMcpTool: true,
        'scope.version': '5.10.1',
        'scope.name': 'langfuse-sdk',
        'resourceAttributes.telemetry.sdk.version': '2.9.0',
        'resourceAttributes.telemetry.sdk.name': 'opentelemetry',
        'resourceAttributes.telemetry.sdk.language': 'nodejs',
        'resourceAttributes.service.name': 'unknown_service:node',
    },
};
