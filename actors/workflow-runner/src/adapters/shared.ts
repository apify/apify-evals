import { execFileSync, type ChildProcess } from 'node:child_process';
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

/** Parent of every live process: /proc on Linux, `ps` elsewhere. */
function parentPids(): Map<number, number> {
    const parents = new Map<number, number>();
    try {
        if (process.platform === 'linux') {
            for (const name of readdirSync('/proc')) {
                if (!/^\d+$/.test(name)) continue;
                try {
                    // `pid (comm) state ppid ...`; comm can hold spaces and parentheses.
                    const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
                    parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
                } catch {
                    /* exited meanwhile */
                }
            }
        } else {
            for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
                const [pid, ppid] = line.trim().split(/\s+/).map(Number);
                if (pid && Number.isFinite(ppid)) parents.set(pid, ppid);
            }
        }
    } catch {
        /* no process table: only the group kill below */
    }
    return parents;
}

/** Every descendant of `root`, found by walking the parent links. */
export function descendantPids(root: number, parents = parentPids()): number[] {
    const out: number[] = [];
    const queue = [root];
    while (queue.length > 0) {
        const pid = queue.shift() as number;
        for (const [child, parent] of parents) {
            if (parent === pid && !out.includes(child)) {
                out.push(child);
                queue.push(child);
            }
        }
    }
    return out;
}

/**
 * Kill the detached process group, including descendants holding stdio open.
 * Descendants in their own session (Codex runs shell commands in a PTY, which
 * starts a new session) are outside the group: kill them by pid first, or a
 * `sleep`/`tail -f` the agent started keeps running after the session.
 *
 * Best effort, by design without native helpers. Two gaps remain: a process
 * whose parent already exited is reparented to PID 1 (or a subreaper) and is
 * no longer a descendant, so it survives (`nohup cmd & exit`); and a process
 * forked between the process-table read and the kills is missed. Production
 * relies on the session's sandbox (bubblewrap on Linux kills its PID
 * namespace with the sandboxed command) and on the container ending with the
 * Actor run for those.
 */
export function killProcessTree(child: ChildProcess): void {
    if (child.pid) {
        for (const pid of descendantPids(child.pid)) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                /* already gone */
            }
        }
    }
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
    // Injected skills and the harnesses' own project state, not the agent's work.
    '.claude',
    '.opencode',
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
