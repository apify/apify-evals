import type { OnlineTurn, TurnToolCall } from './online-turn.js';

/**
 * Judge input rendering (ai-team#269): the reconstructed turn as the text the
 * judge reads. Pure, so the exact text the model saw is reproducible from the
 * observations alone.
 *
 * Tool results ARE included, unlike the offline suite, which shows the judge
 * previews only. Three of the online criteria (resultUtilization,
 * taskCompletion, errorRecovery) are checks on whether the answer matches what
 * the tools actually returned, and a judge that cannot see the returned data
 * can only guess at them.
 */

/** Per-payload cap: enough for the judge to see the shape and the salient values, not a whole dataset. */
export const PAYLOAD_CHAR_BUDGET = 4096;

function omissionMarker(omitted: number): string {
    return `[... ${omitted} chars omitted ...]`;
}

/**
 * Keep the head and the tail of a long payload, with an explicit marker in
 * between: the head shows what the payload is, the tail whether it ended well
 * (a trailing error, a truncated JSON, a pagination hint). The result never
 * exceeds `budget` characters, marker included.
 */
export function truncateHeadTail(text: string, budget: number = PAYLOAD_CHAR_BUDGET): string {
    if (text.length <= budget) return text;
    // Size the marker for the largest count it could carry so the final length
    // never overshoots when the real count has fewer digits.
    const keep = Math.max(0, budget - omissionMarker(text.length).length);
    const headLength = Math.ceil(keep / 2);
    const tailLength = keep - headLength;
    const omitted = text.length - keep;
    return `${text.slice(0, headLength)}${omissionMarker(omitted)}${tailLength > 0 ? text.slice(-tailLength) : ''}`;
}

function payload(value: unknown, budget: number): string {
    if (value === undefined) return '(none recorded)';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return truncateHeadTail(text ?? String(value), budget);
}

function renderCall(call: TurnToolCall, budget: number): string {
    const lines = [
        `- tool call: ${call.name} (span ${call.observationId}, call ${call.callId})`,
        `  arguments: ${payload(call.arguments, budget)}`,
        `  ${call.isError ? 'result [TOOL ERROR]' : 'result'}: ${payload(call.result, budget)}`,
    ];
    return lines.join('\n');
}

/**
 * Sections: the user request, earlier conversation as context, the steps with
 * every call's arguments and result, the final answer, the recorded outcome.
 * Payloads are capped one by one, so a single huge result cannot crowd out the
 * rest of the turn.
 */
export function renderTurnForJudge(turn: OnlineTurn, budget: number = PAYLOAD_CHAR_BUDGET): string {
    const sections: string[] = [`## User request\n${truncateHeadTail(turn.prompt, budget)}`];

    if (turn.priorMessages.length > 0) {
        const prior = turn.priorMessages.map((m) => `[${m.role}] ${truncateHeadTail(m.text, budget)}`).join('\n');
        sections.push(`## Earlier conversation (context only, not the subject of the verdict)\n${prior}`);
    }

    if (turn.steps.length === 0) {
        sections.push('## Agent steps\n(no tool calls)');
    } else {
        const steps = turn.steps
            .map((step) => `### Step ${step.index}\n${step.calls.map((c) => renderCall(c, budget)).join('\n')}`)
            .join('\n');
        sections.push(`## Agent steps\n${steps}`);
    }

    sections.push(
        `## Final answer to the user\n${turn.finalText ? truncateHeadTail(turn.finalText, budget) : '(no final text)'}`,
    );

    const outcome = turn.metadata.outcome ?? 'unknown';
    const toolErrors = turn.hasToolError ? 'at least one tool call errored' : 'no tool call errored';
    sections.push(`## Recorded outcome\n${outcome}; ${turn.steps.length} tool-calling step(s); ${toolErrors}`);

    return sections.join('\n\n');
}
