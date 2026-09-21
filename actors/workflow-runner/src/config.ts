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
