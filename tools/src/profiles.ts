/**
 * Suite profiles: what is under test, how the agent is set up per skill, and
 * which fix areas the judge may name. Loaded from `profiles/<name>.yaml`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type McpServerSpec, validateDatasetItemMetadata } from '@apify-evals/contract';
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
    /** The MCP server the agent talks to; absent = the Apify MCP server. */
    mcp?: McpServerSpec;
    /** Agent skills (skills/<name>/SKILL.md) a run of this suite may inject. */
    agentSkills?: string[];
    skills: Record<string, SkillConfig>;
    wrongSubjectLabel: string;
    fixAreas: FixArea[];
    /** Judge: which fix area a failed deterministic check forces, by check type. */
    forcedFixAreas?: Record<string, string | { find: string; use: string }>;
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
    if (doc.mcp !== undefined && !validateDatasetItemMetadata({ mcp: doc.mcp })) {
        throw new Error(`profiles/${name}.yaml: invalid "mcp": ${JSON.stringify(validateDatasetItemMetadata.errors)}`);
    }
    for (const skill of doc.agentSkills ?? []) {
        if (!existsSync(join(rootDir, 'skills', skill, 'SKILL.md'))) {
            throw new Error(`profiles/${name}.yaml: agentSkills "${skill}" has no skills/${skill}/SKILL.md`);
        }
    }
    cache.set(key, doc);
    return doc;
}
