import {
  Rating as FsrsRating,
  State,
  createEmptyCard,
  fsrs,
  type Card,
  type CardInput
} from "ts-fsrs";
import type { Rating } from "./core";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const FSRS_ALGORITHM = "fsrs-6" as const;

export interface FsrsOptions {
  desiredRetention: number;
  maximumIntervalDays: number;
  enableFuzzing: boolean;
}

export const DEFAULT_FSRS_OPTIONS: FsrsOptions = {
  desiredRetention: 0.9,
  maximumIntervalDays: 3_650,
  enableFuzzing: false
};

export interface FsrsMemoryState {
  due: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  lastReview: string | null;
}

export interface FsrsScheduleResult {
  state: FsrsMemoryState;
  dueAt: string;
  intervalMinutes: number;
  scheduledDays: number;
  retrievability: number;
}

export interface LegacyScheduleSeed {
  stage: number;
  reviewCount: number;
  errorCount: number;
  lastReviewedAt: string;
  nextReviewAt: string;
}

export function normalizeFsrsOptions(options: Partial<FsrsOptions> = {}): FsrsOptions {
  return {
    desiredRetention: clamp(options.desiredRetention ?? DEFAULT_FSRS_OPTIONS.desiredRetention, 0.7, 0.97),
    maximumIntervalDays: Math.round(clamp(
      options.maximumIntervalDays ?? DEFAULT_FSRS_OPTIONS.maximumIntervalDays,
      1,
      36_500
    )),
    enableFuzzing: options.enableFuzzing ?? DEFAULT_FSRS_OPTIONS.enableFuzzing
  };
}

export function scheduleFsrsReview(
  state: FsrsMemoryState | null,
  rating: Rating,
  now: Date,
  options: Partial<FsrsOptions> = DEFAULT_FSRS_OPTIONS
): FsrsScheduleResult {
  const normalized = normalizeFsrsOptions(options);
  const scheduler = createScheduler(normalized);
  const card = state ? deserializeFsrsState(state) : createEmptyCard(now);
  const previousRetrievability = state ? scheduler.get_retrievability(card, now, false) : 0;
  const result = scheduler.next(card, now, toFsrsRating(rating));
  const dueTime = result.card.due.getTime();
  return {
    state: serializeFsrsCard(result.card),
    dueAt: result.card.due.toISOString(),
    intervalMinutes: Math.max(1, Math.round((dueTime - now.getTime()) / MINUTE_MS)),
    scheduledDays: result.log.scheduled_days,
    retrievability: clamp(previousRetrievability, 0, 1)
  };
}

export function previewFsrsSchedule(
  state: FsrsMemoryState | null,
  now: Date,
  options: Partial<FsrsOptions> = DEFAULT_FSRS_OPTIONS
): Record<Rating, FsrsScheduleResult> {
  return {
    1: scheduleFsrsReview(state, 1, now, options),
    2: scheduleFsrsReview(state, 2, now, options),
    3: scheduleFsrsReview(state, 3, now, options),
    4: scheduleFsrsReview(state, 4, now, options)
  };
}

export function getFsrsRetrievability(
  state: FsrsMemoryState | null,
  now: Date,
  options: Partial<FsrsOptions> = DEFAULT_FSRS_OPTIONS
): number | null {
  if (!state) return null;
  const scheduler = createScheduler(normalizeFsrsOptions(options));
  return clamp(scheduler.get_retrievability(deserializeFsrsState(state), now, false), 0, 1);
}

export function seedFsrsStateFromLegacy(seed: LegacyScheduleSeed, now: Date): FsrsMemoryState {
  const lastReviewTime = validTime(seed.lastReviewedAt, now.getTime());
  const dueTime = validTime(seed.nextReviewAt, now.getTime());
  const scheduledDays = Math.max(1 / 1_440, (dueTime - lastReviewTime) / DAY_MS);
  const elapsedDays = Math.max(0, (now.getTime() - lastReviewTime) / DAY_MS);
  return {
    due: new Date(dueTime).toISOString(),
    stability: Math.max(scheduledDays, legacyStageDays(seed.stage)),
    difficulty: 5,
    elapsedDays,
    scheduledDays,
    learningSteps: 0,
    reps: Math.max(1, Math.round(seed.reviewCount)),
    lapses: Math.max(0, Math.round(seed.errorCount)),
    state: State.Review,
    lastReview: new Date(lastReviewTime).toISOString()
  };
}

export function fsrsStageFromInterval(intervalMinutes: number): number {
  const boundaries = [20, 1_440, 2_880, 5_760, 10_080, 21_600, 43_200, 86_400];
  let stage = 0;
  for (let index = 0; index < boundaries.length; index += 1) {
    if (intervalMinutes >= boundaries[index]) stage = index;
  }
  return stage;
}

export function serializeFsrsCard(card: Card): FsrsMemoryState {
  return {
    due: card.due.toISOString(),
    stability: finiteNonNegative(card.stability),
    difficulty: finiteNonNegative(card.difficulty),
    elapsedDays: finiteNonNegative(card.elapsed_days),
    scheduledDays: finiteNonNegative(card.scheduled_days),
    learningSteps: Math.max(0, Math.round(card.learning_steps)),
    reps: Math.max(0, Math.round(card.reps)),
    lapses: Math.max(0, Math.round(card.lapses)),
    state: normalizeState(card.state),
    lastReview: card.last_review ? card.last_review.toISOString() : null
  };
}

export function deserializeFsrsState(state: FsrsMemoryState): CardInput {
  return {
    due: state.due,
    stability: finiteNonNegative(state.stability),
    difficulty: finiteNonNegative(state.difficulty),
    elapsed_days: finiteNonNegative(state.elapsedDays),
    scheduled_days: finiteNonNegative(state.scheduledDays),
    learning_steps: Math.max(0, Math.round(state.learningSteps)),
    reps: Math.max(0, Math.round(state.reps)),
    lapses: Math.max(0, Math.round(state.lapses)),
    state: normalizeState(state.state),
    last_review: state.lastReview
  };
}

function createScheduler(options: FsrsOptions) {
  return fsrs({
    request_retention: options.desiredRetention,
    maximum_interval: options.maximumIntervalDays,
    enable_fuzz: options.enableFuzzing,
    enable_short_term: true,
    learning_steps: ["1m", "10m"],
    relearning_steps: ["10m"]
  });
}

function toFsrsRating(rating: Rating): FsrsRating.Again | FsrsRating.Hard | FsrsRating.Good | FsrsRating.Easy {
  return rating as FsrsRating.Again | FsrsRating.Hard | FsrsRating.Good | FsrsRating.Easy;
}

function normalizeState(value: number): 0 | 1 | 2 | 3 {
  return value === State.Learning || value === State.Review || value === State.Relearning ? value : State.New;
}

function validTime(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function legacyStageDays(stage: number): number {
  const minutes = [20, 1_440, 2_880, 5_760, 10_080, 21_600, 43_200, 86_400];
  const safeStage = Math.max(0, Math.min(minutes.length - 1, Math.round(stage)));
  return minutes[safeStage] / 1_440;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
