/**
 * Deterministic three-model dataset for tests and screenshots: 6 Actors in two
 * teams, 12 days, Haiku from day 1, GPT Luna and DeepSeek Flash from day 5,
 * a Haiku alias move on day 9 and a judge move on day 9. Outcomes follow a
 * fixed pattern per (actor, task, model, day) so every UI state appears:
 * all-pass, all-fail, disagreement, inconclusive, missing.
 */
import type { Aggregate } from '../../src/aggregate.js';
import { aggregate, ownerPrefixesFromExpected } from '../../src/aggregate.js';
import type { ExpectedScenario, Observation, ReportData } from '../../src/collect.js';

export const HAIKU = '~anthropic/claude-haiku-latest';
export const LUNA = '~openai/gpt-luna-latest';
export const FLASH = '~deepseek/deepseek-flash-latest';

const ACTORS: { subject: string; owner: string }[] = [
    { subject: 'apify/instagram-scraper', owner: 'socials' },
    { subject: 'apify/facebook-posts-scraper', owner: 'socials' },
    { subject: 'maxcopell/zillow-zip-search', owner: 'socials' },
    { subject: 'compass/crawler-google-places', owner: 'google' },
    { subject: 'apify/google-search-scraper', owner: 'google' },
    { subject: 'voyager/booking-scraper', owner: 'google' },
];

export function days(n = 12, from = '2026-10-05'): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        const d = new Date(from + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + i);
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}

export function expected(): ExpectedScenario[] {
    return ACTORS.flatMap((a) => {
        const short = a.subject.split('/')[1];
        return [
            {
                id: `${short}-find`,
                subject: a.subject,
                owner: a.owner,
                skill: 'find',
                title: `${short} / find / x`,
                tags: [],
                prompt: `Find ${short} data.`,
            },
            {
                id: `${short}-use`,
                subject: a.subject,
                owner: a.owner,
                skill: 'use',
                title: `${short} / use / x`,
                tags: [],
                prompt: `Use ${a.subject} to get data.`,
            },
        ];
    });
}

/** Outcome pattern: actor index decides the story. */
function verdict(ai: number, skill: string, model: string, di: number): Observation['verdict'] | 'missing' {
    const m = model === HAIKU ? 0 : model === LUNA ? 1 : 2;
    switch (ai) {
        case 0: // instagram: discovery lost to a sibling on every model, use passes
            return skill === 'find' ? 'wrong-actor' : 'pass';
        case 1: // facebook: passes everywhere, one infra day
            return di === 7 && m === 1 ? 'inconclusive' : 'pass';
        case 2: // zillow: models disagree on use; discovery fails on Luna only
            if (skill === 'find') return m === 1 ? 'fail' : 'pass';
            return (di + m) % 3 === 0 ? 'fail' : 'pass';
        case 3: // places: everything fails before day 8 (a README fix), passes after, on all models
            return di < 8 ? 'fail' : 'pass';
        case 4: // search: missing result for DeepSeek on the last day, otherwise pass
            return di === 11 && m === 2 ? 'missing' : 'pass';
        default: // booking: DeepSeek fails always, others pass
            return m === 2 ? 'fail' : 'pass';
    }
}

