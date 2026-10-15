import { execFile as execFileCb } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { type DatasetItemMetadata, validateDatasetItemMetadata } from '@apify-evals/contract';
import { Actor, log } from 'apify';

import { killTrackedChildren } from './adapters/shared.js';
import {
    LANGFUSE_CREDENTIALS,
    judgeLangfuseInput,
    resolveHealthThreshold,
    resolveTrigger,
    shouldNotify,
} from './config.js';

const execFile = promisify(execFileCb);

const OUTPUT_PREVIEW_CAP = 500;
const DEFAULT_JUDGE_ACTOR = 'artogahr/eval-judge';
const OPENROUTER_PROXY_URL = 'https://openrouter.apify.actor/api';

/**
 * Exit codes (spec D14: run status = system health, scores = results).
 * 0 ran and judged (scenario failures are results, not errors);
 * 10 health: too few sessions completed; 11 judge failed; 12 nothing
 * selected; 13 telemetry flush failed; 14 preflight failed (MCP, CLI, API or
 * proxy); 15 the run would exceed maxSessions.
 */
const EXIT = { ok: 0, health: 10, judge: 11, nothing: 12, flush: 13, preflight: 14, tooLarge: 15 } as const;

interface Input {
    datasetName?: string;
    /** Deprecated: the experiment is always named after the dataset so all runs share one compare view. */
    experimentName?: string;
    runName?: string;
    model?: string;
    models?: string[];
    harness?: Partial<{ kind: string; model: string; maxTurns: number }>;
    repeats?: number;
    judge?: boolean;
    judgeModel?: string;
    concurrency?: number;
    perItemTimeoutSecs?: number;
    itemLimit?: number;
    /** Team-facing filters: subject ids (owner/name) and owners (teams). */
    subjects?: string[];
    owners?: string[];
    /** Deprecated alias of subjects, matched against metadata.category (slug). */
    categories?: string[];
    healthThreshold?: number | string;
    skipPreflight?: boolean;
    trigger?: string;
    /** Post the Slack digest for this run (scheduled runs post by default). */
    notify?: boolean;
    mcpUrl?: string;
    /** Values for `${VAR}` placeholders in a suite's MCP server config; overrides the Actor env. */
    mcpEnv?: Record<string, string>;
    /** Skill variants: one experiment each ("none", "a", "a+b"). */
    skillSets?: string[];
    /** Expand the skills into every subset (incl. none). */
    skillCombinations?: boolean;
    /** Surface variants (surfaces/<name>.yaml): one experiment each; default ["mcp"]. */
    surfaces?: string[];
    /** Apify CLI version for every CLI surface in the run (overrides the surface file). */
    cliVersion?: string;
    /** Refuse to start when models x surfaces x skill sets x scenarios x repeats exceeds this. */
    maxSessions?: number;
    useOpenRouterProxy?: boolean;
    artifactStore?: string;
    langfuseBaseUrl?: string;
    langfusePublicKey?: string;
    langfuseSecretKey?: string;
}

interface JudgeOutput {
    items?: number;
    judged?: number;
    conclusive?: number;
    inconclusive?: number;
    passed?: number;
    passRate?: number | null;
    foundRate?: number | null;
    worksRate?: number | null;
    checksPassed?: number;
    checksTotal?: number;
    disagreements?: number;
    actorRunsCostUsd?: number;
    errors?: number;
    scoreboard?: unknown[];
    fixAreas?: Record<string, number>;
    flaky?: unknown[];
}

await Actor.init();

// Sessions run as detached `claude` process groups, so they survive this
// process unless they are killed explicitly. Kill them on abort and exit as
// soon as possible, so an aborted run stops billing compute and tokens.
Actor.on('aborting', async () => {
    const killed = killTrackedChildren();
    log.warning(`Aborting: killed ${killed} running session(s)`);
    // Give the SDK's state persistence a moment before tearing the process down.
    await delay(1000);
    await Actor.exit({ statusMessage: `Aborted; ${killed} running session(s) killed` });
});
const input = ((await Actor.getInput()) ?? {}) as Input;
const {
    datasetName = 'store-actors',
    runName,
    model: modelInput,
    models: modelsInput,
    harness: harnessInput,
    repeats = 1,
    judge = true,
    judgeModel = 'anthropic/claude-sonnet-4.6',
    concurrency = 4,
    perItemTimeoutSecs = 300,
    itemLimit = 0,
    subjects = [],
    owners = [],
    categories = [],
    healthThreshold: healthThresholdInput,
    skipPreflight = false,
    mcpUrl = 'https://mcp.apify.com',
    useOpenRouterProxy = true,
    maxSessions = 400,
} = input;
const healthThreshold = resolveHealthThreshold(healthThresholdInput);
// Artifact store: the resource-picker grant when given, else the store id
// from the Actor environment (schedules and tasks do not need the picker).
const artifactStoreId = input.artifactStore ?? process.env.ARTIFACT_STORE_ID ?? undefined;
if (input.experimentName && input.experimentName !== datasetName) {
    log.warning(`experimentName is ignored; runs are grouped under the dataset name "${datasetName}"`);
}

