import { log } from 'apify';

import { type JevCaller, type NoulQuestion } from './jev.js';
import { fetchTraceObservations, type OnlineTurn, reconstructTurn, type TurnMessage } from './online-turn.js';

/**
 * Online input classifier (#29): before the judge runs, reject the turns that
 * cannot be evaluated, so a user who typed only `2` with no context does not
 * add noise to `agent_judge` and the daily rollup.
 *
 * Two stages. Deterministic rules first (`ruleVerdict`), then one TypeSafe Jev
 * `noul` question (`classifyTurn`). A Jev failure fails OPEN: the trace is
 * judged anyway and counted in `classifierFailed`, so the gate can never hold
 * the checkpoint. `classifyBatch` runs both stages over the sample and, in
 * enforce mode, tops the sample up from the unsampled completed traces.
 *
 * Nothing here writes to Langfuse: the caller passes `onIneligible`, which
 * writes the `agent_judge_eligible = 0` score (online-scores.ts).
 */

/** BOOLEAN trace score written only on a skipped turn, always 0; eligible turns get none. */
export const ELIGIBLE_SCORE_NAME = 'agent_judge_eligible';

export const CLASSIFIER_MODES = ['off', 'shadow', 'enforce'] as const;
export type ClassifierMode = (typeof CLASSIFIER_MODES)[number];

/** The input schema default. The scheduled Task starts at `shadow` (see schedule/README.md). */
export const DEFAULT_CLASSIFIER_MODE: ClassifierMode = 'enforce';
/** Pinned, not the floating `~typesafe/jev-latest`: the model is part of the skip score id. */
export const DEFAULT_CLASSIFIER_MODEL = 'typesafe/jev-1.13';
/** Skip only when P(yes) is below this. Low on purpose: the gate skips only when Jev is confident. */
export const DEFAULT_CLASSIFIER_THRESHOLD = 0.3;
/** The top-up stops after this many times the target in classification attempts. */
export const DEFAULT_MAX_CLASSIFY_FACTOR = 3;

/**
 * After this many Jev failures in a row, the rest of the batch fails open
 * without a call. One call can take 94 s when Jev is down (`JEV_ATTEMPT_TIMEOUT_MS`),
 * and 100 of them before the judge starts would push the run past its timeout,
 * which holds the checkpoint.
 */
export const MAX_CONSECUTIVE_JEV_FAILURES = 5;

/**
 * Wall-clock budget of the whole classification phase, top-up included. After
 * it, every trace not yet classified fails open (it goes to the judge
 * unclassified) and the top-up stops. The breaker above covers a Jev that is
 * down; this covers a Jev that is slow or fails only now and then, which the
 * breaker never trips on. 20 min plus the judge's documented worst case
 * (152 min, schedule/README.md) stays under the Task's 3 h timeout.
 */
export const CLASSIFY_BUDGET_MS = 20 * 60_000;

// ---------------------------------------------------------------------------
// Stage 1: deterministic rules
// ---------------------------------------------------------------------------

export type RuleId = 'empty' | 'punctuation-only' | 'emoji-only' | 'digits-only' | 'too-short';

/**
 * Whitespace and every invisible character: format characters (zero-width
 * space and joiners, soft hyphen, invisible operators U+2061-2064, emoji tag
 * characters) and the other default-ignorable code points (variation selectors,
 * Hangul fillers). Removing the joiner, the variation selector and the tags
 * leaves the visible base of an emoji sequence, which the checks below read.
 */
const INVISIBLE = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;
/**
 * What is left of a punctuation-or-emoji message after INVISIBLE: punctuation,
 * symbols (which include the pictographs and the regional indicators of a flag),
 * skin-tone modifiers and the keycap mark of `#️⃣`.
 */
const SYMBOLS_ONLY = /^[\p{P}\p{S}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u20e3]+$/u;
/**
 * Read on the message with only whitespace removed, so the variation selector
 * is still there: a character drawn as an emoji by default, a pictograph with
 * U+FE0F, a flag or a keycap. `©` and `™` alone stay text symbols.
 */
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f|\p{Regional_Indicator}|\u20e3/u;
const DIGITS_ONLY = /^\p{Nd}+$/u;
/** Fewer visible characters than this, with no earlier messages, is rejected. */
export const MIN_PROMPT_CHARS = 3;

