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

/**
 * `off`: no classifier. `shadow`: write the skip scores, but judge every
 * sampled turn. `enforce`: do not judge a skipped turn, and top the sample up.
 */
export type ClassifierMode = 'off' | 'shadow' | 'enforce';

/**
 * After this many Jev failures in a row, the rest of the batch fails open
 * without a call. One call can take 34 s when Jev is down
 * (`JEV_ATTEMPT_TIMEOUT_MS`), and hundreds of them before the judge starts
 * would push the run past its timeout, which holds the checkpoint.
 */
export const MAX_CONSECUTIVE_JEV_FAILURES = 5;

// ---------------------------------------------------------------------------
// Stage 1: deterministic rules
// ---------------------------------------------------------------------------

export type RuleId = 'no-text' | 'digits-only' | 'too-short';

/** No letter and no digit: empty, whitespace, punctuation, emoji or invisible characters only. */
const NO_TEXT = /^[^\p{L}\p{N}]*$/u;
const DIGITS_ONLY = /^\p{Nd}+$/u;
/** Fewer characters than this (after trim), with no earlier messages, is rejected. */
export const MIN_PROMPT_CHARS = 3;

/**
 * The rule that rejects the turn, or null when the rules let it through to Jev.
 *
 * Always rejected: a message with no letter and no digit. Only when the turn
 * has NO earlier messages: digits only, or fewer than MIN_PROMPT_CHARS
 * characters. The judge sees up to 10 earlier messages, so a `2` that answers
 * "choose 1-3" is a valid turn and must reach Jev. There is no word list
 * ("hi", "test", "ok"): Jev handles those.
 */
export function ruleVerdict(turn: Pick<OnlineTurn, 'prompt' | 'priorMessages'>): RuleId | null {
    const text = turn.prompt.trim();
    if (NO_TEXT.test(text)) return 'no-text';
    if (turn.priorMessages.length > 0) return null;
    if (DIGITS_ONLY.test(text)) return 'digits-only';
    if ([...text].length < MIN_PROMPT_CHARS) return 'too-short';
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
 * TypeSafe sends a state above about 32,000 bytes to a long-context mode that
 * is slower and less accurate. So the state is capped in UTF-8 bytes of its
 * JSON, with some room below that line for JSON escapes.
 */
export const MAX_STATE_BYTES = 30_000;

const utf8Bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export interface ClassifierState {
    prompt: string;
    priorMessages: TurnMessage[];
}

/**
 * `text` cut at the end, on code points, until `size(cut)` is at most
 * MAX_STATE_BYTES; '' when nothing fits.
 */
function cutToFit(text: string, size: (cut: string) => number): string {
    const chars = [...text];
    let cut = text;
    for (let keep = chars.length; keep > 0 && size(cut) > MAX_STATE_BYTES; ) {
        const over = size(cut) - MAX_STATE_BYTES;
        keep = Math.min(keep - 1, keep - Math.ceil((over * keep) / utf8Bytes(cut)));
        cut = chars.slice(0, Math.max(0, keep)).join('');
    }
    return cut;
}

/**
 * What Jev sees: the user message and the earlier messages, never the agent's
 * answer to this turn. When `JSON.stringify(state)` is above MAX_STATE_BYTES,
 * the prompt is cut at the end until it fits alone, then the oldest earlier
 * messages are dropped. The newest earlier message is cut at the end instead
 * of dropped, so a follow-up such as `2` keeps its context.
 */
export function classifierState(turn: Pick<OnlineTurn, 'prompt' | 'priorMessages'>): ClassifierState {
    const prompt = cutToFit(turn.prompt, (cut) => utf8Bytes({ prompt: cut, priorMessages: [] }));
    const priorMessages = turn.priorMessages.map(({ role, text }) => ({ role, text }));
    const fits = () => utf8Bytes({ prompt, priorMessages }) <= MAX_STATE_BYTES;
    while (priorMessages.length > 1 && !fits()) priorMessages.shift();
    if (priorMessages.length === 1 && !fits()) {
        const [{ role, text }] = priorMessages;
        priorMessages[0] = {
            role,
            text: cutToFit(text, (cut) => utf8Bytes({ prompt, priorMessages: [{ role, text: cut }] })),
        };
        // The prompt alone fills the cap.
        if (!fits()) priorMessages.pop();
    }
    return { prompt, priorMessages };
}

export type Classification =
    | { verdict: 'eligible'; probability: number; servedModel: string | null }
    | { verdict: 'ineligible'; stage: 'rule'; rule: RuleId }
    | { verdict: 'ineligible'; stage: 'model'; probability: number; servedModel: string | null }
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
        const { [EVALUABLE_QUESTION_NAME]: probability } = answer.noul;
        return probability < threshold
            ? { verdict: 'ineligible', stage: 'model', probability, servedModel: answer.model }
            : { verdict: 'eligible', probability, servedModel: answer.model };
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

export type TraceClassifier = (traceId: string) => Promise<Classification>;

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
            return { verdict: 'failed', error: `trace read failed: ${String(err).slice(0, 300)}` };
        }
        return classifyTurn(turn, config);
    };
}