// Credentials: input wins, env fallback. Env must be set BEFORE the Langfuse
// modules load, because parts of the SDK capture process.env at module load;
// the dynamic imports below guarantee that ordering.
for (const [inputKey, envKey] of LANGFUSE_CREDENTIALS) {
    if (input[inputKey]) process.env[envKey] = input[inputKey];
    if (!process.env[envKey]) throw new Error(`Missing ${envKey} (set it as Actor input or env var)`);
}

const { LangfuseClient } = await import('@langfuse/client');
const { LangfuseSpanProcessor } = await import('@langfuse/otel');
const { NodeSDK } = await import('@opentelemetry/sdk-node');
const { runSession, validateHarness, DEFAULT_MAX_TURNS } = await import('./harness.js');
const { CODEX_PROVIDER } = await import('./adapters/codex.js');
const { ArtifactStore, SnapshotCache, fetchToolSchemas } = await import('./artifacts.js');
const { ReferenceRunner } = await import('./evidence.js');
const { resolveMcp } = await import('./mcp.js');
const { postDigest } = await import('./notify.js');
const { assertSkillsExist, resolveSkillSets, skillSetLabel, skillsRoot } = await import('./skills.js');
const { installCli, loadSurface, resolveSurface, resolveSurfaceNames, surfacesRoot } = await import('./surfaces.js');
const { surfaceApplies } = await import('@apify-evals/contract');

// `model` / `models` are the team-facing inputs; the `harness` object stays
// accepted for older callers. Merge partial harness input over defaults.
const baseHarness = {
    kind: 'claude-code',
    model: 'anthropic/claude-haiku-4.5',
    maxTurns: DEFAULT_MAX_TURNS,
    ...(harnessInput ?? {}),
    ...(modelInput ? { model: modelInput } : {}),
};
validateHarness(baseHarness);
const models = modelsInput && modelsInput.length > 0 ? [...new Set(modelsInput)] : [baseHarness.model];

// APIFY token: injected on platform; via CLI when run locally. Always required
// now: the named artifact store lives in the cloud even for local runs.
let apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) {
    try {
        apifyToken = (await execFile('apify', ['auth', 'token'], { timeout: 10_000 })).stdout.trim();
        process.env.APIFY_TOKEN = apifyToken;
    } catch {
        /* stays undefined */
    }
}
if (!apifyToken) throw new Error('No APIFY_TOKEN available (needed for artifacts, MCP, and the OpenRouter proxy)');

// Secrets for the suite's MCP server config: the run's own token for Apify
// MCP, anything else (e.g. NOTION_TOKEN) from the Actor env or the mcpEnv input.
const mcpEnv: Record<string, string | undefined> = { ...process.env, APIFY_TOKEN: apifyToken, ...(input.mcpEnv ?? {}) };

const otel = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
otel.start();
const langfuse = new LangfuseClient();
const artifactStore = await ArtifactStore.open(artifactStoreId);
const snapshots = new SnapshotCache(artifactStore);
const references = new ReferenceRunner();
const writeScore = async (score: {
    traceId: string;
    observationId: string;
    name: string;
    value: number;
    comment: string;
}) => {
    await langfuse.api.scores.create({ ...score, dataType: 'NUMERIC' });
};

// ---------------------------------------------------------------------------
// Scenario selection and scope
// ---------------------------------------------------------------------------

const dataset = await langfuse.dataset.get(datasetName);
// Fail fast on malformed scenarios: a typo in `skill` or `checks` would
// otherwise silently drop the item from every aggregate.
const invalid = dataset.items
    .filter((i) => i.status !== 'ARCHIVED' && !validateDatasetItemMetadata(i.metadata ?? {}))
    .map((i) => `${i.id}: ${JSON.stringify(validateDatasetItemMetadata.errors)}`);
if (invalid.length > 0) throw new Error(`Invalid scenario metadata in "${datasetName}":\n${invalid.join('\n')}`);

