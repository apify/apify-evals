/**
 * Apify surfaces: the ways an agent can reach the platform.
 *
 * A run configures one surface per session (`surfaces/<name>.yaml`), but the
 * agent is not blocked from the others: Bash can still `curl` the API in a CLI
 * session. These pure helpers classify each tool call, so the evidence records
 * which surfaces the agent actually used and a `surface.used` check can flag a
 * fallback. The runner and the judge share them.
 */

/**
 * `mcp`: the Apify MCP server as the agent's own MCP tools. `cli`: shell
 * commands, the `apify` CLI and `mcpc` (the MCP CLI client, which reaches the
 * MCP server from Bash). `api`: raw HTTP to api.apify.com.
 */
export const SURFACE_KINDS = ['mcp', 'cli', 'api'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

/** The Apify MCP server's name in the session config (see the runner's mcp.ts). */
const APIFY_MCP_PREFIX = 'mcp__apify__';

// `apify <subcommand>` at a command boundary, also through npx. A preceding
// `.` or `/` (api.apify.com, ~/.apify) does not count.
const CLI_RE = /(?:^|[\s;&|(`$])(?:npx\s+(?:-y\s+)?)?apify(?:-cli)?\s+-{0,2}[a-z]/;
const API_RE = /\bapi\.apify\.com\b/;
const MCPC_RE = /(?:^|[\s;&|(`$])(?:npx\s+(?:-y\s+)?(?:@apify\/)?)?mcpc\s+\S/;

function bashCommand(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
        return (input as { command: string }).command;
    }
    return '';
}

/** The Apify surfaces one tool call used; [] for anything else (Read, docs, other MCP servers). */
export function surfacesOfCall(tool: string, input: unknown): SurfaceKind[] {
    if (tool.startsWith(APIFY_MCP_PREFIX)) return ['mcp'];
    if (tool === 'Bash') {
        const command = bashCommand(input);
        const out: SurfaceKind[] = [];
        if (CLI_RE.test(command) || MCPC_RE.test(command)) out.push('cli');
        if (API_RE.test(command)) out.push('api');
        return out;
    }
    if (tool === 'WebFetch') {
        const url = input && typeof input === 'object' ? (input as { url?: unknown }).url : null;
        return typeof url === 'string' && API_RE.test(url) ? ['api'] : [];
    }
    return [];
}

/** Every Apify surface the session used, in SURFACE_KINDS order. */
export function surfacesUsed(calls: { tool: string; input: unknown }[]): SurfaceKind[] {
    const used = new Set(calls.flatMap((c) => surfacesOfCall(c.tool, c.input)));
    return SURFACE_KINDS.filter((k) => used.has(k));
}

/** Whether a scenario applies to a surface: its `surfaces` list names the surface or its kind. */
export function surfaceApplies(itemSurfaces: unknown, surface: { name: string; kind: string }): boolean {
    if (!Array.isArray(itemSurfaces) || itemSurfaces.length === 0) return true;
    return itemSurfaces.some((s) => s === surface.name || s === surface.kind);
}
