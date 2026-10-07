/** The few profile facts the report needs, read from profiles/<suite>.yaml. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

export interface FixArea {
    id: string;
    /** Plain words for readers of the report; the profile description is the long form. */
    label: string;
    owner: string;
    description: string;
}

export interface ReportProfile {
    name: string;
    subjectKind: string;
    skills: Record<string, { label: string }>;
    wrongSubjectLabel: string;
    fixAreas: FixArea[];
}

/** Short labels for the store profile's fix areas; unknown ids fall back to the id. */
const FIX_AREA_LABELS: Record<string, string> = {
    'input-schema': 'Input schema',
    'readme-docs': 'README / docs',
    'output-format': 'Output format',
    'error-messages': 'Error messages',
    discoverability: 'Store search / Actor selection',
    'agent-or-model': 'Agent or model',
};

const FALLBACK: ReportProfile = {
    name: 'store-actors',
    subjectKind: 'actor',
    skills: { find: { label: 'Found' }, use: { label: 'Works' } },
    wrongSubjectLabel: 'wrong-actor',
    fixAreas: [],
};

export function loadReportProfile(rootDir: string, name: string): ReportProfile {
    try {
        const doc = parse(readFileSync(join(rootDir, 'profiles', `${name}.yaml`), 'utf8')) as {
            name?: string;
            subjectKind?: string;
            skills?: Record<string, { label?: string }>;
            wrongSubjectLabel?: string;
            fixAreas?: { id: string; label?: string; owner?: string; description?: string }[];
        };
        return {
            name: doc.name ?? name,
            subjectKind: doc.subjectKind ?? FALLBACK.subjectKind,
            skills: Object.fromEntries(
                Object.entries(doc.skills ?? FALLBACK.skills).map(([k, v]) => [k, { label: v.label ?? k }]),
            ),
            wrongSubjectLabel: doc.wrongSubjectLabel ?? FALLBACK.wrongSubjectLabel,
            fixAreas: (doc.fixAreas ?? []).map((f) => ({
                id: f.id,
                label: f.label ?? FIX_AREA_LABELS[f.id] ?? f.id,
                owner: f.owner ?? 'subject',
                description: f.description ?? '',
            })),
        };
    } catch {
        return { ...FALLBACK, name };
    }
}
