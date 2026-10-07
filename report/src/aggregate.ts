/**
 * Turn the collected observations into the report's sections. Pure functions,
 * no I/O. "Canonical" observations are the ones the portfolio and recurrence
 * numbers are built from: full-scope runs (the daily schedule), not filtered
 * team reruns or repeat diagnostics, which are counted separately.
 */
import type { ExpectedScenario, Observation, ReportData } from './collect.js';

export interface SkillCell {
    attempts: number;
    pass: number;
    fail: number;
    wrongSubject: number;
    inconclusive: number;
    /** find scenarios that ran but had no applicable subject check. */
    notMeasured: number;
    days: string[];
    latest: Observation | null;
    /** Verdict letters in time order: P pass, F fail, W wrong subject, I inconclusive, U unjudged. */
    sequence: string;
}

export interface PortfolioRow {
    subject: string;
    owner: string;
    cells: Record<string, SkillCell>;
    /** Expected scenario ids that never produced an observation in the window. */
    missing: string[];
}

export interface ObservationGroup {
    key: string;
    subject: string;
    owner: string;
    scenarioId: string;
    title: string;
    skill: string;
    model: string;
    fixArea: string;
    verdicts: Record<string, number>;
    occurrences: number;
    eligible: number;
    days: string[];
    firstSeen: string;
    lastSeen: string;
    sequence: string;
    evidence: string | null;
    failedChecks: string[];
    lostTo: string[];
    latestUrl: string;
    urls: string[];
}

export interface DiscoveryRow {
    subject: string;
    owner: string;
    attempts: number;
    intended: number;
    none: number;
    notMeasured: number;
    inconclusive: number;
    lostTo: { subject: string; count: number; ours: boolean }[];
}

export interface Aggregate {
    canonical: Observation[];
    diagnostics: Observation[];
    header: {
        generatedAt: string;
        window: ReportData['window'];
        canonicalRuns: number;
        latestRun: { day: string; judged: number; expected: number; inconclusive: number; unjudged: number } | null;
        totals: Record<string, number>;
    };
    portfolio: PortfolioRow[];
    recurring: ObservationGroup[];
    fresh: ObservationGroup[];
    discovery: DiscoveryRow[];
    maintainers: { inconclusive: Observation[]; unjudged: Observation[]; disagreements: Observation[] };
}

const LETTER: Record<Observation['verdict'], string> = {
    pass: 'P',
    fail: 'F',
    'wrong-actor': 'W',
    inconclusive: 'I',
    unjudged: 'U',
};

const SCHEDULED = (t: string | null) => (t ?? '').toLowerCase().startsWith('schedul');

/**
 * One canonical result per task per day: the scheduled full-scope run, or,
 * on a day without one, the only full-scope single-repeat run. Extra full runs
 * on the same day (e.g. three concurrent manual runs) stay out of the counts
 * and are listed as excluded, so a day never carries more than one attempt
 * per task.
 */
export function canonicalExperimentIds(observations: Observation[]): Set<string> {
    const byDay = new Map<string, Map<string, Observation>>();
    for (const o of observations) {
        if (o.fullScope !== true || (o.repeats ?? 1) > 1) continue;
        const day = byDay.get(o.day) ?? new Map<string, Observation>();
        if (!day.has(o.experimentId)) day.set(o.experimentId, o);
        byDay.set(o.day, day);
    }
    const out = new Set<string>();
    for (const runs of byDay.values()) {
        const list = [...runs.values()];
        const scheduled = list.filter((o) => SCHEDULED(o.trigger));
        if (scheduled.length > 0) for (const o of scheduled) out.add(o.experimentId);
        else if (list.length === 1) out.add(list[0].experimentId);
    }
    return out;
}

export function isCanonical(o: Observation, canonicalIds?: Set<string>): boolean {
    if (!canonicalIds) return o.fullScope === true && (o.repeats ?? 1) <= 1;
    return canonicalIds.has(o.experimentId);
}

const emptyCell = (): SkillCell => ({
    attempts: 0,
    pass: 0,
    fail: 0,
    wrongSubject: 0,
    inconclusive: 0,
    notMeasured: 0,
    days: [],
    latest: null,
    sequence: '',
});

