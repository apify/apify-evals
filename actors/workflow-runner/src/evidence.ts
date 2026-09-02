/**
 * Evidence collection: turn one finished session into the facts the check
 * engine and the judge reason about, and freeze them as an artifact.
 *
 * Sources, in order of trust:
 *  1. Full tool results from the raw stream (not the 2000-char previews):
 *     `call-actor` / `get-actor-run` results carry runId, status and the
 *     default dataset id; `get-dataset-items` inputs carry dataset ids.
 *  2. The Apify API, with the run's own token: run status and cost, dataset
 *     items (capped). The agent's runs belong to this account because the MCP
 *     server ran them with the same token.
 *  3. An optional reference run of the subject Actor (fresh ground truth),
 *     started once per experiment per cacheKey and shared by repeats.
 */
import type { ActorRunEvidence, Evidence, ReferenceEvidence, ToolCallEvidence } from '@apify-evals/contract';
import { Actor, log } from 'apify';

export const ITEMS_CAP = 1000;
const APIFY_ID_RE = /^[A-Za-z0-9]{17}$/;

export interface RawToolCall {
    id: string;
    name: string;
    input: unknown;
}
export interface RawToolResult {
    toolUseId: string;
    content: string;
    isError: boolean;
}

/** Pair tool calls with their results and extract Actor runs from the JSON. */
export function extractFromTools(
    calls: RawToolCall[],
    results: RawToolResult[],
): { toolCalls: ToolCallEvidence[]; actorRuns: ActorRunEvidence[]; datasetsRead: string[] } {
    const resultById = new Map(results.map((r) => [r.toolUseId, r]));
    const toolCalls: ToolCallEvidence[] = [];
    const runs = new Map<string, ActorRunEvidence>();
    const datasetsRead = new Set<string>();

    for (const call of calls) {
        const short = call.name.replace(/^mcp__[^_]+__/, '');
        const res = resultById.get(call.id);
        toolCalls.push({ tool: call.name, input: call.input, ...(res?.isError ? { isError: true } : {}) });
        const input = (call.input ?? {}) as Record<string, unknown>;
        const parsed = res ? parseJson(res.content) : null;

        if (short === 'call-actor' || short === 'get-actor-run') {
            const runId = str(parsed?.runId) ?? str(parsed?.id);
            const actorName =
                str(parsed?.actorName) ?? str(input.actor) ?? str((parsed?.actor as Record<string, unknown>)?.fullName);
            if (runId && APIFY_ID_RE.test(runId)) {
                const storages = parsed?.storages as { datasets?: { default?: { id?: string; itemCount?: number } } } | undefined;
                const prev = runs.get(runId);
                runs.set(runId, {
                    actor: actorName ?? prev?.actor ?? 'unknown',
                    runId,
                    ...(str(parsed?.actorId) ? { actorId: str(parsed?.actorId) } : prev?.actorId ? { actorId: prev.actorId } : {}),
                    ...(storages?.datasets?.default?.id
                        ? { datasetId: storages.datasets.default.id }
                        : str(parsed?.defaultDatasetId)
                          ? { datasetId: str(parsed?.defaultDatasetId) }
                          : prev?.datasetId
                            ? { datasetId: prev.datasetId }
                            : {}),
                    ...(str(parsed?.status) ? { status: str(parsed?.status) } : prev?.status ? { status: prev.status } : {}),
                    ...(typeof storages?.datasets?.default?.itemCount === 'number'
                        ? { itemCount: storages.datasets.default.itemCount }
                        : prev?.itemCount !== undefined
                          ? { itemCount: prev.itemCount }
                          : {}),
                    // The input the agent built (call-actor only).
                    ...(short === 'call-actor' && input.input !== undefined ? { input: input.input } : prev?.input !== undefined ? { input: prev.input } : {}),
                    consoleUrl: `https://console.apify.com/actors/runs/${runId}`,
                });
            } else if (short === 'call-actor' && actorName) {
                // The call failed before a run existed (bad input, unknown Actor):
                // still evidence of which Actor the agent tried to use.
                const key = `nocall:${actorName}:${runs.size}`;
                runs.set(key, { actor: actorName, runId: '', status: res?.isError ? 'CALL-FAILED' : 'UNKNOWN', input: input.input });
            }
        }
        if (short === 'get-dataset-items') {
            const id = str(input.datasetId) ?? str(parsed?.datasetId);
            if (id) datasetsRead.add(id);
        }
        // CLI suites: `apify call` output in Bash results carries run ids as URLs.
        if (call.name === 'Bash' && res) {
            for (const m of res.content.matchAll(/console\.apify\.com\/(?:actors\/)?runs\/([A-Za-z0-9]{17})/g)) {
                const runId = m[1];
                if (!runs.has(runId)) runs.set(runId, { actor: cliActor(String(input.command ?? '')) ?? 'unknown', runId, consoleUrl: `https://console.apify.com/actors/runs/${runId}` });
            }
        }
    }
    return { toolCalls, actorRuns: [...runs.values()].filter((r) => r.runId || r.status === 'CALL-FAILED'), datasetsRead: [...datasetsRead] };
}

