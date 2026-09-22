/** The few profile facts the report needs, read from profiles/<suite>.yaml. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

export interface ReportProfile {
    name: string;
    subjectKind: string;
    skills: Record<string, { label: string }>;
    wrongSubjectLabel: string;
}

const FALLBACK: ReportProfile = {
    name: 'store-actors',
    subjectKind: 'actor',
    skills: { find: { label: 'Found' }, use: { label: 'Works' } },
    wrongSubjectLabel: 'wrong-actor',
};

export function loadReportProfile(rootDir: string, name: string): ReportProfile {
    try {
        const doc = parse(readFileSync(join(rootDir, 'profiles', `${name}.yaml`), 'utf8')) as {
            name?: string;
            subjectKind?: string;
            skills?: Record<string, { label?: string }>;
            wrongSubjectLabel?: string;
        };
        return {
            name: doc.name ?? name,
            subjectKind: doc.subjectKind ?? FALLBACK.subjectKind,
            skills: Object.fromEntries(
                Object.entries(doc.skills ?? FALLBACK.skills).map(([k, v]) => [k, { label: v.label ?? k }]),
            ),
            wrongSubjectLabel: doc.wrongSubjectLabel ?? FALLBACK.wrongSubjectLabel,
        };
    } catch {
        return { ...FALLBACK, name };
    }
}