function uniqueSorted(xs: string[]): string[] {
    return [...new Set(xs)].sort();
}

export function aggregate(data: ReportData, ourPrefixes: string[]): Aggregate {
    const canonicalIds = canonicalExperimentIds(data.observations);
    const canonical = data.observations
        .filter((o) => isCanonical(o, canonicalIds))
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const diagnostics = data.observations.filter((o) => !isCanonical(o, canonicalIds));
    const expectedById = new Map(data.expected.map((e) => [e.id, e]));
    const skills = Object.keys(data.profile.skills);

    // Portfolio: expected subjects first, so an Actor with no data still has a row.
    const rows = new Map<string, PortfolioRow>();
    for (const e of data.expected) {
        const row = rows.get(e.subject) ?? {
            subject: e.subject,
            owner: e.owner,
            cells: Object.fromEntries(skills.map((s) => [s, emptyCell()])),
            missing: [],
        };
        rows.set(e.subject, row);
    }
    const seenScenario = new Set<string>();
    for (const o of canonical) {
        const e = expectedById.get(o.scenarioId);
        const subject = o.subject ?? e?.subject ?? 'unknown';
        const row = rows.get(subject) ?? {
            subject,
            owner: o.owner ?? e?.owner ?? 'unknown',
            cells: Object.fromEntries(skills.map((s) => [s, emptyCell()])),
            missing: [],
        };
        rows.set(subject, row);
        const skill = o.skill ?? e?.skill ?? 'use';
        const cell = (row.cells[skill] ??= emptyCell());
        seenScenario.add(o.scenarioId);
        cell.attempts++;
        if (o.verdict === 'pass') cell.pass++;
        else if (o.verdict === 'fail') cell.fail++;
        else if (o.verdict === 'wrong-actor') cell.wrongSubject++;
        else if (o.verdict === 'inconclusive') cell.inconclusive++;
        if (skill === 'find' && o.verdict !== 'inconclusive' && o.verdict !== 'unjudged' && o.found === null)
            cell.notMeasured++;
        cell.days = uniqueSorted([...cell.days, o.day]);
        cell.sequence += LETTER[o.verdict];
        if (!cell.latest || cell.latest.startTime < o.startTime) cell.latest = o;
    }
    for (const e of data.expected) if (!seenScenario.has(e.id)) rows.get(e.subject)?.missing.push(e.id);
    const portfolio = [...rows.values()].sort(
        (a, b) => a.owner.localeCompare(b.owner) || a.subject.localeCompare(b.subject),
    );

    // Observation groups: fail + wrong-subject, keyed without the day.
    const eligible = new Map<string, number>();
    for (const o of canonical)
        if (o.verdict !== 'inconclusive' && o.verdict !== 'unjudged')
            eligible.set(`${o.scenarioId}|${o.model}`, (eligible.get(`${o.scenarioId}|${o.model}`) ?? 0) + 1);
    const groups = new Map<string, ObservationGroup>();
    for (const o of canonical) {
        if (o.verdict !== 'fail' && o.verdict !== 'wrong-actor') continue;
        const e = expectedById.get(o.scenarioId);
        const fixArea = o.fixArea ?? 'unknown';
        const key = `${o.subject ?? e?.subject}|${o.scenarioId}|${o.model}|${fixArea}`;
        const g = groups.get(key) ?? {
            key,
            subject: o.subject ?? e?.subject ?? 'unknown',
            owner: o.owner ?? e?.owner ?? 'unknown',
            scenarioId: o.scenarioId,
            title: o.title ?? e?.title ?? o.scenarioId,
            skill: o.skill ?? e?.skill ?? '',
            model: o.model ?? 'unknown',
            fixArea,
            verdicts: {},
            occurrences: 0,
            eligible: eligible.get(`${o.scenarioId}|${o.model}`) ?? 0,
            days: [],
            firstSeen: o.day,
            lastSeen: o.day,
            sequence: '',
            evidence: null,
            failedChecks: [],
            lostTo: [],
            latestUrl: o.traceUrl,
            urls: [],
        };
        g.occurrences++;
        g.verdicts[o.verdict] = (g.verdicts[o.verdict] ?? 0) + 1;
        g.days = uniqueSorted([...g.days, o.day]);
        if (o.day < g.firstSeen) g.firstSeen = o.day;
        if (o.day >= g.lastSeen) {
            g.lastSeen = o.day;
            g.evidence = o.judgeComment;
            g.latestUrl = o.traceUrl;
        }
        g.failedChecks = uniqueSorted([...g.failedChecks, ...o.failedChecks]);
        if (o.subjectCalled && o.subjectCalled !== 'intended' && o.subjectCalled !== 'none')
            g.lostTo = uniqueSorted([...g.lostTo, o.subjectCalled]);
        g.urls.push(o.traceUrl);
        groups.set(key, g);
    }
    // Sequence per group = the scenario's full canonical history, not only the failures.
    for (const g of groups.values()) {
        g.sequence = canonical
            .filter((o) => o.scenarioId === g.scenarioId && o.model === g.model)
            .map((o) => LETTER[o.verdict])
            .join('');
    }
    const all = [...groups.values()].sort(
        (a, b) =>
            b.days.length - a.days.length || b.lastSeen.localeCompare(a.lastSeen) || a.subject.localeCompare(b.subject),
    );
    const recurring = all.filter((g) => g.days.length >= 2);
    const fresh = all.filter((g) => g.days.length < 2);

    // Discovery: find scenarios only, who got the run.
    const disc = new Map<string, DiscoveryRow>();
    const ours = (id: string) => ourPrefixes.some((p) => id.toLowerCase().startsWith(p.toLowerCase() + '/'));
    for (const o of canonical) {
        const e = expectedById.get(o.scenarioId);
        if ((o.skill ?? e?.skill) !== 'find') continue;
        const subject = o.subject ?? e?.subject ?? 'unknown';
        const row = disc.get(subject) ?? {
            subject,
            owner: o.owner ?? e?.owner ?? 'unknown',
            attempts: 0,
            intended: 0,
            none: 0,
            notMeasured: 0,
            inconclusive: 0,
            lostTo: [],
        };
        row.attempts++;
        if (o.verdict === 'inconclusive' || o.verdict === 'unjudged') row.inconclusive++;
        else if (o.found === null) row.notMeasured++;
        else if (o.subjectCalled === 'intended' || o.found === 1) row.intended++;
        else if (o.subjectCalled === 'none') row.none++;
        else if (o.subjectCalled) {
            const hit = row.lostTo.find((l) => l.subject === o.subjectCalled);
            if (hit) hit.count++;
            else row.lostTo.push({ subject: o.subjectCalled, count: 1, ours: ours(o.subjectCalled) });
        } else row.notMeasured++;
        disc.set(subject, row);
    }
    const discovery = [...disc.values()].sort(
        (a, b) => b.lostTo.length + b.none - (a.lostTo.length + a.none) || a.subject.localeCompare(b.subject),
    );

    // Header.
    const totals: Record<string, number> = {};
    for (const o of canonical) totals[o.verdict] = (totals[o.verdict] ?? 0) + 1;
    const days = uniqueSorted(canonical.map((o) => o.day));
    const lastDay = days.at(-1);
    const latestRun = lastDay
        ? {
              day: lastDay,
              judged: canonical.filter((o) => o.day === lastDay && o.verdict !== 'unjudged').length,
              expected: data.expected.length,
              inconclusive: canonical.filter((o) => o.day === lastDay && o.verdict === 'inconclusive').length,
              unjudged: canonical.filter((o) => o.day === lastDay && o.verdict === 'unjudged').length,
          }
        : null;

    return {
        canonical,
        diagnostics,
        header: {
            generatedAt: data.generatedAt,
            window: data.window,
            canonicalRuns: new Set(canonical.map((o) => o.experimentId)).size,
            latestRun,
            totals,
        },
        portfolio,
        recurring,
        fresh,
        discovery,
        maintainers: {
            inconclusive: canonical.filter((o) => o.verdict === 'inconclusive'),
            unjudged: canonical.filter((o) => o.verdict === 'unjudged'),
            disagreements: canonical.filter((o) => o.scores['judge.disagreement']?.value === 1),
        },
    };
}

export function ownerPrefixesFromExpected(expected: ExpectedScenario[]): string[] {
    return uniqueSorted(expected.map((e) => e.subject.split('/')[0]));
}
