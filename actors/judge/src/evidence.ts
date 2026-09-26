/**
 * Read the runner's evidence artifact and full session log for one trace.
 * Both live in the named eval-artifacts store and are hash-verified: the
 * judge grades frozen facts, never live data.
 */
import { createHash } from 'node:crypto';

import type { AgentSpanMetadata, CheckResult, ConversationEntry, Evidence } from '@apify-evals/contract';
import { log } from 'apify';

export interface EvidenceArtifact {
    evidence: Evidence;
    checks: CheckResult[];
    infra: { ok: boolean; reasons: string[] };
}

async function fetchVerified(url: string, expectedHash: string | undefined, apifyToken: string): Promise<string | null> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apifyToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
        log.warning(`artifact fetch ${url}: HTTP ${res.status}`);
        return null;
    }
    const text = await res.text();
    if (expectedHash) {
        const got = `sha256:${createHash('sha256').update(text).digest('hex')}`;
        if (got !== expectedHash) {
            log.warning(`artifact ${url}: hash mismatch`);
            return null;
        }
    }
    return text;
}

export async function fetchEvidence(meta: Partial<AgentSpanMetadata>, apifyToken: string): Promise<EvidenceArtifact | null> {
    const url = (meta as { evidenceUrl?: string }).evidenceUrl;
    if (!url) return null;
    const text = await fetchVerified(url, (meta as { evidenceHash?: string }).evidenceHash, apifyToken).catch((err) => {
        log.warning(`evidence fetch failed: ${err}`);
        return null;
    });
    if (!text) return null;
    try {
        const parsed = JSON.parse(text) as Partial<EvidenceArtifact> & Evidence;
        // Runner writes {evidence, checks, infra}; tolerate a bare Evidence too.
        if (parsed.evidence) return { evidence: parsed.evidence, checks: parsed.checks ?? [], infra: parsed.infra ?? { ok: true, reasons: [] } };
        return { evidence: parsed as Evidence, checks: [], infra: { ok: true, reasons: [] } };
    } catch (err) {
        log.warning(`evidence parse failed: ${err}`);
        return null;
    }
}

/**
 * Rebuild the conversation from the full Claude Code stream-json log with a
 * generous preview cap, so the judge sees what the agent saw instead of the
 * 2000-character previews on the span. Falls back to null on any problem.
 */
export async function conversationFromFullLog(
    meta: Partial<AgentSpanMetadata>,
    apifyToken: string,
    previewCap = 8000,
): Promise<ConversationEntry[] | null> {
    if (!meta.fullLogUrl) return null;
    const text = await fetchVerified(meta.fullLogUrl, meta.fullLogHash, apifyToken).catch((err) => {
        log.warning(`full log fetch failed: ${err}`);
        return null;
    });
    if (!text) return null;
    const conversation: ConversationEntry[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let ev: { type?: string; message?: { content?: unknown[] } };
        try {
            ev = JSON.parse(line);
        } catch {
            continue;
        }
        if (ev.type !== 'assistant' && ev.type !== 'user') continue;
        for (const block of (ev.message?.content ?? []) as Record<string, unknown>[]) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                conversation.push({ role: ev.type, type: 'text', text: block.text.slice(0, previewCap) });
            } else if (block.type === 'tool_use') {
                const json = JSON.stringify(block.input ?? null);
                conversation.push({
                    role: 'assistant',
                    type: 'tool_call',
                    tool: String(block.name),
                    input: json.length <= previewCap ? block.input : json.slice(0, previewCap),
                });
            } else if (block.type === 'tool_result') {
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
                conversation.push({ role: 'tool', type: 'tool_result', preview: content.slice(0, previewCap) });
            }
        }
    }
    return conversation.length > 0 ? conversation : null;
}

/** The facts block the judge reads before the conversation. */
export function renderFacts(opts: {
    intendedSubject: string | null;
    skill: 'find' | 'use' | null;
    artifact: EvidenceArtifact | null;
    session: Partial<AgentSpanMetadata>;
}): string {
    const { intendedSubject, skill, artifact, session } = opts;
    const lines: string[] = [];
    lines.push(`- Scenario type: ${skill === 'find' ? 'find (the agent had to discover the subject in store search)' : skill === 'use' ? 'use (the subject was named in the prompt)' : 'unknown'}`);
    lines.push(`- Intended subject: ${intendedSubject ?? 'unknown'}`);
    const runs = artifact?.evidence.actorRuns ?? [];
    if (runs.length === 0) lines.push('- Actor runs triggered by the agent: none');
    for (const r of runs) {
        const items = r.datasetId ? artifact?.evidence.datasets[r.datasetId]?.length : undefined;
        lines.push(`- Actor run: ${r.actor} · ${r.status ?? 'status unknown'}${items !== undefined ? ` · ${items} dataset items` : r.itemCount !== undefined ? ` · ${r.itemCount} items` : ''}${r.runId ? ` · run ${r.runId}` : ''}`);
    }
    const tools = artifact?.evidence.toolCalls.map((c) => c.tool.replace(/^mcp__[^_]+__/, '')) ?? [];
    if (tools.length > 0) lines.push(`- Tool calls (${tools.length}): ${[...new Set(tools)].join(', ')}`);
    if (artifact) {
        const applicable = artifact.checks.filter((c) => c.applicable);
        if (applicable.length > 0) {
            lines.push('- Deterministic checks (already decided, do not re-judge them):');
            for (const c of applicable) lines.push(`    - ${c.id} (${c.type}${c.severity === 'warn' ? ', warn' : ''}): ${c.passed ? 'PASS' : 'FAIL'} — ${c.comment}`);
        }
        if (!artifact.infra.ok) lines.push(`- Infrastructure problems: ${artifact.infra.reasons.join('; ')}`);
    }
    if (session.timedOut) lines.push('- The session hit the time limit.');
    if (session.subtype === 'error_max_turns') lines.push('- The agent ran out of turns.');
    return lines.join('\n');
}
