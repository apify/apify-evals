/**
 * Scenario files -> Langfuse dataset items.
 *
 * Authors write `scenarios/<suite>/<owner>/<subject-slug>.yaml`; everything a
 * runner needs but an author should not have to type (tools, maxTurns, the
 * prompt trailer, subject/owner/suite identity, legacy store fields) is
 * derived here from the folder layout and the suite's profile.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { validateDatasetItemMetadata, type DatasetItemMetadata } from '@apify-evals/contract';
import YAML from 'yaml';

import { loadProfile, type Profile } from './profiles.js';

export interface ScenarioFileEntry {
    id: string;
    skill: 'find' | 'use';
    title?: string;
    prompt: string;
    expected: string;
    checks?: Record<string, unknown>[];
    reference?: Record<string, unknown>;
    maxTurns?: number;
    timeoutSecs?: number;
    tools?: string[];
    allowBash?: boolean;
    appendSuffix?: boolean;
    notes?: string;
    tags?: string[];
}

export interface ScenarioFile {
    subject: string;
    profile?: string;
    /** Tags applied to every scenario in the file (e.g. `family:instagram`); merged with per-scenario tags. */
    tags?: string[];
    scenarios: ScenarioFileEntry[];
}

export interface DatasetItemDraft {
    id: string;
    input: { prompt: string };
    expectedOutput: string;
    metadata: DatasetItemMetadata;
    source: string;
}

export interface SuiteFiles {
    suite: string;
    profile: Profile;
    items: DatasetItemDraft[];
    problems: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/;

/** Read every scenario file of one suite folder and derive dataset items. */
export function loadSuite(rootDir: string, suite: string): SuiteFiles {
    const suiteDir = join(rootDir, 'scenarios', suite);
    const problems: string[] = [];
    const items: DatasetItemDraft[] = [];
    const seen = new Map<string, string>();

    // The suite's profile: default = the suite name, overridable per file.
    const profileName = suite;
    const profile = loadProfile(rootDir, profileName);

    for (const owner of readdirSync(suiteDir).filter((d) => statSync(join(suiteDir, d)).isDirectory())) {
        for (const file of readdirSync(join(suiteDir, owner)).filter((f) => /\.ya?ml$/.test(f))) {
            const path = join(suiteDir, owner, file);
            const rel = relative(rootDir, path);
            let doc: ScenarioFile;
            try {
                doc = YAML.parse(readFileSync(path, 'utf8')) as ScenarioFile;
            } catch (err) {
                problems.push(`${rel}: YAML parse error: ${err}`);
                continue;
            }
            if (!doc?.subject || !Array.isArray(doc.scenarios)) {
                problems.push(`${rel}: needs "subject" and a "scenarios" list`);
                continue;
            }
            const fileProfile = doc.profile ? loadProfile(rootDir, doc.profile) : profile;
            const slug = basename(file).replace(/\.ya?ml$/, '');
            const fileTags = Array.isArray(doc.tags) ? doc.tags.map(String) : [];
            if (doc.subject.split('/')[1] !== slug) {
                problems.push(
                    `${rel}: file name "${slug}" should match the subject name "${doc.subject.split('/')[1]}"`,
                );
            }
            for (const s of doc.scenarios) {
                const where = `${rel} › ${s?.id ?? '(no id)'}`;
                if (!s?.id || !ID_PATTERN.test(s.id)) {
                    problems.push(`${where}: id must be lowercase letters, digits and dashes (3-80 chars)`);
                    continue;
                }
                if (seen.has(s.id)) {
                    problems.push(`${where}: duplicate id, also in ${seen.get(s.id)}`);
                    continue;
                }
                seen.set(s.id, rel);
                if (s.skill !== 'find' && s.skill !== 'use') {
                    problems.push(`${where}: skill must be "find" or "use"`);
                    continue;
                }
                if (!s.prompt?.trim()) problems.push(`${where}: prompt is empty`);
                if (!s.expected?.trim()) problems.push(`${where}: expected is empty (the judge needs it)`);
                const skillCfg = fileProfile.skills[s.skill];
                if (!skillCfg) {
                    problems.push(`${where}: profile "${fileProfile.name}" has no skill "${s.skill}"`);
                    continue;
                }
                const prompt =
                    s.appendSuffix !== false && skillCfg.promptSuffix
                        ? `${s.prompt.trim()} ${skillCfg.promptSuffix}`
                        : s.prompt.trim();
                for (const w of lintPrompt(prompt)) problems.push(`${where}: warning: ${w}`);
                const title = s.title ?? s.expected.split(/(?<=\.)\s/)[0].slice(0, 120);
                if (title.length > 60)
                    problems.push(
                        `${where}: title is ${title.length} chars; keep it under 60 ("<actor> / find|use / <topic>") so chart labels stay readable`,
                    );

                const checks = (s.checks ?? []).map((c, i) => ({ id: `c${i + 1}`, ...c }));
                const metadata: Record<string, unknown> = {
                    title: s.title ?? s.expected.split(/(?<=\.)\s/)[0].slice(0, 120),
                    suite,
                    profile: fileProfile.name,
                    subject: { kind: fileProfile.subjectKind, id: doc.subject },
                    owner,
                    skill: s.skill,
                    tools: s.tools ?? skillCfg.tools,
                    maxTurns: s.maxTurns ?? skillCfg.maxTurns,
                    checks,
                    ...((s.allowBash ?? skillCfg.allowBash) ? { allowBash: true } : {}),
                    ...(s.timeoutSecs ? { timeoutSecs: s.timeoutSecs } : {}),
                    ...(s.reference ? { reference: s.reference } : {}),
                    ...(s.notes ? { notes: s.notes } : {}),
                    ...(fileTags.length > 0 || s.tags ? { tags: [...fileTags, ...(s.tags ?? [])] } : {}),
                    // Store-suite sugar for filters, tags and the existing dashboards.
                    ...(fileProfile.subjectKind === 'actor'
                        ? { actor: doc.subject, team: owner, category: doc.subject.split('/')[1] }
                        : {}),
                };
                if (!validateDatasetItemMetadata(metadata)) {
                    problems.push(`${where}: ${JSON.stringify(validateDatasetItemMetadata.errors)}`);
                    continue;
                }
                items.push({
                    id: s.id,
                    input: { prompt },
                    expectedOutput: s.expected.trim(),
                    metadata: metadata as DatasetItemMetadata,
                    source: rel,
                });
            }
        }
    }
    return { suite, profile, items, problems };
}

/** Cheap prompt hygiene: the things that made scenarios flaky or slow before. */
export function lintPrompt(prompt: string): string[] {
    const warnings: string[] = [];
    if (!/\b\d{1,3}\b/.test(prompt))
        warnings.push('no result cap in the prompt (e.g. "10 results"); unbounded asks run long');
    if (/\b(all|every|entire|whole)\b.*\b(posts|pages|reviews|results|site)\b/i.test(prompt)) {
        warnings.push('asks for "all/every" items; cap it so the scenario finishes in ~2 minutes');
    }
    if (/\b(today|yesterday|this week|right now)\b/i.test(prompt)) {
        warnings.push('time-anchored wording; prefer rolling windows ("in the last month")');
    }
    return warnings;
}