type Meta = DatasetItemMetadata & { subject?: { id?: string }; owner?: string };
const meta = (i: { metadata?: unknown }) => (i.metadata ?? {}) as Meta;
const subjectOf = (m: Meta) => m.subject?.id ?? m.actor ?? '';
const ownerOf = (m: Meta) => m.owner ?? m.team ?? '';
const slugOf = (s: string) => s.split('/').pop() ?? s;
const wantSubjects = new Set([...subjects, ...categories].map((s) => s.trim()).filter(Boolean));
const wantOwners = new Set(owners.map((o) => o.trim()).filter(Boolean));

const filtered = dataset.items
    .filter((i) => i.status !== 'ARCHIVED')
    .filter((i) => {
        const m = meta(i);
        const subject = subjectOf(m);
        const bySubject =
            wantSubjects.size === 0 ||
            wantSubjects.has(subject) ||
            wantSubjects.has(slugOf(subject)) ||
            wantSubjects.has(m.category ?? '');
        const byOwner = wantOwners.size === 0 || wantOwners.has(ownerOf(m));
        return bySubject && byOwner;
    });
const selected = itemLimit > 0 ? filtered.slice(0, itemLimit) : filtered;

// Skill variants: every set becomes its own experiment (model x skill set).
// The suite's injectable skills travel on the items (profile agentSkills).
const suiteSkills = [...new Set(selected.flatMap((i) => (meta(i) as { agentSkills?: string[] }).agentSkills ?? []))];
const skillSets = resolveSkillSets(input, suiteSkills);
const skillsDir = skillsRoot();
assertSkillsExist(skillSets, skillsDir);
const skillsVaried = skillSets.length > 1 || skillSets[0].length > 0;

// Surface variants: how the agent reaches Apify (MCP, CLI, API). Each surface
// is its own experiment too: model x surface x skill set.
const surfacesDir = surfacesRoot();
const surfaces = resolveSurfaceNames(input.surfaces).map((name) =>
    resolveSurface(loadSurface(surfacesDir, name), { env: mcpEnv, cliVersion: input.cliVersion }),
);
const surfacesVaried = surfaces.length > 1 || surfaces[0].name !== 'mcp';
const multiVariant = skillsVaried || surfacesVaried;
const itemsFor = (surface: (typeof surfaces)[number]) =>
    selected.filter((i) => surfaceApplies(meta(i).surfaces, surface));

// Fail fast on an MCP server config the environment cannot satisfy (missing
// NOTION_TOKEN and the like), before any session is paid for.
const mcpProblems = [
    ...new Set(
        selected
            .map((i) => {
                try {
                    resolveMcp(meta(i), { mcpUrl, env: mcpEnv });
                    return null;
                } catch (err) {
                    return String((err as Error).message ?? err);
                }
            })
            .filter((p): p is string => p !== null),
    ),
];
if (mcpProblems.length > 0) throw new Error(mcpProblems.join('\n'));
if (baseHarness.kind === 'codex') {
    if (skillSets.some((set) => set.length > 0)) throw new Error('Codex harness does not support skill sets');
    if (selected.some((i) => meta(i).mcp && meta(i).mcp?.name !== 'apify')) {
        throw new Error('Codex harness supports only the Apify MCP server');
    }
    if (surfaces.some((surface) => surface.kind !== 'mcp')) {
        throw new Error('Codex harness supports only MCP surfaces (its shell tools are off)');
    }
}
const safeRepeats = Math.max(1, Math.min(10, Math.floor(repeats)));
// Repeats: each repeat is its own experiment item, so every average (compare
// view, dashboards) already accounts for it and flaky scenarios show as x/N.
// The items themselves are built per surface in the variant loop.
const plannedSessions =
    models.length *
    skillSets.length *
    surfaces.reduce((acc, surface) => acc + itemsFor(surface).length, 0) *
    safeRepeats;

// Scope: what this run covers. Full-scope runs feed the OKR trend; filtered
// runs (a team checking their own Actors) are compared in the compare view
// and must not move the run-level averages.
const scopeParts: string[] = [];
if (wantOwners.size > 0) scopeParts.push(`owner:${[...wantOwners].join(',')}`);
if (wantSubjects.size > 0) scopeParts.push(`subject:${[...wantSubjects].map(slugOf).join(',')}`);
if (itemLimit > 0) scopeParts.push(`limit:${itemLimit}`);
const scope = scopeParts.length === 0 ? 'all' : scopeParts.join(' ');
const fullScope = scope === 'all';
const trigger = resolveTrigger(input.trigger, process.env.APIFY_META_ORIGIN);