// ---------------------------------------------------------------------------
// The batch
// ---------------------------------------------------------------------------

export interface ClassifyBatchOptions {
    mode: ClassifierMode;
    /** The sample after `skipAlreadyJudged()`. */
    initial: string[];
    /** The unsampled completed traces, in shuffled order (`Selection.unsampledTraceIds`). Enforce only. */
    reserve: string[];
    /** The top-up stops when this many traces were classified, the sample included. */
    maxAttempts: number;
    concurrency: number;
    classify: TraceClassifier;
    /** `skipAlreadyJudged()` over a slice of the reserve: returns the ids that still need processing. */
    filterProcessed: (traceIds: string[]) => Promise<string[]>;
    /** Writes the `agent_judge_eligible = 0` score. A throw is logged, never fatal. */
    onIneligible: (traceId: string, classification: Ineligible) => Promise<void>;
}

export interface ClassifyBatchResult {
    /** The traces to judge, in classification order. */
    toJudge: string[];
    skippedIneligible: { rule: number; model: number };
    /** Failed open: Jev or the trace read failed, the trace went to the judge. */
    classifierFailed: number;
    /** False when enforce mode could not find as many eligible traces as the sample had. */
    targetReached: boolean;
}

function describe(c: Classification): string {
    if (c.verdict === 'eligible') return `eligible (P(yes)=${c.probability.toFixed(3)})`;
    if (c.verdict === 'failed') return `classifier failed, judged anyway: ${c.error}`;
    return c.stage === 'rule' ? `ineligible (rule ${c.rule})` : `ineligible (P(yes)=${c.probability.toFixed(3)})`;
}

/**
 * Classify the sample. `off` classifies nothing. In shadow mode the skip
 * scores are written, every sampled trace still goes to the judge and nothing
 * is topped up. In enforce mode a skipped trace is not judged, and each one is
 * replaced by the next unprocessed trace of the reserve until the sample size
 * of traces is eligible, the reserve runs out, or `maxAttempts` traces were
 * classified. A failed score read stops the top-up, never the run.
 */
export async function classifyBatch(opts: ClassifyBatchOptions): Promise<ClassifyBatchResult> {
    const { mode, initial, reserve, maxAttempts, concurrency, classify, filterProcessed, onIneligible } = opts;
    const result: ClassifyBatchResult = {
        toJudge: initial,
        skippedIneligible: { rule: 0, model: 0 },
        classifierFailed: 0,
        targetReached: true,
    };
    if (mode === 'off' || initial.length === 0) return result;
    const servedModels = new Set<string>();
    const classified: string[] = [];
    const ineligible = new Set<string>();

    async function classifyOne(traceId: string) {
        const c = await classify(traceId);
        log.info(`${traceId}: ${describe(c)}`);
        const servedModel = 'servedModel' in c ? c.servedModel : null;
        if (servedModel && !servedModels.has(servedModel)) {
            servedModels.add(servedModel);
            log.info(`Classifier answered with model ${servedModel}`);
        }
        if (c.verdict === 'failed') result.classifierFailed++;
        if (c.verdict !== 'ineligible') return;
        result.skippedIneligible[c.stage]++;
        ineligible.add(traceId);
        try {
            await onIneligible(traceId, c);
        } catch (err) {
            log.warning(`${traceId}: ${ELIGIBLE_SCORE_NAME} score write failed: ${err}`);
        }
    }

    async function round(traceIds: string[]) {
        classified.push(...traceIds);
        let next = 0;
        async function worker() {
            while (next < traceIds.length) await classifyOne(traceIds[next++]);
        }
        await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), traceIds.length) }, worker));
    }

    const target = initial.length;
    const eligible = () => classified.length - ineligible.size;
    await round(initial);
    let cursor = 0;
    while (mode === 'enforce' && eligible() < target && classified.length < maxAttempts && cursor < reserve.length) {
        const want = Math.min(target - eligible(), maxAttempts - classified.length);
        const chunk: string[] = [];
        try {
            while (chunk.length < want && cursor < reserve.length) {
                const slice = reserve.slice(cursor, cursor + want - chunk.length);
                cursor += slice.length;
                chunk.push(...(await filterProcessed(slice)));
            }
        } catch (err) {
            log.warning(`Classifier top-up stopped, reading existing scores failed: ${err}`);
            break;
        }
        if (chunk.length === 0) break;
        await round(chunk);
    }

    result.toJudge = mode === 'shadow' ? classified : classified.filter((id) => !ineligible.has(id));
    result.targetReached = mode === 'shadow' || eligible() >= target;
    log.info(
        `Classifier (${mode}): ${classified.length} classified, ${ineligible.size} skipped, ` +
            `${result.classifierFailed} failed open`,
    );
    if (!result.targetReached) {
        log.warning(`Classifier top-up stopped at ${eligible()} of ${target} eligible traces (limit ${maxAttempts})`);
    }
    return result;
}
