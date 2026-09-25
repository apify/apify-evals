import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Load the client the way the renderer does: a bare script in a vm sandbox.
const sandbox: { module: { exports: Record<string, unknown> }; URLSearchParams: typeof URLSearchParams } = {
    module: { exports: {} },
    URLSearchParams,
};
vm.runInNewContext(readFileSync(new URL('../assets/client-v2.js', import.meta.url), 'utf8'), sandbox);
const application = sandbox.module.exports.application as (model: unknown) => {
    render: (s: unknown) => string;
    state: (h?: string) => unknown;
};

const task = (id: string, subject: string, skill: 'find' | 'use') => ({
    id,
    subject,
    owner: 'google',
    skill,
    title: `${subject} / ${skill}`,
    tags: [],
    prompt: 'p',
});
const obs = (scenarioId: string, day: string, verdict: string, found: 0 | 1 | null = null, infraOk = true) => ({
    scenarioId,
    day,
    verdict,
    found,
    infraOk,
    failedChecks: verdict === 'fail' ? ['apify.run'] : [],
    fixArea: null,
    subjectCalled: null,
    judgeComment: `${verdict} comment`,
    traceUrl: 'https://langfuse.example/trace',
    scores: {},
});

function model(observations: unknown[], days: string[]) {
    return {
        suite: 'store-actors',
        generatedAt: '2026-09-25T06:00:00Z',
        days,
        excludedAttempts: 0,
        expected: [task('a-find', 'x/a', 'find'), task('a-use', 'x/a', 'use'), task('b-find', 'x/b', 'find'), task('b-use', 'x/b', 'use')],
        observations,
    };
}

describe('report v2 comparison', () => {
    it('pairs tasks by id across the two latest canonical days and lists transitions', () => {
        const app = application(
            model(
                [
                    obs('a-find', '2026-09-24', 'pass', 1),
                    obs('a-find', '2026-09-25', 'wrong-actor', 0),
                    obs('a-use', '2026-09-24', 'fail'),
                    obs('a-use', '2026-09-25', 'pass'),
                    obs('b-find', '2026-09-24', 'pass', 1),
                    obs('b-find', '2026-09-25', 'inconclusive', null, false), // not usable → omitted
                    obs('b-use', '2026-09-25', 'pass'), // no previous result → omitted
                ],
                ['2026-09-24', '2026-09-25'],
            ),
        );
        const html = app.render(app.state(''));
        expect(html).toContain('Compared with the previous run');
        expect(html).toContain('September 24 to 25, 2026');
        // discovery: only a-find paired: pass → wrong-actor
        const discoveryRow = html.slice(html.indexOf('Discovery tasks passed</th>'), html.indexOf('Named-Actor tasks passed</th>'));
        expect(discoveryRow).toContain('Previous</span>1/1</td>');
        expect(discoveryRow).toContain('Latest</span>0/1</td>');
        expect(discoveryRow).toContain('−1 passed');
        // named: only a-use paired: fail → pass
        expect(html).toContain('+1 passed');
        expect(html).toContain('left out: 1 discovery, 1 named');
        expect(html).toContain('1 passed before and failed now');
        expect(html).toContain('1 failed before and passed now');

        const withList = app.render(app.state('#team=all&range=7&compare=discovery'));
        expect(withList).toContain('Passed before, failed now <span>1</span>');
        expect(withList).toContain('Latest evidence');
    });

    it('explains a missing baseline instead of showing zero fractions', () => {
        const app = application(model([obs('a-find', '2026-09-25', 'pass', 1), obs('a-use', '2026-09-25', 'pass')], ['2026-09-25']));
        const html = app.render(app.state(''));
        expect(html).toContain('No earlier run to compare.');
        expect(html).toContain('No earlier comparable run is available.');
    });

    it('marks failed checks only on failing cells and mutes them on passing ones', () => {
        const app = application(
            model(
                [
                    { ...obs('a-use', '2026-09-25', 'pass'), failedChecks: ['apify.items'] },
                    obs('b-use', '2026-09-25', 'fail'),
                ],
                ['2026-09-25'],
            ),
        );
        const html = app.render(app.state(''));
        expect(html).toContain('1 check failed, task still passed');
        expect(html).toContain('× 1 failed check</a>');
        expect(html).toContain('What these numbers mean');
        expect(html).toContain('How this is measured');
    });
});
