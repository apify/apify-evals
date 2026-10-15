/**
 * Evidence collection: turn one finished session into the facts the check
 * engine and the judge reason about, and freeze them as an artifact.
 *
 * Sources, in order of trust:
 *  1. Full tool results from the raw stream (not the 2000-char previews):
 *     `call-actor` / `get-actor-run` results carry runId, status and the
 *     default dataset id; `get-dataset-items` inputs carry dataset ids.
 *     CLI and API surfaces: Console and API run URLs and run objects in Bash
 *     and WebFetch output (and in the commands themselves).
 *  2. The Apify API, with the run's own token: run status and cost, dataset
 *     items (capped), the run's INPUT record. The agent's runs belong to this
 *     account because every surface ran them with the same token. Runs that no
 *     output names (`run-sync-get-dataset-items`, `apify call -s`) are found by
 *     the session's marker in the run's user agent (surfaces.ts `curlrc` and
 *     `MARKER_PRELOAD`).
 *  3. An optional reference run of the subject Actor (fresh ground truth),
 *     started once per experiment per cacheKey and shared by repeats.
 */
import {
    type ActorRunEvidence,
    type Evidence,
    type ReferenceEvidence,
    surfacesOfCall,
    type ToolCallEvidence,
} from '@apify-evals/contract';
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
): {
    toolCalls: ToolCallEvidence[];
    actorRuns: ActorRunEvidence[];
    datasetsRead: string[];
    datasetHints: DatasetHint[];
} {
    const resultById = new Map(results.map((r) => [r.toolUseId, r]));
    const toolCalls: ToolCallEvidence[] = [];
    const runs = new Map<string, ActorRunEvidence>();
    const datasetsRead = new Set<string>();
    const datasetHints = new Map<string, DatasetHint>();

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
                const storages = parsed?.storages as
                    | { datasets?: { default?: { id?: string; itemCount?: number } } }
                    | undefined;
                const prev = runs.get(runId);
                runs.set(runId, {
                    actor: actorName ?? prev?.actor ?? 'unknown',
                    runId,
                    ...(str(parsed?.actorId)
                        ? { actorId: str(parsed?.actorId) }
                        : prev?.actorId
                          ? { actorId: prev.actorId }
                          : {}),
                    ...(storages?.datasets?.default?.id
                        ? { datasetId: storages.datasets.default.id }
                        : str(parsed?.defaultDatasetId)
                          ? { datasetId: str(parsed?.defaultDatasetId) }
                          : prev?.datasetId
                            ? { datasetId: prev.datasetId }
                            : {}),
                    ...(str(parsed?.status)
                        ? { status: str(parsed?.status) }
                        : prev?.status
                          ? { status: prev.status }
                          : {}),
                    ...(typeof storages?.datasets?.default?.itemCount === 'number'
                        ? { itemCount: storages.datasets.default.itemCount }
                        : prev?.itemCount !== undefined
                          ? { itemCount: prev.itemCount }
                          : {}),
                    // The input the agent built (call-actor only).
                    ...(short === 'call-actor' && input.input !== undefined
                        ? { input: input.input }
                        : prev?.input !== undefined
                          ? { input: prev.input }
                          : {}),
                    consoleUrl: `https://console.apify.com/actors/runs/${runId}`,
                    origin: 'mcp',
                });
            } else if (short === 'call-actor' && actorName) {
                // The call failed before a run existed (bad input, unknown Actor):
                // still evidence of which Actor the agent tried to use.
                const key = `nocall:${actorName}:${runs.size}`;
                runs.set(key, {
                    actor: actorName,
                    runId: '',
                    status: res?.isError ? 'CALL-FAILED' : 'UNKNOWN',
                    input: input.input,
                });
            }
        }
        if (short === 'get-dataset-items') {
            const id = str(input.datasetId) ?? str(parsed?.datasetId);
            if (id) datasetsRead.add(id);
        }
        // CLI and API surfaces: runs named in Bash / WebFetch commands and output.
        if (call.name === 'Bash' || call.name === 'WebFetch') {
            const command = String((call.name === 'Bash' ? input.command : input.url) ?? '');
            const origin = surfacesOfCall(call.name, call.input).includes('cli') ? 'cli' : 'api';
            const actor = cliActor(command) ?? apiActor(command);
            const text = `${command}\n${res?.content ?? ''}`;
            for (const datasetId of datasetIdsInText(text)) {
                if (!datasetHints.has(datasetId)) datasetHints.set(datasetId, { datasetId, actor, origin });
            }
            for (const found of runsInText(text)) {
                const prev = runs.get(found.runId);
                runs.set(found.runId, {
                    ...found,
                    ...prev,
                    actor: prev?.actor && prev.actor !== 'unknown' ? prev.actor : (actor ?? 'unknown'),
                    origin: prev?.origin ?? origin,
                    consoleUrl: `https://console.apify.com/actors/runs/${found.runId}`,
                });
            }
        }
    }
    return {
        toolCalls,
        actorRuns: [...runs.values()].filter((r) => r.runId || r.status === 'CALL-FAILED'),
        datasetsRead: [...datasetsRead],
        datasetHints: [...datasetHints.values()],
    };
}

