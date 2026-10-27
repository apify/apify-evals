import { log } from 'apify';

import { type ClassifierMode, classifyBatch, type TraceClassifier } from './online-classify.js';
import {
    type CoverageCounters,
    type CreateScoreRequest,
    type EligibilityVersion,
    eligibleScoreId,
    ineligibleScoreRequest,
    NO_CLASSIFIER_COUNTERS,
    type OnlineScoreReader,
    type OnlineScoreVersion,
    SAMPLE_TRACE_ID,
    skipAlreadyJudged,
} from './online-scores.js';
import type { OnlineTurn } from './online-turn.js';
import type { Selection } from './select.js';

/**
 * Steps 2 and 3 of an online run (#29), between selection and judging:
 * `skipAlreadyJudged`, then the input classifier. Taken out of main.ts so the
 * wiring (which mode passes what to whom, and what OUTPUT reports) is tested
 * against fakes. All I/O is injected.
 */

export type ClassifierCoverage = Pick<
    CoverageCounters,
    'skippedIneligibleRule' | 'skippedIneligibleModel' | 'classifierFailed' | 'targetMissed'
>;

/** The classifier fields of the online OUTPUT. */
export interface ClassifierOutput {
    classifier: ClassifierMode;
    classifierModel: string;
    classifierThreshold: number;
    skippedIneligible: { rule: number; model: number };
    classifierFailed: number;
    /** Off and shadow judge the whole sample, so only enforce can miss it. */
    targetReached: boolean;
    classifierTarget: number;
    classifierAttempts: number;
    toppedUp: number;
    skipScoreWriteFailed: number;
    classifierBudgetExceeded: number;
    classifierCostUsd: number;
    /** Traces that got `agent_judge_eligible = 0` (judged anyway in shadow mode). */
    ineligibleTraceIds: string[];
    /** Traces taken from the unsampled reserve (enforce only); judged when eligible. */
    toppedUpTraceIds: string[];
}

export interface PrepareOnlineBatchOptions {
    classifier: ClassifierMode;
    selection: Pick<Selection, 'sampled' | 'sampledTraceIds' | 'unsampledTraceIds'>;
    maxClassifyFactor: number;
    concurrency: number;
    force: boolean;
    /** The judge version: a holistic score under it marks a trace as judged. */
    version: OnlineScoreVersion;
    eligibility: EligibilityVersion;
    threshold: number;
    environment: string;
    readScores: OnlineScoreReader;
    classify: TraceClassifier;
    /** `langfuse.api.scores.create` in production. */
    writeScore: (request: CreateScoreRequest) => Promise<unknown>;
    budgetMs?: number;
    now?: () => number;
}

export interface PreparedOnlineBatch {
    /** What the judge gets, in order. */
    toJudge: string[];
    /** Turns the classifier already rebuilt; the judge reads only the traces missing here. */
    turns: Map<string, OnlineTurn>;
    /** Sampled traces already processed under this version. */
    skipped: string[];
    coverage: ClassifierCoverage;
    output: ClassifierOutput;
}

/**
 * Fails before any read when the classifier model would make the skip score
 * id invalid (too long, for example). Without this, in enforce mode every
 * skip-score write would fail and the skipped traces would be dropped with no
 * record.
 */
export function assertClassifierModel(eligibility: EligibilityVersion): void {
    try {
        eligibleScoreId(SAMPLE_TRACE_ID, eligibility);
    } catch (err) {
        throw new Error(`classifierModel "${eligibility.classifierModel}" cannot be used: ${err}`);
    }
}

export async function prepareOnlineBatch(opts: PrepareOnlineBatchOptions): Promise<PreparedOnlineBatch> {
    const { classifier, selection, force, version, eligibility, threshold, environment, readScores } = opts;
    // In enforce mode a matching agent_judge_eligible = 0 score also marks a
    // trace as processed; shadow mode must still judge every sampled trace.
    const alreadyProcessed = async (traceIds: string[]) =>
        skipAlreadyJudged({
            traceIds,
            version,
            force,
            readScores,
            ...(classifier === 'enforce' ? { eligibility } : {}),
        });
    const { toJudge: unprocessed, skipped } = await alreadyProcessed(selection.sampledTraceIds);
    if (skipped.length > 0) log.info(`${skipped.length} sampled traces already processed under this version, skipped`);

    const classified =
        classifier === 'off' || unprocessed.length === 0
            ? null
            : await classifyBatch({
                  mode: classifier,
                  initial: unprocessed,
                  reserve: selection.unsampledTraceIds,
                  maxAttempts: Math.ceil(opts.maxClassifyFactor * selection.sampled),
                  concurrency: opts.concurrency,
                  classify: opts.classify,
                  filterProcessed: async (traceIds) => (await alreadyProcessed(traceIds)).toJudge,
                  onIneligible: async (traceId, classification) => {
                      await opts.writeScore(
                          ineligibleScoreRequest({
                              traceId,
                              classification,
                              version: eligibility,
                              threshold,
                              mode: classifier,
                              environment,
                          }),
                      );
                  },
                  budgetMs: opts.budgetMs,
                  now: opts.now,
              });

    const toJudge = classified?.toJudge ?? unprocessed;
    const coverage: ClassifierCoverage = classified
        ? {
              skippedIneligibleRule: classified.counters.skippedIneligible.rule,
              skippedIneligibleModel: classified.counters.skippedIneligible.model,
              classifierFailed: classified.counters.classifierFailed,
              targetMissed: classified.targetReached ? 0 : 1,
          }
        : { ...NO_CLASSIFIER_COUNTERS };
    return {
        toJudge,
        turns: classified?.turns ?? new Map(),
        skipped,
        coverage,
        output: {
            classifier,
            classifierModel: eligibility.classifierModel,
            classifierThreshold: threshold,
            skippedIneligible: { rule: coverage.skippedIneligibleRule, model: coverage.skippedIneligibleModel },
            classifierFailed: coverage.classifierFailed,
            targetReached: classified?.targetReached ?? true,
            classifierTarget: classified?.target ?? toJudge.length,
            classifierAttempts: classified?.counters.attempts ?? 0,
            toppedUp: classified?.counters.toppedUp ?? 0,
            skipScoreWriteFailed: classified?.counters.skipScoreWriteFailed ?? 0,
            classifierBudgetExceeded: classified?.counters.budgetExceeded ?? 0,
            classifierCostUsd: classified?.counters.costUsd ?? 0,
            ineligibleTraceIds: classified?.ineligible ?? [],
            toppedUpTraceIds: classified?.toppedUp ?? [],
        },
    };
}
