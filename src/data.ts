import { AiProvider, AiQuestion } from "./ai";
import { Rating } from "./core";
import { DEFAULT_UI_SKIN, UiSkin, normalizeUiSkin } from "./ui-skin";
import {
  DEFAULT_EXAM_END_DATE,
  DEFAULT_EXAM_NAME,
  DEFAULT_EXAM_START_DATE,
  normalizeExamDateKey
} from "./exam-countdown";
import {
  DEFAULT_FSRS_OPTIONS,
  FSRS_ALGORITHM,
  FsrsMemoryState,
  FsrsOptions,
  fsrsStageFromInterval,
  normalizeFsrsOptions,
  scheduleFsrsReview,
  seedFsrsStateFromLegacy
} from "./fsrs-scheduler";

export const CURRENT_DATA_VERSION = 5 as const;

export interface RecallGardenSettings {
  uiSkin: UiSkin;
  enableVisualEffects: boolean;
  folder: string;
  strictEightSections: boolean;
  dailyNewCards: number;
  dailyReviewLimit: number;
  pauseNewCards: boolean;
  trackAnswerTime: boolean;
  examName: string;
  examStartDate: string;
  examEndDate: string;
  schedulerAlgorithm: typeof FSRS_ALGORITHM;
  desiredRetention: number;
  maximumIntervalDays: number;
  enableFuzzing: boolean;
  aiProvider: AiProvider;
  codexModel: string;
  codexModels: string[];
  deepseekModel: string;
  deepseekBaseUrl: string;
  deepseekSecretId: string;
}

export interface ReviewRecord {
  reviewId: string;
  sourcePath: string;
  stage: number;
  introducedAt: string;
  lastReviewedAt: string;
  nextReviewAt: string;
  lastRating: Rating;
  reviewCount: number;
  errorCount: number;
  history: ReviewAttempt[];
  fsrs: FsrsMemoryState | null;
}

export interface ReviewAttempt {
  reviewedAt: string;
  rating: Rating;
  revealLevel: 0 | 1 | 2;
  fullyRevealed: boolean;
  durationSeconds: number | null;
  scheduledDays?: number;
  stability?: number;
  difficulty?: number;
}

export interface ReviewEvidence {
  revealLevel: 0 | 1 | 2;
  durationSeconds: number | null;
}

export type ArchiveReason = "deleted" | "out-of-scope";

export interface ArchivedCard {
  reviewId: string;
  sourcePath: string;
  archivedAt: string;
  reason: ArchiveReason;
  record: ReviewRecord | null;
  questions: AiQuestion[];
}

export interface RecallGardenData {
  version: typeof CURRENT_DATA_VERSION;
  settings: RecallGardenSettings;
  sourceIds: Record<string, string>;
  records: Record<string, ReviewRecord>;
  questions: Record<string, AiQuestion[]>;
  archived: Record<string, ArchivedCard>;
}

export interface DataSummary {
  stableIds: number;
  activeCards: number;
  reviewedCards: number;
  totalRatings: number;
  aiQuestions: number;
  archivedCards: number;
}

export const DEFAULT_SETTINGS: RecallGardenSettings = {
  uiSkin: DEFAULT_UI_SKIN,
  enableVisualEffects: true,
  folder: "Recall Garden/Cards",
  strictEightSections: false,
  dailyNewCards: 20,
  dailyReviewLimit: 100,
  pauseNewCards: false,
  trackAnswerTime: true,
  examName: DEFAULT_EXAM_NAME,
  examStartDate: DEFAULT_EXAM_START_DATE,
  examEndDate: DEFAULT_EXAM_END_DATE,
  schedulerAlgorithm: FSRS_ALGORITHM,
  desiredRetention: DEFAULT_FSRS_OPTIONS.desiredRetention,
  maximumIntervalDays: DEFAULT_FSRS_OPTIONS.maximumIntervalDays,
  enableFuzzing: DEFAULT_FSRS_OPTIONS.enableFuzzing,
  aiProvider: "disabled",
  codexModel: "",
  codexModels: [],
  deepseekModel: "deepseek-v4-flash",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekSecretId: ""
};

export class UnknownSchemaVersionError extends Error {
  constructor(public readonly foundVersion: number) {
    super(`数据版本 ${foundVersion} 高于本插件支持的版本 ${CURRENT_DATA_VERSION}`);
    this.name = "UnknownSchemaVersionError";
  }
}

