/**
 * Creates the online-eval score configs in a Langfuse project (ai-team#268).
 * Idempotent: lists what exists, creates only the missing configs, and prints
 * a table. Configs already present are left untouched; a same-name config
 * with the wrong dataType or an archived one is reported as a conflict and
 * the script exits 1 without creating anything for that name.
 *
 * Score configs cannot be deleted, so before creating anything the script
 * checks that the keys belong to the online project ("Apify AI Agent", the
 * one production apify-ai traces and the online scores live in). The shell's
 * LANGFUSE_* keys usually point at the dataset-run project ("MCP Agent
 * Evals"); run with them by mistake and the configs would be permanent there.
 * Set LANGFUSE_PROJECT (name or id) to target another project on purpose.
 *
 * Run from the repo root with the ONLINE project's keys in the environment:
 *   LANGFUSE_BASE_URL=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
 *     npm run create-score-configs --workspace actors/judge
 */
import { LangfuseClient } from '@langfuse/client';

import { assertOnlineProject, DEFAULT_ONLINE_PROJECT, langfuseProjectFetcher } from '../src/online-project.js';
import { desiredOnlineScoreConfigs, type ExistingScoreConfig, planScoreConfigs } from '../src/score-configs.js';

const REQUIRED_ENV = ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'] as const;
const PAGE_SIZE = 50;

/** GET /api/public/score-configs is page-numbered (meta.page / meta.totalPages). */
async function listAllScoreConfigs(langfuse: LangfuseClient): Promise<ExistingScoreConfig[]> {
    const all: ExistingScoreConfig[] = [];
    let page = 1;
    let totalPages = 1;
    do {
        const res = await langfuse.api.scoreConfigs.get({ page, limit: PAGE_SIZE });
        all.push(...res.data);
        totalPages = res.meta.totalPages;
        page++;
    } while (page <= totalPages);
    return all;
}

async function main(): Promise<void> {
    const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length > 0) throw new Error(`Missing env: ${missing.join(', ')}`);

    const langfuse = new LangfuseClient();
    // Before any write: configs are permanent, so the wrong project is not recoverable.
    const project = await assertOnlineProject(
        langfuseProjectFetcher(langfuse),
        process.env.LANGFUSE_PROJECT ?? DEFAULT_ONLINE_PROJECT,
    );
    console.log(`Langfuse project: ${project.name} (${project.id})`);
    const existing = await listAllScoreConfigs(langfuse);
    const plan = planScoreConfigs(desiredOnlineScoreConfigs(), existing);

    const rows: { name: string; status: string; detail: string }[] = [];
    for (const entry of plan) {
        if (entry.action === 'create') {
            const created = await langfuse.api.scoreConfigs.create(entry.config);
            rows.push({ name: entry.name, status: 'created', detail: created.id });
        } else if (entry.action === 'exists') {
            rows.push({ name: entry.name, status: 'existing', detail: entry.id });
        } else {
            rows.push({ name: entry.name, status: 'CONFLICT', detail: entry.reason });
        }
    }
    console.table(rows);

    const conflicts = plan.filter((e) => e.action === 'conflict');
    if (conflicts.length > 0) {
        throw new Error(`${conflicts.length} score config(s) conflict; resolve them in the Langfuse UI and re-run`);
    }
}

await main();
