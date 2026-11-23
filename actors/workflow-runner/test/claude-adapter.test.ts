import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runClaudeCode } from '../src/harness.js';

const TOKEN = 'apify_api_testTokenNotASecret123';
const jsonl = (...events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join('');

describe('Claude Code process adapter (stub executable, no network)', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'claude-adapter-test-'));
        vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(dir, { recursive: true, force: true });
    });

    it('redacts the Apify token from the stored log, tool results and the answer', async () => {
        // The agent echoes the token from its env, as `curl -v` or `echo $APIFY_TOKEN` would.
        const stream = jsonl(
            { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [] },
            {
                type: 'assistant',
                message: {
                    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo $APIFY_TOKEN' } }],
                },
            },
            {
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `${TOKEN}\n` }] },
            },
            { type: 'result', subtype: 'success', is_error: false, result: `Your token is ${TOKEN}.`, num_turns: 2 },
        );
        writeFileSync(join(dir, 'stream.jsonl'), stream);
        writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'stream.jsonl'))}\n`);
        chmodSync(join(dir, 'claude'), 0o755);

        const result = await runClaudeCode({
            prompt: 'Show my token.',
            item: { metadata: { tools: [], allowBash: true } as never },
            datasetName: 'test',
            harness: { kind: 'claude-code', model: 'claude-haiku-4-5', maxTurns: 3 },
            mcpUrl: 'https://mcp.invalid',
            apifyToken: TOKEN,
            mcpEnv: {},
            skillSet: [],
            skillsRoot: dir,
            useOpenRouterProxy: false,
            perItemTimeoutSecs: 10,
        } as never);

        expect(result.rawStdout).toContain('[REDACTED]');
        expect(result.rawStdout).not.toContain(TOKEN);
        expect(JSON.stringify(result.conversation)).not.toContain(TOKEN);
        expect(JSON.stringify(result.timeline)).not.toContain(TOKEN);
        expect(result.output).toBe('Your token is [REDACTED].');
    });
    function stubClaude(initSkills: string[]): void {
        const stream = jsonl(
            { type: 'system', subtype: 'init', tools: [], mcp_servers: [], skills: initSkills },
            { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1 },
        );
        writeFileSync(join(dir, 'stream.jsonl'), stream);
        writeFileSync(join(dir, 'claude'), `#!/bin/sh\ncat ${JSON.stringify(join(dir, 'stream.jsonl'))}\n`);
        chmodSync(join(dir, 'claude'), 0o755);
        mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true });
        writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: t\n---\nbody\n');
    }

    const skillsCtx = () =>
        ({
            prompt: 'Do it.',
            item: { metadata: { tools: [] } as never },
            datasetName: 'test',
            harness: { kind: 'claude-code', model: 'claude-haiku-4-5', maxTurns: 3 },
            mcpUrl: 'https://mcp.invalid',
            apifyToken: TOKEN,
            mcpEnv: {},
            skillSet: ['alpha'],
            skillsRoot: join(dir, 'skills'),
            useOpenRouterProxy: false,
            perItemTimeoutSecs: 10,
        }) as never;

    it('breaks a skills session whose injected skills Claude Code did not load', async () => {
        stubClaude(['some-bundled-skill']);
        const result = await runClaudeCode(skillsCtx());
        expect(result.harnessBroke).toBe(true);
        expect(result.metrics).toMatchObject({ subtype: 'error_skills', isError: true, skillsLoaded: [] });
        expect(result.stderr).toContain('injected skills not loaded: alpha');
    });

    it('keeps a skills session whose injected skills loaded', async () => {
        stubClaude(['alpha', 'some-bundled-skill']);
        const result = await runClaudeCode(skillsCtx());
        expect(result.harnessBroke).toBe(false);
        expect(result.metrics).toMatchObject({ subtype: 'success', skillsLoaded: ['alpha'] });
    });
});
