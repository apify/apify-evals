import type { RuleId } from '../../src/online-classify.js';
import type { TurnMessage } from '../../src/online-turn.js';

/**
 * Prompts for the classifier's rules stage (#29), in the shapes production
 * users send them. No real user data: the tasks are typical Apify AI requests
 * written for this fixture. `rule` is what `ruleVerdict()` must return; null
 * means the rules let the turn through to Jev.
 */
export interface RuleCase {
    name: string;
    prompt: string;
    priorMessages: TurnMessage[];
    rule: RuleId | null;
}

const OFFERED_CHOICE: TurnMessage[] = [
    { role: 'user', text: 'I need to scrape product reviews from Amazon' },
    {
        role: 'assistant',
        text:
            'I found three Actors that fit. Which one should I run?\n' +
            '1. Amazon Reviews Scraper\n2. Amazon Product Scraper\n3. E-commerce Scraping Tool',
    },
];

const FINISHED_RUN: TurnMessage[] = [
    { role: 'user', text: 'Get the last 20 posts from the apify Instagram profile' },
    { role: 'assistant', text: 'Done. The run finished with 20 posts in the dataset. Do you want anything else?' },
];

export const RULE_CASES: RuleCase[] = [
    // No letter and no digit: always rejected, with or without context.
    { name: 'empty', prompt: '', priorMessages: [], rule: 'no-text' },
    { name: 'whitespace and a zero-width space', prompt: '  \n\t​ ', priorMessages: [], rule: 'no-text' },
    { name: 'question marks', prompt: '???', priorMessages: [], rule: 'no-text' },
    { name: 'dots with context', prompt: '...', priorMessages: FINISHED_RUN, rule: 'no-text' },
    { name: 'thumbs up', prompt: '👍', priorMessages: [], rule: 'no-text' },
    { name: 'emoji with skin tone, with context', prompt: '🙏🏽 🙏🏽', priorMessages: FINISHED_RUN, rule: 'no-text' },
    { name: 'country flag', prompt: '🇨🇿', priorMessages: FINISHED_RUN, rule: 'no-text' },
    { name: 'soft hyphen alone', prompt: '­', priorMessages: FINISHED_RUN, rule: 'no-text' },

    // Rejected only with no earlier messages.
    { name: 'a lone number', prompt: '2', priorMessages: [], rule: 'digits-only' },
    { name: 'a long number', prompt: ' 12345 ', priorMessages: [], rule: 'digits-only' },
    { name: 'hi with no context', prompt: 'hi', priorMessages: [], rule: 'too-short' },
    { name: 'ok with no context', prompt: ' ok ', priorMessages: [], rule: 'too-short' },

    // Follow-ups with context: the rules must not reject them.
    { name: 'a number that picks an offered option', prompt: '2', priorMessages: OFFERED_CHOICE, rule: null },
    { name: 'hi in a running chat', prompt: 'hi', priorMessages: FINISHED_RUN, rule: null },
    { name: 'export follow-up', prompt: 'Now export it as CSV', priorMessages: FINISHED_RUN, rule: null },

    // Words with no task: no word list, Jev decides.
    { name: 'hello with no context', prompt: 'hello', priorMessages: [], rule: null },
    { name: 'keyboard mash', prompt: 'asdfjkl', priorMessages: [], rule: null },

    // Real tasks.
    {
        name: 'Google Maps task',
        prompt: 'Find me the best Actor to scrape Google Maps reviews for restaurants in Prague',
        priorMessages: [],
        rule: null,
    },
    {
        name: 'German task',
        prompt: 'Wie kann ich TikTok-Videos mit einem bestimmten Hashtag scrapen?',
        priorMessages: [],
        rule: null,
    },
    { name: 'a URL alone', prompt: 'https://www.example.com/products', priorMessages: [], rule: null },
];
