/**
 * Judge calibration: compare human review (score `human.verdict` from the
 * judge-audit annotation queue) with the judge's verdict on the same trace.
 *
 *   npm -w tools run judge:calibrate            print the agreement table
 *   npm -w tools run judge:calibrate -- --write write calibration.agreement (1/0) on each reviewed item
 *
 * Agreement is reported per judge version tuple (rubric, model, prompt, impl)
 * so a prompt change can be judged by its own number. Needs the Langfuse env.
 */
import { LangfuseClient } from '@langfuse/client';

const write = process.argv.includes('--write');
for (const k of ['LANGFUSE_BASE_URL', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY']) {
    if (!process.env[k]) throw new Error(`Missing ${k}`);
}
const langfuse = new LangfuseClient();

interface Score {
    name?: string;
    value?: unknown;
    stringValue?: string;
    comment?: string;
    metadata?: Record<string, unknown>;
    subject?: { kind?: string; id?: string; traceId?: string };
    source?: string;
}

async function listScores(params: Record<string, unknown>): Promise<Score[]> {
    const out: Score[] = [];
    let cursor: string | undefined;
    do {
        const page = (await langfuse.api.scoresV3.getManyV3({ ...params, limit: 100, cursor, fields: 'details,subject' } as never)) as unknown as {
            data?: Score[];
            meta?: { cursor?: string };
        };
        out.push(...(page.data ?? []));
        cursor = page.meta?.cursor;
    } while (cursor);
    return out;
}

const human = await listScores({ name: 'human.verdict', source: 'ANNOTATION' });
if (human.length === 0) {
    console.log('No human.verdict annotations yet. Review items in the judge-audit queue first.');
    process.exit(0);
}
const traceIds = [...new Set(human.map((h) => h.subject?.traceId).filter((x): x is string => Boolean(x)))];
const judgeVerdicts = new Map<string, Score>();
for (let i = 0; i < traceIds.length; i += 50) {
    for (const s of await listScores({ name: 'judge.verdict', traceId: traceIds.slice(i, i + 50).join(',') })) {
        if (s.subject?.traceId) judgeVerdicts.set(s.subject.traceId, s);
    }
}

const byVersion = new Map<string, { agree: number; disagree: number; unsure: number }>();
let written = 0;
for (const h of human) {
    const traceId = h.subject?.traceId;
    const j = traceId ? judgeVerdicts.get(traceId) : undefined;
    if (!traceId || !j) continue;
    const label = String(h.stringValue ?? h.value ?? '').toLowerCase();
    const m = j.metadata ?? {};
    const key = `${m.rubricVersion} · ${m.judgeModel} · prompt v${m.promptVersion} · impl ${m.judgeImplVersion}`;
    const row = byVersion.get(key) ?? { agree: 0, disagree: 0, unsure: 0 };
    if (label === 'agree') row.agree++;
    else if (label === 'disagree') row.disagree++;
    else row.unsure++;
    byVersion.set(key, row);
    if (write && label !== 'unsure' && j.subject?.id) {
        await langfuse.api.scores.create({
            traceId,
            observationId: j.subject.id,
            name: 'calibration.agreement',
            value: label === 'agree' ? 1 : 0,
            comment: `human ${label} with judge verdict "${j.stringValue ?? j.value}"${h.comment ? `: ${h.comment.slice(0, 300)}` : ''}`,
            metadata: { ...m, source: 'judge-calibrate' },
        });
        written++;
    }
}
await langfuse.flush();

console.log(`\nJudge agreement with human review (${human.length} annotations)\n`);
for (const [key, r] of byVersion) {
    const decided = r.agree + r.disagree;
    const rate = decided === 0 ? 'n/a' : `${Math.round((r.agree / decided) * 100)}%`;
    console.log(`${key}\n  agreement ${rate} (${r.agree} agree, ${r.disagree} disagree, ${r.unsure} unsure)`);
}
if (write) console.log(`\ncalibration.agreement written on ${written} item(s).`);
else console.log('\nRun with --write to store calibration.agreement scores for the dashboard.');
