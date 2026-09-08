import { createHash } from 'node:crypto';

import { Ajv } from 'ajv';

import type { OnlineTurn, TurnToolCall } from './online-turn.js';

/**
 * Deterministic `argumentCorrectness` (ai-team#269): every tool call's
 * arguments validated against the tool's declared input schema, no LLM.
 *
 * A production trace carries only `toolSchemaHash`, the agent's fingerprint of
 * the MCP toolset it ran against, not the schemas. The schemas come from a
 * `ToolSchemaSource`; the production one asks the Apify MCP server for its
 * tool list and recomputes the fingerprint with the agent's algorithm. When
 * the two hashes agree the verdict is reproducible (`schemaMatch: true`); when
 * they do not, the calls are still validated against the live schemas and the
 * mismatch is reported so the score comment can say so.
 *
 * Tool-key mapping. The agent's keys are Mastra-namespaced: `@mastra/mcp`
 * registers each server tool as `${serverName}_${tool.name}` and the agent
 * names its one server `apify-ai` (apify-ai-agent `token-toolsets.ts`,
 * `MCP_CLIENT_NAME`), so `search-actors` on the wire is `apify-ai_search-actors`
 * in the toolset, in the model's tool calls, and in the hash. The description
 * is `tool.description || ''` and the input schema is the raw JSON Schema the
 * server sent (`convertInputSchema` returns it unchanged unless wrapped in a
 * `jsonSchema` key, which the MCP SDK never does). Schemas are looked up by
 * that namespaced key; a call whose name lacks the prefix is looked up by bare
 * name as a fallback.
 */

/** The agent's MCP server name, and so the prefix of every tool key it hashes and calls. */
export const AGENT_MCP_SERVER_NAME = 'apify-ai';

/** Depth at which the agent's stableStringify stops (apify-ai-agent `MAX_SCHEMA_DEPTH`). */
const MAX_SCHEMA_DEPTH = 8;

export interface ToolSchema {
    /** Mastra-namespaced key, e.g. `apify-ai_search-actors`. */
    key: string;
    description: string;
    inputSchema: unknown;
}

export interface ToolSchemaSet {
    /** Fingerprint over `tools`, in the agent's format (`sha256:<hex>`). */
    hash: string;
    tools: ToolSchema[];
}

export interface ToolSchemaSource {
    load(): Promise<ToolSchemaSet>;
}

/** Code-unit order, as the agent's `(a < b ? -1 : a > b ? 1 : 0)` comparator; not localeCompare. */
function compareKeys(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/** Port of apify-ai-agent `trace-contract.ts` stableStringify: sorted keys, functions and symbols dropped, depth-capped. */
export function stableStringify(value: unknown, depth = 0): string {
    if (value === null || typeof value !== 'object') {
        const primitive = typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
        return JSON.stringify(primitive) ?? 'null';
    }
    if (depth >= MAX_SCHEMA_DEPTH) return '"[depth]"';
    if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => typeof item !== 'function' && typeof item !== 'symbol')
        .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, depth + 1)}`).join(',')}}`;
}

/**
 * Port of apify-ai-agent `toolSchemaHash`: sha256 over the stable rendering of
 * `[{ key, description, inputSchema }]` sorted by key. Must stay byte-for-byte
 * equal to the agent's, or `schemaMatch` is false forever; the test pins it
 * against a hash produced by the agent's own function.
 */
export function toolSchemaHash(tools: Record<string, { description?: unknown; inputSchema?: unknown } | null>): string {
    const shape = Object.keys(tools)
        .sort()
        .map((key) => ({ key, description: tools[key]?.description, inputSchema: tools[key]?.inputSchema }));
    return `sha256:${createHash('sha256').update(stableStringify(shape)).digest('hex')}`;
}

/** The namespaced key the agent uses for an MCP tool name. */
export function agentToolKey(mcpToolName: string): string {
    return `${AGENT_MCP_SERVER_NAME}_${mcpToolName}`;
}

/** Build the schema set from an MCP `tools/list` result, keyed and hashed the agent's way. */
export function toolSchemaSetFromMcp(
    mcpTools: { name: string; description?: string; inputSchema: unknown }[],
): ToolSchemaSet {
    const tools = mcpTools.map<ToolSchema>((t) => ({
        key: agentToolKey(t.name),
        description: t.description || '',
        inputSchema: t.inputSchema,
    }));
    const hash = toolSchemaHash(
        Object.fromEntries(tools.map((t) => [t.key, { description: t.description, inputSchema: t.inputSchema }])),
    );
    return { hash, tools };
}

