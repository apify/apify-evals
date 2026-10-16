import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

import { buildV2Model } from '../src/render-v2.js';
import { HAIKU, LUNA, syntheticData } from './fixtures/multi-model.js';

const sandbox: { module: { exports: Record<string, unknown> }; URLSearchParams: typeof URLSearchParams } = {
    module: { exports: {} },
    URLSearchParams,
};
vm.runInNewContext(readFileSync(new URL('../assets/client-v2.js', import.meta.url), 'utf8'), sandbox);
const application = sandbox.module.exports.application as (m: unknown) => {
    render: (s: unknown) => string;
    state: (h?: string) => { model: string };
};

const { data, agg } = syntheticData();
const app = application(buildV2Model(data, agg));
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('report v2 client with three models', () => {
    it('shows model tabs, the models line and a three-line chart in the All view', () => {
        const h = app.render(app.state(''));
        expect(h).toContain('>All models<');
        expect(h).toContain('>Haiku<');
        expect(h).toContain('>GPT Luna<');
        expect(h).toContain('>DeepSeek Flash<');
        // The tabs name the models; the resolved ids live under "How this is measured", not in a standing line.
        expect(text(h)).not.toContain('Models in latest run');
        expect(text(h)).toContain('Models in this export: Haiku (~anthropic/claude-haiku-latest');
        expect(text(h)).toContain(
            'Model update in this period: Haiku changed from claude-haiku-5.5 to claude-haiku-5.6 on October 13, 2026; Judge changed from claude-sonnet-4.6 to claude-sonnet-5.5 on October 13, 2026.',
        );
        expect((h.match(/<polyline/g) || []).length).toBe(6); // 3 models x 2 charts, no dashed selection line
        expect(h).toContain('Haiku, Judge updated 10/13');
    });

    it('summarises universal versus partial failures and sorts by failing attempts', () => {
        const h = app.render(app.state(''));
        // latest day 2026-10-16: instagram (find fails on all 3), zillow (find fails on Luna; use fails on some), booking (DeepSeek fails both)
        expect(text(h)).toMatch(
            /3 of 6 Actors had a failing task in the latest run \(1 on all 3 models, 2 on 1 or 2\)/,
        );
        const order = [...h.matchAll(/data-actor="([^"]+)"/g)].map((m) => m[1]);
        expect(order.slice(0, 3)).toEqual([
            'voyager/booking-scraper',
            'apify/google-search-scraper',
            'compass/crawler-google-places',
        ]);
        expect(order.slice(3)).toEqual([
            'apify/instagram-scraper',
            'maxcopell/zillow-zip-search',
            'apify/facebook-posts-scraper',
        ]);
    });

    it('renders cross-model badges, per-model pills and disagreement cells', () => {
        const h = app.render(app.state(''));
        const booking = h.slice(
            h.indexOf('data-actor="voyager/booking-scraper"'),
            h.indexOf('data-actor="compass/crawler-google-places"'),
        );
        expect(text(booking)).toContain('2/3 passed');
        expect(booking).toContain('class="pill F"');
        expect(booking).toContain('× 1 failed check on DeepSeek Flash');
        const zillow = h.slice(
            h.indexOf('data-actor="maxcopell/zillow-zip-search"'),
            h.indexOf('data-actor="apify/facebook-posts-scraper"'),
        );
        expect(zillow).toMatch(/class="day-cell F mixed"[^>]*>[12]\/3</);
    });

    it('a single-model view renders like the old page for that model', () => {
        const h = app.render(app.state('#model=gpt-luna'));
        expect(h).not.toContain('class="pill');
        expect((h.match(/<polyline/g) || []).length).toBe(3); // pass + dashed selection on discovery, pass on named
        expect(text(h)).toContain('on GPT Luna in the latest run');
        expect(h).toContain('href="#team=all&amp;model=gpt-luna&amp;range=7"'); // period links keep the model
        expect(app.state('#model=gpt-luna').model).toBe(LUNA);
        expect(app.state('#model=nope').model).toBe('');
    });

    it('pools before/after only over models with results on both sides', () => {
        // marker on day 7 (2026-10-11): Luna and DeepSeek started on day 5, so all three have both sides in a 12-day view
        let h = app.render(app.state('#range=28&mark=2026-10-11'));
        expect(text(h)).toContain('Pooled over Haiku, DeepSeek Flash, GPT Luna');
        expect(h).toContain('class="per-model"');
        // marker on day 2: only Haiku has results before it
        h = app.render(app.state('#range=28&mark=2026-10-06'));
        expect(text(h)).toContain('Pooled over Haiku:');
        expect(text(h)).toMatch(/GPT Luna — → \d+\/\d+/);
    });

    it('expands failing models and collapses passing ones in the evidence card', () => {
        const h = app.render(app.state('#actor=voyager%2Fbooking-scraper'));
        const card = h.slice(
            h.indexOf('id="evidence-booking-scraper-use"'),
            h.indexOf('id="evidence-booking-scraper-use"') + 6000,
        );
        expect(card).toContain('class="model-result open"');
        expect((card.match(/<details class="model-result">/g) || []).length).toBe(2);
        expect(text(card)).toContain('2/3 passed');
        expect(card).toContain('<th>Model</th>');
    });

    it('with a single slot nothing model-specific appears', () => {
        const single = {
            ...buildV2Model(data, agg),
            models: [{ id: HAIKU, label: 'Haiku', firstDay: '2026-10-05', resolvedByDay: {} }],
        };
        single.observations = single.observations.filter((o) => o.model === HAIKU);
        const h = application(single).render(app.state(''));
        expect(h).not.toContain('>All models<');
        expect(h).not.toContain('class="pill');
        expect(h).not.toContain('Models disagreed');
        expect(text(h)).not.toContain('Model in latest run');
    });
});