/**
 * The rule that rejects the turn, or null when the rules let it through to Jev.
 *
 * Always rejected: empty or whitespace-only, punctuation-only, emoji-only.
 * Only when the turn has NO earlier messages: digits-only and fewer than
 * MIN_PROMPT_CHARS characters. The judge sees up to 10 earlier messages, so a
 * `2` that answers "choose 1-3" is a valid turn and must reach Jev. There is
 * no word list ("hi", "test", "ok"): Jev handles those.
 */
export function ruleVerdict(turn: Pick<OnlineTurn, 'prompt' | 'priorMessages'>): RuleId | null {
    const compact = turn.prompt.replace(INVISIBLE, '');
    if (compact.length === 0) return 'empty';
    if (SYMBOLS_ONLY.test(compact)) {
        return EMOJI.test(turn.prompt.replace(/\s+/gu, '')) ? 'emoji-only' : 'punctuation-only';
    }
    if (turn.priorMessages.length > 0) return null;
    if (DIGITS_ONLY.test(compact)) return 'digits-only';
    if ([...compact].length < MIN_PROMPT_CHARS) return 'too-short';
    return null;
}

// ---------------------------------------------------------------------------
// Stage 2: Jev
// ---------------------------------------------------------------------------

export const EVALUABLE_QUESTION_NAME = 'evaluable';

/** Hard-coded on purpose (not in Langfuse prompt management): the skip score id does not carry a prompt version. */
export const EVALUABLE_QUESTION: NoulQuestion = {
    type: 'noul',
    instructions:
        'The state is one user turn of a chat with Apify AI, an assistant that uses tools on the Apify platform ' +
        '(web scraping, Actors, datasets). "prompt" is the message the user sent in this turn. "priorMessages" are ' +
        'the earlier messages of the same chat, oldest first; they can be empty. Can this turn be evaluated? A turn ' +
        'can be evaluated when the user message, read together with the earlier messages, asks for something or ' +
        'says something that an assistant can act on or answer. The topic does not matter: a request that is not ' +
        'about Apify or web scraping can be evaluated.',
    criteria: {
        true:
            'The message has content that makes sense, alone or together with the earlier messages. Examples: a task, ' +
            'a question, a request on any topic, a follow-up that refers to or answers an earlier message (also one ' +
            'number or one word that selects an option the assistant offered), a confirmation of a step the ' +
            'assistant proposed.',
        false:
            'The message has no content that an assistant can act on, or it does not make sense even with the ' +
            'earlier messages. Examples: random keys or gibberish, only a greeting, a test word or an acknowledgement ' +
            'that asks for nothing and answers nothing earlier, a number or a fragment with no context, abuse or ' +
            'insults with no request.',
    },
};

/**
 * Jev's context is 262,144 tokens, but the TypeSafe guide sends a state above
 * about 32,000 bytes to a long-context mode that is slower and less accurate.
 * So the state is capped in UTF-8 bytes of its JSON, with some room below
 * that line: CJK text takes 3 bytes per character, and JSON escapes add more.
 */
export const MAX_STATE_BYTES = 30_000;
/** Per text, before the whole state is fitted: the prompt keeps the most room. */
export const MAX_STATE_PROMPT_BYTES = 12_000;
export const MAX_STATE_MESSAGE_BYTES = 3_000;

const utf8Bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));

/** `text` cut in the middle, on code points, until its UTF-8 size is at most `maxBytes`. */
function cutMiddle(text: string, maxBytes: number): string {
    if (utf8Bytes(text) <= maxBytes) return text;
    const chars = [...text];
    let keep = Math.floor((chars.length * maxBytes) / utf8Bytes(text));
    for (;;) {
        const half = Math.max(0, Math.floor(keep / 2));
        const cut = `${chars.slice(0, half).join('')}\n[... ${chars.length - 2 * half} chars omitted ...]\n${chars
            .slice(chars.length - half)
            .join('')}`;
        if (utf8Bytes(cut) <= maxBytes || half === 0) return cut;
        keep = Math.floor(keep * 0.9);
    }
}

