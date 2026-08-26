import { sha256 } from '@apify-evals/contract';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Actor, type KeyValueStore } from 'apify';

/**
 * Durable eval artifacts (design decision 8): full session logs and tool-schema
 * snapshots go to a NAMED cloud store, because default run stores expire under
 * platform retention and the judge must re-grade historical traces (#242).
 * Spans carry only URL + content hash pointers.
 */

export const ARTIFACT_STORE_NAME = 'eval-artifacts';

export interface ArtifactRef {
    url: string;
    hash: string;
}

export interface ToolSchema {
    name: string;
    inputSchema: unknown;
}

/** THE per-item tool config URL. Single source of truth: the agent's MCP
 * config and the schema snapshot must be built from the same URL, or the
 * snapshot stops describing what the agent actually saw. */
export function toolsUrl(mcpUrl: string, tools: string[]): string {
    const url = new URL(mcpUrl);
    url.searchParams.set('tools', tools.join(','));
    return url.toString();
}

export class ArtifactStore {
    private constructor(private readonly store: KeyValueStore) {}

    /** On the platform, pass the store granted via the resourcePicker input
     * (limited-permission runs cannot open other stores); locally the default
     * name works because the developer token has full access. */
    static async open(storeIdOrName?: string): Promise<ArtifactStore> {
        return new ArtifactStore(await Actor.openKeyValueStore(storeIdOrName ?? ARTIFACT_STORE_NAME, { forceCloud: true }));
    }

    private recordUrl(key: string): string {
        return `https://api.apify.com/v2/key-value-stores/${this.store.id}/records/${key}`;
    }

    /** Store one session's full untruncated stream-json log, keyed by trace id.
     * One retry: losing this write would discard a completed, paid session. */
    async putLog(traceId: string, ndjson: string): Promise<ArtifactRef> {
        const key = `log-${traceId}`;
        try {
            await this.store.setValue(key, ndjson, { contentType: 'text/plain' });
        } catch {
            await new Promise((r) => setTimeout(r, 2000));
            await this.store.setValue(key, ndjson, { contentType: 'text/plain' });
        }
        return { url: this.recordUrl(key), hash: sha256(ndjson) };
    }

    /**
     * Store a tools/list snapshot, deduped by content hash: many traces share
     * one tool config, so the snapshot is written once and referenced by all.
     * The stored bytes are exactly the hashed bytes, so any consumer can
     * verify integrity by hashing the fetched record.
     */
    async putToolSchemaSnapshot(schemas: ToolSchema[]): Promise<ArtifactRef> {
        const content = JSON.stringify({ tools: schemas });
        const hash = sha256(content);
        const key = `toolschema-${hash.slice('sha256:'.length, 'sha256:'.length + 16)}`;
        if ((await this.store.getValue(key)) === null) {
            await this.store.setValue(key, content, { contentType: 'application/json' });
        }
        return { url: this.recordUrl(key), hash };
    }
}

/** Fetch the tool schemas an agent session will actually see (per-item ?tools= config). */
export async function fetchToolSchemas(mcpUrl: string, tools: string[], apifyToken: string): Promise<ToolSchema[]> {
    const url = new URL(toolsUrl(mcpUrl, tools));
    const client = new Client({ name: 'workflow-runner', version: '0.2.0' });
    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${apifyToken}` } },
    });
    await client.connect(transport);
    try {
        const { tools: toolList } = await client.listTools();
        return toolList
            .map((t) => ({ name: t.name, inputSchema: t.inputSchema }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } finally {
        await client.close();
    }
}

/**
 * Lazily snapshots each unique tool config once per run. Returns null (with a
 * warning upstream) when snapshotting fails: a missing snapshot degrades the
 * judge's schema-validity check to not_applicable, it does not fail the item.
 */
export class SnapshotCache {
    private readonly cache = new Map<string, Promise<ArtifactRef>>();

    constructor(
        private readonly store: ArtifactStore,
        private readonly mcpUrl: string,
        private readonly apifyToken: string,
    ) {}

    get(tools: string[]): Promise<ArtifactRef> {
        const key = [...tools].sort().join(',');
        let ref = this.cache.get(key);
        if (!ref) {
            ref = fetchToolSchemas(this.mcpUrl, tools, this.apifyToken).then((schemas) =>
                this.store.putToolSchemaSnapshot(schemas),
            );
            // Evict rejections so one transient MCP failure does not poison
            // this tool config for the rest of the run.
            ref.catch(() => this.cache.delete(key));
            this.cache.set(key, ref);
        }
        return ref;
    }
}