function cliActor(command: string): string | null {
    const m = command.match(/apify\s+(?:actors?\s+)?call\s+([\w.-]+\/[\w.-]+)/);
    return m ? m[1] : null;
}

function parseJson(text: string): Record<string, unknown> | null {
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
        // Some MCP results wrap JSON in text; take the first {...} block.
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end <= start) return null;
        try {
            return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
        } catch {
            return null;
        }
    }
}

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v ? v : undefined;
}

/**
 * Enrich runs from the API (final status, cost, dataset id when the tool
 * result lacked it) and fetch dataset items. Failures degrade to "not
 * fetched" so a check becomes not-applicable instead of the session failing.
 */
export async function enrichFromApify(
    actorRuns: ActorRunEvidence[],
    extraDatasetIds: string[],
): Promise<{ actorRuns: ActorRunEvidence[]; datasets: Record<string, unknown[]>; actorRunsCostUsd: number }> {
    const client = Actor.apifyClient;
    const datasets: Record<string, unknown[]> = {};
    let cost = 0;
    const enriched: ActorRunEvidence[] = [];
    for (const r of actorRuns) {
        let run = r;
        if (r.runId) {
            try {
                const info = await client.run(r.runId).get();
                if (info) {
                    run = {
                        ...r,
                        status: info.status ?? r.status,
                        datasetId: r.datasetId ?? info.defaultDatasetId,
                        ...(typeof info.usageTotalUsd === 'number' ? { costUsd: info.usageTotalUsd } : {}),
                    };
                    if (typeof info.usageTotalUsd === 'number') cost += info.usageTotalUsd;
                }
            } catch (err) {
                log.warning(`evidence: run ${r.runId} lookup failed: ${err}`);
            }
        }
        enriched.push(run);
    }
    const ids = new Set([...enriched.map((r) => r.datasetId).filter((x): x is string => Boolean(x)), ...extraDatasetIds]);
    for (const id of ids) {
        try {
            const page = await client.dataset(id).listItems({ clean: true, limit: ITEMS_CAP });
            datasets[id] = page.items;
        } catch (err) {
            log.warning(`evidence: dataset ${id} fetch failed: ${err}`);
        }
    }
    return { actorRuns: enriched, datasets, actorRunsCostUsd: Number(cost.toFixed(4)) };
}

/**
 * Reference runs: fresh ground truth by running the subject Actor with a
 * canonical input. One run per cacheKey per experiment; concurrent sessions
 * share the same promise. Failures are recorded on the evidence, never thrown.
 */
export class ReferenceRunner {
    private readonly cache = new Map<string, Promise<ReferenceEvidence>>();

    constructor(private readonly defaultMaxSecs = 180) {}

    run(spec: { actor: string; input: unknown; maxSecs?: number; cacheKey?: string }): Promise<ReferenceEvidence> {
        const key = spec.cacheKey ?? `${spec.actor}:${JSON.stringify(spec.input)}`;
        let p = this.cache.get(key);
        if (!p) {
            p = this.start(spec);
            this.cache.set(key, p);
        }
        return p;
    }

    private async start(spec: { actor: string; input: unknown; maxSecs?: number }): Promise<ReferenceEvidence> {
        const base: ReferenceEvidence = { actor: spec.actor, input: spec.input, items: [] };
        try {
            log.info(`reference run: ${spec.actor}`);
            const run = await Actor.apifyClient.actor(spec.actor).call(spec.input, {
                waitSecs: spec.maxSecs ?? this.defaultMaxSecs,
            });
            if (run.status !== 'SUCCEEDED') {
                return { ...base, runId: run.id, status: run.status, error: `reference run ${run.status}` };
            }
            const page = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems({ clean: true, limit: ITEMS_CAP });
            return { ...base, runId: run.id, datasetId: run.defaultDatasetId, status: run.status, items: page.items };
        } catch (err) {
            return { ...base, error: String((err as Error).message ?? err).slice(0, 300) };
        }
    }
}

export function summarizeRuns(evidence: Evidence): Record<string, unknown>[] {
    return evidence.actorRuns.map((r) => ({
        actor: r.actor,
        runId: r.runId,
        status: r.status ?? null,
        datasetId: r.datasetId ?? null,
        itemCount: r.itemCount ?? (r.datasetId ? evidence.datasets[r.datasetId]?.length ?? null : null),
        costUsd: r.costUsd ?? null,
        consoleUrl: r.consoleUrl ?? null,
    }));
}