export interface ClassifierState {
    prompt: string;
    priorMessages: TurnMessage[];
}

/**
 * What Jev sees: the user message and the earlier messages, never the agent's
 * answer to this turn. Long texts are cut in the middle, then the oldest
 * earlier messages are dropped until `JSON.stringify(state)` is at most
 * MAX_STATE_BYTES.
 */
export function classifierState(turn: Pick<OnlineTurn, 'prompt' | 'priorMessages'>): ClassifierState {
    const prompt = cutMiddle(turn.prompt, MAX_STATE_PROMPT_BYTES);
    const priorMessages = turn.priorMessages.map(({ role, text }) => ({
        role,
        text: cutMiddle(text, MAX_STATE_MESSAGE_BYTES),
    }));
    while (priorMessages.length > 0 && utf8Bytes({ prompt, priorMessages }) > MAX_STATE_BYTES) priorMessages.shift();
    return { prompt, priorMessages };
}

export type Classification =
    | { verdict: 'eligible'; probability: number; servedModel: string | null; costUsd: number | null }
    | { verdict: 'ineligible'; stage: 'rule'; rule: RuleId }
    | { verdict: 'ineligible'; stage: 'model'; probability: number; servedModel: string | null; costUsd: number | null }
    /** Jev or the trace read failed: the trace is judged anyway (fail open). */
    | { verdict: 'failed'; error: string };

export type Ineligible = Extract<Classification, { verdict: 'ineligible' }>;

export interface ClassifierConfig {
    apifyToken: string;
    model: string;
    threshold: number;
    callJev: JevCaller;
}

/** Rules, then Jev. Never throws: a Jev failure is a `failed` classification. */
export async function classifyTurn(
    turn: Pick<OnlineTurn, 'prompt' | 'priorMessages'>,
    { apifyToken, model, threshold, callJev }: ClassifierConfig,
): Promise<Classification> {
    const rule = ruleVerdict(turn);
    if (rule) return { verdict: 'ineligible', stage: 'rule', rule };
    try {
        const answer = await callJev({
            apifyToken,
            model,
            state: classifierState(turn),
            questions: { [EVALUABLE_QUESTION_NAME]: EVALUABLE_QUESTION },
        });
        const probability = answer.noul[EVALUABLE_QUESTION_NAME];
        const reply = { probability, servedModel: answer.model, costUsd: answer.costUsd };
        return probability < threshold
            ? { verdict: 'ineligible', stage: 'model', ...reply }
            : { verdict: 'eligible', ...reply };
    } catch (err) {
        return { verdict: 'failed', error: String(err).slice(0, 300) };
    }
}

/**
 * `callJev` that stops calling after `limit` failures in a row and throws at
 * once instead, so a Jev outage costs at most `limit` slow calls per batch.
 * Any success resets the count.
 */
export function withCircuitBreaker(callJev: JevCaller, limit: number = MAX_CONSECUTIVE_JEV_FAILURES): JevCaller {
    let consecutiveFailures = 0;
    return async (request) => {
        if (consecutiveFailures >= limit) {
            throw new Error(`Jev skipped: ${consecutiveFailures} calls in a row failed in this batch`);
        }
        try {
            const result = await callJev(request);
            consecutiveFailures = 0;
            return result;
        } catch (err) {
            consecutiveFailures++;
            throw err;
        }
    };
}

export interface TraceClassification {
    classification: Classification;
    /** The reconstructed turn, kept so the judge does not fetch the trace again; absent when the read failed. */
    turn?: OnlineTurn;
}

export type TraceClassifier = (traceId: string) => Promise<TraceClassification>;

/**
 * The production classifier for one trace: fetch, reconstruct, classify. A
 * trace that cannot be read or rebuilt fails open too: the judge then tries
 * it and counts it in `failedToJudge` if it fails there as well.
 */
