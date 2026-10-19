/**
 * Preflight pings: one tiny LLM call per configured model through the proxy,
 * before any session starts. Besides failing fast on a bad id, the reply names
 * the concrete model behind a moving alias, which the experiment metadata
 * records as `resolvedModel`.
 */

export interface PingOptions {
    url: string;
    apifyToken: string;
    model: string;
    /** Codex speaks the Responses API; everything else OpenAI chat completions. */
    codex: boolean;
    timeoutMs?: number;
}

export interface PingResult {
    ok: boolean;
    status: number;
    /** `model` from the reply body when present. */
    resolvedModel: string | null;
    /** Reply text (truncated) for error messages. */
    text: string;
}

export async function pingModel(opts: PingOptions, fetchImpl: typeof fetch = fetch): Promise<PingResult> {
    const body = opts.codex
        ? { model: opts.model, input: 'ping', max_output_tokens: 16 }
        : { model: opts.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    const res = await fetchImpl(opts.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apifyToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    let resolvedModel: string | null = null;
    if (res.ok) {
        try {
            const parsed = JSON.parse(text) as { model?: unknown };
            if (typeof parsed.model === 'string' && parsed.model) resolvedModel = parsed.model;
        } catch {
            /* a non-JSON 200 still counts as reachable */
        }
    }
    return { ok: res.ok, status: res.status, resolvedModel, text: text.slice(0, 200) };
}

/** Preflight every model in the matrix; returns the problems and the resolved ids. */
export async function preflightModels(
    models: string[],
    base: Omit<PingOptions, 'model'>,
    fetchImpl: typeof fetch = fetch,
): Promise<{ problems: string[]; resolved: Record<string, string | null> }> {
    const problems: string[] = [];
    const resolved: Record<string, string | null> = {};
    for (const model of models) {
        try {
            const r = await pingModel({ ...base, model }, fetchImpl);
            resolved[model] = r.resolvedModel;
            if (!r.ok) problems.push(`LLM proxy HTTP ${r.status} for model ${model}: ${r.text}`);
        } catch (err) {
            resolved[model] = null;
            problems.push(
                `LLM proxy unreachable for model ${model}: ${String((err as Error).message ?? err).slice(0, 200)}`,
            );
        }
    }
    return { problems, resolved };
}