/** A dataset id seen in CLI or API output; its run is found through the dataset (`actRunId`). */
export interface DatasetHint {
    datasetId: string;
    actor: string | null;
    origin: 'cli' | 'api';
}

/**
 * Dataset ids in free text: `datasetId=...` (mcpc and the MCP server's text
 * results name only the dataset), JSON `"datasetId"` / `"defaultDatasetId"`,
 * and Console or API dataset URLs.
 */
export function datasetIdsInText(text: string): string[] {
    const out = new Set<string>();
    for (const re of [
        /\b(?:default)?[dD]atasetId["']?\s*[=:]\s*["']?([A-Za-z0-9]{17})\b/g,
        /console\.apify\.com\/storage\/datasets\/([A-Za-z0-9]{17})\b/g,
        /api\.apify\.com\/v2\/datasets\/([A-Za-z0-9]{17})\b/g,
    ]) {
        for (const m of text.matchAll(re)) out.add(m[1]);
    }
    return [...out];
}

/**
 * Runs behind dataset ids the agent saw (mcpc prints `datasetId=...`, not the
 * run id). The dataset records the run that wrote it; runs already known are
 * skipped, and enrichFromApify drops runs that started before the session.
 */
export async function runsFromDatasets(hints: DatasetHint[], known: Set<string>): Promise<ActorRunEvidence[]> {
    const client = Actor.apifyClient;
    const out: ActorRunEvidence[] = [];
    for (const hint of hints.slice(0, 25)) {
        try {
            const info = (await client.dataset(hint.datasetId).get()) as
                | { actRunId?: string; actId?: string }
                | undefined;
            const runId = info?.actRunId;
            if (!runId || known.has(runId)) continue;
            known.add(runId);
            out.push({
                actor: hint.actor ?? 'unknown',
                ...(info?.actId ? { actorId: info.actId } : {}),
                runId,
                datasetId: hint.datasetId,
                origin: hint.origin,
                consoleUrl: `https://console.apify.com/actors/runs/${runId}`,
            });
        } catch (err) {
            log.warning(`evidence: dataset ${hint.datasetId} lookup failed: ${err}`);
        }
    }
    return out;
}

function cliActor(command: string): string | null {
    const m = command.match(/apify\s+(?:actors?\s+)?(?:call|start)\s+([\w.-]+\/[\w.-]+)/);
    return m ? m[1] : null;
}

/** `api.apify.com/v2/acts/apify~web-scraper/runs` -> `apify/web-scraper`. */
function apiActor(command: string): string | null {
    const m = command.match(/api\.apify\.com\/v2\/acts\/([\w.-]+)(?:~|%2F|\/)([\w.-]+)\/(?:runs|run-sync)/i);
    return m ? `${m[1]}/${m[2]}` : null;
}

type FoundRun = Pick<ActorRunEvidence, 'runId' | 'actorId' | 'datasetId' | 'status'>;

// Run ids in URLs: Console (every form) and the API's run endpoints.
const RUN_URL_RES = [
    // `--json` output of MCP tools through mcpc (call-actor, get-actor-run).
    /"runId"\s*:\s*"([A-Za-z0-9]{17})"/g,
    /console\.apify\.com\/(?:view\/)?(?:actors\/(?:[A-Za-z0-9]{17}\/)?)?runs\/([A-Za-z0-9]{17})\b/g,
    /api\.apify\.com\/v2\/actor-runs\/([A-Za-z0-9]{17})\b/g,
    /api\.apify\.com\/v2\/acts\/[^/\s]+\/runs\/([A-Za-z0-9]{17})\b/g,
];

/**
 * Runs named in free text: URLs, and run objects in JSON (a whole document,
 * one per line, or the first {...} block). A run object has `id` and `actId`
 * plus a default storage, which tells it apart from a build.
 */
export function runsInText(text: string): FoundRun[] {
    const found = new Map<string, FoundRun>();
    for (const re of RUN_URL_RES) {
        for (const m of text.matchAll(re)) if (!found.has(m[1])) found.set(m[1], { runId: m[1] });
    }
    const docs: unknown[] = [];
    const whole = parseJson(text);
    if (whole) docs.push(whole);
    else {
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (t.startsWith('{') || t.startsWith('[')) {
                try {
                    docs.push(JSON.parse(t));
                } catch {
                    /* not JSON */
                }
            }
        }
    }
    const walk = (v: unknown, depth: number) => {
        if (depth > 5 || found.size >= 50 || !v || typeof v !== 'object') return;
        if (Array.isArray(v)) {
            for (const x of v) walk(x, depth + 1);
            return;
        }
        const o = v as Record<string, unknown>;
        const id = str(o.id);
        const actId = str(o.actId);
        if (id && actId && APIFY_ID_RE.test(id) && (str(o.defaultDatasetId) || str(o.defaultKeyValueStoreId))) {
            found.set(id, {
                ...found.get(id),
                runId: id,
                actorId: actId,
                ...(str(o.defaultDatasetId) ? { datasetId: str(o.defaultDatasetId) } : {}),
                ...(str(o.status) ? { status: str(o.status) } : {}),
            });
        }
        for (const x of Object.values(o)) walk(x, depth + 1);
    };
    for (const d of docs) walk(d, 0);
    return [...found.values()];
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

/** Runs named by the agent but started this long before its session are not its own. */
const SESSION_SLACK_MS = 60_000;

export interface SessionWindow {
    /** Session start and end (epoch ms). */
    from: number;
    to: number;
    /** The marker in the session's curl user agent; enables the window lookup. */
    marker?: string;
}

/**
 * Runs that no output named but that carry the session's marker in their user
 * agent (`run-sync-get-dataset-items` and `apify call -s` return items, not a run). The list
 * endpoint has no user agent, so each API-started candidate in the session
 * window is fetched once.
 */
/** Run origins the session marker can be on: curl (API) and the session's CLI. */
const MARKED_ORIGINS = new Set(['API', 'CLI']);

export async function findMarkedRuns(window: SessionWindow, known: Set<string>): Promise<ActorRunEvidence[]> {
    if (!window.marker) return [];
    const client = Actor.apifyClient;
    const out: ActorRunEvidence[] = [];
    try {
        const page = await client.runs().list({ desc: true, limit: 100 });
        const candidates = page.items.filter((r) => {
            const t = new Date(r.startedAt).getTime();
            return (
                t >= window.from - 5_000 &&
                t <= window.to + 5_000 &&
                !known.has(r.id) &&
                MARKED_ORIGINS.has(String(r.meta?.origin))
            );
        });
        for (const c of candidates.slice(0, 25)) {
            const info = await client.run(c.id).get();
            const userAgent = (info?.meta as { userAgent?: string } | undefined)?.userAgent ?? '';
            if (info && userAgent.includes(window.marker)) {
                out.push({ actor: 'unknown', actorId: info.actId, runId: info.id, origin: 'window' });
            }
        }
    } catch (err) {
        log.warning(`evidence: session-window run lookup failed: ${err}`);
    }
    return out;
}

/**
 * Enrich runs from the API (final status, cost, dataset id when the tool
 * result lacked it, the Actor's name and the run's INPUT when no tool call
 * carried them) and fetch dataset items. A run the agent only named (a CLI or
 * API listing of old runs) that started before the session is dropped.
 * Failures degrade to "not fetched" so a check becomes not-applicable instead
 * of the session failing.
 */
export async function enrichFromApify(
    actorRuns: ActorRunEvidence[],
    extraDatasetIds: string[],
    window?: SessionWindow,
): Promise<{ actorRuns: ActorRunEvidence[]; datasets: Record<string, unknown[]>; actorRunsCostUsd: number }> {
    const client = Actor.apifyClient;
    const datasets: Record<string, unknown[]> = {};
    const actorNames = new Map<string, Promise<string | null>>();
    const actorName = (actId: string) => {
        let p = actorNames.get(actId);
        if (!p) {
            p = client
                .actor(actId)
                .get()
                .then((a) => (a ? `${a.username}/${a.name}` : null))
                .catch(() => null);
            actorNames.set(actId, p);
        }
        return p;
    };
    let cost = 0;
    const enriched: ActorRunEvidence[] = [];
    for (const r of actorRuns) {
        let run = r;
        if (r.runId) {
            try {
                const info = await client.run(r.runId).get();
                if (info) {
                    const startedBefore = window && new Date(info.startedAt).getTime() < window.from - SESSION_SLACK_MS;
                    if (startedBefore && r.origin && r.origin !== 'mcp') continue;
                    run = {
                        ...r,
                        actorId: r.actorId ?? info.actId,
                        status: info.status ?? r.status,
                        datasetId: r.datasetId ?? info.defaultDatasetId,
                        ...(typeof info.usageTotalUsd === 'number' ? { costUsd: info.usageTotalUsd } : {}),
                    };
                    if (run.actor === 'unknown' && info.actId) run.actor = (await actorName(info.actId)) ?? 'unknown';
                    if (run.input === undefined && info.defaultKeyValueStoreId) {
                        const record = await client
                            .keyValueStore(info.defaultKeyValueStoreId)
                            .getRecord('INPUT')
                            .catch(() => undefined);
                        if (record) run.input = record.value;
                    }
                    if (typeof info.usageTotalUsd === 'number') cost += info.usageTotalUsd;
                }
            } catch (err) {
                log.warning(`evidence: run ${r.runId} lookup failed: ${err}`);
            }
        }
        enriched.push(run);
    }
    const ids = new Set([
        ...enriched.map((r) => r.datasetId).filter((x): x is string => Boolean(x)),
        ...extraDatasetIds,
    ]);
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
            const page = await Actor.apifyClient
                .dataset(run.defaultDatasetId)
                .listItems({ clean: true, limit: ITEMS_CAP });
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
        itemCount: r.itemCount ?? (r.datasetId ? (evidence.datasets[r.datasetId]?.length ?? null) : null),
        costUsd: r.costUsd ?? null,
        consoleUrl: r.consoleUrl ?? null,
    }));
}
