import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { actorCheckpointStore, type Checkpoint } from '../src/select.js';

/**
 * The production checkpoint store against the SDK's real local storage. On the
 * platform every run gets a new default key-value store, so a "next run" is
 * simulated by switching ACTOR_DEFAULT_KEY_VALUE_STORE_ID (the SDK reads it on
 * every call). The checkpoint must survive that switch.
 */
const ENV_KEYS = ['CRAWLEE_STORAGE_DIR', 'APIFY_LOCAL_STORAGE_DIR', 'ACTOR_DEFAULT_KEY_VALUE_STORE_ID'] as const;

let storageDir: string;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function startRun(defaultStoreId: string) {
    process.env.ACTOR_DEFAULT_KEY_VALUE_STORE_ID = defaultStoreId;
}

function checkpoint(upperBound: string, runId: string): Checkpoint {
    return { upperBound, runId, writtenAt: upperBound };
}

beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    storageDir = mkdtempSync(join(tmpdir(), 'judge-checkpoint-'));
    process.env.CRAWLEE_STORAGE_DIR = storageDir;
    process.env.APIFY_LOCAL_STORAGE_DIR = storageDir;
});

afterAll(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
    rmSync(storageDir, { recursive: true, force: true });
});

describe('actorCheckpointStore', () => {
    it('reads the checkpoint the previous run wrote, although each run has its own default store', async () => {
        startRun('run-1-default-store');
        const written = checkpoint('2026-09-08T05:27:00.000Z', 'run-1');
        await actorCheckpointStore('prod').write(written);

        startRun('run-2-default-store');
        expect(await actorCheckpointStore('prod').read()).toEqual(written);
    });

    it('keeps one checkpoint per environment', async () => {
        startRun('run-3-default-store');
        const prod = checkpoint('2026-09-09T05:27:00.000Z', 'run-3');
        await actorCheckpointStore('prod').write(prod);
        await actorCheckpointStore('staging').write(checkpoint('2026-09-01T00:00:00.000Z', 'run-3'));

        startRun('run-4-default-store');
        expect(await actorCheckpointStore('prod').read()).toEqual(prod);
        expect(await actorCheckpointStore('dev').read()).toBeNull();
    });
});
