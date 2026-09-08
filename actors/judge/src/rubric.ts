/**
 * Online rubric (ai-team#268): the versioned definition every online score is
 * written against, and the Langfuse score names derived from it.
 *
 * Kept apart from the offline `DIMENSIONS` in core.ts on purpose: the two
 * modes share the six criterion ids today, but this object is versioned and
 * stamped into scores, so a change to the offline list must not silently
 * change what an online score means (and vice versa).
 */

/** Langfuse caps score config names at 35 characters and restricts the charset
 * (letters, numbers, underscores, spaces, periods, parentheses, hyphens). */
export const MAX_SCORE_CONFIG_NAME_LENGTH = 35;
export const SCORE_CONFIG_NAME_PATTERN = /^[A-Za-z0-9_ .()-]+$/;

export const ONLINE_CRITERIA = [
    'toolSelection',
    'argumentCorrectness',
    'resultUtilization',
    'taskCompletion',
    'errorRecovery',
    'planEfficiency',
] as const;
export type OnlineCriterion = (typeof ONLINE_CRITERIA)[number];

export interface RubricCriterion {
    id: OnlineCriterion;
    /** One paragraph, reused verbatim by the judge prompt, the README and the score config. */
    description: string;
}

export interface Rubric {
    name: string;
    version: number;
    /** The holistic verdict: a separate judgment, see the note on ONLINE_RUBRIC. */
    holistic: { description: string };
    criteria: readonly RubricCriterion[];
}

/**
 * Every criterion is judged independently as PASS or FAIL.
 *
 * The holistic verdict (`agent_judge`) is a SEPARATE judgment made by the judge
 * over the whole turn (ai-team#269). It is neither a computed AND over the
 * criteria nor a copy of taskCompletion, unlike the offline `judge.overall`.
 * Do not add an "overall = taskCompletion" rule here.
 */
export const ONLINE_RUBRIC: Rubric = {
    name: 'apify-ai-turn',
    version: 1,
    holistic: {
        description:
            'Holistic verdict on the whole turn: did the agent serve the user well, taking the task, the tool ' +
            'usage, the final answer and its honesty about failures together? Judged as one separate PASS or FAIL, ' +
            'not derived from the criteria below.',
    },
    criteria: [
        {
            id: 'toolSelection',
            description:
                'The agent chose tools and Actors that fit the task. It searched or fetched details when it did not ' +
                'know the right Actor, picked a well-suited Actor over a generic one, and did not call tools the ' +
                'task did not need. PASS when every tool choice is defensible for the stated task; FAIL when a ' +
                'clearly better tool was available or an unnecessary tool was called.',
        },
        {
            id: 'argumentCorrectness',
            description:
                'Tool inputs were well-formed and sensible: required fields present, values of the right type and ' +
                'shape, URLs and identifiers taken from the conversation rather than invented, and limits set ' +
                'appropriately for the request. PASS when inputs would be accepted and do what the task asks; ' +
                'FAIL on malformed inputs, fabricated identifiers or parameters that contradict the task.',
        },
        {
            id: 'resultUtilization',
            description:
                'The agent grounded its answer in the data the tools actually returned. Numbers, names and ' +
                'quotes in the final answer trace back to tool results; nothing is invented, and nothing ' +
                'important the tools returned is ignored. PASS when the answer is faithful to the retrieved data; ' +
                'FAIL on hallucinated facts or an answer that disregards what was retrieved.',
        },
        {
            id: 'taskCompletion',
            description:
                'The final answer fulfils what the user asked for, at the requested scope and format, and is ' +
                'grounded in retrieved data. An honest report that the data could not be retrieved is still a ' +
                'FAIL here (the task was not completed), even though it may pass errorRecovery. PASS only when ' +
                'the user got what they asked for.',
        },
        {
            id: 'errorRecovery',
            description:
                'When a tool call failed, returned nothing useful or hit a limit, the agent noticed, adapted ' +
                '(retried with corrected input, chose another tool, or narrowed the task) and told the user ' +
                'plainly what did not work. PASS when errors were handled reasonably or no error occurred; FAIL ' +
                'when the agent ignored an error, repeated the same failing call or hid the failure from the user.',
        },
        {
            id: 'planEfficiency',
            description:
                'The path from request to answer was reasonably direct: no pointless repetition, no redundant ' +
                'fetches of data already in hand, no detours unrelated to the task. Extra calls that reduce risk ' +
                '(checking an input schema before a paid run) are fine. PASS when the step count is proportionate ' +
                'to the task; FAIL on loops, duplicated work or wandering.',
        },
    ],
};

export const HOLISTIC_SCORE_NAME = 'agent_judge';

export function criterionScoreName(criterion: string): string {
    return `${HOLISTIC_SCORE_NAME}_${criterion}`;
}

/** Holistic name first, then one name per criterion in rubric order. */
export function onlineScoreNames(rubric: Rubric = ONLINE_RUBRIC): string[] {
    return [HOLISTIC_SCORE_NAME, ...rubric.criteria.map((c) => criterionScoreName(c.id))];
}

export class InvalidScoreConfigNameError extends Error {
    constructor(
        readonly scoreName: string,
        reason: string,
    ) {
        super(`Score config name "${scoreName}" ${reason}`);
        this.name = 'InvalidScoreConfigNameError';
    }
}

/** Langfuse rejects the config at create time otherwise; failing here keeps a
 * bad rename from reaching the (archive-only) score config table. */
export function assertScoreConfigName(name: string): void {
    if (name.length > MAX_SCORE_CONFIG_NAME_LENGTH) {
        throw new InvalidScoreConfigNameError(name, `is ${name.length} chars, max is ${MAX_SCORE_CONFIG_NAME_LENGTH}`);
    }
    if (!SCORE_CONFIG_NAME_PATTERN.test(name)) {
        throw new InvalidScoreConfigNameError(name, `contains characters outside ${SCORE_CONFIG_NAME_PATTERN}`);
    }
}

export const ONLINE_SCORE_NAMES = onlineScoreNames();
for (const name of ONLINE_SCORE_NAMES) assertScoreConfigName(name);
