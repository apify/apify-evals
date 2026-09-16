/**
 * Merge the deterministic checks with the model's rubric into ONE verdict.
 *
 * Order of precedence (deterministic evidence beats the model, always):
 *   1. infrastructure failed            -> inconclusive (not the team's problem)
 *   2. subject.used check failed        -> wrong-subject (store label: wrong-actor)
 *   3. any fail-severity check failed   -> fail
 *   4. otherwise                        -> the model's taskCompletion
 *
 * The fix area follows the same rule: a failed check names the area directly
 * (a wrong Actor input is an input-schema problem whatever the model thinks);
 * only when every check passed does the model's opinion stand, constrained to
 * the profile's taxonomy.
 */
import type { CheckResult } from '@apify-evals/contract';

export type MergedVerdict = 'pass' | 'fail' | 'wrong-subject' | 'inconclusive';

export interface ProfileForVerdict {
    wrongSubjectLabel: string;
    fixAreaIds: string[];
    /** Fix area forced by a failed check type; keyed by check type. `find` /
     * `use` variants for subject.used. */
    forcedFixAreas: Record<string, string | { find: string; use: string }>;
}

export interface LlmOpinion {
    taskCompletion: 'pass' | 'fail' | 'not_applicable';
    fixArea: string | null;
    anyDimensionFailed: boolean;
}

export interface MergeInput {
    llm: LlmOpinion;
    checks: CheckResult[];
    infraOk: boolean;
    infraReasons: string[];
    skill: 'find' | 'use' | null;
    profile: ProfileForVerdict;
}

export interface MergeOutput {
    verdict: MergedVerdict;
    /** Label to show teams (profile-specific for wrong-subject). */
    verdictLabel: string;
    /** 1 / 0, or null for inconclusive (no judge.overall written). */
    overall: 0 | 1 | null;
    fixArea: string;
    fixAreaSource: 'deterministic' | 'model' | 'none';
    /** 1 when the model and the checks disagree on pass/fail. */
    disagreement: 0 | 1;
    found: 0 | 1 | null;
    works: 0 | 1 | null;
    reasons: string[];
}

export const STORE_PROFILE_FOR_VERDICT: ProfileForVerdict = {
    wrongSubjectLabel: 'wrong-actor',
    fixAreaIds: ['input-schema', 'readme-docs', 'output-format', 'error-messages', 'discoverability', 'agent-or-model', 'none'],
    forcedFixAreas: {
        'subject.used': { find: 'discoverability', use: 'readme-docs' },
        'apify.input': 'input-schema',
        'apify.items': 'output-format',
        reference: 'output-format',
        'apify.run': 'error-messages',
        'answer.grounded': 'agent-or-model',
        'tool.called': 'agent-or-model',
        'workspace.file': 'agent-or-model',
        'answer.contains': 'agent-or-model',
        'answer.regex': 'agent-or-model',
        contains: 'agent-or-model',
        regex: 'agent-or-model',
    },
};

export function mergeVerdict(input: MergeInput): MergeOutput {
    const { llm, checks, infraOk, infraReasons, skill, profile } = input;
    const gating = checks.filter((c) => c.applicable && c.severity === 'fail');
    const failed = gating.filter((c) => !c.passed);
    const subjectMiss = failed.find((c) => c.type === 'subject.used');
    const llmPass = llm.taskCompletion === 'pass';
    const reasons: string[] = [];

    let verdict: MergedVerdict;
    if (!infraOk) {
        verdict = 'inconclusive';
        reasons.push(...infraReasons.map((r) => `infrastructure: ${r}`));
    } else if (subjectMiss) {
        verdict = 'wrong-subject';
        reasons.push(`check ${subjectMiss.id}: ${subjectMiss.comment}`);
    } else if (failed.length > 0) {
        verdict = 'fail';
        reasons.push(...failed.map((c) => `check ${c.id}: ${c.comment}`));
    } else {
        verdict = llmPass ? 'pass' : 'fail';
        if (!llmPass) reasons.push('judge: task not completed');
    }

    // Fix area: forced by the first failed check that has a mapping.
    let fixArea = 'none';
    let fixAreaSource: MergeOutput['fixAreaSource'] = 'none';
    if (verdict !== 'inconclusive') {
        const forcedFrom = subjectMiss ?? failed.find((c) => profile.forcedFixAreas[c.type] !== undefined);
        if (forcedFrom) {
            const mapping = profile.forcedFixAreas[forcedFrom.type];
            const area = typeof mapping === 'string' ? mapping : mapping ? mapping[skill ?? 'use'] : undefined;
            if (area) {
                fixArea = area;
                fixAreaSource = 'deterministic';
            }
        }
        if (fixAreaSource === 'none' && verdict !== 'pass') {
            const candidate = llm.fixArea && profile.fixAreaIds.includes(llm.fixArea) ? llm.fixArea : 'agent-or-model';
            fixArea = candidate === 'none' ? 'agent-or-model' : candidate;
            fixAreaSource = 'model';
        }
        if (verdict === 'pass' && llm.fixArea && llm.fixArea !== 'none' && profile.fixAreaIds.includes(llm.fixArea) && llm.anyDimensionFailed) {
            // Passed, but the model saw a real issue on the way: keep the hint.
            fixArea = llm.fixArea;
            fixAreaSource = 'model';
        }
    }

    // Disagreement: only meaningful when there were gating checks and infra was fine.
    const disagreement: 0 | 1 =
        infraOk && gating.length > 0 && ((llmPass && failed.length > 0) || (!llmPass && failed.length === 0 && llm.taskCompletion === 'fail'))
            ? 1
            : 0;

    const overall: MergeOutput['overall'] = verdict === 'inconclusive' ? null : verdict === 'pass' ? 1 : 0;
    const found: MergeOutput['found'] = skill === 'find' && verdict !== 'inconclusive' ? (subjectMiss ? 0 : 1) : null;
    const works: MergeOutput['works'] = skill === 'use' && verdict !== 'inconclusive' ? (overall as 0 | 1) : null;

    return {
        verdict,
        verdictLabel: verdict === 'wrong-subject' ? profile.wrongSubjectLabel : verdict,
        overall,
        fixArea,
        fixAreaSource,
        disagreement,
        found,
        works,
        reasons,
    };
}
