/**
 * The MCP server an agent session talks to.
 *
 * Every suite used to assume the Apify MCP server narrowed per item with
 * `?tools=`. A suite profile can now name any server (`mcp` in
 * profiles/<suite>.yaml, stamped on each dataset item by the sync), e.g. the
 * Notion MCP server over stdio. This module turns that spec plus the item's
 * tool list into what the harness needs: the Claude Code `--mcp-config`
 * document, the `--allowedTools` patterns, the secrets to redact, and a
 * tools/list client for preflight and schema snapshots.
 *
 * Secrets never live on dataset items: header and env values hold `${VAR}`
 * placeholders that are filled from the runner's environment here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@apify-evals/contract';

export interface ToolSchema {
    name: string;
    inputSchema: unknown;
}

export interface ResolvedMcp {
    name: string;
    spec: McpServerSpec;
    /** The item's tool list as it reached the harness (`['*']` = all). */
    tools: string[];
    /** `--allowedTools` entries that pre-approve the server's tools. */
    allowedTools: string[];
    /** Resolved secret values, for log redaction. */
    secrets: string[];
    /** Stable identity of this server + tool config, for snapshot dedup. */
    key: string;
}

export const ALL_TOOLS = '*';
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;

/** THE per-item Apify tool config URL. The agent's MCP config and the schema
 * snapshot must be built from the same URL, or the snapshot stops describing
 * what the agent actually saw. */
export function toolsUrl(mcpUrl: string, tools: string[]): string {
    const url = new URL(mcpUrl);
    url.searchParams.set('tools', tools.join(','));
    return url.toString();
}

/** The default server: Apify MCP, bearer token, tools narrowed in the URL. */
export function apifyMcpSpec(mcpUrl: string): McpServerSpec {
    return {
        name: 'apify',
        transport: 'http',
        url: mcpUrl,
        headers: { Authorization: 'Bearer ${APIFY_TOKEN}' },
        toolsQuery: true,
    };
}

function fill(value: string, env: Record<string, string | undefined>, where: string, secrets: Set<string>): string {
    return value.replace(PLACEHOLDER, (_, name: string) => {
        const v = env[name];
        if (!v) throw new Error(`MCP server config ${where} needs ${name}, which is not set in the runner environment`);
        secrets.add(v);
        return v;
    });
}

/**
 * Fill placeholders and derive the harness-facing pieces. Returns null when the
 * item has no tools: no MCP server at all, as before (CLI / SDK suites).
 */
export function resolveMcp(
    meta: { tools?: string[]; mcp?: McpServerSpec },
    opts: { mcpUrl: string; env: Record<string, string | undefined> },
): ResolvedMcp | null {
    const tools = meta.tools ?? [];
    if (tools.length === 0) return null;
    const raw = meta.mcp ?? apifyMcpSpec(opts.mcpUrl);
    const secrets = new Set<string>();
    const spec: McpServerSpec = { ...raw };
    const where = `"${raw.name}"`;
    if (raw.transport === 'http') {
        if (!raw.url) throw new Error(`MCP server ${where}: http transport needs a url`);
        spec.url = raw.toolsQuery ? toolsUrl(raw.url, tools) : raw.url;
        if (raw.headers) {
            spec.headers = Object.fromEntries(
                Object.entries(raw.headers).map(([k, v]) => [k, fill(v, opts.env, where, secrets)]),
            );
        }
    } else {
        if (!raw.command) throw new Error(`MCP server ${where}: stdio transport needs a command`);
        if (raw.env) {
            spec.env = Object.fromEntries(
                Object.entries(raw.env).map(([k, v]) => [k, fill(v, opts.env, where, secrets)]),
            );
        }
    }
    const allTools = raw.toolsQuery || tools.includes(ALL_TOOLS);
    const allowedTools = allTools ? [`mcp__${raw.name}__*`] : tools.map((t) => `mcp__${raw.name}__${t}`);
    // The key must not contain secrets: it names a shared, deduped artifact.
    const key = JSON.stringify({ ...raw, tools: [...tools].sort() });
    return { name: raw.name, spec, tools, allowedTools, secrets: [...secrets], key };
}

/** The `--mcp-config` document for Claude Code. */
export function claudeMcpConfig(mcp: ResolvedMcp): unknown {
    const { spec } = mcp;
    const server =
        spec.transport === 'http'
            ? { type: 'http', url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) }
            : { type: 'stdio', command: spec.command, args: spec.args ?? [], ...(spec.env ? { env: spec.env } : {}) };
    return { mcpServers: { [mcp.name]: server } };
}

/** Which of the server's tools the item lets the agent use; `[]` = every tool. */
export function filterTools(mcp: ResolvedMcp, names: Iterable<string>): string[] {
    const all = mcp.spec.toolsQuery || mcp.tools.includes(ALL_TOOLS);
    const out: string[] = [];
    for (const n of names) if (all || mcp.tools.includes(n)) out.push(n);
    return out;
}

/** tools/list against the server exactly as the agent will see it. A stdio
 * server is spawned for the call and shut down after. */
export async function listTools(mcp: ResolvedMcp, signal?: AbortSignal): Promise<ToolSchema[]> {
    const { spec } = mcp;
    const transport =
        spec.transport === 'http'
            ? new StreamableHTTPClientTransport(new URL(spec.url as string), {
                  requestInit: { headers: spec.headers ?? {}, signal },
              })
            : new StdioClientTransport({
                  command: spec.command as string,
                  args: spec.args ?? [],
                  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(spec.env ?? {}) },
                  stderr: 'ignore',
              });
    const client = new Client({ name: 'workflow-runner', version: '0.3.0' });
    await client.connect(transport, { signal, timeout: 30_000 });
    try {
        const out: ToolSchema[] = [];
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 30_000 });
            for (const t of page.tools) out.push({ name: t.name, inputSchema: t.inputSchema });
            cursor = page.nextCursor;
        } while (cursor);
        return out.sort((a, b) => a.name.localeCompare(b.name));
    } finally {
        await client.close();
    }
}
