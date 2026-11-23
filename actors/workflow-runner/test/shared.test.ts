import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
    descendantPids,
    killProcessTree,
    killTrackedChildren,
    trackChild,
    untrackChild,
} from '../src/adapters/shared.js';

/** A detached child that outlives its parent unless it is killed, like a session. */
function spawnSleeper() {
    return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

afterEach(() => {
    killTrackedChildren();
});

describe('killTrackedChildren', () => {
    it('kills every tracked child and reports how many were running', async () => {
        const children = [spawnSleeper(), spawnSleeper()];
        for (const child of children) trackChild(child);

        expect(killTrackedChildren()).toBe(2);

        await delay(200);
        for (const child of children) expect(alive(child.pid as number)).toBe(false);
    });

    it('leaves untracked (already settled) children alone', async () => {
        const settled = spawnSleeper();
        trackChild(settled);
        untrackChild(settled);

        expect(killTrackedChildren()).toBe(0);
        await delay(200);
        expect(alive(settled.pid as number)).toBe(true);

        settled.kill('SIGKILL');
    });

    it('is a no-op when nothing is running', () => {
        expect(killTrackedChildren()).toBe(0);
    });
});

describe('killProcessTree', () => {
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    it('kills a descendant that started its own session, outside the process group', async () => {
        // Like Codex's PTY shell: the grandchild calls setsid, so a group kill misses it.
        const child = spawn(
            process.execPath,
            [
                '-e',
                `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
                 console.log(c.pid); setInterval(() => {}, 1000);`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
        );
        const grandchild = await new Promise<number>((resolve) =>
            child.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim()))),
        );
        expect(descendantPids(child.pid as number)).toContain(grandchild);
        killProcessTree(child);
        await delay(300);
        expect(alive(grandchild)).toBe(false);
        expect(alive(child.pid as number)).toBe(false);
    });

    it('leaves an unrelated sibling process alive', async () => {
        const sibling = spawnSleeper();
        const child = spawnSleeper();
        try {
            await delay(200);
            killProcessTree(child);
            await delay(300);
            expect(alive(child.pid as number)).toBe(false);
            expect(alive(sibling.pid as number)).toBe(true);
        } finally {
            killProcessTree(sibling);
        }
    });

    it('walks parent links to every depth', () => {
        const parents = new Map([
            [2, 1],
            [3, 2],
            [4, 3],
            [9, 8],
        ]);
        expect(descendantPids(1, parents).sort()).toEqual([2, 3, 4]);
    });
});