export function createEmptyData(): RecallGardenData {
  return {
    version: CURRENT_DATA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    sourceIds: {},
    records: {},
    questions: {},
    archived: {}
  };
}

export function migrateData(raw: unknown): RecallGardenData {
  const input = asRecord(raw);
  const parsedVersion = Number(input.version ?? 1);
  const version = Number.isFinite(parsedVersion) ? parsedVersion : 1;
  if (version > CURRENT_DATA_VERSION) throw new UnknownSchemaVersionError(version);

  return {
    version: CURRENT_DATA_VERSION,
    settings: migrateSettings(input.settings),
    sourceIds: stringMap(input.sourceIds),
    records: recordMap(input.records),
    questions: questionMap(input.questions),
    archived: archivedMap(input.archived)
  };
}

export function summarizeData(data: RecallGardenData): DataSummary {
  const stableIds = new Set<string>([
    ...Object.values(data.sourceIds),
    ...Object.keys(data.archived)
  ]);
  const archivedReviewedCards = Object.values(data.archived).filter((entry) => entry.record !== null).length;
  return {
    stableIds: stableIds.size,
    activeCards: Object.keys(data.sourceIds).length,
    reviewedCards: Object.keys(data.records).length + archivedReviewedCards,
    totalRatings: Object.values(data.records).reduce((sum, record) => sum + record.reviewCount, 0) +
      Object.values(data.archived).reduce((sum, entry) => sum + (entry.record?.reviewCount ?? 0), 0),
    aiQuestions: Object.values(data.questions).reduce((sum, questions) => sum + questions.length, 0) +
      Object.values(data.archived).reduce((sum, entry) => sum + entry.questions.length, 0),
    archivedCards: Object.keys(data.archived).length
  };
}

export function assignReviewId(data: RecallGardenData, sourcePath: string, createId: () => string): string {
  const activeId = data.sourceIds[sourcePath];
  if (activeId) return activeId;

  const archived = Object.values(data.archived).find((entry) => entry.sourcePath === sourcePath);
  if (archived) {
    restoreArchivedCard(data, archived.reviewId, sourcePath);
    return archived.reviewId;
  }

  const reviewId = createId();
  data.sourceIds[sourcePath] = reviewId;
  return reviewId;
}

export function buildReviewRecord(
  existing: ReviewRecord | undefined,
  reviewId: string,
  sourcePath: string,
  rating: Rating,
  evidence: ReviewEvidence,
  now = new Date(),
  fsrsOptions: Partial<FsrsOptions> = DEFAULT_FSRS_OPTIONS
): ReviewRecord {
  const initialState = existing?.fsrs ?? (existing ? seedFsrsStateFromLegacy(existing, now) : null);
  const schedule = scheduleFsrsReview(initialState, rating, now, fsrsOptions);
  const revealLevel = evidence.revealLevel;
  const durationSeconds = evidence.durationSeconds !== null && Number.isFinite(evidence.durationSeconds)
    ? Math.max(0, Math.round(evidence.durationSeconds))
    : null;
  const attempt: ReviewAttempt = {
    reviewedAt: now.toISOString(),
    rating,
    revealLevel,
    fullyRevealed: revealLevel === 2,
    durationSeconds,
    scheduledDays: schedule.scheduledDays,
    stability: schedule.state.stability,
    difficulty: schedule.state.difficulty
  };
  return {
    reviewId,
    sourcePath,
    stage: fsrsStageFromInterval(schedule.intervalMinutes),
    introducedAt: existing?.introducedAt ?? now.toISOString(),
    lastReviewedAt: now.toISOString(),
    nextReviewAt: schedule.dueAt,
    lastRating: rating,
    reviewCount: (existing?.reviewCount ?? 0) + 1,
    errorCount: (existing?.errorCount ?? 0) + (rating === 1 ? 1 : 0),
    history: [...(existing?.history ?? []), attempt],
    fsrs: schedule.state
  };
}

export function archiveCard(
  data: RecallGardenData,
  sourcePath: string,
  reason: ArchiveReason,
  archivedAt = new Date().toISOString()
): ArchivedCard | null {
  const reviewId = data.sourceIds[sourcePath];
  if (!reviewId) return null;

  const previous = data.archived[reviewId];
  const record = data.records[reviewId] ?? previous?.record ?? null;
  const questions = data.questions[reviewId] ?? previous?.questions ?? [];
  const archived: ArchivedCard = {
    reviewId,
    sourcePath,
    archivedAt,
    reason,
    record: record ? { ...record, sourcePath } : null,
    questions: questions.map((question) => ({ ...question, sourcePath }))
  };

  delete data.sourceIds[sourcePath];
  delete data.records[reviewId];
  delete data.questions[reviewId];
  data.archived[reviewId] = archived;
  return archived;
}

