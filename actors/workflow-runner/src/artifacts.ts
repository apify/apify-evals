import { sha256 } from '@apify-evals/contract';
import { Actor, type KeyValueStore } from 'apify';

import { filterTools, listTools, type ResolvedMcp, type ToolSchema } from './mcp.js';

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

export { toolsUrl, type ToolSchema } from './mcp.js';

export class ArtifactStore {
    private constructor(private readonly store: KeyValueStore) {}

    /** On the platform, pass the store granted via the resourcePicker input
     * (limited-permission runs cannot open other stores); locally the default
     * name works because the developer token has full access. */
    static async open(storeIdOrName?: string): Promise<ArtifactStore> {
        return new ArtifactStore(
            await Actor.openKeyValueStore(storeIdOrName ?? ARTIFACT_STORE_NAME, { forceCloud: true }),
        );
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

    /** Store one JSON record (e.g. the evidence snapshot of a session). */
    async putJson(key: string, value: unknown): Promise<ArtifactRef> {
        const content = JSON.stringify(value);
        await this.store.setValue(key, content, { contentType: 'application/json' });
        return { url: this.recordUrl(key), hash: sha256(content) };
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

/** Fetch the tool schemas an agent session will actually see: the server as
 * configured for the item, narrowed to the item's tool list. */
export async function fetchToolSchemas(mcp: ResolvedMcp, signal?: AbortSignal): Promise<ToolSchema[]> {
    const all = await listTools(mcp, signal);
    const allowed = new Set(
        filterTools(
            mcp,
            all.map((t) => t.name),
        ),
    );
    return all.filter((t) => allowed.has(t.name));
}

/**
 * Lazily snapshots each unique server + tool config once per run. Returns null
 * (with a warning upstream) when snapshotting fails: a missing snapshot
 * degrades the judge's schema-validity check to not_applicable, it does not
 * fail the item.
 */
export class SnapshotCache {
    private readonly cache = new Map<string, Promise<ArtifactRef>>();

    constructor(private readonly store: ArtifactStore) {}

    get(mcp: ResolvedMcp): Promise<ArtifactRef> {
        const { key } = mcp;
        let ref = this.cache.get(key);
        if (!ref) {
            ref = fetchToolSchemas(mcp).then((schemas) => this.store.putToolSchemaSnapshot(schemas));
            // Evict rejections so one transient MCP failure does not poison
            // this tool config for the rest of the run.
            ref.catch(() => this.cache.delete(key));
            this.cache.set(key, ref);
        }
        return ref;
    }
}
