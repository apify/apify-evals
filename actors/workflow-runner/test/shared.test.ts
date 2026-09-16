import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { killTrackedChildren, trackChild, untrackChild } from '../src/adapters/shared.js';

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
