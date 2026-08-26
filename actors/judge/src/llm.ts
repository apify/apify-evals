/** One structured judge call through the Apify OpenRouter proxy (OpenAI wire format). */

const PROXY_URL = 'https://openrouter.apify.actor/api/v1/chat/completions';

export interface LlmCallOptions {
    apifyToken: string;
    model: string;
    prompt: string;
}

/** Extract the first JSON object from a model reply (tolerates code fences and prose). */
function extractJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error(`no JSON object in reply: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start, end + 1));
}

/** Two attempts covering every transient failure mode: network errors and
 * timeouts, non-JSON proxy bodies (HTML 502s), HTTP errors, and unparseable
 * model replies. v1 limitation: field order (evidence before verdict) is
 * prompt-requested, not enforced via structured output. */
export async function judgeLlmCall({ apifyToken, model, prompt }: LlmCallOptions): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
        try {
            const res = await fetch(PROXY_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apifyToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    temperature: 0,
                    max_tokens: 2000,
                    messages: [{ role: 'user', content: prompt }],
                }),
                signal: AbortSignal.timeout(120_000),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`judge LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
            const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
            return extractJson(body.choices?.[0]?.message?.content ?? '');
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}
