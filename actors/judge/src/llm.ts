/** One structured judge call through the Apify OpenRouter proxy (OpenAI wire format). */

const PROXY_URL = 'https://openrouter.apify.actor/api/v1/chat/completions';

export interface LlmCallOptions {
    apifyToken: string;
    model: string;
    prompt: string;
    /** JSON Schema the reply must satisfy (sent as response_format when supported). */
    schema?: object;
}

export interface LlmCallResult {
    json: unknown;
    usage: Record<string, number> | null;
    startedAt: number;
    endedAt: number;
}

/** Extract the first JSON object from a model reply (tolerates code fences and prose). */
function extractJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start, end + 1));
}

/** Per-attempt HTTP timeout; `MAX_ATTEMPTS` of these plus the sleeps between them bound one call (see the schedule README). */
export const ATTEMPT_TIMEOUT_MS = 120_000;
export const MAX_ATTEMPTS = 3;
export const RETRY_SLEEP_MS = 2000;

/**
 * Structured output first (`response_format: json_schema`); if the proxy or
 * model rejects it (HTTP 400), retry without it and parse by brace scan.
 * Up to MAX_ATTEMPTS (three) attempts cover transient failures: network
 * errors, timeouts, HTML 502s. Worst case per call is
 * `MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + (MAX_ATTEMPTS - 1) * RETRY_SLEEP_MS`,
 * 364 s at these values.
 */
export async function judgeLlmCall({ apifyToken, model, prompt, schema }: LlmCallOptions): Promise<LlmCallResult> {
    let lastError: unknown;
    let useSchema = Boolean(schema);
    const startedAt = Date.now();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_SLEEP_MS));
        try {
            const res = await fetch(PROXY_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apifyToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    temperature: 0,
                    max_tokens: 2500,
                    messages: [{ role: 'user', content: prompt }],
                    ...(useSchema
                        ? {
                              response_format: {
                                  type: 'json_schema',
                                  json_schema: { name: 'judge_reply', strict: false, schema },
                              },
                          }
                        : {}),
                }),
                signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
            });
            const text = await res.text();
            if (res.status === 400 && useSchema) {
                // Provider does not support structured output: fall back once.
                useSchema = false;
                lastError = new Error(`structured output rejected: ${text.slice(0, 200)}`);
                continue;
            }
            if (!res.ok) throw new Error(`judge LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
            const body = JSON.parse(text) as {
                choices?: { message?: { content?: string } }[];
                usage?: Record<string, number>;
            };
            return {
                json: extractJson(body.choices?.[0]?.message?.content ?? ''),
                usage: body.usage ?? null,
                startedAt,
                endedAt: Date.now(),
            };
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}
