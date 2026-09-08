/**
 * Creates the online-eval score configs in a Langfuse project (ai-team#268).
 * Idempotent: lists what exists, creates only the missing configs, and prints
 * a table. Configs already present are left untouched; a same-name config
 * with the wrong dataType or an archived one is reported as a conflict and
 * the script exits 1 without creating anything for that name.
 *
 * Run from the repo root with the project's keys in the environment:
 *   LANGFUSE_BASE_URL=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
 *     npm run create-score-configs --workspace actors/judge
 */
import { LangfuseClient } from '@langfuse/client';

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
            rows.push({ name: entry.name, status: 'CONFLICT', detail: `${entry.reason} (id ${entry.id})` });
        }
    }
    console.table(rows);

    const conflicts = plan.filter((e) => e.action === 'conflict');
    if (conflicts.length > 0) {
        throw new Error(`${conflicts.length} score config(s) conflict; resolve them in the Langfuse UI and re-run`);
    }
}

await main();