export interface CallValidation {
    callId: string;
    name: string;
    observationId: string;
    /** `null` when no schema was found for the tool. */
    valid: boolean | null;
    /** ajv error paths and messages; never the argument values. */
    errors: string[];
}

export interface ArgumentCorrectnessResult {
    /** Omitted (no verdict) when nothing could be validated; `reason` says why. */
    verdict: 'pass' | 'fail' | 'omitted';
    reason?: string;
    /** Whether the recomputed hash equals the trace's; `null` when the trace carries none. */
    schemaMatch: boolean | null;
    liveHash: string;
    validated: CallValidation[];
    /** Called tools with no schema in the set. */
    unvalidatedTools: string[];
}

function findSchema(byKey: Map<string, ToolSchema>, call: TurnToolCall): ToolSchema | undefined {
    return byKey.get(call.name) ?? byKey.get(agentToolKey(call.name));
}

/** ajv error text without the instance data: paths and messages only, so the comment quotes no payload. */
function describeErrors(errors: { instancePath?: string; message?: string }[] | null | undefined): string[] {
    return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim());
}

/**
 * Pure: validate every call of the turn against `schemas`. A tool with no
 * schema is skipped and listed; when every call was skipped, or there were no
 * calls, the criterion is omitted with a reason instead of passing by default.
 */
export function checkArgumentCorrectness(turn: OnlineTurn, schemas: ToolSchemaSet): ArgumentCorrectnessResult {
    const traceHash = turn.metadata.toolSchemaHash;
    const schemaMatch = traceHash ? traceHash === schemas.hash : null;
    const base = { schemaMatch, liveHash: schemas.hash };
    const calls = turn.steps.flatMap((s) => s.calls);
    if (calls.length === 0)
        return {
            ...base,
            verdict: 'omitted',
            reason: 'no tool calls in the turn',
            validated: [],
            unvalidatedTools: [],
        };

    const byKey = new Map(schemas.tools.map((t) => [t.key, t]));
    // Fresh ajv per turn: MCP schemas may carry $ids that a shared instance would reject on re-registration.
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validated: CallValidation[] = [];
    const unvalidatedTools = new Set<string>();
    for (const call of calls) {
        const schema = findSchema(byKey, call);
        const entry = { callId: call.callId, name: call.name, observationId: call.observationId };
        if (!schema || typeof schema.inputSchema !== 'object' || schema.inputSchema === null) {
            unvalidatedTools.add(call.name);
            validated.push({ ...entry, valid: null, errors: [] });
            continue;
        }
        try {
            const validate = ajv.compile(schema.inputSchema as object);
            const valid = validate(call.arguments);
            validated.push({ ...entry, valid, errors: valid ? [] : describeErrors(validate.errors) });
        } catch (err) {
            unvalidatedTools.add(call.name);
            validated.push({ ...entry, valid: null, errors: [`schema did not compile: ${(err as Error).message}`] });
        }
    }

    const checked = validated.filter((v) => v.valid !== null);
    const result = { ...base, validated, unvalidatedTools: [...unvalidatedTools] };
    if (checked.length === 0) {
        return {
            ...result,
            verdict: 'omitted',
            reason: `no schema for the called tool(s): ${[...unvalidatedTools].join(', ')}`,
        };
    }
    return { ...result, verdict: checked.every((v) => v.valid) ? 'pass' : 'fail' };
}

// ---------------------------------------------------------------------------
// Production adapter
// ---------------------------------------------------------------------------

/** Same server, same default toolset the agent connects to (apify-ai-agent `DEFAULT_MCP_URL`, no `?tools=`). */
export const APIFY_MCP_URL = 'https://mcp.apify.com';

/**
 * `tools/list` from the Apify MCP server over streamable HTTP, authenticated
 * with the Actor's own token, once per `load()`. The judge is expected to call
 * it once per batch and reuse the set.
 */
export function mcpToolSchemaSource({ url = APIFY_MCP_URL, token }: { url?: string; token: string }): ToolSchemaSource {
    return {
        async load() {
            const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
                import('@modelcontextprotocol/sdk/client/index.js'),
                import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
            ]);
            const client = new Client({ name: 'apify-evals-judge', version: '0.1.0' });
            const transport = new StreamableHTTPClientTransport(new URL(url), {
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
            });
            try {
                await client.connect(transport);
                const tools: { name: string; description?: string; inputSchema: unknown }[] = [];
                let cursor: string | undefined;
                do {
                    const page = await client.listTools(cursor ? { cursor } : undefined);
                    tools.push(...page.tools);
                    cursor = page.nextCursor;
                } while (cursor);
                return toolSchemaSetFromMcp(tools);
            } finally {
                await client.close().catch(() => undefined);
            }
        },
    };
}
