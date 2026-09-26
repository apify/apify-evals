/**
 * Sync scenario files to Langfuse datasets.
 *
 *   npm run scenarios:check                 validate every suite, print problems, exit 1 on errors
 *   npm run scenarios:sync -- --dry-run     show what would change
 *   npm run scenarios:sync                  upsert items by id; archive items whose file is gone
 *   npm run scenarios:sync -- --suite store-actors
 *
 * The repo is the source of truth: an item edited in the Langfuse UI is
 * overwritten by the next sync. Needs LANGFUSE_BASE_URL / LANGFUSE_PUBLIC_KEY /
 * LANGFUSE_SECRET_KEY in the environment for anything but --check.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadSuite, type DatasetItemDraft } from './scenario-format.js';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const dryRun = args.has('--dry-run');
const suiteArg = process.argv.find((a) => a.startsWith('--suite='))?.split('=')[1];
const rootDir = resolve(process.argv.find((a) => a.startsWith('--root='))?.split('=')[1] ?? join(import.meta.dirname, '..', '..'));

// A suite is a scenarios/<name>/ folder with a matching profiles/<name>.yaml.
// Other folders (e.g. the legacy markdown scenarios) are left alone.
const suites = suiteArg
    ? [suiteArg]
    : readdirSync(join(rootDir, 'scenarios')).filter(
          (d) =>
              statSync(join(rootDir, 'scenarios', d)).isDirectory() &&
              existsSync(join(rootDir, 'profiles', `${d}.yaml`)),
      );

let hadErrors = false;
for (const suite of suites) {
    const { items, problems, profile } = loadSuite(rootDir, suite);
    const errors = problems.filter((p) => !p.includes(': warning: '));
    const warnings = problems.filter((p) => p.includes(': warning: '));
    console.log(`\n${suite} (profile ${profile.name}): ${items.length} scenarios, ${errors.length} errors, ${warnings.length} warnings`);
    for (const p of problems) console.log(`  ${p}`);
    if (errors.length > 0) {
        hadErrors = true;
        continue;
    }
    if (checkOnly) continue;
    await syncSuite(suite, items, dryRun);
}
process.exit(hadErrors ? 1 : 0);

async function syncSuite(suite: string, items: DatasetItemDraft[], dry: boolean): Promise<void> {
    for (const k of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
        if (!process.env[k]) throw new Error(`Missing ${k} (needed to sync; use --check to validate only)`);
    }
    const { LangfuseClient } = await import('@langfuse/client');
    const langfuse = new LangfuseClient();

    let existing: { id: string; status?: string; metadata?: unknown; input?: unknown; expectedOutput?: unknown }[] = [];
    try {
        existing = (await langfuse.dataset.get(suite)).items as typeof existing;
    } catch (err) {
        if (!/not found/i.test(String((err as Error).message))) throw err;
        console.log(`  dataset "${suite}" does not exist yet${dry ? '' : ', creating it'}`);
        if (!dry) await langfuse.api.datasets.create({ name: suite, description: `Scenarios from scenarios/${suite}/ (synced from the repo; edit there)` });
    }
    const byId = new Map(existing.map((e) => [e.id, e]));

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const item of items) {
        const prev = byId.get(item.id);
        const same =
            prev &&
            prev.status !== 'ARCHIVED' &&
            JSON.stringify(prev.input) === JSON.stringify(item.input) &&
            JSON.stringify(prev.expectedOutput) === JSON.stringify(item.expectedOutput) &&
            JSON.stringify(sortKeys(prev.metadata)) === JSON.stringify(sortKeys(item.metadata));
        if (same) {
            unchanged++;
            continue;
        }
        if (prev) updated++;
        else created++;
        console.log(`  ${prev ? 'update' : 'create'} ${item.id}  (${item.source})`);
        if (!dry) {
            await langfuse.dataset.createItem({
                datasetName: suite,
                id: item.id,
                input: item.input,
                expectedOutput: item.expectedOutput,
                metadata: item.metadata,
                status: 'ACTIVE',
            });
        }
    }
    const fileIds = new Set(items.map((i) => i.id));
    let archived = 0;
    for (const e of existing) {
        if (fileIds.has(e.id) || e.status === 'ARCHIVED') continue;
        archived++;
        console.log(`  archive ${e.id}  (no file for it any more)`);
        if (!dry) {
            await langfuse.dataset.createItem({
                datasetName: suite,
                id: e.id,
                input: e.input,
                expectedOutput: e.expectedOutput,
                metadata: e.metadata,
                status: 'ARCHIVED',
            });
        }
    }
    await langfuse.flush();
    console.log(
        `  ${dry ? 'would: ' : ''}${created} created, ${updated} updated, ${archived} archived, ${unchanged} unchanged`,
    );
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as object)
                .sort()
                .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
        );
    }
    return value;
}
