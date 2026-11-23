import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startModelRelay, type ModelRelay } from '../src/adapters/codex-relay.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let upstream: Server | undefined;
let relay: ModelRelay | undefined;
const seen: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[] = [];

async function startUpstream(handler: Handler): Promise<string> {
    upstream = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            handler(req, res, body);
        });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api/v1`;
}

const sse = (event: object) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`;
const call = (i: number) => ({
    type: 'response.output_item.done',
    item: { type: 'function_call', name: 'exec_command', call_id: `c${i}` },
});
const message = { type: 'response.output_item.done', item: { type: 'message', content: [] } };
const completed = { type: 'response.completed', response: { id: 'r' } };

/** One POST through the relay; resolves with status, headers and the chunks as they arrived. */
function post(
    path: string,
    body: string,
    headers: Record<string, string> = {},
    onChunk?: (chunk: string) => void,
): Promise<{ status: number; headers: IncomingMessage['headers']; body: string }> {
    return new Promise((resolve, reject) => {
        const req = request(`${relay!.url}${path}`, { method: 'POST', headers }, (res) => {
            let text = '';
            res.on('data', (d: Buffer) => {
                text += d;
                onChunk?.(String(d));
            });
            // 'close' also covers a stream the relay cut off.
            res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
            res.on('error', () => undefined);
        });
        req.on('error', reject);
        req.end(body);
    });
}

afterEach(async () => {
    seen.length = 0;
    await relay?.close();
    relay = undefined;
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
});

describe('Codex model relay', () => {
    it('passes requests through unchanged and streams the response as it arrives', async () => {
        let release!: () => void;
        const firstChunkSeen = new Promise<void>((resolve) => (release = resolve));
        const base = await startUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'yes' });
            res.write(sse({ type: 'response.created', response: { id: 'r' } }));
            // The rest only after the client has the first event: no buffering in the relay.
            void firstChunkSeen.then(() => {
                res.write(sse(call(0)) + sse(call(1)) + sse(completed));
                res.end();
            });
        });
        relay = await startModelRelay({ upstream: base, maxCalls: 5 });
        const reply = await post(
            '/responses',
            '{"model":"m","stream":true}',
            { authorization: 'Bearer run-token', 'content-type': 'application/json' },
            (chunk) => {
                if (chunk.includes('response.created')) release();
            },
        );
        expect(reply.status).toBe(200);
        expect(reply.headers['x-upstream']).toBe('yes');
        expect(reply.body).toContain('response.completed');
        expect(seen[0]).toMatchObject({
            method: 'POST',
            url: '/api/v1/responses',
            body: '{"model":"m","stream":true}',
        });
        expect(seen[0].headers).toMatchObject({
            authorization: 'Bearer run-token',
            'content-type': 'application/json',
            host: new URL(base).host,
        });
        // Two parallel tool calls in one response are one model call.
        expect(relay.calls).toBe(1);
        expect(relay.toolCalls).toBe(1);
    });

    it('counts completed model calls, with and without tool calls, and nothing else', async () => {
        let n = 0;
        const base = await startUpstream((req, res) => {
            if (req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"models":[]}');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(n++ === 0 ? sse(call(0)) + sse(completed) : sse(message) + sse(completed));
        });
        relay = await startModelRelay({ upstream: base, maxCalls: 5 });
        await post('/responses', '{}');
        await post('/responses', '{}');
        const models = await new Promise<number>((resolve) =>
            request(`${relay!.url}/models`, (res) => {
                res.resume();
                resolve(res.statusCode ?? 0);
            }).end(),
        );
        expect(models).toBe(200);
        expect(relay.calls).toBe(2);
        expect(relay.toolCalls).toBe(1);
    });

    it('refuses the call past the budget without reaching the provider', async () => {
        const base = await startUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(sse(call(0)) + sse(completed));
        });
        relay = await startModelRelay({ upstream: base, maxCalls: 2 });
        const onRefused = vi.fn();
        relay.onRefused = onRefused;
        expect((await post('/responses', '{}')).status).toBe(200);
        expect((await post('/responses', '{}')).status).toBe(200);
        const refused = await post('/responses', '{}');
        await post('/responses', '{}');
        expect(refused.status).toBe(400);
        expect(refused.body).toContain('turn budget');
        expect(seen).toHaveLength(2);
        expect(onRefused).toHaveBeenCalledOnce();
        expect(relay).toMatchObject({ calls: 2, refused: true });
    });

    it('passes provider errors through as they are and does not count them', async () => {
        let n = 0;
        const base = await startUpstream((_req, res) => {
            if (n++ === 0) {
                res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
                res.end('{"error":{"message":"rate limited"}}');
                return;
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(sse(message) + sse(completed));
        });
        relay = await startModelRelay({ upstream: base, maxCalls: 1 });
        const first = await post('/responses', '{}');
        expect(first).toMatchObject({ status: 429, body: '{"error":{"message":"rate limited"}}' });
        expect(first.headers['retry-after']).toBe('1');
        // Codex retries: still the first model call.
        expect((await post('/responses', '{}')).status).toBe(200);
        expect(relay.calls).toBe(1);
    });

    it('does not count a stream that broke before response.completed', async () => {
        const base = await startUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(sse(call(0)));
            res.destroy();
        });
        relay = await startModelRelay({ upstream: base, maxCalls: 1 });
        await post('/responses', '{}').catch(() => undefined);
        expect(relay.calls).toBe(0);
    });

    it('answers 502 when the provider is unreachable', async () => {
        relay = await startModelRelay({ upstream: 'http://127.0.0.1:9/api/v1', maxCalls: 1 });
        const reply = await post('/responses', '{}');
        expect(reply.status).toBe(502);
        expect(reply.body).toContain('upstream unreachable');
    });

    it('drops the provider request when Codex aborts the call', async () => {
        const upstreamClosed = new Promise<void>((resolve) => {
            void startUpstream((_req, res) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write(sse({ type: 'response.created', response: { id: 'r' } }));
                res.on('close', () => resolve());
            }).then(async (base) => {
                relay = await startModelRelay({ upstream: base, maxCalls: 1 });
                const req = request(`${relay.url}/responses`, { method: 'POST' }, (res) => {
                    res.once('data', () => req.destroy());
                });
                req.on('error', () => undefined);
                req.end('{}');
            });
        });
        await upstreamClosed;
        expect(relay!.calls).toBe(0);
    });

    it('stops listening when closed, also with a call in flight', async () => {
        const base = await startUpstream((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(sse({ type: 'response.created', response: { id: 'r' } }));
        });
        relay = await startModelRelay({ upstream: base, maxCalls: 1 });
        const inFlight = post('/responses', '{}').catch((error: Error) => error);
        await new Promise((resolve) => setTimeout(resolve, 100));
        await relay.close();
        await inFlight;
        await expect(post('/responses', '{}')).rejects.toThrow(/ECONNREFUSED/);
    });
});
