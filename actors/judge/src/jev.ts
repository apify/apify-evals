/**
 * One TypeSafe Jev decision through the Apify OpenRouter proxy (#29).
 *
 * Jev is a "System One" model: it returns typed answers, not text, on
 * `/api/v1/systemone`, not on chat/completions, so `llm.ts` does not fit. The
 * body is `{model, state, questions}`; there is no system prompt, no
 * temperature and no max_tokens. `questions` and `answers` are objects keyed
 * by question name. A `noul` answer is `{type: 'noul', noul: P(yes)}`.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { MAX_ATTEMPTS, RETRY_SLEEP_MS } from './llm.js';

const SYSTEM_ONE_URL = 'https://openrouter.apify.actor/api/v1/systemone';

/**
 * Per-attempt HTTP timeout. Shorter than the judge's 120 s: a decision model
 * answers fast, and a slow gate must not eat the run's time budget. Worst case
 * per call is `MAX_ATTEMPTS * JEV_ATTEMPT_TIMEOUT_MS + (MAX_ATTEMPTS - 1) * RETRY_SLEEP_MS`,
 * 34 s at these values.
 */
export const JEV_ATTEMPT_TIMEOUT_MS = 10_000;

export interface NoulQuestion {
    type: 'noul';
    instructions: string;
    criteria: { true: string; false: string };
}

export interface JevRequest {
    apifyToken: string;
    model: string;
    state: unknown;
    questions: Record<string, NoulQuestion>;
}

export interface JevResult {
    /** P(yes) per question name. */
    noul: Record<string, number>;
    /** The model id the response names (the concrete model that answered). */
    model: string | null;
}

/** The call the classifier makes; `jevDecide` in production, a fake in tests. */
export type JevCaller = (request: JevRequest) => Promise<JevResult>;

export class InvalidJevReplyError extends Error {
    constructor(reason: string) {
        super(`Invalid Jev reply: ${reason}`);
        this.name = 'InvalidJevReplyError';
    }
}

/** Strict parse: every asked question must come back as a `noul` answer with a probability in [0, 1]. */
export function parseJevReply(body: unknown, questionNames: string[]): JevResult {
    const record = body as { answers?: Record<string, unknown>; model?: unknown } | null;
    if (typeof record !== 'object' || record === null) throw new InvalidJevReplyError('not an object');
    if (typeof record.answers !== 'object' || record.answers === null) {
        throw new InvalidJevReplyError('answers is missing');
    }
    const noul: Record<string, number> = {};
    for (const name of questionNames) {
        const answer = record.answers[name] as { type?: unknown; noul?: unknown } | undefined;
        if (!answer || answer.type !== 'noul') throw new InvalidJevReplyError(`answers.${name} is not a noul answer`);
        const p = answer.noul;
        if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
            throw new InvalidJevReplyError(`answers.${name}.noul ${JSON.stringify(p)} is not a probability`);
        }
        noul[name] = p;
    }
    return { noul, model: typeof record.model === 'string' && record.model ? record.model : null };
}

/**
 * The retry pattern of `judgeLlmCall`: up to MAX_ATTEMPTS attempts with
 * RETRY_SLEEP_MS between them, for any failure (network error, timeout, HTTP
 * error, a body that is not JSON or not a valid answer). Throws the last
 * error; the classifier then fails open.
 */
export async function jevDecide(
    { apifyToken, model, state, questions }: JevRequest,
    fetchImpl: typeof fetch = fetch,
    sleepMs: number = RETRY_SLEEP_MS,
    timeoutMs: number = JEV_ATTEMPT_TIMEOUT_MS,
): Promise<JevResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(sleepMs);
        try {
            const res = await fetchImpl(SYSTEM_ONE_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apifyToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, state, questions }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
            return parseJevReply(JSON.parse(text), Object.keys(questions));
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}