log.info(
    `Dataset "${datasetName}": ${selected.length} scenarios x${safeRepeats}, scope ${scope}, models ${models.join(', ')}, surfaces ${surfaces.map((x) => x.name).join(' | ')}, skill sets ${skillSets.map(skillSetLabel).join(' | ')}, ${plannedSessions} sessions, concurrency ${concurrency}, trigger ${trigger}`,
);
if (plannedSessions === 0) {
    log.error(
        `No scenarios selected for any surface (subjects=${JSON.stringify(subjects)}, owners=${JSON.stringify(owners)}, categories=${JSON.stringify(categories)})`,
    );
    await Actor.setValue('OUTPUT', { error: 'no scenarios selected', scope, datasetName });
    await Actor.exit({ exitCode: EXIT.nothing, statusMessage: 'No scenarios matched the filters' });
}
if (plannedSessions > maxSessions) {
    const message = `${plannedSessions} sessions planned (models x surfaces x skill sets x scenarios x repeats), more than maxSessions ${maxSessions}`;
    log.error(message);
    await Actor.setValue('OUTPUT', { error: 'too many sessions', plannedSessions, maxSessions, scope, datasetName });
    await Actor.exit({ exitCode: EXIT.tooLarge, statusMessage: message });
}

// Every CLI version the surfaces need, once per run, before any session.
for (const surface of surfaces) {
    if (!surface.cli) continue;
    try {
        await installCli(surface, { preinstalledRoot: process.env.CLI_ROOT });
        log.info(`surface ${surface.name}: ${surface.cli.package} ${surface.cliVersion} at ${surface.cliBinDir}`);
    } catch (err) {
        const message = `surface ${surface.name}: installing ${surface.cli.package}@${surface.cli.version} failed: ${String((err as Error).message ?? err).slice(0, 300)}`;
        log.error(message);
        await Actor.setValue('OUTPUT', { error: 'preflight failed', problems: [message], scope, datasetName });
        await Actor.exit({ exitCode: EXIT.preflight, statusMessage: message });
    }
}

// ---------------------------------------------------------------------------
// Preflight: fail in seconds, not after 18 sessions fail the same way.
// ---------------------------------------------------------------------------

