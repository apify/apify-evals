/**
 * Suite profile for the judge: the fix-area taxonomy it may choose from and
 * how deterministic failures map onto it. Read from profiles/<name>.yaml
 * (copied into the image); falls back to the store profile.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from 'apify';
import YAML from 'yaml';

import { STORE_PROFILE_FOR_VERDICT, type ProfileForVerdict } from './verdict.js';

export interface JudgeProfile extends ProfileForVerdict {
    name: string;
    fixAreas: { id: string; owner: string; description: string }[];
}

const STORE_FIX_AREAS = [
    { id: 'input-schema', owner: 'subject', description: 'The agent built wrong or missing Actor input (required fields missed, wrong types, wrong mode flags).' },
    { id: 'readme-docs', owner: 'subject', description: 'The agent misunderstood what the Actor does or which mode or sibling to use, although it read the Actor details.' },
    { id: 'output-format', owner: 'subject', description: 'The Actor returned data but the agent could not find or use the right fields.' },
    { id: 'error-messages', owner: 'subject', description: 'The Actor failed or returned an error the agent could not act on.' },
    { id: 'discoverability', owner: 'store-search', description: 'The agent could not find, or picked the wrong, Actor in store search.' },
    { id: 'agent-or-model', owner: 'none', description: 'The Actor did its part; the failure is the agent’s reasoning or the model.' },
];

/** Items that name no profile and are not store scenarios (foreign datasets).
 * No store vocabulary: the item's expected output carries the pass criteria. */
export const GENERIC_PROFILE_NAME = 'generic';

const GENERIC_FIX_AREAS = [
    { id: 'tool-description', owner: 'subject', description: 'A tool’s description or docs misled the agent about what it does or when to use it.' },
    { id: 'tool-schema', owner: 'subject', description: 'The agent built wrong or missing tool arguments given the tool’s input schema.' },
    { id: 'tool-output', owner: 'subject', description: 'A tool returned data the agent could not find or use, or that did not match what the tool promises.' },
    { id: 'error-messages', owner: 'subject', description: 'A tool failed or returned an error the agent could not act on.' },
    { id: 'agent-or-model', owner: 'none', description: 'The tools did their part; the failure is the agent’s reasoning or the model.' },
];

const GENERIC_PROFILE: JudgeProfile = {
    name: GENERIC_PROFILE_NAME,
    fixAreas: GENERIC_FIX_AREAS,
    wrongSubjectLabel: 'wrong-subject',
    fixAreaIds: [...GENERIC_FIX_AREAS.map((f) => f.id), 'none'],
    forcedFixAreas: {
        ...STORE_PROFILE_FOR_VERDICT.forcedFixAreas,
        'subject.used': { find: 'tool-description', use: 'tool-description' },
        'apify.input': 'tool-schema',
        'apify.items': 'tool-output',
        reference: 'tool-output',
        'apify.run': 'error-messages',
    },
};

const cache = new Map<string, JudgeProfile>();

export function loadJudgeProfile(name: string | undefined): JudgeProfile {
    const key = name ?? 'store-actors';
    if (key === GENERIC_PROFILE_NAME) return GENERIC_PROFILE;
    const hit = cache.get(key);
    if (hit) return hit;
    let profile: JudgeProfile = { name: 'store-actors', fixAreas: STORE_FIX_AREAS, ...STORE_PROFILE_FOR_VERDICT };
    const candidates = [join(process.cwd(), '..', '..', 'profiles', `${key}.yaml`), join(process.cwd(), 'profiles', `${key}.yaml`)];
    const path = candidates.find((p) => existsSync(p));
    if (path) {
        try {
            const doc = YAML.parse(readFileSync(path, 'utf8')) as {
                name: string;
                wrongSubjectLabel?: string;
                fixAreas?: { id: string; owner: string; description: string }[];
                forcedFixAreas?: Record<string, string | { find: string; use: string }>;
            };
            const fixAreas = doc.fixAreas ?? STORE_FIX_AREAS;
            const ids = new Set(fixAreas.map((f) => f.id));
            for (const [type, area] of Object.entries(doc.forcedFixAreas ?? {})) {
                for (const id of typeof area === 'string' ? [area] : [area.find, area.use]) {
                    if (!ids.has(id)) throw new Error(`forcedFixAreas.${type} names unknown fix area "${id}"`);
                }
            }
            profile = {
                name: doc.name,
                fixAreas,
                wrongSubjectLabel: doc.wrongSubjectLabel ?? 'wrong-subject',
                fixAreaIds: [...fixAreas.map((f) => f.id), 'none'],
                // Forced mappings: the profile's own `forcedFixAreas` win; the
                // rest are the store defaults remapped onto this profile's ids
                // when they exist, else the closest generic id.
                forcedFixAreas: {
                    ...Object.fromEntries(
                        Object.entries(STORE_PROFILE_FOR_VERDICT.forcedFixAreas).map(([type, area]) => {
                            const pick = (a: string) => (ids.has(a) ? a : ids.has('agent-or-model') ? 'agent-or-model' : fixAreas[0]?.id ?? 'none');
                            return [type, typeof area === 'string' ? pick(area) : { find: pick(area.find), use: pick(area.use) }];
                        }),
                    ),
                    ...(doc.forcedFixAreas ?? {}),
                },
            };
        } catch (err) {
            log.warning(`profile ${key} unreadable, using store defaults: ${err}`);
        }
    } else if (key !== 'store-actors') {
        log.warning(`profile ${key} not found in the image, using store defaults`);
    }
    cache.set(key, profile);
    return profile;
}

/** Prompt section listing the areas the model may name. */
export function fixAreaPromptSection(profile: JudgeProfile): string {
    return [
        ...profile.fixAreas.map((f) => `- "${f.id}": ${f.description}`),
        '- "none": every dimension passed.',
    ].join('\n');
}
