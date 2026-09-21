import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/** One file the agent left in its working directory. `content` is inline for
 * small text files so `workspace.file` checks can validate JSON without the
 * judge re-fetching anything. */
export interface WorkspaceFile {
    path: string;
    size: number;
    content?: string;
}

export const WORKSPACE_MAX_FILES = 300;
export const WORKSPACE_INLINE_BYTES = 64 * 1024;
export const WORKSPACE_INLINE_TOTAL = 2 * 1024 * 1024;
const WORKSPACE_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.venv',
    '__pycache__',
    'dist',
    'storage',
    'apify_storage',
]);

/** Snapshot the files under `dir` (relative paths, sorted), skipping dependency
 * and VCS folders, capped in count and inline bytes. Never throws: a missing
 * or unreadable directory yields an empty list. */
export function snapshotWorkspace(dir: string): WorkspaceFile[] {
    const out: WorkspaceFile[] = [];
    let inlineTotal = 0;
    const walk = (d: string) => {
        let entries: string[];
        try {
            entries = readdirSync(d).sort();
        } catch {
            return;
        }
        for (const name of entries) {
            if (out.length >= WORKSPACE_MAX_FILES) return;
            const full = join(d, name);
            let st;
            try {
                st = statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                if (!WORKSPACE_SKIP_DIRS.has(name)) walk(full);
                continue;
            }
            if (!st.isFile()) continue;
            const file: WorkspaceFile = { path: relative(dir, full).split('\\').join('/'), size: st.size };
            if (st.size <= WORKSPACE_INLINE_BYTES && inlineTotal + st.size <= WORKSPACE_INLINE_TOTAL) {
                try {
                    const buf = readFileSync(full);
                    if (!buf.subarray(0, 8192).includes(0)) {
                        file.content = buf.toString('utf8');
                        inlineTotal += st.size;
                    }
                } catch {
                    /* unreadable: path and size only */
                }
            }
            out.push(file);
        }
    };
    walk(dir);
    return out;
}