if (!skipPreflight) {
    const problems: string[] = [];
    const firstMeta = meta(selected[0]);
    // One MCP probe per distinct MCP URL among the surfaces that use MCP.
    const mcpUrls = [...new Set(surfaces.filter((x) => x.spec.mcp).map((x) => x.spec.mcpUrl ?? mcpUrl))];
    for (const url of mcpUrls) {
        const firstMcp = resolveMcp(
            { ...firstMeta, tools: firstMeta.tools ?? ['fetch-actor-details'] },
            { mcpUrl: url, env: mcpEnv },
        );
        if (!firstMcp) continue;
        const where = firstMcp.spec.transport === 'http' ? (firstMcp.spec.url as string) : `${firstMcp.name} (stdio)`;
        try {
            const schemas = await fetchToolSchemas(firstMcp, AbortSignal.timeout(60_000));
            if (schemas.length === 0)
                problems.push(`MCP server ${where} returned no tools for ${firstMcp.tools.join(',')}`);
            else log.info(`preflight: MCP server ${firstMcp.name} lists ${schemas.length} tool(s)`);
        } catch (err) {
            problems.push(`MCP server ${where} unreachable: ${String((err as Error).message ?? err).slice(0, 200)}`);
        }
    }
    // CLI surfaces: the installed CLI must reach the API with the surface's token.
    for (const surface of surfaces.filter((x) => x.cliBinDir)) {
        try {
            await execFile(`${surface.cliBinDir}/apify`, ['info'], {
                timeout: 30_000,
                env: { PATH: process.env.PATH, HOME: process.env.HOME, ...surface.env },
            });
        } catch (err) {
            problems.push(
                `surface ${surface.name}: \`apify info\` failed: ${String((err as Error).message ?? err).slice(0, 200)}`,
            );
        }
    }
    // API surfaces: the token must be accepted.
    for (const surface of surfaces.filter((x) => x.kind === 'api')) {
        try {
            const res = await fetch('https://api.apify.com/v2/users/me', {
                headers: { Authorization: `Bearer ${surface.env.APIFY_TOKEN ?? apifyToken}` },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) problems.push(`surface ${surface.name}: GET /v2/users/me returned HTTP ${res.status}`);
        } catch (err) {
            problems.push(
                `surface ${surface.name}: Apify API unreachable: ${String((err as Error).message ?? err).slice(0, 200)}`,
            );
        }
    }
    if (useOpenRouterProxy) {
        try {
            const codex = baseHarness.kind === 'codex';
            const res = await fetch(
                codex ? `${CODEX_PROVIDER.base_url}/responses` : `${OPENROUTER_PROXY_URL}/v1/chat/completions`,
                {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${apifyToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(
                        codex
                            ? { model: models[0], input: 'ping', max_output_tokens: 16 }
                            : { model: models[0], max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
                    ),
                    signal: AbortSignal.timeout(20_000),
                },
            );
            if (!res.ok)
                problems.push(
                    `LLM proxy HTTP ${res.status} for model ${models[0]}: ${(await res.text()).slice(0, 200)}`,
                );
        } catch (err) {
            problems.push(`LLM proxy unreachable: ${String((err as Error).message ?? err).slice(0, 200)}`);
        }
    }
    if (problems.length > 0) {
        for (const p of problems) log.error(`preflight: ${p}`);
        await Actor.setValue('OUTPUT', { error: 'preflight failed', problems, scope, datasetName });
        await Actor.exit({ exitCode: EXIT.preflight, statusMessage: `Preflight failed: ${problems[0]}` });
    }
    log.info('preflight ok: every surface answered, LLM proxy answered');
}

// ---------------------------------------------------------------------------
// One experiment per model x skill set (spec D6), sequential so pass rates
// stay comparable. Skill sets are the "which skills help" axis: each set is
// its own dataset run, so the compare view puts them side by side.
// ---------------------------------------------------------------------------

const actorRunId = process.env.ACTOR_RUN_ID ?? null;
const consoleRunUrl = actorRunId ? `https://console.apify.com/actors/runs/${actorRunId}` : null;
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

interface ModelRunSummary {
    model: string;
    /** Surface variant (surfaces/<name>.yaml). */
    surface: string;
    /** Skill variant label: `none` or `a+b`. */
    skillSet: string;
    agentSkills: string[];
    resultsUrl: string | null;
    datasetRunId: string | null;
    datasetRunName: string | null;
    datasetRunUrl: string | null;
    items: number;
    completed: number;
    suiteMs: number;
    judge: JudgeOutput | null;
    judgeRunUrl: string | null;
    judgeError: string | null;
    judgeDatasetId: string | null;
    projectBase: string | null;
}

const summaries: ModelRunSummary[] = [];
let flushFailed = false;

const variants = models.flatMap((model) =>
    surfaces.flatMap((surface) => skillSets.map((skillSet) => ({ model, surface, skillSet }))),
);
for (const { model, surface, skillSet } of variants) {
    const harness = { ...baseHarness, model };
    const skillLabel = skillSetLabel(skillSet);
    const variantItems = Array.from({ length: safeRepeats }, () => itemsFor(surface)).flat();
    if (variantItems.length === 0) {
        log.warning(`Surface ${surface.name}: no selected scenario applies to it (scenario \`surfaces\`); skipped`);
        continue;
    }
    const shortModel = model.replace(/^[^/]+\//, '');
    const nameParts = [datasetName, shortModel];
    if (harness.kind !== 'claude-code') nameParts.push(harness.kind);
    if (surfacesVaried) nameParts.push(`surface:${surface.name}`);
    if (skillsVaried) nameParts.push(`skills:${skillLabel}`);
    if (!fullScope) nameParts.push(scope);
    if (safeRepeats > 1) nameParts.push(`×${safeRepeats}`);
    nameParts.push(stamp);
    if (trigger !== 'unknown') nameParts.push(trigger);
    // Experiment names are unique per dataset: two runs started in the same
    // minute would otherwise merge into one experiment (three did on 22 Sept).
    const runTag = (process.env.APIFY_ACTOR_RUN_ID ?? '').slice(-5).toLowerCase();
    if (runTag) nameParts.push(runTag);
    const effectiveRunName = runName ?? nameParts.join(' · ');

    const started = Date.now();
    let result;
    try {
        result = await langfuse.experiment.run({
            name: datasetName,
            runName: effectiveRunName,
            description: [
                `Runner: ${harness.kind} / ${model}`,
                `Surface: ${surface.name}${surface.cliVersion ? ` (CLI ${surface.cliVersion})` : ''}`,
                `Skills: ${skillLabel}`,
                `Scope: ${scope}`,
                judge ? `Judge: ${judgeModel}` : 'Not judged',
                consoleRunUrl,
            ]
                .filter(Boolean)
                .join(' · '),
            metadata: {
                harness: harness.kind,
                model,
                skillSet: skillLabel,
                agentSkills: skillSet,
                surface: surface.name,
                surfaceKind: surface.kind,
                ...(surface.cliVersion ? { cliVersion: surface.cliVersion } : {}),
                runner: 'workflow-runner',
                actorRunId,
                repeats: safeRepeats,
                scope,
                fullScope,
                trigger,
                scenarioCount: selected.length,
                models,
                environment: actorRunId ? 'apify' : 'local',
            },
            data: variantItems,
            maxConcurrency: concurrency,
            task: async (item) => {
                const r = await runSession({
                    item: item as never,
                    datasetName,
                    trigger,
                    repeats: safeRepeats,
                    harness,
                    mcpUrl: surface.spec.mcpUrl ?? mcpUrl,
                    apifyToken,
                    mcpEnv,
                    surface,
                    skillSet,
                    skillsRoot: skillsDir,
                    useOpenRouterProxy,
                    perItemTimeoutSecs,
                    artifactStore,
                    snapshots,
                    references,
                    writeScore,
                });
                return r.output;
            },
            // Deterministic checks are scored inside runSession (they need the
            // evidence); the LLM rubric belongs to the Judge Actor.
            evaluators: [],
        });
    } finally {
        // Flush telemetry after every model so completed items keep their
        // traces even if a later model breaks (the judge handoff depends on them).
        try {
            await langfuse.flush();
        } catch (err) {
            flushFailed = true;
            log.warning(`Langfuse flush failed: ${err}`);
        }
    }

    const datasetRunId = result.datasetRunId ?? null;
    const datasetRunUrl: string | null = result.datasetRunUrl ?? null;
    const urlParts = datasetRunUrl?.match(/^(https?:\/\/[^/]+)\/project\/([^/]+)\//);
    // The compare view is the team-facing results page: one row per scenario,
    // scores as columns, this run as the baseline.
    const resultsUrl =
        urlParts && datasetRunId
            ? `${urlParts[1]}/project/${urlParts[2]}/experiments/results?baseline=${datasetRunId}`
            : datasetRunUrl;

    // Judge: a separate Actor (re-gradable, spec D9) that the runner starts so a
    // single Run click produces scored results. It uses its own Actor env for
    // Langfuse unless this run was given override credentials, which are passed
    // on so both Actors talk to the same project.
    let judgeOutput: JudgeOutput | null = null;
    let judgeRunUrl: string | null = null;
    let judgeError: string | null = null;
    let judgeDatasetId: string | null = null;
    if (judge && datasetRunId) {
        const judgeActor = process.env.JUDGE_ACTOR ?? DEFAULT_JUDGE_ACTOR;
        log.info(`Starting judge ${judgeActor} for run ${datasetRunId}`);
        try {
            const judgeRun = await Actor.call(
                judgeActor,
                {
                    datasetRunId,
                    datasetName,
                    judgeModel,
                    writeRunScores: fullScope,
                    ...(artifactStoreId ? { artifactStore: artifactStoreId } : {}),
                    ...judgeLangfuseInput(input, process.env),
                },
                { memory: 1024, timeout: 1800 },
            );
            judgeRunUrl = `https://console.apify.com/actors/runs/${judgeRun.id}`;
            judgeDatasetId = judgeRun.defaultDatasetId;
            if (judgeRun.status !== 'SUCCEEDED') {
                judgeError = `judge run ${judgeRun.id} ended with ${judgeRun.status}`;
                log.error(judgeError);
            } else {
                const record = await Actor.apifyClient
                    .keyValueStore(judgeRun.defaultKeyValueStoreId)
                    .getRecord('OUTPUT');
                judgeOutput = (record?.value ?? null) as JudgeOutput | null;
            }
        } catch (err) {
            judgeError = String((err as Error).message ?? err).slice(0, 300);
            log.error(`Judge failed: ${judgeError}`);
        }
    }

    await Actor.pushData(
        result.itemResults.map((r) => ({
            model,
            surface: surface.name,
            skillSet: skillLabel,
            input: r.input,
            output: typeof r.output === 'string' ? r.output.slice(0, OUTPUT_PREVIEW_CAP) : r.output,
            expectedOutput: r.expectedOutput ?? null,
            traceId: r.traceId ?? null,
        })),
    );

    summaries.push({
        model,
        surface: surface.name,
        skillSet: skillLabel,
        agentSkills: skillSet,
        resultsUrl,
        datasetRunId,
        datasetRunName: result.runName ?? null,
        datasetRunUrl,
        items: variantItems.length,
        // itemResults excludes items whose task threw (broken harness); the gap
        // between items and completed is the health signal (spec D13).
        completed: result.itemResults.length,
        suiteMs: Date.now() - started,
        judge: judgeOutput,
        judgeRunUrl,
        judgeError,
        judgeDatasetId,
        projectBase: urlParts ? `${urlParts[1]}/project/${urlParts[2]}` : null,
    });
    log.info(
        `Model ${model}, surface ${surface.name}, skills ${skillLabel}: ${result.itemResults.length}/${variantItems.length} sessions completed; results ${resultsUrl}`,
    );
}

try {
    await otel.shutdown();
} catch (err) {
    log.warning(`OTel shutdown failed: ${err}`);
}

// ---------------------------------------------------------------------------
// OUTPUT and exit code
// ---------------------------------------------------------------------------

const first = summaries[0];
const totalItems = summaries.reduce((a, s) => a + s.items, 0);
const totalCompleted = summaries.reduce((a, s) => a + s.completed, 0);
const completedRatio = totalItems === 0 ? 1 : totalCompleted / totalItems;
const judgeFailed = judge && summaries.some((s) => s.judgeError !== null);

// The configurations compared in one table: every (model, surface, skill set)
// with its rates, best first. Equal pass rates are broken by checks, then fewer skills.
const rate = (x: number | null | undefined) => (typeof x === 'number' ? x : null);
const variantRows = summaries
    .map((s) => ({
        model: s.model,
        surface: s.surface,
        skillSet: s.skillSet,
        agentSkills: s.agentSkills,
        passRate: rate(s.judge?.passRate),
        foundRate: rate(s.judge?.foundRate),
        worksRate: rate(s.judge?.worksRate),
        checksPassRate: s.judge?.checksTotal
            ? Number(((s.judge.checksPassed ?? 0) / s.judge.checksTotal).toFixed(3))
            : null,
        inconclusive: s.judge?.inconclusive ?? null,
        completed: s.completed,
        items: s.items,
        resultsUrl: s.resultsUrl,
    }))
    .sort(
        (a, b) =>
            (b.passRate ?? -1) - (a.passRate ?? -1) ||
            (b.checksPassRate ?? -1) - (a.checksPassRate ?? -1) ||
            a.agentSkills.length - b.agentSkills.length,
    );

const summary = {
    resultsUrl: first.resultsUrl,
    passRate: first.judge?.passRate ?? null,
    passed: first.judge?.passed ?? null,
    judged: first.judge?.judged ?? null,
    inconclusive: first.judge?.inconclusive ?? null,
    foundRate: first.judge?.foundRate ?? null,
    worksRate: first.judge?.worksRate ?? null,
    checksPassed: first.judge?.checksPassed ?? null,
    checksTotal: first.judge?.checksTotal ?? null,
    disagreements: first.judge?.disagreements ?? null,
    actorRunsCostUsd: first.judge?.actorRunsCostUsd ?? null,
    fixAreas: first.judge?.fixAreas ?? null,
    flaky: first.judge?.flaky ?? null,
    scoreboard: first.judge?.scoreboard ?? null,
    judgeRunUrl: first.judgeRunUrl,
    datasetName,
    scope,
    fullScope,
    trigger,
    datasetRunId: first.datasetRunId,
    datasetRunName: first.datasetRunName,
    datasetRunUrl: first.datasetRunUrl,
    scenarios: selected.length,
    repeats: safeRepeats,
    items: first.items,
    completed: first.completed,
    suiteMs: first.suiteMs,
    harness: baseHarness.kind,
    model: first.model,
    models,
    surfaces: surfaces.map((x) => x.name),
    skillSets: skillSets.map(skillSetLabel),
    // One row per (model, surface, skill set), best pass rate first; null when not judged.
    variants: variantRows,
    bestVariant: variantRows[0]?.passRate !== null ? variantRows[0] : null,
    judgeModel: judge ? judgeModel : null,
    health: { completedRatio: Number(completedRatio.toFixed(3)), threshold: healthThreshold, judgeFailed, flushFailed },
    // One entry per model when `models` was given; the top-level fields mirror the first.
    runs: summaries,
};
log.info(`SUMMARY: ${JSON.stringify(summary, null, 2)}`);
await Actor.setValue('OUTPUT', summary);
if (summary.passRate !== null) {
    log.info(`Pass rate ${Math.round(summary.passRate * 100)}% (${summary.passed}/${summary.judged} scenarios)`);
}
for (const s of summaries) log.info(`Results (${s.model}, ${s.surface}, skills ${s.skillSet}): ${s.resultsUrl}`);
if (multiVariant && variantRows.some((v) => v.passRate !== null)) {
    log.info(
        `Variants by pass rate:\n${variantRows
            .map(
                (v) =>
                    `  ${`${v.surface} · skills:${v.skillSet}`.padEnd(60)} ${v.passRate === null ? 'n/a' : `${Math.round(v.passRate * 100)}%`} (${v.model})`,
            )
            .join('\n')}`,
    );
}

// Slack digest: scheduled runs post by default, manual runs only when asked.
// Per-scenario rows come from the judge's dataset; the previous pass rate
// from the last run-level pass_rate score that is not this run's.
if (shouldNotify(input.notify, trigger)) {
    for (const s of summaries) {
        if (!s.judge || !s.judgeDatasetId) continue;
        try {
            const judgeItems = (
                await Actor.apifyClient.dataset(s.judgeDatasetId).listItems({ clean: true, limit: 1000 })
            ).items as {
                title?: string;
                itemOwner?: string;
                itemTeam?: string;
                itemSubject?: string;
                itemActor?: string;
                verdictLabel?: string;
                fixArea?: string;
                traceId?: string;
                overallEvidence?: string;
                status?: string;
            }[];
            let previousPassRate: number | null = null;
            if (fullScope) {
                try {
                    const page = (await langfuse.api.scoresV3.getManyV3({
                        name: 'pass_rate',
                        limit: 10,
                        fields: 'subject',
                    })) as unknown as {
                        data?: { value?: unknown; subject?: { id?: string } }[];
                    };
                    const prev = (page.data ?? []).find((sc) => sc.subject?.id && sc.subject.id !== s.datasetRunId);
                    previousPassRate = prev && typeof prev.value === 'number' ? prev.value : null;
                } catch (err) {
                    log.warning(`previous pass rate lookup failed: ${err}`);
                }
            }
            const sent = await postDigest({
                suite: datasetName,
                model: [
                    s.model,
                    ...(surfacesVaried ? [`surface:${s.surface}`] : []),
                    ...(skillsVaried ? [`skills:${s.skillSet}`] : []),
                ].join(' · '),
                scope,
                fullScope,
                trigger,
                resultsUrl: s.resultsUrl,
                runName: s.datasetRunName,
                passRate: s.judge.passRate ?? null,
                previousPassRate,
                judged: s.judge.judged ?? 0,
                passed: s.judge.passed ?? 0,
                inconclusive: s.judge.inconclusive ?? 0,
                disagreements: s.judge.disagreements ?? 0,
                actorRunsCostUsd: s.judge.actorRunsCostUsd ?? null,
                fixAreas: s.judge.fixAreas ?? {},
                scenarios: judgeItems
                    .filter((it) => it.status === 'judged')
                    .map((it) => ({
                        title: it.title ?? 'untitled scenario',
                        owner: it.itemOwner ?? it.itemTeam ?? 'unknown',
                        subject: it.itemSubject ?? it.itemActor ?? 'unknown',
                        verdict: it.verdictLabel ?? 'unknown',
                        fixArea: it.fixArea ?? 'none',
                        traceUrl: it.traceId && s.projectBase ? `${s.projectBase}/traces/${it.traceId}` : null,
                        reason: it.overallEvidence ?? '',
                    })),
            });
            log.info(`Slack digest: ${sent} message(s) posted for ${s.model}`);
        } catch (err) {
            log.warning(`Slack digest failed: ${err}`);
        }
    }
}

let exitCode: number = EXIT.ok;
let statusMessage = `${totalCompleted}/${totalItems} sessions, pass rate ${summary.passRate === null ? 'n/a' : `${Math.round(summary.passRate * 100)}%`}`;
if (completedRatio < healthThreshold) {
    exitCode = EXIT.health;
    statusMessage = `Health: only ${totalCompleted}/${totalItems} sessions completed (threshold ${healthThreshold})`;
} else if (judgeFailed) {
    exitCode = EXIT.judge;
    statusMessage = `Judge failed: ${summaries.find((s) => s.judgeError)?.judgeError}`;
} else if (flushFailed) {
    exitCode = EXIT.flush;
    statusMessage = 'Langfuse flush failed; some traces may be missing';
}
if (exitCode !== EXIT.ok) log.error(statusMessage);
await Actor.exit({ exitCode, statusMessage });
