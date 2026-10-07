/**
 * Report data layer: everything the developer-facing report needs, as one
 * normalized JSON. Reads the suite's expected population from the repo
 * (scenario files) and the observed results from Langfuse (experiment items
 * with their scores), joins them, and keeps only the latest version of every
 * score so a forced re-judge does not double count.
 *
 * Nothing here renders; `render.ts` turns this into HTML/CSV.
 */
import type { LangfuseClient } from '@langfuse/client';

import { loadProfile, type Profile } from '../profiles.js';
import { loadSuite } from '../scenario-format.js';

export interface ExpectedScenario {
    id: string;
    subject: string;
    owner: string;
    skill: 'find' | 'use' | string;
    title: string;
    tags: string[];
}

export interface ScoreValue {
    value: number | null;
    stringValue: string | null;
    comment: string | null;
    timestamp: string;
}

export interface Observation {
    /** Dataset item id = scenario id. */
    scenarioId: string;
    experimentId: string;
    experimentName: string;
    /** From the experiment metadata the runner writes. */
    model: string | null;
    trigger: string | null;
    repeats: number | null;
    fullScope: boolean | null;
    startTime: string;
    /** Calendar day (UTC) of the attempt, for recurrence counting. */
    day: string;
    traceId: string;
    observationId: string;
    traceUrl: string;
    subject: string | null;
    owner: string | null;
    skill: string | null;
    title: string | null;
    /** Latest version of every score written on the experiment item, by name. */
    scores: Record<string, ScoreValue>;
    // Derived, for convenience of renderers.
    verdict: 'pass' | 'fail' | 'wrong-actor' | 'inconclusive' | 'unjudged';
    fixArea: string | null;
    found: 0 | 1 | null;
    works: 0 | 1 | null;
    subjectCalled: string | null;
    infraOk: boolean | null;
    failedChecks: string[];
    judgeComment: string | null;
}

export interface ReportData {
    suite: string;
    profile: {
        name: string;
        subjectKind: string;
        skills: Record<string, { label: string }>;
        wrongSubjectLabel: string;
    };
    projectId: string | null;
    baseUrl: string;
    generatedAt: string;
    window: { from: string; to: string; days: number };
    expected: ExpectedScenario[];
    observations: Observation[];
    experiments: {
        id: string;
        name: string;
        startTime: string;
        itemCount: number;
        trigger: string | null;
        fullScope: boolean | null;
        model: string | null;
    }[];
}