export function observations(): Observation[] {
    const out: Observation[] = [];
    const ds = days();
    for (const [di, day] of ds.entries()) {
        const models = di < 4 ? [HAIKU] : [HAIKU, LUNA, FLASH];
        for (const model of models) {
            const expId = `${day}-${model}`;
            const resolved =
                model === HAIKU
                    ? di < 8
                        ? 'anthropic/claude-haiku-5.5'
                        : 'anthropic/claude-haiku-5.6'
                    : model === LUNA
                      ? 'openai/gpt-6-luna'
                      : 'deepseek/deepseek-v4.1-flash';
            for (const [ai, a] of ACTORS.entries()) {
                for (const skill of ['find', 'use']) {
                    const v = verdict(ai, skill, model, di);
                    if (v === 'missing') continue;
                    const id = `${a.subject.split('/')[1]}-${skill}`;
                    const infra = v === 'inconclusive';
                    const fail = v === 'fail' || v === 'wrong-actor';
                    out.push({
                        scenarioId: id,
                        experimentId: expId,
                        experimentName: expId,
                        model,
                        resolvedModel: resolved,
                        judgeModel: di < 8 ? 'anthropic/claude-sonnet-4.6' : 'anthropic/claude-sonnet-5.5',
                        trigger: 'scheduler',
                        repeats: 1,
                        fullScope: true,
                        startTime: `${day}T04:${String(models.indexOf(model) * 20).padStart(2, '0')}:00Z`,
                        day,
                        traceId: `t-${id}-${day}-${model}`,
                        observationId: `o-${id}-${day}-${model}`,
                        traceUrl: `https://lf/project/p/traces/t-${id}-${day}-${model.replace(/[^a-z]/g, '')}?observation=o`,
                        subject: a.subject,
                        owner: a.owner,
                        skill,
                        title: `${id} title`,
                        scores: {
                            'judge.fixArea': {
                                value: null,
                                stringValue: fail ? (skill === 'find' ? 'discoverability' : 'input-schema') : 'none',
                                comment: fail
                                    ? `The agent ${skill === 'find' ? 'ran a third-party Actor instead' : 'set maxItems wrong'}.`
                                    : 'All dimensions passed.',
                                timestamp: 't',
                            },
                            ...(fail
                                ? {
                                      'check.rightActor': {
                                          value: 0,
                                          stringValue: null,
                                          comment: 'FAIL: used other/actor',
                                          timestamp: 't',
                                      },
                                      'check.all': { value: 0, stringValue: null, comment: null, timestamp: 't' },
                                  }
                                : { 'check.all': { value: 1, stringValue: null, comment: null, timestamp: 't' } }),
                            ...(infra
                                ? {
                                      'check.infra': {
                                          value: 0,
                                          stringValue: null,
                                          comment: 'MCP server returned no tools',
                                          timestamp: 't',
                                      },
                                  }
                                : {}),
                        },
                        verdict: v,
                        fixArea: fail ? (skill === 'find' ? 'discoverability' : 'input-schema') : 'none',
                        found: skill === 'find' && !infra ? (v === 'wrong-actor' ? 0 : 1) : null,
                        works: skill === 'use' && !infra ? (v === 'pass' ? 1 : 0) : null,
                        subjectCalled:
                            skill === 'find'
                                ? v === 'wrong-actor'
                                    ? 'apify/instagram-post-scraper'
                                    : v === 'fail'
                                      ? 'none'
                                      : 'intended'
                                : null,
                        infraOk: !infra,
                        failedChecks: fail ? ['rightActor'] : [],
                        judgeComment: fail
                            ? `FAIL: ${skill === 'find' ? 'wrong Actor chosen' : 'returned 3 items instead of 10'}`
                            : infra
                              ? null
                              : 'PASS: task completed with the expected Actor',
                    });
                }
            }
        }
    }
    return out;
}

export function syntheticData(): { data: ReportData; agg: Aggregate } {
    const exp = expected();
    const data: ReportData = {
        suite: 'store-actors',
        profile: {
            name: 'store-actors',
            subjectKind: 'actor',
            skills: { find: { label: 'Found' }, use: { label: 'Works' } },
            wrongSubjectLabel: 'wrong-actor',
            fixAreas: [
                {
                    id: 'discoverability',
                    label: 'Store search / Actor selection',
                    owner: 'store',
                    description: 'The agent did not pick the expected Actor.',
                },
                {
                    id: 'input-schema',
                    label: 'Input schema',
                    owner: 'subject',
                    description: 'The agent built wrong input.',
                },
            ],
            modelLabels: {},
        },
        projectId: 'p',
        baseUrl: 'https://lf',
        generatedAt: '2026-10-16T06:00:00Z',
        window: { from: '2026-10-05', to: '2026-10-16', days: 12 },
        expected: exp,
        observations: observations(),
        experiments: [],
    };
    return { data, agg: aggregate(data, ownerPrefixesFromExpected(exp)) };
}
