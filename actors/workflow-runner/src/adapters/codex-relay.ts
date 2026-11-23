/**
 * Per-session model relay for Codex: a local HTTP server that Codex's model
 * provider points to. It passes every request to the real provider unchanged
 * (headers, auth and body as Codex sent them; the response streamed back as it
 * arrives) and counts the model calls on the way, because `codex exec` has no
 * `--max-turns` and its JSONL events do not show where one model call ends.
 *
 * A model call is a `POST /responses` whose stream reached `response.completed`;
 * a failed request that Codex retries is not a second call. When Codex asks for
 * one call more than the budget allows, the relay refuses it (HTTP 400, which
 * Codex does not retry) and calls `onRefused`, which stops the session.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

export interface ModelRelay {
    /** Base URL for Codex's provider config (`base_url`). */
    url: string;
    /** Model calls that completed (`response.completed` seen). */
    readonly calls: number;
    /** Completed model calls whose response asked for at least one tool call. */
    readonly toolCalls: number;
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

/** Reads the Responses SSE stream as it passes: one completed call, and whether it asked for tools. */
function sseTap(onCompleted: (usedTools: boolean) => void): (chunk: Buffer) => void {
    let buffer = '';
    let usedTools = false;
    return (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
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

export async function startModelRelay(opts: { upstream: string; maxCalls: number }): Promise<ModelRelay> {
    const base = opts.upstream.replace(/\/+$/, '');
    const state = { calls: 0, toolCalls: 0, refused: false };
    const relay: ModelRelay = {
        url: '',
        get calls() {
            return state.calls;
        },
        get toolCalls() {
            return state.toolCalls;
        },
        get refused() {
            return state.refused;
        },
        onRefused: () => {},
        close: async () => {},
    };

    const handle = (req: IncomingMessage, res: ServerResponse) => {
        const path = req.url ?? '/';
        const isModelCall = req.method === 'POST' && path.split('?')[0] === '/responses';
        if (isModelCall && state.calls >= opts.maxCalls) {
            req.resume();
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `turn budget of ${opts.maxCalls} model calls used` } }));
            if (!state.refused) {
                state.refused = true;
                relay.onRefused();
            }
            return;
        }
        const target = new URL(base + path);
        const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const upstream = send(target, { method: req.method, headers: forwardHeaders(req.headers, target.host) });
        upstream.on('response', (up) => {
            res.writeHead(up.statusCode ?? 502, up.statusMessage, forwardHeaders(up.headers));
            if (isModelCall && up.statusCode === 200) {
                up.on(
                    'data',
                    sseTap((usedTools) => {
                        state.calls++;
                        if (usedTools) state.toolCalls++;
                    }),
                );
            }
            up.pipe(res);
            up.on('error', () => res.destroy());
        });
        upstream.on('error', (error) => {
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
        });
        req.pipe(upstream);
    };

    const server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    relay.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    relay.close = () =>
        new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
        });
    return relay;
}