export function traceClassifier({
    langfuse,
    ...config
}: ClassifierConfig & { langfuse: Parameters<typeof fetchTraceObservations>[0] }): TraceClassifier {
    return async (traceId) => {
        let turn: OnlineTurn;
        try {
            turn = reconstructTurn(traceId, await fetchTraceObservations(langfuse, traceId));
        } catch (err) {
            return { classification: { verdict: 'failed', error: `trace read failed: ${String(err).slice(0, 300)}` } };
        }
        return { classification: await classifyTurn(turn, config), turn };
    };
}

// ---------------------------------------------------------------------------
// The batch: classify the sample, top it up in enforce mode
// ---------------------------------------------------------------------------

export interface ClassifierCounters {
    /** Every trace classified, the top-up included. */
    attempts: number;
    skippedIneligible: { rule: number; model: number };
    /** Failed open: Jev or the trace read failed, the trace went to the judge. */
    classifierFailed: number;
    /** Traces taken from the unsampled reserve (enforce only). */
    toppedUp: number;
    /** Skip scores that could not be written; the trace is still not judged in enforce mode. */
    skipScoreWriteFailed: number;
    /** Traces not classified because CLASSIFY_BUDGET_MS ran out; also in `classifierFailed`. */
    budgetExceeded: number;
    /** Sum of Jev `usage.cost` over the batch, USD. */
    costUsd: number;
}

export interface ClassifyBatchResult {
    /** The traces to judge, in classification order. */
    toJudge: string[];
    /** Reconstructed turns by trace id, for the judge. */
    turns: Map<string, OnlineTurn>;
    /** Eligible traces the judge must get: the sampled traces that were not already processed. */
    target: number;
    /** False when enforce mode could not find `target` eligible traces within `maxAttempts` or the reserve. */
    targetReached: boolean;
    /** Traces that got `agent_judge_eligible = 0`, in classification order (judged anyway in shadow mode). */
    ineligible: string[];
    /** Traces taken from the reserve and classified (enforce only). */
    toppedUp: string[];
    counters: ClassifierCounters;
}

export interface ClassifyBatchOptions {
    mode: Exclude<ClassifierMode, 'off'>;
    /** The sample after `skipAlreadyJudged()`. */
    initial: string[];
    /** The unsampled completed traces, in shuffled order (`Selection.unsampledTraceIds`). */
    reserve: string[];
    /** `ceil(maxClassifyFactor * target)`; the top-up stops when this many traces were classified. */
    maxAttempts: number;
    concurrency: number;
    classify: TraceClassifier;
    /** `skipAlreadyJudged()` over a slice of the reserve: returns the ids that still need processing. */
    filterProcessed: (traceIds: string[]) => Promise<string[]>;
    /** Writes the `agent_judge_eligible = 0` score. A throw is counted, never fatal. */
    onIneligible: (traceId: string, classification: Ineligible) => Promise<void>;
    /** Default CLASSIFY_BUDGET_MS. */
    budgetMs?: number;
    /** Test seam for the clock. */
    now?: () => number;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
    return out;
}

function describe(c: Classification): string {
    switch (c.verdict) {
        case 'eligible':
            return `eligible (P(yes)=${c.probability.toFixed(3)})`;
        case 'failed':
            return `classifier failed, judged anyway: ${c.error}`;
        default:
            return c.stage === 'rule'
                ? `ineligible (rule ${c.rule})`
                : `ineligible (P(yes)=${c.probability.toFixed(3)})`;
    }
}

/**
 * Classify the sample. In shadow mode every sampled trace still goes to the
 * judge and nothing is topped up; the skip scores are written either way. In
 * enforce mode an ineligible trace is not judged, and each one is replaced by
 * the next unprocessed trace of the reserve until `target` traces are
 * eligible, the reserve runs out, or `maxAttempts` traces were classified.
 */
