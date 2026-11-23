/**
 * Pure input-resolution helpers shared by `main.ts` and its tests. They live
 * outside `main.ts` because that module is the Actor entry point: importing it
 * would run the whole Actor.
 */

export const DEFAULT_HEALTH_THRESHOLD = 0.9;

/**
 * The schema carries the threshold as a string (Apify has no float editor), so
 * it arrives as `"0.9"` from the Console and as a number from JSON callers.
 * `0` is a legal value that means "never fail on health", so a falsy check
 * would silently replace it with the default; only a non-finite value (empty
 * string, `"abc"`, missing) falls back.
 */
export function resolveHealthThreshold(value: number | string | undefined): number {
    // `Number('')` is 0, so an empty field has to be treated as missing first.
    const trimmed = typeof value === 'string' ? value.trim() : value;
    if (trimmed === '') return DEFAULT_HEALTH_THRESHOLD;
    const parsed = typeof trimmed === 'string' ? Number(trimmed) : trimmed;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return DEFAULT_HEALTH_THRESHOLD;
    return Math.min(1, Math.max(0, parsed));
}

/**
 * Trigger label shown in the run name and the digest. The platform origin for
 * a scheduled run is `SCHEDULER`; it is normalised to `schedule` so the label
 * matches what the input schema documents (schedule, web, api, cli) and so the
 * scheduled-run defaults below can rely on one spelling.
 */
export function resolveTrigger(triggerInput: string | undefined, origin: string | undefined): string {
    const raw = (triggerInput ?? origin ?? 'unknown').trim().toLowerCase();
    if (raw === '') return 'unknown';
    return raw === 'scheduler' ? 'schedule' : raw;
}

/** Scheduled runs post the Slack digest by default; other runs only when asked. */
export function shouldNotify(notify: boolean | undefined, trigger: string): boolean {
    return notify ?? trigger === 'schedule';
}

/** One pass of the model matrix: a model and the harness that runs it. */
export interface ModelEntry {
    model: string;
    kind: string;
}

export const HARNESS_KINDS = ['claude-code', 'codex'] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/**
 * What each harness can run. A harness that gains a feature flips its flag
 * here; `assertHarnessSupport` refuses an unsupported combination before any
 * session is paid for, so a variant never runs silently without its skills.
 */
export interface HarnessSupport {
    /** Agent skills (skill sets) are installed where the harness discovers them. */
    skills: boolean;
    /** MCP servers other than the Apify one (a profile's own `mcp`). */
    foreignMcp: boolean;
    /** Surfaces that are not MCP (the API surface needs a shell and curl). */
    nonMcpSurfaces: boolean;
}

export const HARNESS_SUPPORT: Record<HarnessKind, HarnessSupport> = {
    'claude-code': { skills: true, foreignMcp: true, nonMcpSurfaces: true },
    codex: { skills: true, foreignMcp: false, nonMcpSurfaces: false },
};

/**
 * Refuse a run whose matrix asks a harness for something it cannot do. Checks
 * every model entry, not only the base harness: a `{model, harness: "codex"}`
 * entry in a Claude Code run must not run, say, its `api` surface arm on a
 * harness without that surface.
 */
export function assertHarnessSupport(
    entries: ModelEntry[],
    plan: { skillSets: string[][]; foreignMcp: boolean; surfaceKinds: string[] },
): void {
    const problems: string[] = [];
    for (const kind of new Set(entries.map((e) => e.kind))) {
        const support = HARNESS_SUPPORT[kind as HarnessKind];
        if (!support) continue; // resolveModelEntries already refused unknown kinds
        if (!support.skills && plan.skillSets.some((set) => set.length > 0)) {
            problems.push(`${kind} harness does not support skill sets`);
        }
        if (!support.foreignMcp && plan.foreignMcp) {
            problems.push(`${kind} harness supports only the Apify MCP server`);
        }
        if (!support.nonMcpSurfaces && plan.surfaceKinds.some((k) => k !== 'mcp')) {
            problems.push(`${kind} harness supports only MCP surfaces`);
        }
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
}

/** OpenAI ids, pinned or alias (`openai/gpt-6-luna`, `~openai/gpt-luna-latest`). */
export const isOpenAiModel = (model: string): boolean => /^~?openai\//.test(model);

/**
 * The model matrix as passes. An entry is a model id (run on the base harness)
 * or `{ model, harness }`. OpenAI models are refused on Claude Code: through the
 * Anthropic-to-OpenAI conversion in the proxy they send every tool call with an
 * empty `input`, retry it and run out of turns, so the pass measures nothing.
 */
export function resolveModelEntries(
    entries: (string | { model?: string; harness?: string })[] | undefined,
    base: { kind: string; model: string },
): ModelEntry[] {
    const raw = entries && entries.length > 0 ? entries : [base.model];
    const out: ModelEntry[] = [];
    for (const e of raw) {
        const model = typeof e === 'string' ? e : e?.model;
        const kind = typeof e === 'string' ? base.kind : (e?.harness ?? base.kind);
        const unknown =
            typeof e === 'object' && e ? Object.keys(e).filter((k) => k !== 'model' && k !== 'harness') : [];
        if (unknown.length > 0) {
            throw new Error(
                `models: entry ${JSON.stringify(e)} has unknown keys ${unknown.join(', ')} (allowed: model, harness)`,
            );
        }
        if (typeof model !== 'string' || model.length === 0) {
            throw new Error(`models: entry without a model id: ${JSON.stringify(e)}`);
        }
        if (!(HARNESS_KINDS as readonly string[]).includes(kind)) {
            throw new Error(`models: unknown harness "${kind}" for ${model} (supported: ${HARNESS_KINDS.join(', ')})`);
        }
        if (kind === 'claude-code' && isOpenAiModel(model)) {
            throw new Error(
                `models: ${model} cannot run on the claude-code harness: OpenAI models send empty tool inputs through the Anthropic-format proxy (apify/apify-evals#44). Use {"model": "${model}", "harness": "codex"}.`,
            );
        }
        if (!out.some((o) => o.model === model && o.kind === kind)) out.push({ model, kind });
    }
    return out;
}

/** Langfuse credential inputs and the env vars they override. */
export const LANGFUSE_CREDENTIALS = [
    ['langfuseBaseUrl', 'LANGFUSE_BASE_URL'],
    ['langfusePublicKey', 'LANGFUSE_PUBLIC_KEY'],
    ['langfuseSecretKey', 'LANGFUSE_SECRET_KEY'],
] as const;

type LangfuseCredentialInput = Partial<Record<(typeof LANGFUSE_CREDENTIALS)[number][0], string>>;

/**
 * Langfuse credentials to pass to the judge: the runner's resolved set (`env`
 * already holds input over env). The judge falls back to its own deployed
 * env, which points at one project; a runner that wrote to another project,
 * through override inputs or its own env, would otherwise send the judge to
 * look up a dataset run that does not exist there. The key fields are
 * `isSecret` in the judge schema, so the platform encrypts them.
 */
export function judgeLangfuseInput(env: Record<string, string | undefined>): LangfuseCredentialInput {
    return Object.fromEntries(
        LANGFUSE_CREDENTIALS.filter(([, envKey]) => env[envKey]).map(([inputKey, envKey]) => [inputKey, env[envKey]]),
    );
}