interface RawItem {
    id: string;
    traceId: string;
    startTime: string;
    experimentId: string;
    experimentName: string;
    experimentItemId: string;
    experimentMetadata?: Record<string, unknown> | null;
    experimentItemMetadata?: Record<string, unknown> | null;
    metadata?: Record<string, unknown> | null;
    scores?: {
        name: string;
        value?: number | null;
        stringValue?: string | null;
        comment?: string | null;
        timestamp?: string;
        createdAt?: string;
    }[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null =>
    typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;
/** Experiment metadata comes back stringified ("1", "false"); accept both. */
const numish = (v: unknown): number | null =>
    typeof v === 'number'
        ? v
        : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
          ? Number(v)
          : null;

interface RawScore {
    name: string;
    value?: number | string | null;
    stringValue?: string | null;
    comment?: string | null;
    timestamp?: string;
    createdAt?: string;
    traceId?: string | null;
    observationId?: string | null;
    /** scores-v3 nests the target under subject. */
    subject?: { kind?: string; id?: string; traceId?: string } | null;
}

/** All scores of the given traces, grouped by the observation they sit on
 * (experiment-item root) with a `trace:<id>` bucket for trace-level ones.
 * scores-v3 filters by one traceId per call (its experimentId filter returns
 * nothing for these scores), so calls run a few at a time. */
async function loadScoresByObservation(langfuse: LangfuseClient, traceIds: string[]): Promise<Map<string, RawScore[]>> {
    const out = new Map<string, RawScore[]>();
    const unique = [...new Set(traceIds)];
    const one = async (traceId: string) => {
        let cursor: string | undefined;
        do {
            const page = (await langfuse.api.scoresV3.getManyV3({
                traceId,
                fields: 'details,subject',
                limit: 100,
                cursor,
            })) as unknown as { data?: RawScore[]; meta?: { cursor?: string } };
            for (const sc of page.data ?? []) {
                const subj = sc.subject ?? null;
                const obsId = subj?.kind === 'observation' ? subj.id : sc.observationId;
                const key = obsId ?? `trace:${subj?.traceId ?? sc.traceId ?? traceId}`;
                const list = out.get(key) ?? [];
                list.push(sc);
                out.set(key, list);
            }
            cursor = page.meta?.cursor;
        } while (cursor);
    };
    for (let i = 0; i < unique.length; i += 8) await Promise.all(unique.slice(i, i + 8).map(one));
    return out;
}

interface RawExperiment {
    id: string;
    name: string;
    startTime?: string;
    itemCount?: number;
    metadata?: Record<string, unknown> | null;
}

/** Experiments of the dataset in the window, with the runner's metadata
 * (trigger, repeats, model, fullScope) when the API exposes it. */
async function loadExperiments(
    langfuse: LangfuseClient,
    datasetId: string,
    from: Date,
    to: Date,
): Promise<Map<string, RawExperiment>> {
    const out = new Map<string, RawExperiment>();
    let cursor: string | undefined;
    do {
        const page = (await langfuse.api.experiments.list({
            datasetId,
            fields: 'core,metadata',
            fromStartTime: from.toISOString(),
            toStartTime: to.toISOString(),
            limit: 50,
            cursor,
        })) as unknown as { data?: RawExperiment[]; meta?: { cursor?: string } };
        for (const e of page.data ?? []) out.set(e.id, e);
        cursor = page.meta?.cursor;
    } while (cursor);
    return out;
}

export function latestScores(list: RawScore[] | undefined): Record<string, ScoreValue> {
    const out: Record<string, ScoreValue> = {};
    for (const s of list ?? []) {
        const ts = String(s.timestamp ?? s.createdAt ?? '');
        const cur = out[s.name];
        if (cur && cur.timestamp > ts) continue;
        // scores-v3 returns categorical values in `value` as a string.
        out[s.name] = {
            value: num(s.value),
            stringValue: str(s.stringValue) ?? (typeof s.value === 'string' ? s.value : null),
            comment: str(s.comment),
            timestamp: ts,
        };
    }
    return out;
}

export function derive(
    scores: Record<string, ScoreValue>,
    wrongSubjectLabel: string,
): Pick<
    Observation,
    'verdict' | 'fixArea' | 'found' | 'works' | 'subjectCalled' | 'infraOk' | 'failedChecks' | 'judgeComment'
> {
    const v = scores['judge.verdict']?.stringValue ?? null;
    const verdict: Observation['verdict'] =
        v === 'pass' || v === 'fail' || v === 'inconclusive'
            ? v
            : v === wrongSubjectLabel || v === 'wrong-subject'
              ? 'wrong-actor'
              : 'unjudged';
    const asBit = (s: ScoreValue | undefined): 0 | 1 | null => (s?.value === 1 ? 1 : s?.value === 0 ? 0 : null);
    const failedChecks = Object.entries(scores)
        .filter(
            ([name, s]) => name.startsWith('check.') && !['check.all', 'check.infra'].includes(name) && s.value === 0,
        )
        .map(([name]) => name.slice('check.'.length));
    return {
        verdict,
        fixArea: scores['judge.fixArea']?.stringValue ?? null,
        found: asBit(scores['eval.found']),
        works: asBit(scores['eval.works']),
        subjectCalled: scores['eval.subjectCalled']?.stringValue ?? null,
        infraOk: scores['check.infra'] ? scores['check.infra'].value === 1 : null,
        failedChecks,
        judgeComment: scores['judge.overall']?.comment ?? null,
    };
}

export interface CollectOptions {
    rootDir: string;
    suite: string;
    days: number;
    now?: Date;
    /** Project id for trace links; read from the first score or passed in. */
    projectId?: string;
    baseUrl?: string;
}

export async function collectReportData(langfuse: LangfuseClient, opts: CollectOptions): Promise<ReportData> {
    const now = opts.now ?? new Date();
    const from = new Date(now.getTime() - opts.days * 86_400_000);
    const baseUrl = opts.baseUrl ?? process.env.LANGFUSE_BASE_URL ?? 'https://langfuse.apify.dev';
    const profile: Profile = loadProfile(opts.rootDir, opts.suite);
    const { items: files } = loadSuite(opts.rootDir, opts.suite);
    const expected: ExpectedScenario[] = files.map((it) => {
        const m = it.metadata as unknown as Record<string, unknown>;
        const subject = (m.subject as { id?: string } | undefined)?.id ?? String(m.actor ?? '');
        return {
            id: it.id,
            subject,
            owner: String(m.owner ?? m.team ?? ''),
            skill: String(m.skill ?? ''),
            title: String(m.title ?? it.id),
            tags: Array.isArray(m.tags) ? (m.tags as unknown[]).map(String) : [],
        };
    });

    const dataset = (await langfuse.dataset.get(opts.suite)) as unknown as { id: string };
    const raw: RawItem[] = [];
    let cursor: string | undefined;
    do {
        const page = (await langfuse.api.experiments.listItems({
            datasetId: dataset.id,
            fields: 'core',
            fromStartTime: from.toISOString(),
            toStartTime: now.toISOString(),
            limit: 100,
            cursor,
        })) as unknown as { data?: RawItem[]; meta?: { cursor?: string; nextCursor?: string } };
        raw.push(...(page.data ?? []));
        cursor = page.meta?.cursor ?? page.meta?.nextCursor;
    } while (cursor);

    // Scores come from scores-v3, not the items' embedded list: that list is
    // capped at 50 per item and a forced re-judge writes a second version of
    // every score, so the cap would silently drop the newest ones.
    const scoresByObservation = await loadScoresByObservation(
        langfuse,
        raw.map((it) => it.traceId),
    );
    const experimentMeta = await loadExperiments(langfuse, dataset.id, from, now);
    const expectedById = new Map(expected.map((e) => [e.id, e]));

    const projectId = opts.projectId ?? null;
    const experiments = new Map<string, ReportData['experiments'][number]>();
    const observations: Observation[] = raw.map((it) => {
        const em = it.experimentMetadata ?? experimentMeta.get(it.experimentId)?.metadata ?? {};
        const exp0 = expectedById.get(it.experimentItemId);
        const im = it.experimentItemMetadata ?? {};
        const scores = latestScores(
            scoresByObservation.get(it.id) ?? scoresByObservation.get(`trace:${it.traceId}`) ?? [],
        );
        const subject = exp0?.subject ?? (im.subject as { id?: string } | undefined)?.id ?? str(im.actor);
        const exp = experiments.get(it.experimentId) ?? {
            id: it.experimentId,
            name: it.experimentName,
            startTime: it.startTime,
            itemCount: 0,
            trigger: str(em.trigger),
            fullScope: bool(em.fullScope),
            model: str(em.model),
        };
        exp.itemCount++;
        if (it.startTime < exp.startTime) exp.startTime = it.startTime;
        experiments.set(it.experimentId, exp);
        return {
            scenarioId: it.experimentItemId,
            experimentId: it.experimentId,
            experimentName: it.experimentName,
            model: str(em.model),
            trigger: str(em.trigger),
            repeats: numish(em.repeats),
            fullScope: bool(em.fullScope),
            startTime: it.startTime,
            day: it.startTime.slice(0, 10),
            traceId: it.traceId,
            observationId: it.id,
            traceUrl: projectId
                ? `${baseUrl}/project/${projectId}/traces/${it.traceId}?observation=${it.id}`
                : `${baseUrl}/trace/${it.traceId}`,
            subject,
            owner: exp0?.owner ?? str(im.owner) ?? str(im.team),
            skill: exp0?.skill ?? str(im.skill),
            title: exp0?.title ?? str(im.title),
            scores,
            ...derive(scores, profile.wrongSubjectLabel),
        };
    });
    observations.sort((a, b) => a.startTime.localeCompare(b.startTime));

    return {
        suite: opts.suite,
        profile: {
            name: profile.name,
            subjectKind: profile.subjectKind,
            skills: Object.fromEntries(Object.entries(profile.skills).map(([k, v]) => [k, { label: v.label }])),
            wrongSubjectLabel: profile.wrongSubjectLabel,
        },
        projectId,
        baseUrl,
        generatedAt: now.toISOString(),
        window: { from: from.toISOString(), to: now.toISOString(), days: opts.days },
        expected,
        observations,
        experiments: [...experiments.values()].sort((a, b) => a.startTime.localeCompare(b.startTime)),
    };
}