export function restoreArchivedCard(data: RecallGardenData, reviewId: string, sourcePath?: string): boolean {
  const archived = data.archived[reviewId];
  if (!archived) return false;
  const restoredPath = sourcePath ?? archived.sourcePath;
  data.sourceIds[restoredPath] = reviewId;
  if (archived.record) data.records[reviewId] = { ...archived.record, sourcePath: restoredPath };
  if (archived.questions.length > 0) {
    data.questions[reviewId] = archived.questions.map((question) => ({ ...question, sourcePath: restoredPath }));
  }
  delete data.archived[reviewId];
  return true;
}

export function reconcileSources(
  data: RecallGardenData,
  activeSourcePaths: ReadonlySet<string>,
  existingVaultPaths: ReadonlySet<string>,
  archivedAt = new Date().toISOString()
): ArchivedCard[] {
  const archived: ArchivedCard[] = [];
  for (const sourcePath of Object.keys(data.sourceIds)) {
    if (activeSourcePaths.has(sourcePath)) continue;
    const entry = archiveCard(
      data,
      sourcePath,
      existingVaultPaths.has(sourcePath) ? "out-of-scope" : "deleted",
      archivedAt
    );
    if (entry) archived.push(entry);
  }
  return archived;
}

export function updateSourcePath(data: RecallGardenData, oldPath: string, newPath: string): string | null {
  const reviewId = data.sourceIds[oldPath];
  if (reviewId) {
    delete data.sourceIds[oldPath];
    data.sourceIds[newPath] = reviewId;
    const record = data.records[reviewId];
    if (record) record.sourcePath = newPath;
    const questions = data.questions[reviewId] ?? [];
    for (const question of questions) question.sourcePath = newPath;
    return reviewId;
  }

  const archived = Object.values(data.archived).find((entry) => entry.sourcePath === oldPath);
  if (!archived) return null;
  archived.sourcePath = newPath;
  if (archived.record) archived.record.sourcePath = newPath;
  for (const question of archived.questions) question.sourcePath = newPath;
  return archived.reviewId;
}

function migrateSettings(value: unknown): RecallGardenSettings {
  const input = asRecord(value);
  const aiProvider = input.aiProvider;
  const examStartDate = normalizeExamDateKey(input.examStartDate, DEFAULT_EXAM_START_DATE);
  const requestedExamEndDate = normalizeExamDateKey(input.examEndDate, DEFAULT_EXAM_END_DATE);
  const examEndDate = requestedExamEndDate < examStartDate ? examStartDate : requestedExamEndDate;
  const fsrsOptions = normalizeFsrsOptions({
    desiredRetention: numberValue(input.desiredRetention, DEFAULT_FSRS_OPTIONS.desiredRetention),
    maximumIntervalDays: numberValue(input.maximumIntervalDays, DEFAULT_FSRS_OPTIONS.maximumIntervalDays),
    enableFuzzing: booleanValue(input.enableFuzzing, DEFAULT_FSRS_OPTIONS.enableFuzzing)
  });
  return {
    ...DEFAULT_SETTINGS,
    uiSkin: normalizeUiSkin(input.uiSkin),
    enableVisualEffects: booleanValue(input.enableVisualEffects, DEFAULT_SETTINGS.enableVisualEffects),
    folder: stringValue(input.folder, DEFAULT_SETTINGS.folder),
    strictEightSections: booleanValue(input.strictEightSections, DEFAULT_SETTINGS.strictEightSections),
    dailyNewCards: numberValue(input.dailyNewCards, DEFAULT_SETTINGS.dailyNewCards),
    dailyReviewLimit: numberValue(input.dailyReviewLimit, DEFAULT_SETTINGS.dailyReviewLimit),
    pauseNewCards: booleanValue(input.pauseNewCards, DEFAULT_SETTINGS.pauseNewCards),
    trackAnswerTime: booleanValue(input.trackAnswerTime, DEFAULT_SETTINGS.trackAnswerTime),
    examName: stringValue(input.examName, DEFAULT_EXAM_NAME),
    examStartDate,
    examEndDate,
    schedulerAlgorithm: FSRS_ALGORITHM,
    desiredRetention: fsrsOptions.desiredRetention,
    maximumIntervalDays: fsrsOptions.maximumIntervalDays,
    enableFuzzing: fsrsOptions.enableFuzzing,
    aiProvider: aiProvider === "codex-oauth" || aiProvider === "deepseek" || aiProvider === "disabled" ? aiProvider : "disabled",
    codexModel: stringValue(input.codexModel),
    codexModels: Array.isArray(input.codexModels) ? input.codexModels.filter((item): item is string => typeof item === "string") : [],
    deepseekModel: stringValue(input.deepseekModel, DEFAULT_SETTINGS.deepseekModel),
    deepseekBaseUrl: stringValue(input.deepseekBaseUrl, DEFAULT_SETTINGS.deepseekBaseUrl),
    deepseekSecretId: stringValue(input.deepseekSecretId)
  };
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string" && item) result[key] = item;
  }
  return result;
}

