import type { ChildProcess } from 'node:child_process';

export const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
export const TEXT_BLOCK_CAP = 4000;
export const TOOL_INPUT_CAP = 2000;
export const TOOL_RESULT_CAP = 2000;
export const STDERR_CAP = 2000;
export const EXIT_GRACE_MS = 1000;
export const MAX_MCP_RESTARTS = 1;

export function capToolInput(input: unknown): unknown {
    const json = JSON.stringify(input ?? null);
    return json.length <= TOOL_INPUT_CAP ? input : json.slice(0, TOOL_INPUT_CAP);
}

/** Kill the detached process group, including descendants holding stdio open. */
export function killProcessTree(child: ChildProcess): void {
    try {
        process.kill(-(child.pid as number), 'SIGKILL');
    } catch {
        try {
            child.kill('SIGKILL');
        } catch {
            /* already gone */
        }
    }
}

/**
 * Every live session child, so an Actor-level abort can kill them all. The
 * children are detached process group leaders: without this they survive the
 * Actor's own exit and keep burning compute (and tokens) after an abort.
 */
const liveChildren = new Set<ChildProcess>();

export function trackChild(child: ChildProcess): void {
    liveChildren.add(child);
}

export function untrackChild(child: ChildProcess): void {
    liveChildren.delete(child);
}

/** Kill every tracked session child. Returns how many were still running. */
export function killTrackedChildren(): number {
    const count = liveChildren.size;
    for (const child of liveChildren) killProcessTree(child);
    liveChildren.clear();
    return count;
}
