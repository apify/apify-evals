import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { snapshotWorkspace, WORKSPACE_INLINE_BYTES } from '../src/adapters/shared.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('snapshotWorkspace', () => {
    it('lists files with relative paths, inlines small text, skips dependency folders', () => {
        dir = mkdtempSync(join(tmpdir(), 'ws-'));
        mkdirSync(join(dir, '.actor'));
        mkdirSync(join(dir, 'src'));
        mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
        writeFileSync(join(dir, '.actor', 'actor.json'), '{"actorSpecification":1,"name":"demo"}');
        writeFileSync(join(dir, 'src', 'main.ts'), 'console.log(1)');
        writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'ignored');
        writeFileSync(join(dir, 'big.bin'), Buffer.alloc(WORKSPACE_INLINE_BYTES + 1, 0));
        writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
        const files = snapshotWorkspace(dir);
        const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
        expect(Object.keys(byPath).sort()).toEqual(['.actor/actor.json', 'big.bin', 'image.png', 'src/main.ts']);
        expect(JSON.parse(byPath['.actor/actor.json'].content ?? '')).toMatchObject({ name: 'demo' });
        expect(byPath['src/main.ts'].content).toBe('console.log(1)');
        expect(byPath['big.bin'].content).toBeUndefined();
        expect(byPath['image.png'].content).toBeUndefined();
        expect(byPath['image.png'].size).toBe(8);
    });

    it('returns an empty list for a missing directory', () => {
        dir = join(tmpdir(), 'ws-does-not-exist-' + Date.now());
        expect(snapshotWorkspace(dir)).toEqual([]);
    });
});
