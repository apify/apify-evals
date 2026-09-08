import { criterionScoreName, HOLISTIC_SCORE_NAME, ONLINE_RUBRIC, type Rubric } from './rubric.js';

/**
 * Score config planning (ai-team#268): pure logic behind
 * scripts/create-score-configs.ts. Given what Langfuse already has, decide
 * what to create, what to leave alone and what a human must look at.
 *
 * Every online score is BOOLEAN (1 = pass, 0 = fail) so `avg` over a score
 * is its pass rate. Langfuse score configs can be archived but never deleted,
 * which is why this never creates a config whose name is already taken, even
 * when the existing one looks wrong.
 */

export interface DesiredScoreConfig {
    name: string;
    dataType: 'BOOLEAN';
    description: string;
}

/** The subset of a Langfuse ScoreConfig the plan depends on. */
export interface ExistingScoreConfig {
    id: string;
    name: string;
    dataType: string;
    isArchived: boolean;
}

export type ScoreConfigPlanEntry =
    | { name: string; action: 'create'; config: DesiredScoreConfig }
    | { name: string; action: 'exists'; id: string }
    | { name: string; action: 'conflict'; id: string; reason: string };

export function desiredOnlineScoreConfigs(rubric: Rubric = ONLINE_RUBRIC): DesiredScoreConfig[] {
    const stamp = `Rubric ${rubric.name} v${rubric.version}.`;
    return [
        {
            name: HOLISTIC_SCORE_NAME,
            dataType: 'BOOLEAN',
            description: `${rubric.holistic.description} 1 = pass, 0 = fail. ${stamp}`,
        },
        ...rubric.criteria.map((c) => ({
            name: criterionScoreName(c.id),
            dataType: 'BOOLEAN' as const,
            description: `${c.description} 1 = pass, 0 = fail. ${stamp}`,
        })),
    ];
}

function planOne(config: DesiredScoreConfig, sameName: ExistingScoreConfig[]): ScoreConfigPlanEntry {
    if (sameName.length === 0) return { name: config.name, action: 'create', config };

    const usable = sameName.find((c) => !c.isArchived && c.dataType === config.dataType);
    if (usable) return { name: config.name, action: 'exists', id: usable.id };

    // A same-name config that cannot be used is a decision for a human: creating
    // a second one would leave two configs with one name, forever.
    const [first] = sameName;
    const reason =
        first.dataType === config.dataType
            ? 'exists but is archived'
            : `exists with dataType ${first.dataType}, expected ${config.dataType}`;
    return { name: config.name, action: 'conflict', id: first.id, reason };
}

export function planScoreConfigs(
    desired: DesiredScoreConfig[],
    existing: ExistingScoreConfig[],
): ScoreConfigPlanEntry[] {
    return desired.map((config) =>
        planOne(
            config,
            existing.filter((c) => c.name === config.name),
        ),
    );
}
