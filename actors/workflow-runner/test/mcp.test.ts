import { describe, expect, it } from 'vitest';

import { apifyMcpSpec, claudeMcpConfig, filterTools, resolveMcp, toolsUrl } from '../src/mcp.js';

const env = { APIFY_TOKEN: 'apify_secret', NOTION_TOKEN: 'ntn_secret' };

const notion = {
    name: 'notion',
    transport: 'stdio' as const,
    command: 'notion-mcp-server',
    args: ['--transport', 'stdio'],
    env: { NOTION_TOKEN: '${NOTION_TOKEN}' },
};

describe('resolveMcp', () => {
    it('is null when the item has no tools (CLI / SDK suites)', () => {
        expect(resolveMcp({}, { mcpUrl: 'https://mcp.apify.com', env })).toBeNull();
        expect(resolveMcp({ tools: [], mcp: notion }, { mcpUrl: 'https://mcp.apify.com', env })).toBeNull();
    });

    it('defaults to the Apify server with the tools in the URL and a wildcard allowlist', () => {
        const mcp = resolveMcp({ tools: ['call-actor', 'search-actors'] }, { mcpUrl: 'https://mcp.apify.com', env })!;
        expect(mcp.name).toBe('apify');
        expect(mcp.spec.url).toBe(toolsUrl('https://mcp.apify.com', ['call-actor', 'search-actors']));
        expect(mcp.spec.headers).toEqual({ Authorization: 'Bearer apify_secret' });
        expect(mcp.allowedTools).toEqual(['mcp__apify__*']);
        expect(mcp.secrets).toEqual(['apify_secret']);
        expect(claudeMcpConfig(mcp)).toEqual({
            mcpServers: {
                apify: {
                    type: 'http',
                    url: mcp.spec.url,
                    headers: { Authorization: 'Bearer apify_secret' },
                },
            },
        });
    });

    it('fills stdio env placeholders and pre-approves only the listed tools', () => {
        const mcp = resolveMcp(
            { tools: ['API-post-search', 'API-retrieve-a-page'], mcp: notion },
            { mcpUrl: 'https://mcp.apify.com', env },
        )!;
        expect(mcp.spec.env).toEqual({ NOTION_TOKEN: 'ntn_secret' });
        expect(mcp.allowedTools).toEqual(['mcp__notion__API-post-search', 'mcp__notion__API-retrieve-a-page']);
        expect(mcp.secrets).toEqual(['ntn_secret']);
        expect(claudeMcpConfig(mcp)).toEqual({
            mcpServers: {
                notion: {
                    type: 'stdio',
                    command: 'notion-mcp-server',
                    args: ['--transport', 'stdio'],
                    env: { NOTION_TOKEN: 'ntn_secret' },
                },
            },
        });
    });

    it('treats "*" as every tool of the server', () => {
        const mcp = resolveMcp({ tools: ['*'], mcp: notion }, { mcpUrl: 'https://mcp.apify.com', env })!;
        expect(mcp.allowedTools).toEqual(['mcp__notion__*']);
        expect(filterTools(mcp, ['API-post-search', 'API-post-page'])).toEqual(['API-post-search', 'API-post-page']);
        const narrow = resolveMcp(
            { tools: ['API-post-search'], mcp: notion },
            { mcpUrl: 'https://mcp.apify.com', env },
        )!;
        expect(filterTools(narrow, ['API-post-search', 'API-post-page'])).toEqual(['API-post-search']);
    });

    it('keeps secrets out of the snapshot key and makes it independent of tool order', () => {
        const a = resolveMcp({ tools: ['b', 'a'], mcp: notion }, { mcpUrl: '', env })!;
        const b = resolveMcp({ tools: ['a', 'b'], mcp: notion }, { mcpUrl: '', env })!;
        expect(a.key).toBe(b.key);
        expect(a.key).not.toContain('ntn_secret');
        expect(a.key).toContain('${NOTION_TOKEN}');
    });

    it('fails fast when a placeholder has no value', () => {
        expect(() => resolveMcp({ tools: ['*'], mcp: notion }, { mcpUrl: '', env: {} })).toThrow(/needs NOTION_TOKEN/);
    });

    it('fills http headers and leaves the URL alone without toolsQuery', () => {
        const hosted = {
            name: 'notion',
            transport: 'http' as const,
            url: 'https://mcp.notion.com/mcp',
            headers: { Authorization: 'Bearer ${NOTION_MCP_TOKEN}' },
        };
        const mcp = resolveMcp({ tools: ['*'], mcp: hosted }, { mcpUrl: '', env: { NOTION_MCP_TOKEN: 'tok' } })!;
        expect(mcp.spec.url).toBe('https://mcp.notion.com/mcp');
        expect(mcp.spec.headers).toEqual({ Authorization: 'Bearer tok' });
    });

    it('apifyMcpSpec describes the server the old runner hard-coded', () => {
        expect(apifyMcpSpec('https://mcp.apify.com').toolsQuery).toBe(true);
    });
});
