import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseScenario } from '../index.js';

const SCENARIOS_DIR = join(import.meta.dirname, '../../../scenarios');

/**
 * Collect all .md scenario files from scenarios/ and its subdirectories.
 */
function collectScenarioFiles(dir: string, prefix = ''): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') {
            const label = prefix ? `${prefix}/${entry.name}` : entry.name;
            files.push(label);
        } else if (entry.isDirectory()) {
            const subLabel = prefix ? `${prefix}/${entry.name}` : entry.name;
            files.push(...collectScenarioFiles(join(dir, entry.name), subLabel));
        }
    }

    return files;
}

const scenarioFiles = collectScenarioFiles(SCENARIOS_DIR);

describe('scenario files parse successfully', () => {
    it('found at least one scenario file', () => {
        expect(scenarioFiles.length).toBeGreaterThan(0);
    });

    it.each(scenarioFiles)('%s', (relativePath) => {
        const fullPath = join(SCENARIOS_DIR, relativePath);
        const content = readFileSync(fullPath, 'utf-8');

        const result = parseScenario(content);

        // meta.name must be a non-empty string
        expect(result.meta.name).toBeTruthy();
        expect(typeof result.meta.name).toBe('string');

        // at least one test
        expect(result.tests.length).toBeGreaterThanOrEqual(1);

        // each test has non-empty test and checkpoint strings
        for (const tc of result.tests) {
            expect(tc.test.trim().length).toBeGreaterThan(0);
            expect(tc.checkpoint.trim().length).toBeGreaterThan(0);
        }
    });
});
