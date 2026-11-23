/**
 * Per-session model relay for Codex: a local HTTP server that Codex's model
 * provider points to. It passes every request to the real provider unchanged
 * (headers, auth and body as Codex sent them; the response streamed back as it
 * arrives) and counts the model calls on the way, because `codex exec` has no
 * `--max-turns` and its JSONL events do not show where one model call ends.
 *
 * Codex labels each request in its `x-codex-turn-metadata` header
 * (`request_kind`: `turn`, `compaction`, ...; codex-rs core/src/responses_metadata.rs).
 * Only `turn` requests are model calls of the agent loop, the unit of Claude
 * Code's `--max-turns`; compaction and other requests pass through uncounted.
 * A request without a readable kind counts as a turn (the safe side) and is
 * recorded in `unlabelled`.
 *
 * A turn counts once its stream reached `response.completed`; a failed request
 * that Codex retries is not a second turn. Turns still streaming count toward
 * the budget too, so two parallel requests cannot both pass the last slot.
 * When Codex asks for one turn more than the budget allows, the relay refuses
 * it (HTTP 400, which Codex does not retry) and calls `onRefused`, which stops
 * the session.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface ModelRelay {
    /** Base URL for Codex's provider config (`base_url`). */
    url: string;
    /** Turns (agent-loop model calls) that completed (`response.completed` seen). */
    readonly calls: number;
    /** Completed turns whose response asked for at least one tool call. */
    readonly toolCalls: number;
    /** Model requests that were not turns (compaction and the like), passed through uncounted. */
    readonly uncounted: number;
    /** Model requests without a readable `request_kind`, counted as turns. */
    readonly unlabelled: number;
    /** True once a request past the budget was refused. */
    readonly refused: boolean;
    /** Called once, when the first request past the budget arrives. */
    onRefused: () => void;
    close(): Promise<void>;
}

/** Hop-by-hop headers are per connection; everything else passes unchanged. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
]);

function forwardHeaders(headers: IncomingMessage['headers'], host?: string): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(key.toLowerCase())) out[key] = value;
    }
    if (host) out.host = host;
    return out;
}

/** `request_kind` from Codex's turn metadata header, or null when missing or unreadable. */
export function requestKind(headers: IncomingMessage['headers']): string | null {
    const raw = headers['x-codex-turn-metadata'];
    if (typeof raw !== 'string') return null;
    try {
        const kind = (JSON.parse(raw) as { request_kind?: unknown }).request_kind;
        return typeof kind === 'string' ? kind : null;
    } catch {
        return null;
    }
}

/** Reads the Responses SSE stream as it passes (any chunking, LF or CRLF): whether it completed and used tools. */
function sseTap(onCompleted: (usedTools: boolean) => void): (chunk: Buffer) => void {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let usedTools = false;
    return (chunk) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (!line.startsWith('data:')) continue;
            let event: { type?: string; item?: { type?: string } };
            try {
                event = JSON.parse(line.slice(5).trim());
            } catch {
                continue;
            }
            // function_call, custom_tool_call, local_shell_call, mcp_call, ...
            if (event.type === 'response.output_item.done' && /_call$/.test(event.item?.type ?? '')) usedTools = true;
            if (event.type === 'response.completed') {
                onCompleted(usedTools);
                usedTools = false;
            }
        }
    };
}

export async function startModelRelay(opts: {
    upstream: string;
    maxCalls: number;
    /** Listen address; 127.0.0.1 except in tests. */
    host?: string;
}): Promise<ModelRelay> {
    const base = opts.upstream.replace(/\/+$/, '');
    const state = { calls: 0, toolCalls: 0, inFlight: 0, uncounted: 0, unlabelled: 0, refused: false };
    const relay: ModelRelay = {
        url: '',
        get calls() {
            return state.calls;
        },
        get toolCalls() {
            return state.toolCalls;
        },
        get uncounted() {
            return state.uncounted;
        },
        get unlabelled() {
            return state.unlabelled;
        },
        get refused() {
            return state.refused;
        },
        onRefused: () => {},
        close: async () => {},
    };

    const handle = (req: IncomingMessage, res: ServerResponse) => {
        const path = req.url ?? '/';
        const isModelRequest = req.method === 'POST' && path.split('?')[0] === '/responses';
        const kind = isModelRequest ? requestKind(req.headers) : null;
        const isTurn = isModelRequest && (kind === null || kind === 'turn');
        if (isModelRequest && kind === null) state.unlabelled++;
        if (isModelRequest && !isTurn) state.uncounted++;
        if (isTurn && state.calls + state.inFlight >= opts.maxCalls) {
            req.resume();
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `turn budget of ${opts.maxCalls} model calls used` } }));
            if (!state.refused) {
                state.refused = true;
                relay.onRefused();
            }
            return;
        }
        // A turn holds a budget slot from now until it completes or fails.
        let holding = isTurn;
        if (holding) state.inFlight++;
        const release = (completed: boolean, usedTools = false) => {
            if (!holding) return;
            holding = false;
            state.inFlight--;
            if (completed) {
                state.calls++;
                if (usedTools) state.toolCalls++;
            }
        };

        const target = new URL(base + path);
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const upstream = send(target, { method: req.method, headers: forwardHeaders(req.headers, target.host) });
        upstream.on('response', (up) => {
            res.writeHead(up.statusCode ?? 502, up.statusMessage, forwardHeaders(up.headers));
            if (holding && up.statusCode === 200)
                up.on(
                    'data',
                    sseTap((usedTools) => release(true, usedTools)),
                );
            up.pipe(res);
            up.on('error', () => res.destroy());
            up.on('close', () => release(false));
        });
        upstream.on('error', (error) => {
            release(false);
            // A network failure has no upstream response to pass on: answer
            // 502 so Codex reports (and may retry) it like any provider error.
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `model relay: upstream unreachable (${error.message})` } }));
            } else res.destroy();
        });
        // Codex gave up on the call (abort, timeout, session end): drop the upstream request too.
        res.on('close', () => {
            if (!res.writableFinished) upstream.destroy();
            release(false);
        });
        req.pipe(upstream);
    };

    const server = createServer(handle);
    // EMFILE, EADDRNOTAVAIL and the like fail this session, not the runner.
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, opts.host ?? '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    relay.url = `http://${opts.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
    relay.close = () =>
        new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        });
    return relay;
}