export async function classifyBatch(opts: ClassifyBatchOptions): Promise<ClassifyBatchResult> {
    const { mode, initial, reserve, maxAttempts, concurrency, classify, filterProcessed, onIneligible } = opts;
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.budgetMs ?? CLASSIFY_BUDGET_MS);
    const target = initial.length;
    const turns = new Map<string, OnlineTurn>();
    const eligible: string[] = [];
    const ineligible: string[] = [];
    const toppedUp: string[] = [];
    const counters: ClassifierCounters = {
        attempts: 0,
        skippedIneligible: { rule: 0, model: 0 },
        classifierFailed: 0,
        toppedUp: 0,
        skipScoreWriteFailed: 0,
        budgetExceeded: 0,
        costUsd: 0,
    };
    const servedModels = new Set<string>();

    async function classifyInBudget(traceId: string): Promise<TraceClassification> {
        if (now() < deadline) return classify(traceId);
        counters.budgetExceeded++;
        return { classification: { verdict: 'failed', error: 'classifier time budget spent' } };
    }

    async function round(traceIds: string[]) {
        counters.attempts += traceIds.length;
        const results = await mapWithConcurrency(traceIds, concurrency, async (traceId) => {
            const result = await classifyInBudget(traceId);
            const c = result.classification;
            log.info(`${traceId}: ${describe(c)}`);
            if ('costUsd' in c && c.costUsd !== null) {
                counters.costUsd += c.costUsd;
                log.debug(`${traceId}: Jev cost ${c.costUsd} USD`);
            }
            const servedModel = 'servedModel' in c ? c.servedModel : null;
            if (servedModel && !servedModels.has(servedModel)) {
                servedModels.add(servedModel);
                log.info(`Classifier answered with model ${servedModel}`);
            }
            if (c.verdict === 'ineligible') {
                try {
                    await onIneligible(traceId, c);
                } catch (err) {
                    counters.skipScoreWriteFailed++;
                    log.warning(`${traceId}: ${ELIGIBLE_SCORE_NAME} score write failed: ${err}`);
                }
            }
            return { traceId, ...result };
        });
        for (const { traceId, classification: c, turn } of results) {
            if (c.verdict === 'failed') counters.classifierFailed++;
            if (c.verdict === 'ineligible') {
                counters.skippedIneligible[c.stage]++;
                ineligible.push(traceId);
            }
            const judge = mode === 'shadow' || c.verdict !== 'ineligible';
            if (!judge) continue;
            eligible.push(traceId);
            if (turn) turns.set(traceId, turn);
        }
    }

    await round(initial);
    let cursor = 0;
    let readFailed = false;
    while (
        !readFailed &&
        mode === 'enforce' &&
        eligible.length < target &&
        counters.attempts < maxAttempts &&
        now() < deadline
    ) {
        const want = Math.min(target - eligible.length, maxAttempts - counters.attempts);
        const chunk: string[] = [];
        while (chunk.length < want && cursor < reserve.length) {
            const slice = reserve.slice(cursor, cursor + want - chunk.length);
            cursor += slice.length;
            try {
                chunk.push(...(await filterProcessed(slice)));
            } catch (err) {
                // A failed score read stops the top-up, never the run: what is
                // eligible so far is judged and targetReached reports the gap.
                log.warning(`Classifier top-up stopped, reading existing scores failed: ${err}`);
                readFailed = true;
                break;
            }
        }
        if (chunk.length === 0 || readFailed) break;
        counters.toppedUp += chunk.length;
        toppedUp.push(...chunk);
        await round(chunk);
    }

    counters.costUsd = Number(counters.costUsd.toFixed(6));
    log.info(
        `Classifier: ${counters.attempts} classified, ${ineligible.length} skipped, ` +
            `${counters.classifierFailed} failed open, Jev cost ${counters.costUsd} USD`,
    );
    if (counters.budgetExceeded > 0) {
        log.warning(`Classifier time budget spent: ${counters.budgetExceeded} traces go to the judge unclassified`);
    }
    const targetReached = eligible.length >= target;
    if (!targetReached) {
        log.warning(
            `Classifier top-up stopped at ${eligible.length} of ${target} eligible traces after ` +
                `${counters.attempts} classifications (limit ${maxAttempts}, reserve ${reserve.length})`,
        );
    }
    return { toJudge: eligible, turns, target, targetReached, ineligible, toppedUp, counters };
}
