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
        fixAreas: [
            { id: 'discoverability', label: 'Store search / Actor selection', owner: 'store-search', description: 'd' },
            { id: 'output-format', label: 'Output format', owner: 'subject', description: 'o' },
        ],
        expected: [task('a-find', 'x/a', 'find'), task('a-use', 'x/a', 'use'), task('b-find', 'x/b', 'find'), task('b-use', 'x/b', 'use')],
        observations,
    };
}

describe('report v2 comparison', () => {
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

describe('report v2 failure patterns', () => {
    it('counts fix areas and reported alternatives over failed attempts only', () => {
        const app = application(
            model(
                [
                    { ...obs('a-find', '2026-09-24', 'wrong-actor', 0), fixArea: 'discoverability', subjectCalled: 'other/thing' },
                    { ...obs('a-find', '2026-09-25', 'wrong-actor', 0), fixArea: 'discoverability', subjectCalled: 'other/thing' },
                    // a named task never contributes an alternative, even when one is recorded
                    { ...obs('a-use', '2026-09-25', 'fail'), fixArea: 'output-format', subjectCalled: 'leak/named' },
                    // passes and infrastructure failures never count, whatever their fix area or alternative
                    { ...obs('b-find', '2026-09-25', 'pass', 0), fixArea: 'output-format', subjectCalled: 'leak/passed' },
                    { ...obs('b-use', '2026-09-25', 'fail', null, false), fixArea: 'error-messages' },
                    { ...obs('b-find', '2026-09-23', 'wrong-actor', 0, false), fixArea: 'discoverability', subjectCalled: 'leak/infra' },
                    // a failed discovery with no Actor run and no diagnosis; and one where nothing was recorded (null)
                    { ...obs('b-find', '2026-09-24', 'fail', 0), fixArea: null, subjectCalled: 'none' },
                    { ...obs('b-find', '2026-09-22', 'fail', 0), fixArea: 'none', subjectCalled: null },
                ],
                ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'],
            ),
        );
        const html = app.render(app.state(''));
        expect(html).not.toContain('Where failures land');
        const detail = (actor: string) => {
            const at = html.indexOf(`data-actor="${actor}"`);
            return html.slice(html.indexOf('<div class="patterns-detail">', at), html.indexOf('<article class="evidence"', at));
        };
        const a = detail('x/a'), b = detail('x/b');
        expect(a).toContain('3 failed attempts over');
        for (const leak of ['leak/named', 'leak/passed', 'leak/infra']) expect(a + b).not.toContain(leak);
        expect(a + b).not.toContain('Error messages');
        expect(a).toContain('Store search / Actor selection</span><b>2</b>');
        expect(a).toContain('Output format</span><b>1</b>');
        expect(a).toContain('other/thing</a></span><b>2</b>');
        expect(b).toContain('2 failed attempts over');
        expect(b).toContain('No suggested fix recorded</span><b>2</b>');
        expect(b).toContain('No Actor reported</span><b>1</b>');
        // row line: plurality fix area for Actor A; Actor B has no diagnosed failure, so no line
        expect(html).toContain('Top suggested fix: Store search / Actor selection (2 of 3 failures)');
        expect(html.match(/class="pattern"/g)?.length).toBe(1);
        // evidence shows the label, not the id
        expect(html).toContain('<p class="fix-area" title="d">Store search / Actor selection</p>');
    });

    it('lists tied fix areas and marks our own Actors as ours even when their team is filtered out', () => {
        const m = model(
            [
                { ...obs('a-find', '2026-09-25', 'wrong-actor', 0), fixArea: 'discoverability', subjectCalled: 'y/c' },
                { ...obs('a-use', '2026-09-25', 'fail'), fixArea: 'output-format' },
            ],
            ['2026-09-25'],
        );
        m.expected.push({ ...task('c-find', 'y/c', 'find'), owner: 'video' });
        const app = application(m);
        const html = app.render(app.state('#team=google'));
        expect(html).toContain('Top suggested fixes: Store search / Actor selection, Output format (1 each of 2 failures)');
        expect(html).toContain('y/c</a> <span class="ours">ours</span>');
    });
});

describe('report v2 change markers', () => {
    const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    const withMark = () =>
        application(
            model(
                days.flatMap((day) => [
                    obs('a-find', day, day < '2026-09-24' ? 'fail' : 'pass', day < '2026-09-24' ? 0 : 1),
                    obs('a-use', day, day < '2026-09-24' ? 'fail' : 'pass'),
                ]),
                days,
            ),
        );

    it('splits results at the marker with the marked day counted as after', () => {
        const app = withMark();
        const html = app.render(app.state('#mark=2026-09-24'));
        expect(html).toContain('Before vs after September 24, 2026');
        expect(html).toContain('Calendar: September 21 to 23, 2026 before, September 24 to 25, 2026 from the marker');
        const block = html.slice(html.indexOf('<section class="comparison before-after"'), html.indexOf('</table>', html.indexOf('<section class="comparison before-after"')));
        expect(block).toMatch(/Discovery tasks passed<\/th><td><span[^>]*>[^<]*<\/span>0\/3(?:<small[^>]*>[^<]*<\/small>)?<\/td><td><span[^>]*>[^<]*<\/span>2\/2(?:<small[^>]*>[^<]*<\/small>)?<\/td><td><span[^>]*>[^<]*<\/span><span class="muted">too few results on one side<\/span>/);
        // the chart carries a dashed marker line and the per-Actor detail the same split
        expect(html).toContain('change 2026-09-24</text>');
        expect(html).toContain('<li><span>Named-Actor tasks passed</span><b>0/3 → 2/2</b></li>');
        // links keep the marker
        expect(html).toContain('href="#team=google&amp;range=7&amp;mark=2026-09-24"');
        expect(html).not.toContain('Compared with the previous run');
        // the form is hidden until the browser enables it, and lists only run dates in the period
        expect(html).toContain('<form class="marker-form" hidden>');
        expect(html).toContain('value="2026-09-24">');
    });

    it('shows percentage points only when both sides have enough results', () => {
        const app = withMark();
        const html = app.render(app.state('#mark=2026-09-23'));
        const block = html.slice(html.indexOf('<section class="comparison before-after"'), html.indexOf('</table>', html.indexOf('<section class="comparison before-after"')));
        expect(block).toMatch(/Named-Actor tasks passed<\/th><td><span[^>]*>[^<]*<\/span>0\/2(?:<small[^>]*>[^<]*<\/small>)?<\/td><td><span[^>]*>[^<]*<\/span>2\/3(?:<small[^>]*>[^<]*<\/small>)?<\/td>/);
        expect(block).toContain('too few results on one side');
        const app2 = application(
            model(
                days.flatMap((day) => [obs('a-use', day, day < '2026-09-24' ? 'fail' : 'pass'), obs('b-use', day, 'pass')]),
                days,
            ),
        );
        const html2 = app2.render(app2.state('#mark=2026-09-24'));
        const block2 = html2.slice(html2.indexOf('<section class="comparison before-after"'), html2.indexOf('</table>', html2.indexOf('<section class="comparison before-after"')));
        expect(block2).toMatch(/Named-Actor tasks passed<\/th><td><span[^>]*>[^<]*<\/span>3\/6(?:<small[^>]*>[^<]*<\/small>)?<\/td><td><span[^>]*>[^<]*<\/span>4\/4(?:<small[^>]*>[^<]*<\/small>)?<\/td><td><span[^>]*>[^<]*<\/span>\+50 pp/);
    });

    it('rejects malformed dates and explains a marker outside the loaded data', () => {
        const app = withMark();
        expect((app.state('#mark=2026-02-30') as { mark: string }).mark).toBe('');
        expect((app.state('#mark=yesterday') as { mark: string }).mark).toBe('');
        const html = app.render(app.state('#mark=2026-09-01'));
        expect(html).toContain('before the earliest loaded result (September 21, 2026)');
        expect(html).not.toMatch(/change \d{4}-\d{2}-\d{2}<\/text>/);
        const late = app.render(app.state('#mark=2026-12-01'));
        expect(late).toContain('after the latest loaded result (September 25, 2026)');
    });

    it('counts only dates with eligible results per measure, not calendar days', () => {
        // results on the 21st and 25th only; the 23rd is an infrastructure failure, the rest missing
        const app = application(
            model(
                [
                    obs('a-use', '2026-09-21', 'fail'),
                    obs('a-use', '2026-09-23', 'fail', null, false),
                    obs('a-use', '2026-09-25', 'pass'),
                    obs('a-find', '2026-09-25', 'pass', null),
                ],
                days,
            ),
        );
        const html = app.render(app.state('#mark=2026-09-24'));
        const block = html.slice(html.indexOf('<section class="comparison before-after"'), html.indexOf('</table>', html.indexOf('<section class="comparison before-after"')));
        expect(block).toMatch(/Named-Actor tasks passed<\/th><td><span[^>]*>[^<]*<\/span>0\/1<small class="days">1 day<\/small><\/td><td><span[^>]*>[^<]*<\/span>1\/1<small class="days">1 day<\/small>/);
        // selection was never measured, so no eligible results and no day count
        expect(block).toMatch(/Expected Actor selected<\/th><td><span[^>]*>[^<]*<\/span>No eligible results<\/td>/);
        expect(html).toContain('<form class="marker-form" hidden>');
    });
});

describe('report v2 marker picker', () => {
    it('is a native date input bounded by the loaded data, with no submit button', () => {
        const app = application(
            model(
                [obs('a-use', '2026-09-21', 'fail'), obs('a-use', '2026-09-25', 'pass'), obs('a-use', '2026-09-30', 'pass')],
                ['2026-09-21', '2026-09-25', '2026-09-30'],
            ),
        );
        const html = app.render(app.state('#range=7&mark=2026-09-24'));
        expect(html).toContain('<input type="date" name="mark" min="2026-09-21" max="2026-09-30" value="2026-09-24">');
        expect(html).not.toContain('<button');
        expect(html).toContain('Before vs after September 24, 2026');
    });
});