function recordMap(value: unknown): Record<string, ReviewRecord> {
  const result: Record<string, ReviewRecord> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (!isRecord(item)) continue;
    result[key] = {
      ...(item as unknown as ReviewRecord),
      history: reviewHistory(item.history),
      fsrs: fsrsMemoryState(item.fsrs)
    };
  }
  return result;
}

function questionMap(value: unknown): Record<string, AiQuestion[]> {
  const result: Record<string, AiQuestion[]> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (Array.isArray(item)) result[key] = item.map((question) => ({ ...(question as AiQuestion) }));
  }
  return result;
}

function archivedMap(value: unknown): Record<string, ArchivedCard> {
  const result: Record<string, ArchivedCard> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (!isRecord(item)) continue;
    const record = isRecord(item.record)
      ? ({
        ...item.record,
        history: reviewHistory(item.record.history),
        fsrs: fsrsMemoryState(item.record.fsrs)
      } as unknown as ReviewRecord)
      : null;
    const questions = Array.isArray(item.questions) ? item.questions.map((question) => ({ ...(question as AiQuestion) })) : [];
    result[key] = {
      reviewId: stringValue(item.reviewId, key),
      sourcePath: stringValue(item.sourcePath),
      archivedAt: stringValue(item.archivedAt),
      reason: item.reason === "out-of-scope" ? "out-of-scope" : "deleted",
      record,
      questions
    };
  }
  return result;
}

function reviewHistory(value: unknown): ReviewAttempt[] {
  if (!Array.isArray(value)) return [];
  const result: ReviewAttempt[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rating = Number(item.rating);
    const revealLevel = Number(item.revealLevel);
    if (![1, 2, 3, 4].includes(rating) || ![0, 1, 2].includes(revealLevel)) continue;
    const rawDuration = item.durationSeconds;
    result.push({
      reviewedAt: stringValue(item.reviewedAt),
      rating: rating as Rating,
      revealLevel: revealLevel as 0 | 1 | 2,
      fullyRevealed: booleanValue(item.fullyRevealed, revealLevel === 2),
      durationSeconds: typeof rawDuration === "number" && Number.isFinite(rawDuration) ? Math.max(0, Math.round(rawDuration)) : null,
      ...optionalFiniteNumber("scheduledDays", item.scheduledDays),
      ...optionalFiniteNumber("stability", item.stability),
      ...optionalFiniteNumber("difficulty", item.difficulty)
    });
  }
  return result;
}

function fsrsMemoryState(value: unknown): FsrsMemoryState | null {
  if (!isRecord(value)) return null;
  const state = Number(value.state);
  const due = stringValue(value.due);
  if (!due || !Number.isFinite(Date.parse(due)) || ![0, 1, 2, 3].includes(state)) return null;
  const lastReview = value.lastReview === null ? null : stringValue(value.lastReview);
  return {
    due,
    stability: nonNegativeNumber(value.stability),
    difficulty: nonNegativeNumber(value.difficulty),
    elapsedDays: nonNegativeNumber(value.elapsedDays),
    scheduledDays: nonNegativeNumber(value.scheduledDays),
    learningSteps: Math.round(nonNegativeNumber(value.learningSteps)),
    reps: Math.round(nonNegativeNumber(value.reps)),
    lapses: Math.round(nonNegativeNumber(value.lapses)),
    state: state as 0 | 1 | 2 | 3,
    lastReview: lastReview && Number.isFinite(Date.parse(lastReview)) ? lastReview : null
  };
}

function optionalFiniteNumber<Key extends "scheduledDays" | "stability" | "difficulty">(
  key: Key,
  value: unknown
): Partial<Record<Key, number>> {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: Math.max(0, value) } as Record<Key, number> : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
