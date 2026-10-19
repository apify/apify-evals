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

/** What a pass is called in the log and the status message: the model, with its position when there are several. */
export function passLabel(model: string, modelIndex: number, modelCount: number): string {
    return modelCount > 1 ? `Model ${modelIndex + 1}/${modelCount} ${model}` : `Model ${model}`;
}

/**
 * One line per finished session. A pass of 60 sessions takes 15 to 20 minutes
 * and the runner would otherwise log nothing until it ends, which reads as
 * stuck. The same counter goes to the Actor status message, so the Console run
 * list shows it without opening the log.
 */
export function progressLine(p: {
    pass: string;
    done: number;
    total: number;
    running: number;
    itemId: string;
    ms: number;
    failed?: boolean;
}): string {
    const secs = Math.round(p.ms / 1000);
    return `${p.pass}: ${p.done}/${p.total} sessions done, ${p.running} running · ${p.itemId}${p.failed ? ' · failed' : ''} · ${secs} s`;
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
