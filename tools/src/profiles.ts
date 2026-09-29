/**
 * Suite profiles: what is under test, how the agent is set up per skill, and
 * which fix areas the judge may name. Loaded from `profiles/<name>.yaml`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import YAML from 'yaml';

export interface SkillConfig {
    label: string;
    legacy?: string;
    description?: string;
    tools: string[];
    allowBash?: boolean;
    maxTurns: number;
    promptSuffix?: string;
}

export interface FixArea {
    id: string;
    owner: string;
    description: string;
}

export interface Profile {
    name: string;
    subjectKind: 'actor' | 'mcp-tool' | 'cli-command' | 'sdk-feature' | 'agent';
    description?: string;
    skills: Record<string, SkillConfig>;
    wrongSubjectLabel: string;
    fixAreas: FixArea[];
    evidence: string[];
}

const cache = new Map<string, Profile>();

export function loadProfile(rootDir: string, name: string): Profile {
    const key = `${rootDir}:${name}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const path = join(rootDir, 'profiles', `${name}.yaml`);
    const doc = YAML.parse(readFileSync(path, 'utf8')) as Profile;
    for (const field of ['name', 'subjectKind', 'skills', 'wrongSubjectLabel', 'fixAreas'] as const) {
        if (doc[field] === undefined) throw new Error(`profiles/${name}.yaml: missing "${field}"`);
    }
    if (doc.name !== name) throw new Error(`profiles/${name}.yaml: name "${doc.name}" must equal the file name`);
    for (const [skill, cfg] of Object.entries(doc.skills)) {
        if (!Array.isArray(cfg.tools) || typeof cfg.maxTurns !== 'number' || !cfg.label) {
            throw new Error(`profiles/${name}.yaml: skill "${skill}" needs label, tools[] and maxTurns`);
        }
    }
    cache.set(key, doc);
    return doc;
}
